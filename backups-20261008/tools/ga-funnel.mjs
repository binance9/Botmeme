// Offline audit. No imports from the live service and no network access.
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { higherCandles, firstTouch, createStructureCursor, loadCachedSeries } from './ga-replay.mjs';
import { runEngine } from '../services/ga-signal/engine/ga-engine.mjs';
import { atr, adx } from '../services/ga-signal/engine/indicators.mjs';
import { resolveLevels, buildStructures, candleClose, HIGHER_TIMEFRAME } from '../services/ga-signal/level-engine.mjs';
import { inspectLevels } from '../services/ga-signal/entry-state-machine.mjs';

export const DEFAULT_DIRECTORY = 'C:/GA_SIGNAL_LAB/data/klines';
export const OUTPUT_DIRECTORY = fileURLToPath(new URL('../data/ga-signal/', import.meta.url));
export const VARIANTS = ['A', 'B', 'C'];
export const WARMUP = 600;
const emptyGates = () => ({ bars: 0, prefixes: 0, triggers: 0, REFERENCE_REJECT: 0,
  NO_REFERENCE: 0, SL_INVALID: 0, NO_TARGET: 0, RR_LOW: 0, ACCEPTED: 0 });
export const seriesKey = x => `${x.symbol}|${x.timeframe}|${x.variant}`;
export const setupKey = x => `${x.symbol}|${x.timeframe}|${x.signal_time}|${x.side}`;
export async function cachedFiles(directory) {
  return (await readdir(directory)).filter(f => /^(BTCUSDT|ETHUSDT|SOLUSDT|PAXGUSDT)-(5m|15m)\.jsonl$/.test(f)).sort().map(f => resolve(directory, f));
}
export async function writeJSON(name, value) {
  const path = resolve(OUTPUT_DIRECTORY, name);
  await mkdir(dirname(path), { recursive: true });
  if (name === 'funnel.json') {
    const { skipped_full, ...report } = value;
    assert.equal(skipped_full.length, report.spacing_rule.skipped, 'Full skipped-trigger count must equal spacing skips');
    assert.equal(report.skipped_samples.count, skipped_full.length);
    await writeFile(resolve(OUTPUT_DIRECTORY, report.skipped_samples.skipped_full_file),
      skipped_full.map(record => JSON.stringify(record) + '\n').join(''));
    value = report;
  }
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}

