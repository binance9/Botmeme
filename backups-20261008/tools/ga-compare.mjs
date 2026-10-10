import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedFiles, replayCachedFile, createFunnel, mergeFunnels, writeJSON, DEFAULT_DIRECTORY, OUTPUT_DIRECTORY, setupKey } from './ga-funnel.mjs';
import { transition, POLICIES } from '../services/ga-signal/entry-state-machine.mjs';
import { candleClose } from '../services/ga-signal/level-engine.mjs';

export const SPLIT = Date.parse('2026-09-01T00:00:00Z') / 1000;
export const REPORT_METHOD = [
      'Causal engine event streams, with first/middle/last trigger prefix equality checks per variant. Incremental production SMC engines checked against buildStructures. Offline interval-overlap scoring is algebraically equivalent to production; parity checked for every acceptance and every 64th rejection, plus randomized fixture tests.',
      'Baseline spacing is the replay contract’s 50 bars, independently per variant, including rejected evaluated triggers. Funnel evaluates all triggers. Baseline scanner source itself contains no separate 50-bar gate and is untouched.',
      'Trial slots are shared across A/B/C per symbol/timeframe/direction; simultaneous triggers use A, B, C order. Bars advance existing slots before new triggers arm. No spacing in trial policies.',
      'Significance: EXTERNAL/HTF overrides named structural categories; origin swing = latest confirmed opposite-side pivot at a BOS/CHoCH, influence = distance to its broken price. First confirmed link is frozen. Broken-level pivots without origin evidence remain internal.',
      'Targets and SL freeze at arm. Confirmation cannot replace a now-too-close TP1. SHADOW-FAR alone may skip frozen TP1 to frozen TP2 when RR becomes >=1. Internal obstacles cap reported net-of-internal RR, but the contractual RR acceptance gate uses TP1.',
      'Retest requires low/high inside the zone, inclusive; confirmation requires that touching candle close strictly on trend side. Timeout counts closed bars after arm; a timely retest stops the no-retest timer.',
      'IS/OOS assigned at entry; IS residual positions are marked at split (no OOS exits in IS). Armed slots reset at split. Trigger engine uses continuous causal history, with no OOS recalibration. Costs are charged on all marked exits.',
      'Staged exits: 50/30/20; last available target liquidates residual (one target=100%; two=50/50%). Unfilled targets plus SL in one candle choose SL. Fee 0.1% and slippage 0.05% on entry and weighted exit notional. Open-at-end residual marked to last close; censored counts disclosed.',
      'Deduplication key symbol|timeframe|signal_time|direction excludes variant; canonical variant is A then B then C. Aggregate unique counts can be smaller than summed per-variant counts. RR_LOW denominator=entry decisions; EXPIRED denominator=arms, grouped by arm regime. Regime for other pre-entry gates is ADX14 at that event, for trades at entry.',
      'Frequency uses actual first/last accepted entry timestamps per symbol/timeframe within each requested group. Single-timestamp series are undefined, excluded from aggregate frequency numerator and exposure. Aggregate frequency = defined unique setups / summed series signal-weeks.',
      'Drawdown uses closed/marked net R sorted by exit time, fixed one initial risk unit per setup, no capital concurrency model. MFE/MAE use full candle extrema through exit candle; intrabar chronology is unknown.',
      '95% percentile CI: deterministic 2000-resample symbol/timeframe/entry-day cluster bootstrap; fewer than two clusters => undefined. Small samples and correlated instruments limit inference.'
    ];

const mean = xs => xs.length ? xs.reduce((a,b) => a+b,0)/xs.length : null;
const median = xs => { const a = [...xs].sort((a,b) => a-b), n = a.length; return n ? (a[Math.floor(n/2)] + a[Math.floor((n-1)/2)])/2 : null; };
const segment = t => t < SPLIT ? 'IS' : 'OOS';

