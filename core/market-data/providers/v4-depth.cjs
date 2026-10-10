'use strict';
// Executable depth from a Uniswap v4 pool's own curve.
// Active liquidity is the current uint128 L. It is not a USD TVL.
// TVL is the sum of token amounts across initialized ranges that were read.
// Executable depth is the quote-side input whose average price stays inside
// the paper slippage. A missing Quoter contract is not replaced by an invented address.
const Q96 = 2n ** 96n;
const ONE = 10n ** 18n;
function priceFromSqrt(sqrt) {
  if (sqrt <= 0n) return null;
  const scale = 10n ** 24n;
  const ratio = (sqrt * sqrt * scale) / (Q96 * Q96);
  const text = ratio.toString().padStart(25, '0');
  const value = Number(text.slice(0, text.length - 24) + '.' + text.slice(text.length - 24, text.length - 12));
  return Number.isFinite(value) && value > 0 ? value : null;
}
function sqrtAtTick(tick) {
  const ratio = Math.pow(1.0001, tick / 2);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const scaled = ratio * 2 ** 96;
  if (!Number.isFinite(scaled) || scaled < 1) return null;
  return BigInt(Math.floor(scaled));
}
function amount0(sqrtA, sqrtB, liquidity) {
  let a = sqrtA, b = sqrtB;
  if (a > b) { const swap = a; a = b; b = swap; }
  if (a <= 0n) return null;
  return liquidity * (b - a) * Q96 / (a * b);
}
function amount1(sqrtA, sqrtB, liquidity) {
  let a = sqrtA, b = sqrtB;
  if (a > b) { const swap = a; a = b; b = swap; }
  return liquidity * (b - a) / Q96;
}
function quoteExactInput({ sqrt, liquidity, fee, zeroForOne, amountIn, ticks }) {
  if (sqrt <= 0n || liquidity < 0n || amountIn <= 0n || !Number.isInteger(fee) || fee < 0 || fee >= 1000000) return null;
  const bounds = (Array.isArray(ticks) ? ticks : []).filter(row => Number.isInteger(row.tick) && typeof row.liquidityNet === 'bigint').sort((a, b) => a.tick - b.tick);
  let current = sqrt, active = liquidity, left = amountIn, spent = 0n, received = 0n;
  for (let step = 0; step < bounds.length + 1 && left > 0n; step++) {
    const next = zeroForOne
      ? [...bounds].reverse().find(row => sqrtAtTick(row.tick) !== null && sqrtAtTick(row.tick) < current)
      : bounds.find(row => sqrtAtTick(row.tick) !== null && sqrtAtTick(row.tick) > current);
    const target = next ? sqrtAtTick(next.tick) : (zeroForOne ? 1n : (1n << 160n) - 1n);
    if (active === 0n) {
      if (!next) break;
      current = target;
      active += zeroForOne ? -next.liquidityNet : next.liquidityNet;
      if (active < 0n) return null;
      continue;
    }
    const room = zeroForOne ? amount0(current, target, active) : amount1(current, target, active);
    if (room === null) return null;
    const usable = left * BigInt(1000000 - fee) / 1000000n;
    if (usable <= room) {
      const paid = left;
      const net = usable;
      let nextSqrt;
      if (zeroForOne) {
        const denominator = active * Q96 + net * current;
        if (denominator <= 0n) return null;
        nextSqrt = active * Q96 * current / denominator;
        received += amount1(current, nextSqrt, active);
      } else {
        nextSqrt = current + net * Q96 / active;
        received += amount0(current, nextSqrt, active);
      }
      spent += paid;
      current = nextSqrt;
      left = 0n;
    } else {
      const gross = room * 1000000n / BigInt(1000000 - fee) + 1n;
      if (gross > left) break;
      spent += gross;
      left -= gross;
      received += zeroForOne ? amount1(current, target, active) : amount0(current, target, active);
      current = target;
      if (!next) break;
      active += zeroForOne ? -next.liquidityNet : next.liquidityNet;
      if (active < 0n) return null;
    }
  }
  if (spent <= 0n || received <= 0n) return null;
  return { spent, received, sqrtAfter: current };
}
function units(value, decimals) {
  const negative = value < 0n;
  const text = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const number = Number(text.slice(0, text.length - decimals) + '.' + text.slice(text.length - decimals, text.length - decimals + 12));
  return negative ? -number : number;
}
function curveImpact(sqrt, sqrtAfter) {
  const before = priceFromSqrt(sqrt), after = priceFromSqrt(sqrtAfter);
  if (before === null || after === null || before <= 0) return null;
  return Math.abs(after / before - 1);
}
function executableDepth({ sqrt, tick, liquidity, fee, ethUsd, ticks, slippageBps = 10 }) {
  const spot = priceFromSqrt(sqrt);
  if (spot === null || !(ethUsd > 0) || liquidity < 0n) return null;
  const quote = usd => {
    const wei = BigInt(Math.max(1, Math.round(usd / ethUsd * 1e18)));
    const result = quoteExactInput({ sqrt, liquidity, fee, zeroForOne: true, amountIn: wei, ticks });
    if (!result) return { usd, priceImpact: null, out: 0 };
    return { usd, priceImpact: curveImpact(sqrt, result.sqrtAfter), out: units(result.received, 18), spentEth: units(result.spent, 18) };
  };
  let depth = 0, low = 0, high = 100000;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    const probe = quote(Math.max(mid, 0.01));
    if (probe.priceImpact !== null && probe.priceImpact <= slippageBps / 10000) { depth = mid; low = mid; }
    else high = mid;
  }
  const atDepth = depth > 0 ? quote(depth) : null;
  const priceImpactBps = atDepth && atDepth.priceImpact !== null ? Math.round(atDepth.priceImpact * 10000 * 100) / 100 : 0;
  return {
    activeLiquidity: liquidity.toString(),
    tick,
    spotToken1PerToken0: spot,
    feeBps: fee / 100,
    quote,
    executableDepthUsd: Number(depth.toFixed(2)),
    priceImpactBps,
    slippageBps
  };
}
function sizeOrder({ plannedOrderUsd, executableDepthUsd, slippageBps }) {
  const planned = Number(plannedOrderUsd);
  const depthUsd = Number(executableDepthUsd);
  if (!Number.isFinite(planned) || planned <= 0) return { plannedOrderUsd: 0, allowedUsd: 0, state: 'WAIT', reason: 'Risk budget does not produce a positive order.' };
  if (!Number.isFinite(depthUsd) || depthUsd <= 0 || !Number.isFinite(slippageBps)) return { plannedOrderUsd: planned, allowedUsd: 0, state: 'WAIT', reason: 'No executable size within slippage.' };
  const allowedUsd = Math.min(planned, depthUsd);
  if (!(allowedUsd > 0)) return { plannedOrderUsd: planned, allowedUsd: 0, state: 'WAIT', reason: 'Order reduced below a positive size.' };
  return { plannedOrderUsd: planned, allowedUsd, state: 'ELIGIBLE', reason: `Order ${allowedUsd} USD of planned ${planned} USD stays inside ${slippageBps} bps.` };
}
function rangeValue(sqrt, tick, ticks, ethUsd) {
  const spot = priceFromSqrt(sqrt);
  if (spot === null || !(ethUsd > 0)) return null;
  let active = 0n, usd = 0;
  const ordered = [...ticks].sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < ordered.length - 1; i++) {
    active += ordered[i].liquidityNet;
    if (active <= 0n) continue;
    const lower = sqrtAtTick(ordered[i].tick), upper = sqrtAtTick(ordered[i + 1].tick);
    if (!lower || !upper || upper <= lower) continue;
    let token0 = 0n, token1 = 0n;
    if (tick >= ordered[i + 1].tick) token0 = amount0(lower, upper, active);
    else if (tick < ordered[i].tick) token1 = amount1(lower, upper, active);
    else { token0 = amount0(sqrt, upper, active); token1 = amount1(lower, sqrt, active); }
    if (token0 === null || token1 === null) continue;
    usd += units(token0, 18) * ethUsd + units(token1, 18) * ethUsd / spot;
  }
  return Number.isFinite(usd) ? usd : null;
}
const checkSqrt = 1n << 96n;
const check = quoteExactInput({ sqrt: checkSqrt, liquidity: 10n ** 24n, fee: 0, zeroForOne: true, amountIn: 10n ** 16n, ticks: [] });
if (!check || check.sqrtAfter >= checkSqrt || check.received <= 0n) throw Error('V4_DEPTH_DIRECTION');
module.exports = { priceFromSqrt, sqrtAtTick, quoteExactInput, executableDepth, sizeOrder, rangeValue, units, amount0, amount1 };
