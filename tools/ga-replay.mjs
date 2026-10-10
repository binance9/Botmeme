// Historical audit: node tools/ga-replay.mjs --sweep [kline-directory] [minSetups=20]
// Single series: node tools/ga-replay.mjs <klines.jsonl> <timeframe> [A|B|C] [minSetups=20]
// No engine overrides: scanner defaults, full prefixes, closed HTF bars only.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEngine } from '../services/ga-signal/engine/ga-engine.mjs';
import { buildStructures, resolveLevels, atr14, candleClose, HIGHER_TIMEFRAME,
  timeframeSeconds } from '../services/ga-signal/level-engine.mjs';

const OUTPUT = fileURLToPath(new URL('../data/ga-signal/replay-receipts.json', import.meta.url));
const WARMUP = 600, SPACING = 50, TICK = 0.01, ENGINE_WARMUP = 500;

// Aggregate only complete UTC-aligned groups, excluding partial first/last groups.
// These are the available local HTF history; no invented pre-dataset history.
export function higherCandles(candles, symbol, timeframe, higher) {
  if (!higher) return [];
  const step = timeframeSeconds(timeframe), higherStep = timeframeSeconds(higher);
  const size = higherStep / step;
  if (!Number.isInteger(size)) throw new Error('HTF is not an integer multiple of timeframe');
  const result = [];
  for (let i = 0; i + size <= candles.length; i++) {
    const first = candles[i];
    if (first.time % higherStep !== 0) continue;
    const group = candles.slice(i, i + size), end = first.time + higherStep;
    if (group.some((c, j) => c.time !== first.time + j * step || candleClose(c, timeframe) > end)) continue;
    result.push({ time: first.time, open: first.open, close: group.at(-1).close,
      high: Math.max(...group.map(c => c.high)), low: Math.min(...group.map(c => c.low)),
      volume: group.reduce((sum, c) => sum + (c.volume ?? 0), 0),
      closed: true, closedAt: end, symbol, timeframe: higher });
    i += size - 1;
  }
  return result;
}

export function firstTouch(candles, index, side, receipt, timeframe) {
  for (let i = index + 1; i < candles.length; i++) {
    const c = candles[i];
    const stopped = side === 'LONG' ? c.low <= receipt.sl.price : c.high >= receipt.sl.price;
    const touched = receipt.targets.filter(t => side === 'LONG' ? c.high >= t.price : c.low <= t.price);
    if (stopped || touched.length) return {
      outcome: stopped ? 'SL' : `TP${touched[0].level}`,
      outcome_details: { candle_index: i, candle_time: c.time, closed_at: candleClose(c, timeframe),
        ambiguous: stopped && touched.length > 0,
        touched_targets: touched.map(t => `TP${t.level}`), sl_touched: stopped },
    };
  }
  return { outcome: 'OPEN_AT_END', outcome_details: { candle_index: null, candle_time: null,
    ambiguous: false, touched_targets: [], sl_touched: false } };
}