// The last available structural target liquidates the residual allocation.
// Costs apply to entry and each weighted exit notional, in initial-risk units.
export function simulateExit(candles, index, side, receipt, timeframe, cutoff = Infinity) {
  const d = side === 'LONG' ? 1 : -1, entry = receipt.entry, risk = d * (entry-receipt.sl.price);
  let remaining = 1, gross = 0, costs = .0015 * entry / risk, mfe = 0, mae = 0, hit = 0, ambiguous = false;
  const fills = [];
  const fill = (price, weight, time, type) => {
    gross += weight * d * (price-entry)/risk; costs += .0015 * weight * price/risk;
    remaining = Math.max(0, remaining-weight); fills.push({ price, weight, time, type });
  };
  let last = index, terminal = null;
  for (let i = index+1; i < candles.length && candleClose(candles[i], timeframe) <= cutoff; i++) {
    const c = candles[i]; last = i;
    mfe = Math.max(mfe, d * ((d === 1 ? c.high : c.low)-entry)/risk);
    mae = Math.max(mae, -d * ((d === 1 ? c.low : c.high)-entry)/risk);
    const reached = t => d === 1 ? c.high >= t.price : c.low <= t.price;
    const stopped = d === 1 ? c.low <= receipt.sl.price : c.high >= receipt.sl.price;
    if (stopped) {
      ambiguous = receipt.targets.slice(hit).some(reached);
      fill(receipt.sl.price, remaining, candleClose(c, timeframe), 'SL'); terminal = 'SL'; break;
    }
    while (hit < receipt.targets.length && reached(receipt.targets[hit])) {
      const target = receipt.targets[hit];
      const weight = hit === receipt.targets.length-1 ? remaining : [.5,.3,.2][hit];
      fill(target.price, weight, candleClose(c, timeframe), `TP${hit+1}`); hit++;
    }
    if (remaining < 1e-12) { terminal = 'TP'; break; }
  }
  const censored = remaining > 1e-12;
  if (censored) fill(candles[last].close, remaining, candleClose(candles[last], timeframe), 'MARK_TO_MARKET');
  return { gross_r: gross, costs_r: costs, net_r: gross-costs, mfe_r: mfe, mae_r: mae,
    ambiguous, censored, outcome: terminal ?? 'OPEN_AT_END', exit_time: candleClose(candles[last], timeframe), fills };
}

