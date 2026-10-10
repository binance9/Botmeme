'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const depth = require('./v4-depth.cjs');
const { DEFAULT_POLICY: riskPolicy } = require('../../risk/engine.cjs');
const robinhood = require('../../../wallet/network/robinhood.cjs');
const RPC = robinhood.descriptor.balance.rpc;
const MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const POOLS_SLOT = 6n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const MASK64 = (1n << 64n) - 1n;
const rotl = (value, bits) => bits === 0 ? value : ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & MASK64;
function keccak256(input) {
  const rate = 136, state = Array.from({ length: 25 }, () => 0n), data = Buffer.from(input);
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / rate) * rate);
  data.copy(padded); padded[data.length] = 0x01; padded[padded.length - 1] |= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) state[i] = (state[i] ^ padded.readBigUInt64LE(off + i * 8)) & MASK64;
    const c = Array(5).fill(0n);
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      const d = c.map((_, x) => c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1));
      for (let i = 0; i < 25; i++) state[i] = (state[i] ^ d[i % 5]) & MASK64;
      const b = Array(25).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROT[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        state[i] = (b[i] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y])) & MASK64;
      }
      state[0] = (state[0] ^ RC[round]) & MASK64;
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], i * 8);
  return out;
}
if (keccak256(Buffer.alloc(0)).toString('hex') !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') throw Error('ROBINHOOD_POOL_HASH');
const selector = name => keccak256(Buffer.from(name)).subarray(0, 4).toString('hex');
const EXTSLOAD = selector('extsload(bytes32)'), GET_RESERVES = selector('getReserves()'), TOKEN0 = selector('token0()'), TOKEN1 = selector('token1()'), DECIMALS = selector('decimals()');
const INIT_TOPIC = '0x' + keccak256(Buffer.from('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')).toString('hex');
const SWAP_TOPIC = '0x' + keccak256(Buffer.from('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')).toString('hex');
const MODIFY_TOPIC = '0x' + keccak256(Buffer.from('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)')).toString('hex');
if (SWAP_TOPIC !== '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f') throw Error('ROBINHOOD_POOL_SWAP_TOPIC');
const NATIVE = '0x0000000000000000000000000000000000000000';
const SLIPPAGE_BPS = riskPolicy.slippageBps;
const word = value => Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex');
const addressWord = value => Buffer.concat([Buffer.alloc(12), Buffer.from(value.slice(2), 'hex')]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function createRobinhoodPool({ now = () => new Date(), evidenceDirectory, fetcher = fetch } = {}) {
  if (typeof now !== 'function' || typeof evidenceDirectory !== 'string' || !path.isAbsolute(evidenceDirectory) || typeof fetcher !== 'function') throw Error('INVALID_ROBINHOOD_POOL');
  const directory = path.resolve(evidenceDirectory);
  fs.mkdirSync(directory, { recursive: true });
  let requests = 0;
  function remember(name, bytes) {
    const target = path.join(directory, name);
    try { fs.writeFileSync(target, bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || !fs.readFileSync(target).equals(Buffer.from(bytes))) throw Error('ROBINHOOD_POOL_EVIDENCE_WRITE_FAILED'); }
  }
  async function ethUsd(signal) {
    const url = 'https://api.exchange.coinbase.com/products/ETH-USD/trades?limit=1';
    const response = await fetcher(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal });
    if (!response?.ok) return null;
    const body = await response.json();
    const trade = Array.isArray(body) ? body[0] : null;
    const price = Number(trade?.price), time = Date.parse(trade?.time);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time) || Math.abs(Date.now() - time) > 60000) return null;
    return { price, time: new Date(time).toISOString(), raw: body };
  }
  async function batch(calls, signal) {
    requests += 1;
    const response = await fetcher(RPC, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls), signal });
    if (!response?.ok) return null;
    const body = await response.json();
    return Array.isArray(body) ? body : null;
  }
  async function rpc(method, params, signal) {
    requests += 1;
    const response = await fetcher(RPC, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal });
    if (!response?.ok) return null;
    const body = await response.json();
    return body && !body.error ? body.result : null;
  }
  const indexFile = path.join(directory, 'v4-index.json');
  function loadIndex() {
    try {
      const saved = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (saved && saved.pools && typeof saved.pools === 'object') return saved;
    } catch {}
    return { cursor: null, pools: {} };
  }
  function saveIndex(index) {
    const next = indexFile + '.tmp';
    fs.writeFileSync(next, JSON.stringify(index));
    fs.renameSync(next, indexFile);
  }
  function decodeInit(log) {
    if (!log || !Array.isArray(log.topics) || log.topics.length < 4 || typeof log.data !== 'string' || typeof log.blockNumber !== 'string') return null;
    const words = log.data.slice(2).match(/.{64}/g);
    if (!words || words.length < 3) return null;
    const currency0 = '0x' + log.topics[2].slice(-40);
    const currency1 = '0x' + log.topics[3].slice(-40);
    const nativeSide = currency0 === NATIVE ? 0 : currency1 === NATIVE ? 1 : -1;
    return {
      poolAddress: log.topics[1].toLowerCase(),
      token: nativeSide === 0 ? currency1 : nativeSide === 1 ? currency0 : currency1,
      quoteToken: nativeSide === -1 ? currency0 : NATIVE,
      fee: Number(BigInt('0x' + words[0])),
      spacing: Number(BigInt.asIntN(24, BigInt('0x' + words[1]))),
      hooks: '0x' + words[2].slice(-40),
      block: Number(BigInt(log.blockNumber))
    };
  }
  function v4Slot(poolId) {
    return '0x' + keccak256(Buffer.concat([Buffer.from(poolId.slice(2), 'hex'), word(POOLS_SLOT)])).toString('hex');
  }
  function poolKey(quote, token, fee, spacing, hooks) {
    const encoded = Buffer.concat([addressWord(quote), addressWord(token), word(fee), word(spacing), addressWord(hooks)]);
    return '0x' + keccak256(encoded).toString('hex');
  }
  function findSpacing(poolId, token, quote, fee, hooks, hinted) {
    const hook = /^0x[0-9a-f]{40}$/.test(hooks || '') ? hooks : NATIVE;
    const matches = spacing => poolKey(quote, token, fee, spacing, hook) === poolId;
    const candidates = [hinted, 1, 10, 25, 50, 60, 100, 200];
    if (Number.isInteger(fee) && fee > 0 && fee % 100 === 0) candidates.push(fee / 100);
    for (const spacing of candidates) if (Number.isInteger(spacing) && spacing > 0 && spacing <= 100000 && matches(spacing)) return spacing;
    return null;
  }
  function units(value, decimals) {
    const text = value.toString().padStart(decimals + 1, '0');
    return Number(text.slice(0, text.length - decimals) + '.' + text.slice(text.length - decimals, text.length - decimals + 8));
  }
  function mapSlot(base, key) {
    let encoded = BigInt(key);
    if (encoded < 0n) encoded = (1n << 256n) + encoded;
    return '0x' + keccak256(Buffer.concat([word(encoded), word(base)])).toString('hex');
  }
  function compressedTick(tick, spacing) {
    let compressed = Math.trunc(tick / spacing);
    if (tick < 0 && tick % spacing !== 0) compressed -= 1;
    return compressed;
  }
  return {
    get requests() { return requests; },
    async quoteMany(entries, { signal } = {}) {
      const clock = now();
      if (!(clock instanceof Date) || !Number.isFinite(clock.getTime()) || !Array.isArray(entries) || !entries.length) return [];
      const unique = [];
      const pools = new Set();
      for (const entry of entries) {
        const pool = String(entry?.poolAddress || '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(pool) && !/^0x[0-9a-f]{64}$/.test(pool)) continue;
        if (pools.has(pool)) continue;
        pools.add(pool);
        unique.push({ ...entry, poolAddress: pool, token: String(entry.token || '').toLowerCase() });
      }
      if (!unique.length) return [];
      let quote;
      try { quote = await ethUsd(signal); } catch { return []; }
      if (!quote || signal?.aborted) return [];
      let gasPriceWei = null, gasPerTxUsd = null;
      try {
        const hex = await rpc('eth_gasPrice', [], signal);
        if (typeof hex === 'string') gasPriceWei = hex;
      } catch { /* gas stays unobserved; fee and impact still price the order */ }
      if (signal?.aborted) return [];
      const samples = [];
      function observedGasUsd(block) {
        const txs = block?.transactions;
        if (!gasPriceWei || !Array.isArray(txs) || !txs.length || typeof block.gasUsed !== 'string') return null;
        let used, price;
        try { used = BigInt(block.gasUsed); price = BigInt(gasPriceWei); } catch { return null; }
        if (used <= 0n || price <= 0n) return null;
        const wei = (used / BigInt(txs.length)) * price;
        const usd = Number(wei / 10n ** 12n) / 1e6 * quote.price;
        return Number.isFinite(usd) && usd >= 0 ? usd : null;
      }
      function bitmapTicks(raw, wordPos, spacing) {
        if (!raw || raw === '0x') return [];
        const bits = BigInt(raw), ticks = [];
        for (let bit = 0; bit < 256; bit++) if ((bits >> BigInt(bit)) & 1n) ticks.push(((wordPos << 8) + bit) * spacing);
        return ticks;
      }
      for (let offset = 0; offset < unique.length; offset += 4) {
      await new Promise(resolve => setImmediate(resolve));
      if (signal?.aborted) return samples;
      const slice = unique.slice(offset, offset + 4);
      const calls = [{ jsonrpc: '2.0', id: 'block', method: 'eth_getBlockByNumber', params: ['latest', false] }];
      for (const entry of slice) {
        if (entry.poolAddress.length === 66) {
          const slot = v4Slot(entry.poolAddress);
          calls.push({ jsonrpc: '2.0', id: entry.poolAddress + ':slot0', method: 'eth_call', params: [{ to: MANAGER, data: '0x' + EXTSLOAD + slot.slice(2) }, 'latest'] });
          const liquiditySlot = '0x' + (BigInt(slot) + 3n).toString(16).padStart(64, '0');
          calls.push({ jsonrpc: '2.0', id: entry.poolAddress + ':liq', method: 'eth_call', params: [{ to: MANAGER, data: '0x' + EXTSLOAD + liquiditySlot.slice(2) }, 'latest'] });
        } else {
          calls.push({ jsonrpc: '2.0', id: entry.poolAddress + ':reserves', method: 'eth_call', params: [{ to: entry.poolAddress, data: '0x' + GET_RESERVES }, 'latest'] });
          calls.push({ jsonrpc: '2.0', id: entry.poolAddress + ':token0', method: 'eth_call', params: [{ to: entry.poolAddress, data: '0x' + TOKEN0 }, 'latest'] });
          calls.push({ jsonrpc: '2.0', id: entry.poolAddress + ':token1', method: 'eth_call', params: [{ to: entry.poolAddress, data: '0x' + TOKEN1 }, 'latest'] });
          calls.push({ jsonrpc: '2.0', id: entry.poolAddress + ':dec0', method: 'eth_call', params: [{ to: entry.token, data: '0x' + DECIMALS }, 'latest'] });
        }
      }
      let rows;
      try { rows = await batch(calls, signal); } catch { if (signal?.aborted) return samples; continue; }
      if (!rows) continue;
      const byId = new Map(rows.filter(row => row && row.id !== undefined && typeof row.result === 'string').map(row => [row.id, row.result]));
      let blockNumber = null;
      const blockRow = rows.find(row => row && row.id === 'block' && row.result && typeof row.result === 'object');
      if (blockRow?.result?.number) blockNumber = Number.parseInt(blockRow.result.number, 16);
      let observedAt = clock.toISOString();
      if (gasPerTxUsd === null) gasPerTxUsd = observedGasUsd(blockRow?.result);
      if (blockRow?.result?.timestamp) {
        const stamp = new Date(Number(BigInt(blockRow.result.timestamp)) * 1000);
        if (Number.isFinite(stamp.getTime()) && stamp.getTime() <= clock.getTime()) observedAt = stamp.toISOString();
      }
      const receivedAt = observedAt;
      const payload = Buffer.from(JSON.stringify({ rpc: RPC, receivedAt, blockNumber, results: rows }));
      const bodyHash = hash(payload);
      const receipt = Buffer.from(JSON.stringify({ url: RPC, network: 'ROBINHOOD', receivedAt, bodyHash, blockNumber }));
      const receiptHash = hash(receipt);
      remember(bodyHash + '.body.json', payload); remember(receiptHash + '.receipt.json', receipt);
      const evidence = ['robinhood.rpc/' + bodyHash, 'robinhood.receipt/' + receiptHash];
      const curveCalls = [];
      const curveMeta = new Map();
      for (const entry of slice) {
        if (entry.poolAddress.length !== 66) continue;
        const slot0 = byId.get(entry.poolAddress + ':slot0'), liquidityWord = byId.get(entry.poolAddress + ':liq');
        if (!slot0 || !liquidityWord || slot0 === '0x' || liquidityWord === '0x') continue;
        const liquidity = BigInt(liquidityWord) & ((1n << 128n) - 1n);
        if (liquidity === 0n) continue;
        const packed = BigInt(slot0), fee = Number((packed >> 208n) & 0xFFFFFFn);
        const quoteToken = /^0x[0-9a-f]{40}$/.test(entry.quoteToken || '') ? entry.quoteToken.toLowerCase() : NATIVE;
        if (!/^0x[0-9a-f]{40}$/.test(entry.token) || quoteToken !== NATIVE) continue;
        const spacing = findSpacing(entry.poolAddress, entry.token, quoteToken, fee, entry.hooks, entry.spacing);
        if (!spacing) continue;
        let tick = Number((packed >> 160n) & 0xFFFFFFn);
        if (tick >= 0x800000) tick -= 0x1000000;
        const wordPos = compressedTick(tick, spacing) >> 8;
        const slot = v4Slot(entry.poolAddress);
        curveMeta.set(entry.poolAddress, { wordPos, slot, spacing, tick });
        const bitmapBase = BigInt(slot) + 5n;
        for (const pos of [wordPos - 1, wordPos, wordPos + 1]) curveCalls.push({ jsonrpc: '2.0', id: entry.poolAddress + ':' + pos, method: 'eth_call', params: [{ to: MANAGER, data: '0x' + EXTSLOAD + mapSlot(bitmapBase, pos).slice(2) }, 'latest'] });
      }
      let curveById = new Map();
      if (curveCalls.length) {
        let curveRows = null;
        try { curveRows = await batch(curveCalls, signal); } catch { if (signal?.aborted) return samples; curveRows = null; }
        if (!curveRows) curveById = null;
        else curveById = new Map(curveRows.filter(row => row && typeof row.result === 'string').map(row => [row.id, row.result]));
      }
      const tickCalls = [];
      const nearByPool = new Map();
      if (curveById) for (const [pool, meta] of curveMeta) {
        const found = [meta.wordPos - 1, meta.wordPos, meta.wordPos + 1].flatMap(pos => bitmapTicks(curveById.get(pool + ':' + pos), pos, meta.spacing));
        const near = found.filter(value => value < meta.tick && meta.tick - value <= 40000).sort((a, b) => b - a).slice(0, 4);
        nearByPool.set(pool, near);
        const tickBase = BigInt(meta.slot) + 4n;
        for (const value of near) tickCalls.push({ jsonrpc: '2.0', id: pool + ':' + value, method: 'eth_call', params: [{ to: MANAGER, data: '0x' + EXTSLOAD + mapSlot(tickBase, value).slice(2) }, 'latest'] });
      }
      let tickById = new Map();
      if (tickCalls.length) {
        let tickRows = null;
        try { tickRows = await batch(tickCalls, signal); } catch { if (signal?.aborted) return samples; tickRows = null; }
        if (!tickRows) tickById = null;
        else tickById = new Map(tickRows.filter(row => row && typeof row.result === 'string').map(row => [row.id, row.result]));
      }
      for (const entry of slice) {
        const age = Number.isFinite(entry.born) ? clock.getTime() - entry.born : null;
        const extended = Number.isSafeInteger(age) && age >= 0 && age <= 3600000 && Number.isFinite(entry.marketCapUsd) && entry.marketCapUsd >= 0 && entry.marketCapUsd <= 100000 && Number.isFinite(entry.realVolumeUsd) && entry.realVolumeUsd >= 0 && Number.isFinite(entry.volume24hUsd) && entry.volume24hUsd >= 0;
        if (entry.poolAddress.length === 66) {
          const slot0 = byId.get(entry.poolAddress + ':slot0'), liquidityWord = byId.get(entry.poolAddress + ':liq');
          if (!slot0 || !liquidityWord || slot0 === '0x' || liquidityWord === '0x') continue;
          const packed = BigInt(slot0), sqrt = packed & ((1n << 160n) - 1n), fee = Number((packed >> 208n) & 0xFFFFFFn);
          const quoteToken = /^0x[0-9a-f]{40}$/.test(entry.quoteToken || '') ? entry.quoteToken.toLowerCase() : NATIVE;
          const token = entry.token;
          const hooks = /^0x[0-9a-f]{40}$/.test(entry.hooks || '') ? entry.hooks.toLowerCase() : NATIVE;
          if (!/^0x[0-9a-f]{40}$/.test(token) || quoteToken !== NATIVE) continue;
          const ratio = depth.priceFromSqrt(sqrt);
          const price = ratio === null ? null : quote.price / ratio;
          const liquidity = BigInt(liquidityWord) & ((1n << 128n) - 1n);
          if (price === null || !Number.isFinite(price) || price <= 0) continue;
          let tick = Number((packed >> 160n) & 0xFFFFFFn);
          if (tick >= 0x800000) tick -= 0x1000000;
          const state = RPC + '#v4/' + entry.poolAddress + '/block/' + (blockNumber === null ? 'unknown' : blockNumber) + '/state/' + sqrt.toString(16) + 'x' + liquidity.toString(16);
          if (hooks !== NATIVE) {
            const hooked = { token: entry.token, price, liquidityUsd: 0, executableDepthUsd: 0, priceImpactBps: 0, ...(gasPerTxUsd === null ? {} : { gasUsd: gasPerTxUsd }), volume24hUsd: extended ? entry.volume24hUsd : 0, observedAt, source: state + '/hook', evidence: [...new Set([...evidence, ...(entry.evidence || [])])], confidence: .8, evidence_quality: .8, missing_evidence: ['UNSUPPORTED_HOOK'], uncertainty: .2 };
            if (extended) Object.assign(hooked, { poolAgeMs: age, marketCapUsd: entry.marketCapUsd, realVolumeUsd: entry.realVolumeUsd });
            samples.push(hooked);
            continue;
          }
          const spacing = findSpacing(entry.poolAddress, token, quoteToken, fee, hooks, entry.spacing);
          if (!spacing) continue;
          let ticks = [];
          if (liquidity > 0n) {
            if (curveById === null || (nearByPool.get(entry.poolAddress) || []).length && tickById === null) continue;
            ticks = (nearByPool.get(entry.poolAddress) || []).map(value => {
              const raw = tickById.get(entry.poolAddress + ':' + value);
              if (!raw || raw === '0x') return null;
              let net = (BigInt(raw) >> 128n) & ((1n << 128n) - 1n);
              if (net >= 1n << 127n) net -= 1n << 128n;
              return { tick: value, liquidityNet: net };
            }).filter(Boolean);
          }
          const measured = depth.executableDepth({ sqrt, tick, liquidity, fee, ethUsd: quote.price, ticks, slippageBps: SLIPPAGE_BPS });
          if (!measured || !Number.isFinite(measured.executableDepthUsd) || measured.executableDepthUsd < 0 || !Number.isFinite(measured.priceImpactBps)) continue;
          const sample = { token: entry.token, price, liquidityUsd: 0, executableDepthUsd: measured.executableDepthUsd, priceImpactBps: measured.priceImpactBps, ...(gasPerTxUsd === null ? {} : { gasUsd: gasPerTxUsd }), volume24hUsd: extended ? entry.volume24hUsd : 0, observedAt, source: state, evidence: [...new Set([...evidence, ...(entry.evidence || [])])], confidence: .8, evidence_quality: .8, missing_evidence: [], uncertainty: .2 };
          if (extended) Object.assign(sample, { poolAgeMs: age, marketCapUsd: entry.marketCapUsd, realVolumeUsd: entry.realVolumeUsd });
          samples.push(sample);
        } else {
          const reserves = byId.get(entry.poolAddress + ':reserves'), token0 = byId.get(entry.poolAddress + ':token0'), token1 = byId.get(entry.poolAddress + ':token1');
          if (!reserves || !token0 || !token1 || reserves.length < 2 + 64 * 3) continue;
          const reserve0 = BigInt('0x' + reserves.slice(2, 66)), reserve1 = BigInt('0x' + reserves.slice(66, 130));
          const side0 = '0x' + token0.slice(-40), side1 = '0x' + token1.slice(-40);
          const quoteToken = String(entry.quoteToken || '').toLowerCase();
          const base = entry.token;
          if (quoteToken !== side0 && quoteToken !== side1) continue;
          if (base !== side0 && base !== side1) continue;
          if (String(entry.quoteNative) !== '1' && String(entry.quoteNative) !== '1.0') continue;
          const baseReserve = base === side0 ? reserve0 : reserve1;
          const quoteReserve = quoteToken === side0 ? reserve0 : reserve1;
          const decWord = byId.get(entry.poolAddress + ':dec0');
          const baseDecimals = decWord && decWord !== '0x' ? Number(BigInt(decWord)) : null;
          if (baseReserve <= 0n || quoteReserve <= 0n || !Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 30) continue;
          const price = units(quoteReserve, 18) / units(baseReserve, baseDecimals) * quote.price;
          const liquidityUsd = units(quoteReserve, 18) * quote.price * 2;
          if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(liquidityUsd) || liquidityUsd < 0) continue;
          const sample = { token: entry.token, price, liquidityUsd, volume24hUsd: extended ? entry.volume24hUsd : 0, observedAt, source: RPC + '#v2/' + entry.poolAddress + '/block/' + (blockNumber === null ? 'unknown' : blockNumber) + '/state/' + reserve0.toString(16) + 'x' + reserve1.toString(16), evidence: [...new Set([...evidence, ...(entry.evidence || [])])], confidence: .8, evidence_quality: .8, missing_evidence: [], uncertainty: .2 };
          if (extended) Object.assign(sample, { poolAgeMs: age, marketCapUsd: entry.marketCapUsd, realVolumeUsd: entry.realVolumeUsd });
          samples.push(sample);
        }
      }
      }
      return samples;
    },
    async discoverPools({ signal } = {}) {
      const latestHex = await rpc('eth_blockNumber', [], signal);
      if (typeof latestHex !== 'string') throw Error('ROBINHOOD_RPC_UNAVAILABLE');
      const latest = BigInt(latestHex);
      const index = loadIndex();
      const from = index.cursor == null ? (latest > 20000n ? latest - 20000n : 0n) : (BigInt(index.cursor) > 800n ? BigInt(index.cursor) - 800n : 0n);
      let logs = await rpc('eth_getLogs', [{ address: MANAGER, topics: [INIT_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + latest.toString(16) }], signal);
      if (!Array.isArray(logs)) logs = [];
      const activityFrom = latest > 800n ? latest - 800n : 0n;
      const activity = await rpc('eth_getLogs', [{ address: MANAGER, topics: [[SWAP_TOPIC, MODIFY_TOPIC]], fromBlock: '0x' + activityFrom.toString(16), toBlock: '0x' + latest.toString(16) }], signal);
      const active = new Set(Array.isArray(activity) ? activity.map(log => String(log.topics?.[1] || '').toLowerCase()).filter(id => /^0x[0-9a-f]{64}$/.test(id)) : []);
      for (const log of logs) {
        const row = decodeInit(log);
        if (row) index.pools[row.poolAddress] = { ...index.pools[row.poolAddress], ...row };
      }
      const missing = [...active].filter(id => !index.pools[id]).slice(0, 12);
      if (missing.length) {
        const lookback = latest > 400000n ? latest - 400000n : 0n;
        const older = await rpc('eth_getLogs', [{ address: MANAGER, topics: [INIT_TOPIC, missing], fromBlock: '0x' + lookback.toString(16), toBlock: '0x' + latest.toString(16) }], signal);
        if (Array.isArray(older)) for (const log of older) {
          const row = decodeInit(log);
          if (row) index.pools[row.poolAddress] = { ...index.pools[row.poolAddress], ...row };
        }
      }
      const needTime = Object.values(index.pools).filter(row => !Number.isFinite(row.born) && Number.isInteger(row.block)).slice(0, 8);
      if (needTime.length) {
        const blocks = await batch(needTime.map(row => ({ jsonrpc: '2.0', id: row.poolAddress, method: 'eth_getBlockByNumber', params: ['0x' + row.block.toString(16), false] })), signal);
        if (Array.isArray(blocks)) for (const row of blocks) {
          const stamp = row?.result?.timestamp ? Number(BigInt(row.result.timestamp)) * 1000 : null;
          if (index.pools[row.id] && Number.isFinite(stamp)) index.pools[row.id].born = stamp;
        }
      }
      index.cursor = latest.toString();
      saveIndex(index);
      const floor = Number(latest > 20000n ? latest - 20000n : 0n);
      const ranked = Object.values(index.pools).filter(row => active.has(row.poolAddress) || row.block >= floor);
      ranked.sort((a, b) => Number(active.has(b.poolAddress)) - Number(active.has(a.poolAddress)) || b.block - a.block);
      return ranked.slice(0, 40).filter(row => /^0x[0-9a-f]{40}$/.test(row.token)).map(row => ({ token: row.token, poolAddress: row.poolAddress, quoteToken: row.quoteToken, quoteNative: row.quoteToken === NATIVE ? '1.0' : null, fee: row.fee, spacing: row.spacing, hooks: row.hooks, born: Number.isFinite(row.born) ? row.born : null }));
    }
  };
}
module.exports = { createRobinhoodPool };