// runEngine iterates causally and emits immutable events. Full-stream triggers equal
// the final-bar trigger of each prefix; explicit prefix checks guard this optimization.
export async function replayCachedFile(input, { onBar = () => {}, onTrigger = () => {}, deadline = Infinity } = {}) {
  const timeframe = basename(input).match(/-(\d+[mhd])\.jsonl$/)[1];
  const { raw, candles, symbol } = await loadCachedSeries(input, timeframe);
  const hash = createHash('sha256').update(raw).digest('hex');
  const higher = HIGHER_TIMEFRAME[timeframe], htf = higherCandles(candles, symbol, timeframe, higher);
  const cursor = createStructureCursor({ symbol, timeframe });
  const higherCursor = createStructureCursor({ symbol, timeframe: higher });
  const volatility = atr(candles, 14), strength = adx(candles, 14);
  const context = { input, input_sha256: hash, symbol, timeframe, candles, volatility, strength };
  const byTime = new Map();
  for (const variant of VARIANTS) {
    console.error(`START ${symbol} ${timeframe} ${variant}: ${candles.length} bars`);
    const args = { candles, symbol, timeframe, variant, params: { tick: .01, warmup: true, warmupBars: 500 } };
    const triggers = runEngine(args).events.filter(e => e.type === 'SETUP_CREATED' && e.time >= candles[WARMUP].time);
    for (const e of triggers) {
      if (!byTime.has(e.time)) byTime.set(e.time, []);
      byTime.get(e.time).push(e);
    }
    for (const e of [triggers[0], triggers[Math.floor(triggers.length / 2)], triggers.at(-1)].filter(Boolean)) {
      const prefix = candles.filter(c => c.time <= e.time);
      assert.deepEqual(runEngine({ ...args, candles: prefix }).events.find(x => x.type === 'SETUP_CREATED' && x.time === e.time), e);
    }
  }
  let h = 0, checks = 0, levelChecks = 0, triggerCount = 0, lastLog = Date.now();
  for (let i = 0; i < candles.length; i++) {
    if (Date.now() > deadline) throw new Error('COMPARISON_TIME_BUDGET');
    const c = candles[i], signalTime = candleClose(c, timeframe);
    cursor.update(c);
    while (h < htf.length && candleClose(htf[h], higher) <= signalTime) higherCursor.update(htf[h++]);
    if (i < WARMUP) continue;
    onBar({ ...context, index: i, candle: c, signalTime });
    const triggers = byTime.get(c.time) ?? [];
    if (triggers.length) {
      const structures = cursor.snapshot(signalTime), htfLevels = higherCursor.snapshot(signalTime);
      if (checks === 0 || i > candles.length - 300 && checks < 2) {
        const plain = JSON.parse(JSON.stringify(structures));
        for (const s of plain.swings) for (const k of ['structure_event', 'structure_confirmed_at', 'influence_range', 'structure_price']) delete s[k];
        assert.deepEqual(plain, buildStructures({ candles: candles.slice(0, i + 1), symbol, timeframe, signalTime }));
        const plainHigher = structuredClone(htfLevels);
        for (const s of plainHigher.swings) for (const k of ['structure_event', 'structure_confirmed_at', 'influence_range', 'structure_price']) delete s[k];
        assert.deepEqual(plainHigher, buildStructures({ candles: htf.slice(0, h), symbol, timeframe: higher, signalTime }));
        checks++;
      }
      for (const trigger of triggers) {
        const args = { direction: trigger.side, entry: trigger.setup.entry_ref, atr14: volatility[i], tick: .01,
          structures, htfLevels, params: { symbol, timeframe, signalTime } };
        const diagnostic = inspectLevels(args);
        // Same algorithm, memoized scores. Check every acceptance and regularly
        // spaced rejections against production, keeping the offline CPU bound finite.
        const verify = diagnostic.accepted || triggerCount++ % 64 === 0;
        const baseline = verify ? resolveLevels(args) : diagnostic;
        if (verify) {
          levelChecks++;
          assert.equal(diagnostic.accepted, baseline.accepted);
          assert.equal(diagnostic.reason, baseline.reason);
        }
        if (verify && baseline.accepted) {
          assert.deepEqual(diagnostic.sl, baseline.sl);
          assert.deepEqual(diagnostic.targets, baseline.targets);
          assert.deepEqual(diagnostic.rr, baseline.rr);
        }
        onTrigger({ ...context, index: i, signalTime, trigger, args, baseline, diagnostic });
      }
    }
    if (Date.now() - lastLog > 15000) {
      console.error(`PROGRESS ${symbol} ${timeframe}: ${i + 1}/${candles.length} bars (A/B/C shared structures)`);
      lastLog = Date.now();
    }
  }
  for (const variant of VARIANTS) console.error(`DONE ${symbol} ${timeframe} ${variant}`);
  return { symbol, timeframe, input, input_sha256: hash, bars: candles.length, prefixes: candles.length - WARMUP,
    first_candle: candles[0].time, last_candle: candles.at(-1).time, parity_checkpoints: checks, production_level_checks: levelChecks };
}