export function metrics(events, trades) {
  const canonical = new Map();
  for (const t of [...trades].sort((a,b) => a.entry_time-b.entry_time || a.variant.localeCompare(b.variant))) if(!canonical.has(setupKey(t))) canonical.set(setupKey(t),t);
  const unique = [...canonical.values()];
  const net = unique.map(t => t.exit.net_r), n = net.length, average = mean(net);
  const bySeries = new Map();
  for (const t of unique) {
    const key = `${t.symbol}|${t.timeframe}`;
    if (!bySeries.has(key)) bySeries.set(key, []);
    bySeries.get(key).push(t.entry_time);
  }
  const frequencies = [...bySeries].map(([series,times]) => {
    const first = Math.min(...times), last = Math.max(...times), weeks = (last-first)/604800;
    return { series, first_signal: first, last_signal: last, unique_setups: times.length,
      observed_signal_weeks: weeks, signals_per_week: weeks > 0 ? times.length/weeks : null };
  });
  let curve = 0, peak = 0, drawdown = 0;
  for (const t of [...unique].sort((a,b) => a.exit.exit_time-b.exit.exit_time || setupKey(a).localeCompare(setupKey(b)))) {
    curve += t.exit.net_r; peak = Math.max(peak,curve); drawdown = Math.max(drawdown,peak-curve);
  }
  const counts = {};
  for (const e of events) counts[e.status] = (counts[e.status] ?? 0)+1;
  const entryDecisions = (counts.ACCEPTED ?? 0)+(counts.RR_LOW ?? 0)+(counts.NO_TARGET ?? 0)+(counts.SL_INVALID_AT_ENTRY ?? 0);
  const armed = counts.ARMED ?? 0;
  // Deterministic cluster bootstrap resamples symbol/timeframe entry-day blocks.
  // This avoids treating simultaneous A/B or same-day trades as independent observations.
  const blocks = new Map();
  for (const t of unique) {
    const key = `${t.symbol}|${t.timeframe}|${Math.floor(t.entry_time/86400)}`;
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(t.exit.net_r);
  }
  let ci = null;
  if (blocks.size >= 2) {
    let seed = 4004;
    const random = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };
    const groups = [...blocks.values()], samples = [];
    for (let b=0; b<2000; b++) {
      let sum=0, count=0;
      for (let j=0; j<groups.length; j++) { const g=groups[Math.floor(random()*groups.length)]; sum+=g.reduce((a,x)=>a+x,0); count+=g.length; }
      samples.push(sum/count);
    }
    samples.sort((a,b)=>a-b); ci = [samples[49],samples[1949]];
  }
  const weeks = frequencies.reduce((s,f)=>s+f.observed_signal_weeks,0);
  const covered = frequencies.filter(f=>f.signals_per_week!==null).reduce((s,f)=>s+f.unique_setups,0);
  return { unique_setups: n, accepted_variant_receipts: trades.length, signals_per_week: weeks>0 ? covered/weeks : null,
    frequency_by_series: frequencies, frequency_undefined_series: frequencies.filter(f=>f.signals_per_week===null).length,
    median_entry_sl_atr: median(unique.map(t=>Math.abs(t.entry-t.sl.price)/t.atr)), median_rr: median(unique.map(t=>t.rr.tp1)),
    median_rr_net_of_internal: median(unique.map(t=>t.rr_net_of_internal ?? t.rr.tp1)),
    counts, rr_low_rate: entryDecisions ? (counts.RR_LOW??0)/entryDecisions : null,
    rr_low_rate_denominator: entryDecisions, expired_rate: armed ? (counts.EXPIRED??0)/armed : null, expired_rate_denominator: armed,
    wins: net.filter(x=>x>0).length, losses: net.filter(x=>x<0).length, breakeven: net.filter(x=>x===0).length,
    ambiguous: unique.filter(t=>t.exit.ambiguous).length, censored: unique.filter(t=>t.exit.censored).length,
    expectancy_net_r: average, expectancy_ci95: ci, ci_blocks: blocks.size,
    max_drawdown_r: n ? drawdown : null, mean_mfe_r: mean(unique.map(t=>t.exit.mfe_r)), median_mfe_r: median(unique.map(t=>t.exit.mfe_r)),
    mean_mae_r: mean(unique.map(t=>t.exit.mae_r)), median_mae_r: median(unique.map(t=>t.exit.mae_r)) };
}