async function replaySeries(input, timeframe, variant, minSetups, receipts) {
  const { raw, candles, symbol } = await loadCachedSeries(input, timeframe);
  const higher = HIGHER_TIMEFRAME[timeframe];
  const htf = higherCandles(candles, symbol, timeframe, higher);
  const stats = { bars: candles.length, prefixes: 0, triggers: 0, evaluated: 0, spacing_skipped: 0,
    accepted: 0, NO_REFERENCE: 0, RR_LOW: 0, rejections: {} };
  let lastEvaluated = -Infinity, lastProgress = Date.now(), lastIndex = WARMUP - 1;
  for (let i = WARMUP; i < candles.length && receipts.length < minSetups; i++) {
    lastIndex = i;
    const prefix = candles.slice(0, i + 1);
    const result = runEngine({ candles: prefix, symbol, timeframe, variant,
      params: { tick: TICK, warmup: true, warmupBars: ENGINE_WARMUP } });
    stats.prefixes++;
    // Historical events are re-emitted by runEngine: only this prefix's final bar is new.
    const trigger = result.events.find(e => e.type === 'SETUP_CREATED' && e.time === candles[i].time);
    if (trigger) {
      stats.triggers++;
      if (i - lastEvaluated < SPACING) stats.spacing_skipped++;
      else {
        lastEvaluated = i;
        stats.evaluated++;
        const signalTime = candleClose(prefix.at(-1), timeframe);
        const structures = buildStructures({ candles: prefix, symbol, timeframe, signalTime });
        const closedHigher = htf.filter(c => candleClose(c, higher) <= signalTime);
        const htfLevels = higher ? buildStructures({ candles: closedHigher, symbol, timeframe: higher, signalTime }) : {};
        const receipt = resolveLevels({ direction: trigger.side, entry: trigger.setup.entry_ref,
          atr14: atr14(prefix), tick: TICK, structures, htfLevels,
          params: { symbol, timeframe, signalTime } });
        if (!receipt.accepted) {
          stats.rejections[receipt.reason] = (stats.rejections[receipt.reason] ?? 0) + 1;
          if (receipt.reason === 'NO_REFERENCE' || receipt.reason === 'RR_LOW') stats[receipt.reason]++;
        } else {
          receipts.push({ n: receipts.length + 1, signal_time: trigger.time,
            signal_close_time: signalTime, candle_index: i, setup_id: trigger.setup_id,
            symbol, timeframe, variant, side: trigger.side, entry_ref: trigger.setup.entry_ref,
            reference: receipt.reference, sl: receipt.sl, targets: receipt.targets, rr: receipt.rr,
            ...firstTouch(candles, i, trigger.side, receipt, timeframe),
            levels_answer_why: { tp1_reason: receipt.targets[0].reason, sl_reason: receipt.sl.reason } });
          stats.accepted++;
        }
      }
    }
    if (Date.now() - lastProgress >= 15000) {
      console.error(`Replay ${symbol} ${timeframe} ${variant}: ${i + 1}/${candles.length} bars: ${stats.triggers} triggers, ${stats.evaluated} evaluated, ${stats.accepted} accepted, RR_LOW=${stats.RR_LOW}, NO_REFERENCE=${stats.NO_REFERENCE}`);
      lastProgress = Date.now();
    }
  }
  return {
    schema_version: 1, input: resolve(input), input_sha256: createHash('sha256').update(raw).digest('hex'),
    symbol, timeframe, variant, requested_setups: minSetups, goal_met: receipts.length >= minSetups,
    replay: { start_index: WARMUP, last_index: lastIndex, min_trigger_spacing: SPACING,
      engine_params: { tick: TICK, warmup: true, warmupBars: ENGINE_WARMUP },
      level_params: 'Scanner defaults: symbol, timeframe, signalTime; no threshold overrides',
      htf: higher ?? null, htf_source: 'Complete UTC-aligned groups from input; no history before input',
      outcome_policy: 'First touched structural level after signal close; SL wins same-candle ambiguity; nearest TP wins multi-TP candle; OPEN_AT_END if untouched' },
    statistics: stats,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const sweep = !args.length || args[0] === '--sweep';
  const directory = resolve(args[1] ?? 'C:/GA_SIGNAL_LAB/data/klines');
  const [input, timeframe, variant = 'A', count = '20', ...extra] = args;
  const minSetups = Number(sweep ? (args[2] ?? '20') : count);
  if (!Number.isSafeInteger(minSetups) || minSetups < 1 ||
      (sweep ? args.length > 3 : (!input || !/^[1-9]\d*[mhd]$/.test(timeframe ?? '') ||
        !Number.isFinite(timeframeSeconds(timeframe)) || !['A', 'B', 'C'].includes(variant) || extra.length))) {
    throw new Error('Usage: node tools/ga-replay.mjs --sweep [kline-directory] [minSetups=20] OR <kline-jsonl-path> <timeframe> [A|B|C] [minSetups=20]');
  }
  const series = [];
  if (sweep) {
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(f => f.isFile() && /\.jsonl$/i.test(f.name)).map(f => f.name).sort();
    if (!files.length) throw new Error(`No kline JSONL files in ${directory}`);
    for (const file of files) {
      const tf = file.match(/-(\d+[mhd])\.jsonl$/i)?.[1];
      if (!tf || !Number.isFinite(timeframeSeconds(tf))) throw new Error(`Cannot infer timeframe from ${file}`);
      for (const v of ['A', 'B', 'C']) series.push({ input: resolve(directory, file), timeframe: tf, variant: v });
    }
  } else series.push({ input, timeframe, variant });

  const receipts = [], runs = [];
  for (const item of series) {
    if (receipts.length >= minSetups) break;
    console.error(`Starting ${basename(item.input)} variant ${item.variant}; global accepted=${receipts.length}/${minSetups}`);
    runs.push(await replaySeries(item.input, item.timeframe, item.variant, minSetups, receipts));
  }
  const stats = { bars: 0, prefixes: 0, triggers: 0, evaluated: 0, spacing_skipped: 0,
    accepted: 0, NO_REFERENCE: 0, RR_LOW: 0, rejections: {} };
  for (const run of runs) {
    for (const key of Object.keys(stats)) {
      if (key !== 'rejections') stats[key] += run.statistics[key];
    }
    for (const [reason, n] of Object.entries(run.statistics.rejections)) {
      stats.rejections[reason] = (stats.rejections[reason] ?? 0) + n;
    }
  }
  stats.series = series.map(item => {
    const run = runs.find(r => r.input === resolve(item.input) && r.variant === item.variant);
    return run ? {
      input: run.input, input_sha256: run.input_sha256, symbol: run.symbol,
      timeframe: run.timeframe, variant: run.variant, ...run.statistics,
      start_index: run.replay.start_index, last_index: run.replay.last_index, htf: run.replay.htf,
      status: run.replay.last_index === run.statistics.bars - 1 ? 'exhausted' : 'goal_reached',
    } : {
      input: resolve(item.input), symbol: basename(item.input).replace(/-\d+[mhd]\.jsonl$/i, ''),
      timeframe: item.timeframe, variant: item.variant, status: 'not_started_goal_reached',
      prefixes: 0, triggers: 0, evaluated: 0, spacing_skipped: 0,
      NO_REFERENCE: 0, RR_LOW: 0, accepted: 0, rejections: {},
    };
  });
  const report = sweep ? {
    schema_version: 1, input_directory: directory, variants: ['A', 'B', 'C'],
    requested_setups: minSetups, goal_met: receipts.length >= minSetups,
    replay: { ...runs[0].replay, last_index: undefined, htf: undefined,
      order: 'Filename ascending, then A, B, C; spacing resets per file/variant',
      available_series: series.length, started_series: runs.length },
    statistics: stats, receipts,
  } : { ...runs[0], statistics: stats, receipts };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(report, null, 2) + '\n');
  console.table(receipts.map(r => ({ n: r.n, symbol: r.symbol, timeframe: r.timeframe, variant: r.variant, side: r.side, entry: r.entry_ref.toFixed(2),
    SL: r.sl.price.toFixed(2), TP1: r.targets[0]?.price.toFixed(2) ?? '-',
    TP2: r.targets[1]?.price.toFixed(2) ?? '-', TP3: r.targets[2]?.price.toFixed(2) ?? '-',
    rr1: r.rr.tp1.toFixed(3), outcome: r.outcome })));
  console.log(JSON.stringify({ output: OUTPUT, goal_met: report.goal_met, statistics: stats }, null, 2));
  if (!report.goal_met) console.error(`Only ${receipts.length}/${minSetups} accepted setups; exhausted input without changing engine parameters.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`GA_REPLAY_ERROR: ${error.message}`); process.exitCode = 1; });

import { stableId } from '../services/ga-signal/smc/pivot-engine.mjs';
import { StructureEngine } from '../services/ga-signal/smc/structure-engine.mjs';
import { OrderBlockEngine } from '../services/ga-signal/smc/order-block-engine.mjs';
import { FVGEngine } from '../services/ga-signal/smc/fvg-engine.mjs';
import { EqualHighLowEngine } from '../services/ga-signal/smc/eqh-eql-engine.mjs';
import { computePremiumDiscount } from '../services/ga-signal/smc/premium-discount.mjs';


// Incremental equivalent of buildStructures, sharing its production SMC engines.
export function createStructureCursor({ symbol, timeframe, pivotLength = 5 }) {
  const bars = [];
  const engine = new StructureEngine({ N: pivotLength });
  const ob = new OrderBlockEngine(), fvg = new FVGEngine(), eq = new EqualHighLowEngine();
  const obTimes = new Map();
  const influences = new Map();
  return { update(bar) {
    const b = { ...bar, closed: true, closedAt: candleClose(bar, timeframe) };
    bars.push(b);
    const state = engine.update(b);
    for (const e of state.events.filter(e => e.time === b.time && e.status === 'CONFIRMED')) {
      const origin = e.side === 'BULLISH' ? state.low : state.high;
      if (origin && origin.time < e.time && !influences.has(origin.event_id)) influences.set(origin.event_id,
        { structure_event: e.event_id, structure_confirmed_at: e.confirmedAt,
          influence_range: Math.abs(origin.price - e.price), structure_price: e.price });
    }
    for (const item of ob.update(b, state.events)) if (!obTimes.has(item.event_id)) obTimes.set(item.event_id, b.closedAt);
    fvg.update(b); eq.update(b);
  }
  , snapshot(signalTime) {
  if (bars.length && bars.at(-1).closedAt > signalTime) throw new RangeError('Cursor cannot expose a future bar to a past snapshot');
  const state = engine.snapshot();
  const meta = { symbol, timeframe, status: 'CONFIRMED' };
  const swings = state.pivots.filter(p => p.status === 'CONFIRMED').map(p => ({ ...meta,
    kind: p.type === 'PIVOT_LOW' ? 'swing_low' : 'swing_high', price: p.price, time: p.time,
    id: p.event_id, confirmed_at: p.confirmedAt, ...(influences.get(p.event_id) ?? {}) }));
  if (state.weak?.status === 'CONFIRMED') swings.push({ ...meta,
    kind: state.trend === 'BULLISH' ? 'swing_high' : 'swing_low', price: state.weak.price,
    time: state.weak.time, id: stableId('weak', symbol, timeframe, state.weak.time, state.weak.price),
    confirmed_at: bars.at(-1).closedAt });
  const pd = computePremiumDiscount(state);
  const pdBoundary = pd ? { ...meta, id: pd.event_id, confirmed_at: bars.at(-1).closedAt,
    premiumTop: pd.premium.top, premiumBottom: pd.premium.bottom,
    discountTop: pd.discount.top, discountBottom: pd.discount.bottom } : null;
  // Only complete prior UTC periods wholly covered by this window are anchors.
  const prevDWM = [];
  const periodStart = (time, granularity) => {
    const d = new Date(time * 1000); d.setUTCHours(0, 0, 0, 0);
    if (granularity === 'W') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    if (granularity === 'M') d.setUTCDate(1);
    return d.getTime() / 1000;
  };
  for (const granularity of ['D', 'W', 'M']) {
    const end = periodStart(signalTime, granularity), start = periodStart(end - 1, granularity);
    const rows = bars.filter(b => b.time >= start && b.closedAt <= end);
    if (!rows.length || rows[0].time !== start || rows.at(-1).closedAt !== end ||
      rows.some((b, i) => i && b.time !== rows[i - 1].closedAt)) continue;
    for (const kind of ['high', 'low']) prevDWM.push({ ...meta, granularity, kind,
      price: (kind === 'high' ? Math.max : Math.min)(...rows.map(b => b[kind])),
      id: `${symbol}-${timeframe}-${granularity}-${start}-${kind}`, confirmed_at: end });
  }
  return { symbol, timeframe, signal_time: signalTime, swings, pdBoundary, prevDWM,
    obs: ob.snapshot().map(o => ({ ...meta, side: o.bias, top: o.barHigh, bottom: o.barLow,
      time: o.barTime, id: o.event_id, mitigated: o.mitigated, confirmed_at: obTimes.get(o.event_id) })),
    fvgs: fvg.snapshot().map(g => ({ ...meta, ...g, id: g.event_id, filled: g.mitigated,
      confirmed_at: bars.find(b => b.time === g.time).closedAt })),
    eqhEql: eq.snapshot().map(e => ({ ...meta, kind: e.type, price: e.price, time: e.timeTo,
      id: e.event_id, confirmed_at: e.confirmedAt })) };
  } };
}

export async function loadCachedSeries(input, timeframe) {
  const step = timeframeSeconds(timeframe);
  const raw = await readFile(input, 'utf8');
  const candles = raw.replace(/^\uFEFF/, '').split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch { throw new Error(`Invalid JSON at line ${i + 1}`); }
  });
  const symbol = candles[0]?.symbol ?? basename(input).match(/^(.+)-\d+[mhd]\.jsonl$/i)?.[1];
  if (!symbol || candles.length <= WARMUP) throw new Error('Need a symbol (row.symbol or SYMBOL-timeframe.jsonl) and more than 600 bars');
  const filenameTf = basename(input).match(/-(\d+[mhd])\.jsonl$/i)?.[1];
  if (filenameTf && filenameTf !== timeframe) throw new Error('Filename timeframe mismatch');
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || ![c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) ||
        c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close) ||
        c.closed === false || (c.symbol && c.symbol !== symbol) || (c.timeframe && c.timeframe !== timeframe) ||
        !Number.isFinite(candleClose(c, timeframe)) || candleClose(c, timeframe) > Date.now() / 1000 ||
        (i && (c.time - candles[i - 1].time !== step || candleClose(candles[i - 1], timeframe) > c.time))) {
      throw new Error(`Invalid, unclosed, mismatched or discontinuous candle at index ${i}`);
    }
  }
  return { raw, candles, symbol };
}