function sampleOf(x) {
  const { trigger: t, diagnostic: r } = x;
  return { symbol: x.symbol, timeframe: x.timeframe, variant: t.variant, side: t.side,
    signal_time: t.time, signal_close_time: x.signalTime, trigger_time: t.time, trigger_price: t.setup.entry_ref,
    entry: t.setup.entry_ref, entry_ref: t.setup.entry_ref, candle_index: x.index, setup_id: t.setup_id, atr: x.args.atr14,
    anchor_confirmed_at: r.reference?.confirmed_at ?? null, ...r,
    nearest_obstacle: r.nearest_obstacle ? { price: r.nearest_obstacle.price, type: r.nearest_obstacle.source_type,
      distance: Math.abs(r.nearest_obstacle.price-t.setup.entry_ref), distance_atr: Math.abs(r.nearest_obstacle.price-t.setup.entry_ref)/x.args.atr14,
      confirmed_at: r.nearest_obstacle.confirmed_at } : null,
    sl: r.sl ? { ...r.sl, confirmed_at: [...(x.args.structures.swings??[]),...(x.args.structures.obs??[]),...(x.args.structures.fvgs??[]),...(x.args.structures.eqhEql??[]),...(x.args.structures.prevDWM??[]),x.args.structures.pdBoundary].find(s=>s?.id===r.sl.anchor_id)?.confirmed_at??null } : null,
    tp_candidates: r.tp_candidates?.map(t=>({price:t.price, type:t.source_type, timeframe:t.timeframe, rr:t.rr, anchor_id:t.anchor_id, confirmed_at:t.confirmed_at})),
    ...(r.accepted ? { ...firstTouch(x.candles,x.index,t.side,r,x.timeframe),
      levels_answer_why: { tp1_reason:r.targets[0].reason,sl_reason:r.sl.reason } } : {}) };
}
export function createFunnel() {
  const per = new Map(), skipped = [], skippedFull = [], strata = new Map(), accepted = [], spacedAccepted = [];
  const rank = x => createHash('sha256').update(`TRIAL-004|${seriesKey(x)}|${x.side}|${x.signal_time ?? x.time}`).digest('hex');
  const ensure = x => {
    const key = seriesKey(x);
    if (!per.has(key)) per.set(key, { symbol: x.symbol, timeframe: x.timeframe, variant: x.variant,
      ...emptyGates(), spacing: { evaluated: 0, skipped: 0, ...emptyGates() }, last: null });
    return per.get(key);
  };
  const count = (g, r) => { g.triggers++; g[r.accepted ? 'ACCEPTED' : r.reason]++;
    if (r.reason === 'NO_REFERENCE') g.REFERENCE_REJECT++; };
  return {
    onTrigger(x) {
      const t = x.trigger, row = ensure({ ...x, variant: t.variant });
      const r = sampleOf(x); count(row, x.baseline);
      if (x.baseline.reason === 'RR_LOW') {
        const key = `${seriesKey(r)}|${r.side}`;
        if (!strata.has(key)) strata.set(key,{count:0,samples:[]});
        const bucket=strata.get(key); bucket.count++;
        bucket.samples.push({sample:r,rank:rank(r)});bucket.samples.sort((a,b)=>a.rank.localeCompare(b.rank));bucket.samples.splice(2);
      }
      if (x.baseline.accepted) accepted.push(r);
      if (row.last && x.index - row.last.index < 50) {
        row.spacing.skipped++;
        skipped.push({ symbol: x.symbol, timeframe: x.timeframe, variant: t.variant, side: t.side,
          time: t.time, price: t.setup.entry_ref, preceding_evaluated_trigger: row.last });
        skippedFull.push({ series: seriesKey(row), symbol: x.symbol, timeframe: x.timeframe, variant: t.variant,
          time: t.time, price: t.setup.entry_ref, reason: 'SPACING_50',
          preceding_evaluated_outcome: row.last.accepted ? 'ACCEPTED' : row.last.reason === 'RR_LOW' ? 'RR_LOW' : 'none',
          bars_since_previous_evaluated_trigger: x.index - row.last.index });
      } else {
        count(row.spacing, x.baseline); row.spacing.evaluated++;
        row.last = { index: x.index, time: t.time, price: t.setup.entry_ref,
          accepted: x.baseline.accepted, reason: x.baseline.reason ?? 'ACCEPTED' };
        if (x.baseline.accepted) spacedAccepted.push(r);
      }
    },
    finishFile(info) {
      for (const variant of VARIANTS) {
        const row = ensure({ ...info, variant });
        Object.assign(row, { bars: info.bars, prefixes: info.prefixes, input_sha256: info.input_sha256 });
        row.spacing.bars = info.bars; row.spacing.prefixes = info.prefixes;
      }
    },
    report() {
      const per_series = [...per.values()].map(({ last, ...r }) => r);
      const global = emptyGates(), spacing = { evaluated: 0, skipped: 0, ...emptyGates() };
      for (const row of per_series) {
        for (const k of Object.keys(global)) global[k] += row[k];
        for (const k of Object.keys(spacing)) spacing[k] += row.spacing[k];
      }
      assert.equal(skippedFull.length, spacing.skipped, 'Full skipped-trigger count must equal spacing skips');
      const stratified = [...strata.values()].flatMap(b => b.samples.map(x=>x.sample));
      const allStrata = [];
      for (const symbol of ['BTCUSDT','ETHUSDT','SOLUSDT','PAXGUSDT']) for (const timeframe of ['5m','15m'])
        for (const variant of VARIANTS) for (const side of ['LONG','SHORT']) {
          const key = `${symbol}|${timeframe}|${variant}|${side}`;
          allStrata.push({ symbol, timeframe, variant, side, available: strata.get(key)?.count ?? 0 });
        }
      return { schema_version: 1, view: 'ALL triggers; spacing DISABLED', per_series, global, spacing_rule: spacing,
        sampling: { seed: 'TRIAL-004', skipped: 'first 200 + hash-random 200 from remaining', rr_low: 'up to two per nonempty symbol/timeframe/variant/side stratum', strata: allStrata },
        skipped_samples: { skipped_full_file: 'skipped-triggers.jsonl', count: skippedFull.length },
        skipped_full: skippedFull,
        skipped_all: skipped,
        rr_low_samples: stratified, accepted_receipts: accepted, spacing_accepted_receipts: spacedAccepted };
    },
  };
}