export function createComparison() {
  const events = [], trades = [], slots = new Map(), spacing = new Map();
  let previousSegment = null;
  const meta = (x, variant, side, time = x.signalTime) => ({ symbol: x.symbol, timeframe: x.timeframe, variant, side,
    time, segment: segment(time), regime: (x.strength[x.index].adx ?? 0) >=20 ? 'trend' : 'range' });
  const recordTrade = (x, policy, metadata, signal_time, receipt) => {
    const entry_time = x.signalTime;
    trades.push({ ...metadata, policy, signal_time, entry_time, segment: segment(entry_time), ...receipt,
      atr: x.volatility[x.index], armed_atr: receipt.atr ?? null,
      exit: simulateExit(x.candles,x.index,metadata.side,receipt,x.timeframe,entry_time<SPLIT ? SPLIT : Infinity) });
  };
  return { events, trades,
    onBar(x) {
      const part = segment(x.signalTime);
      if (previousSegment && part !== previousSegment) {
        for (const slot of slots.values()) if (['ARMED','RETESTED'].includes(slot.state.state)) events.push({ ...slot.meta, policy: slot.policy, status: 'CENSORED_AT_SPLIT' });
        slots.clear();
      }
      previousSegment = part;
      for (const [key, slot] of slots) {
        if (!['ARMED','RETESTED'].includes(slot.state.state)) continue;
        const next = transition(slot.state, { candle: x.candle, closed_at: x.signalTime, policy: slot.policy });
        slot.state = next;
        if (['CONFIRMED','EXPIRED','INVALIDATED'].includes(next.state)) {
          const metadata = next.state === 'CONFIRMED' ? meta(x,slot.meta.variant,slot.meta.side) : { ...slot.meta, time: x.signalTime };
          const status = next.state === 'CONFIRMED' ? next.receipt.accepted ? 'ACCEPTED' : next.receipt.reason === 'SL_INVALID' ? 'SL_INVALID_AT_ENTRY' : next.receipt.reason : next.state;
          events.push({ ...metadata, policy: slot.policy, status, armed_at: next.armed_at });
          if (next.receipt?.accepted) recordTrade(x,slot.policy,metadata,slot.signal_time,next.receipt);
          slots.delete(key);
        }
      }
    },
    onTrigger(x) {
      const t = x.trigger, metadata = meta(x,t.variant,t.side), last = spacing.get(t.variant) ?? -Infinity;
      if (x.index-last>=50) {
        spacing.set(t.variant,x.index);
        events.push({ ...metadata, policy: 'BASELINE', status: x.baseline.accepted ? 'ACCEPTED' : x.baseline.reason });
        if (x.baseline.accepted) recordTrade(x,'BASELINE',metadata,t.time,{ ...x.baseline, entry: t.setup.entry_ref, atr: x.args.atr14 });
      } else events.push({ ...metadata, policy: 'BASELINE', status: 'SPACING_SKIPPED' });
      for (const policy of POLICIES.slice(1)) {
        const key = `${policy}|${x.symbol}|${x.timeframe}|${t.side}`, slot = slots.get(key);
        const state = transition(slot?.state, { trigger: x.args, policy });
        events.push({ ...metadata, policy, status: state.event });
        if (state.event === 'ARMED') slots.set(key,{ state, meta: metadata, policy, signal_time: t.time });
      }
    },
    finish() {
      for (const slot of slots.values()) if (['ARMED','RETESTED'].includes(slot.state.state)) events.push({ ...slot.meta, policy: slot.policy, status: 'PENDING_AT_END' });
      return { events, trades };
    },
  };
}

export function summarize(events, trades) {
  const result = {};
  for (const policy of POLICIES) {
    const es = events.filter(e=>e.policy===policy), ts=trades.filter(t=>t.policy===policy);
    const summary = { label: policy.startsWith('SHADOW') ? 'SHADOW / REPORT ONLY' : policy, overall: metrics(es,ts), splits: {} };
    const group = (rows, receipts, field, values) => Object.fromEntries(values.map(v=>[v,metrics(rows.filter(e=>e[field]===v),receipts.filter(t=>t[field]===v))]));
    for (const part of ['ALL','IS','OOS']) {
      const rows=part==='ALL'?es:es.filter(e=>e.segment===part), receipts=part==='ALL'?ts:ts.filter(t=>t.segment===part);
      summary.splits[part] = { overall: metrics(rows,receipts),
        per_symbol: group(rows,receipts,'symbol',['BTCUSDT','ETHUSDT','SOLUSDT','PAXGUSDT']),
        per_timeframe: group(rows,receipts,'timeframe',['5m','15m']), per_side: group(rows,receipts,'side',['LONG','SHORT']),
        per_regime: group(rows,receipts,'regime',['trend','range']), per_variant: group(rows,receipts,'variant',['A','B','C']) };
      summary.splits[part].per_series = {};
      for (const symbol of ['BTCUSDT','ETHUSDT','SOLUSDT','PAXGUSDT']) for (const timeframe of ['5m','15m']) for (const variant of ['A','B','C']) {
        const matches = x=>x.symbol===symbol&&x.timeframe===timeframe&&x.variant===variant;
        summary.splits[part].per_series[`${symbol}|${timeframe}|${variant}`] = metrics(rows.filter(matches),receipts.filter(matches));
      }
    }
    result[policy]=summary;
  }
  return result;
}

const fmt = x => x == null ? 'n/a' : Number(x).toFixed(3);
export function summaryMarkdown(report, funnel) {
  const lines = ['# TRIAL-004 offline comparison','',report.scope.note,'',
    'Live runtime remains BASELINE. SHADOW policies are report-only.','',
    '## Funnel','', '| View | Bars | Prefixes | Triggers | NO_REFERENCE | SL_INVALID | NO_TARGET | RR_LOW | Accepted | Spacing skipped |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [name,g] of [['Spacing disabled',funnel.global],['Spacing 50',funnel.spacing_rule]]) lines.push(`| ${name} | ${g.bars} | ${g.prefixes} | ${g.triggers} | ${g.NO_REFERENCE} | ${g.SL_INVALID} | ${g.NO_TARGET} | ${g.RR_LOW} | ${g.ACCEPTED} | ${g.skipped??0} |`);
  for (const part of ['ALL','IS','OOS']) {
    lines.push('',`## ${part}`,'','| Policy | Unique | Signals/week | SL/ATR median | RR median | RR_LOW % | EXPIRED % | Win/loss/ambiguous | Net E(R) | 95% CI | Max DD(R) | MFE mean/median | MAE mean/median |',
      '|---|---:|---:|---:|---:|---:|---:|---|---:|---|---:|---|---|');
    for (const p of POLICIES) {
      const m=report.policies[p].splits[part].overall;
      lines.push(`| ${p} | ${m.unique_setups} | ${fmt(m.signals_per_week)} | ${fmt(m.median_entry_sl_atr)} | ${fmt(m.median_rr)} | ${fmt(m.rr_low_rate==null?null:m.rr_low_rate*100)} | ${fmt(m.expired_rate==null?null:m.expired_rate*100)} | ${m.wins}/${m.losses}/${m.ambiguous} | ${fmt(m.expectancy_net_r)} | ${m.expectancy_ci95?.map(fmt).join(' .. ')??'n/a'} | ${fmt(m.max_drawdown_r)} | ${fmt(m.mean_mfe_r)}/${fmt(m.median_mfe_r)} | ${fmt(m.mean_mae_r)}/${fmt(m.median_mae_r)} |`);
    }
  }
  lines.push('','## Winner proposal','',report.winner_proposal,'','## Method and limitations','',...report.method.map(s=>`- ${s}`),'',
    'Per-symbol, timeframe, side, regime and variant metrics for ALL/IS/OOS, gate events and full trade receipts are in trial-004-report.json.',
    '', '## Files','',...report.files.map(s=>`- ${s}`),'');
  return lines.join('\n');
}

async function main() {
  const directory=resolve(process.argv[2]??DEFAULT_DIRECTORY), files=await cachedFiles(directory), started=Date.now();
  if(files.length!==8) throw new Error(`Expected 8 cached files / 24 series, found ${files.length}`);
  const runs=[], events=[], trades=[]; const funnels=[]; let reduced=false;
  // BTC and ETH sort first, so the complete fallback set is retained on timeout.
  for(const file of files) {
    const comparison=createComparison(), funnel=createFunnel();
    try {
      const info=await replayCachedFile(file,{ deadline: reduced ? Infinity : started+20*60*1000,
        onBar:comparison.onBar, onTrigger:x=>{funnel.onTrigger(x);comparison.onTrigger(x);} });
      funnel.finishFile(info); const finished=comparison.finish();
      runs.push(info); events.push(...finished.events); trades.push(...finished.trades); funnels.push(funnel.report());
    } catch(e) {
      if(e.message!=='COMPARISON_TIME_BUDGET') throw e;
      reduced=true; console.error('20-minute comparison budget exceeded: retaining BTCUSDT+ETHUSDT 5m/15m, A/B/C only.');
      break;
    }
  }
  if(reduced) {
    for(const file of files.filter(f=>/\b(BTCUSDT|ETHUSDT)-/.test(f) && !runs.some(r=>r.input===f))) {
      const comparison=createComparison(),funnel=createFunnel();
      const info=await replayCachedFile(file,{onBar:comparison.onBar,onTrigger:x=>{funnel.onTrigger(x);comparison.onTrigger(x);}});
      funnel.finishFile(info);const finished=comparison.finish();runs.push(info);events.push(...finished.events);trades.push(...finished.trades);funnels.push(funnel.report());
    }
  }
  const inScope=x=>!reduced||['BTCUSDT','ETHUSDT'].includes(x.symbol);
  // A reduced comparison still owes the owner an all-trigger, all-24-series funnel.
  // Complete only missing funnel files, with no trial-policy simulation after the budget.
  if(reduced) for(const file of files.filter(f=>!runs.some(r=>r.input===f))) {
    const audit=createFunnel();
    console.error(`FUNNEL ONLY after comparison timeout: ${file}`);
    const info=await replayCachedFile(file,{onTrigger:audit.onTrigger});
    audit.finishFile(info);funnels.push(audit.report());
  }
  const funnel=mergeFunnels(funnels);
  funnel.scope='All 24 series';
  funnel.input_directory=directory;
  await writeJSON('funnel.json',funnel);
  const policies=summarize(events.filter(inScope),trades.filter(inScope));
  const eligible=POLICIES.filter(p=>policies[p].splits.OOS.overall.expectancy_ci95?.[0]>0)
    .sort((a,b)=>policies[b].splits.OOS.overall.expectancy_ci95[0]-policies[a].splits.OOS.overall.expectancy_ci95[0] ||
      (policies[b].splits.OOS.overall.signals_per_week??0)-(policies[a].splits.OOS.overall.signals_per_week??0));
  const report={ schema_version:1,input_directory:directory,scope:{reduced,series:runs.filter(inScope).length*3,
    elapsed_seconds:(Date.now()-started)/1000,note:reduced?'REDUCED: comparison exceeded ~20 minutes; BTCUSDT + ETHUSDT, 5m/15m, all variants only.':'Full cache: BTC/ETH/SOL/PAXG × 5m/15m × A/B/C = 24 series.'},
    split:'2026-09-01T00:00:00Z',runs:runs.filter(inScope),policies,events:events.filter(inScope),trades:trades.filter(inScope),
    winner_proposal:eligible.length?`${eligible[0]} has the strongest positive OOS lower confidence bound. This is an offline proposal only; shadows require a separate owner decision and live remains BASELINE.`:
      'No policy has an OOS expectancy lower 95% confidence bound above zero. No promotion proposed; live remains BASELINE.',
    method:REPORT_METHOD,files:['services/ga-signal/entry-state-machine.mjs','tools/ga-replay.mjs','tools/ga-funnel.mjs','tools/ga-compare.mjs',
      'tests/ga-signal-entry-state-machine.test.mjs','data/ga-signal/funnel.json','data/ga-signal/trial-004-report.json','data/ga-signal/trial-004-summary.md'] };
  await writeJSON('trial-004-report.json',report);
  await writeFile(resolve(OUTPUT_DIRECTORY,'trial-004-summary.md'),summaryMarkdown(report,funnel));
  console.table([funnel.global,funnel.spacing_rule]);
  console.table(POLICIES.map(policy=>({policy,...Object.fromEntries(['unique_setups','expectancy_net_r','signals_per_week','median_rr','max_drawdown_r'].map(k=>[k,policies[policy].overall[k]]))})));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e);process.exitCode=1;});