export function mergeFunnels(funnels) {
  const result=structuredClone(funnels[0]);
  for(const f of funnels.slice(1)) {
    result.per_series.push(...f.per_series);
    for(const k of Object.keys(result.global)) result.global[k]+=f.global[k];
    for(const k of Object.keys(result.spacing_rule)) result.spacing_rule[k]+=f.spacing_rule[k];
    for(const k of ['skipped_all','skipped_full','rr_low_samples','accepted_receipts','spacing_accepted_receipts']) result[k].push(...f[k]);
    for(const s of f.sampling.strata) result.sampling.strata.find(t=>seriesKey(t)===seriesKey(s)&&t.side===s.side).available+=s.available;
  }
  assert.equal(result.skipped_full.length, result.spacing_rule.skipped, 'Full skipped-trigger count must equal spacing skips');
  result.skipped_samples = { skipped_full_file: 'skipped-triggers.jsonl', count: result.skipped_full.length };
  return result;
}

async function main() {
  const directory = resolve(process.argv[2] ?? DEFAULT_DIRECTORY), funnels = [];
  const files = await cachedFiles(directory);
  if (files.length !== 8) throw new Error(`Expected 8 cached files / 24 variant series; found ${files.length}`);
  for (const file of files) {
    const funnel = createFunnel();
    funnel.finishFile(await replayCachedFile(file, { onTrigger: funnel.onTrigger }));
    funnels.push(funnel.report());
  }
  const report = mergeFunnels(funnels); report.scope = 'All 24 series'; report.input_directory = directory;
  await writeJSON('funnel.json', report);
  console.table([report.global, report.spacing_rule]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exitCode = 1; });
