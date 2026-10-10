'use strict';
// Safety gate — hard, fail-closed token-level veto BEFORE any paper buy.
// Master plan step [2]: mint authority revoked, freeze authority revoked,
// LP locked/burned floor, top-10 holder concentration ceiling, pool age window,
// market-cap ceiling, liquidity floor, and a Jev REJECT veto. On-chain metadata
// that cannot be verified REJECTS the candidate (never "assume safe").
//
// One SafetyDecision per TokenCandidate (deterministic id via derived()).
// Enforcement lives in paper execution: a BUY without an approved SafetyDecision
// for its candidate is refused. This module never signs or sends anything.
const { derived } = require('../../runtime/events/derived.cjs');
const { ENTRY_BAND } = require('../risk/engine.cjs');

const DEFAULT_POLICY = Object.freeze({
  minLiquidityUsd: 500,
  minPoolAgeMs: 0,
  maxPoolAgeMs: Number.MAX_SAFE_INTEGER,
  minMarketCapUsd: ENTRY_BAND[0],
  maxMarketCapUsd: ENTRY_BAND[1],
  minLpLockedPct: 0,                  // owner directive: unlocked LP no longer vetoes; the LP figure is still logged in checks
  maxTop10HolderPct: 100,             // owner directive: concentration recorded, never vetoes
  maxPumpTop10HolderPct: 30,          // RPC curve fallback must enforce concentration
  maxInsiderHolderPct: 100,           // owner directive: insider figure recorded, never vetoes
  maxJevRiskScore: 100                // owner directive: rug score recorded, never vetoes
});

function createSafetyGate({ runtime, now = () => new Date(), readers = {}, policy = {}, executionMode = () => runtime.executionMode?.() ?? 'live' } = {}) {
  if (!runtime || !['get', 'snapshot', 'publish', 'subscribeDurable'].every(k => typeof runtime[k] === 'function') || typeof now !== 'function') throw Error('INVALID_SAFETY_RUNTIME');
  const p = { ...DEFAULT_POLICY, ...policy };
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULT_POLICY, k)) || Object.values(p).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw Error('INVALID_SAFETY_POLICY');
  let running = false, generation = 0, detach = null;
  const clockIso = () => {
    const clock = now();
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_SAFETY_CLOCK');
    return clock.toISOString();
  };

  const strict = () => executionMode() !== 'paper';
  const percentage = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  const bondingCurve = meta => meta?.lpStatus === 'bonding-curve';
  const reportable = meta => meta && ['mintAuthorityRevoked', 'freezeAuthorityRevoked'].every(key => typeof meta[key] === 'boolean') &&
    percentage(meta.top10HolderPct) && (percentage(meta.maxLpLockedPct) || meta.maxLpLockedPct == null) &&
    ['scoreNormalised', 'insiderHolderPct'].every(key => meta[key] === null || percentage(meta[key]));
  const hasEvidence = meta => meta && meta.mintAuthorityRevoked === true && meta.freezeAuthorityRevoked === true &&
    (percentage(meta.maxLpLockedPct) || bondingCurve(meta) && meta.maxLpLockedPct == null) && percentage(meta.top10HolderPct) &&
    ['scoreNormalised', 'insiderHolderPct'].every(key => meta[key] === null || typeof meta[key] === 'number' && Number.isFinite(meta[key]) && meta[key] >= 0 && meta[key] <= 100);

  function finish(candidate, snapshot, approved, reason, checks, variant = 'v1', meta = null) {
    // Validate at publication too: no early return or mode change can turn an
    // advisory/empty read into a live approval.
    if (approved && strict() && !hasEvidence(meta)) {
      approved = false;
      reason = 'VETO: on-chain safety evidence missing or invalid.';
      checks.push({ name: 'SAFETY_EVIDENCE', passed: false, detail: reason });
    }
    // A re-screened candidate may reference a snapshot newer than the candidate
    // itself; the event timestamp must never predate its own evidence.
    const stamp = snapshot && snapshot.timestamp > candidate.timestamp ? snapshot.timestamp : candidate.timestamp;
    const event = derived(candidate, {
      producer: 'SAFETY_GATE', type: 'SafetyDecision', variant,
      timestamp: stamp,
      status: approved ? 'APPROVED' : 'REJECTED',
      evidence: [candidate.id, ...(snapshot ? [snapshot.id] : [])],
      missing_evidence: approved ? [] : [reason],
      confidence: approved ? Math.min(candidate.confidence, snapshot ? snapshot.confidence : 1) : 0,
      uncertainty: approved ? Math.max(candidate.uncertainty, snapshot ? snapshot.uncertainty : 1) : 1,
      payload: { candidateId: candidate.id, approved, reason, checks, ...(reportable(meta) && (strict() || bondingCurve(meta)) ? {
        mintAuthorityRevoked: meta.mintAuthorityRevoked, freezeAuthorityRevoked: meta.freezeAuthorityRevoked,
        maxLpLockedPct: meta.maxLpLockedPct ?? null, top10HolderPct: meta.top10HolderPct,
        insiderHolderPct: meta.insiderHolderPct, scoreNormalised: meta.scoreNormalised,
        ...(bondingCurve(meta) ? { lpStatus: 'bonding-curve' } : {})
      } : {}) }
    });
    if (!runtime.get(event.id)) runtime.publish(event);
    return event;
  }

  async function evaluate(candidate, { signal, variant = 'v1', snapshotOverride = null } = {}) {
    const checks = [];
    const add = (name, passed, detail) => checks.push({ name, passed, detail });
    const fail = detail => { add('SAFETY_GATE', false, detail); return finish(candidate, null, false, detail, checks, variant); };
    const existing = runtime.snapshot().events;
    const snapshot = snapshotOverride ? existing.find(e => e.id === snapshotOverride.id) : existing.find(e => e.id === candidate.payload.snapshotId);
    if (!snapshot || snapshot.type !== 'MarketSnapshot' || snapshot.network !== candidate.network || snapshot.epoch !== candidate.epoch) {
      return fail('SAFETY_SNAPSHOT_MISSING');
    }
    add('SNAPSHOT_FRESH', true, 'observed ' + snapshot.payload.observedAt);
    // liquidityUsd === 0 means the provider did not report liquidity (unknown),
    // not an empty pool — the risk engine still vetoes untradeable sizes later.
    if (candidate.payload.anomalies.includes('TOKEN_DISCOVERY')) {
      add('LIQUIDITY_FRESH_EXEMPT', true, 'owner fresh-window liquidity exemption; execution verifies the route');
    } else if (snapshot.payload.liquidityUsd === 0) {
      add('LIQUIDITY_UNKNOWN', true, 'provider reported no liquidity figure; risk sizing still applies');
    } else if (!(snapshot.payload.liquidityUsd >= p.minLiquidityUsd)) {
      add('LIQUIDITY_FLOOR', false, 'liquidityUsd=' + snapshot.payload.liquidityUsd);
      return finish(candidate, snapshot, false, 'VETO: liquidity below floor (' + snapshot.payload.liquidityUsd + ' < ' + p.minLiquidityUsd + ').', checks, variant);
    } else {
      add('LIQUIDITY_FLOOR', true, 'liquidityUsd=' + snapshot.payload.liquidityUsd);
    }
    if (!Number.isSafeInteger(snapshot.payload.poolAgeMs) || snapshot.payload.poolAgeMs < p.minPoolAgeMs || snapshot.payload.poolAgeMs > p.maxPoolAgeMs) {
      add('POOL_AGE', false, 'poolAgeMs=' + snapshot.payload.poolAgeMs);
      return finish(candidate, snapshot, false, 'VETO: pool age outside watch window (' + snapshot.payload.poolAgeMs + 'ms).', checks, variant);
    }
    add('POOL_AGE', true, 'poolAgeMs=' + snapshot.payload.poolAgeMs);
    const maxCap = p.maxMarketCapUsd;
    if (!Number.isFinite(snapshot.payload.marketCapUsd) || snapshot.payload.marketCapUsd > maxCap || snapshot.payload.marketCapUsd < p.minMarketCapUsd) {
      add('MARKET_CAP', false, 'marketCapUsd=' + snapshot.payload.marketCapUsd);
      return finish(candidate, snapshot, false, 'VETO: market cap missing or outside the configured watch band.', checks, variant);
    }
    add('MARKET_CAP', true, 'marketCapUsd=' + snapshot.payload.marketCapUsd);
    // On-chain metadata: fail-closed wherever a reader exists. On networks with
    // no reader (e.g. ROBINHOOD) the check is recorded as UNVERIFIED and advisory
    // — acceptable ONLY while execution is paper; real execution (P3) must not
    // enable a network without a verified on-chain reader.
    const reader = readers[candidate.network];
    let meta = null;
    if (!reader) {
      checks.push({ name: 'ONCHAIN_METADATA', passed: true, detail: 'no on-chain reader for ' + candidate.network + ' — UNVERIFIED, paper-mode advisory only' });
    } else {
      try {
        meta = await reader.read(snapshot.payload.token, snapshot);
        if (signal?.aborted) return;
      } catch (error) {
        const detail = String(error.message || error);
        // Owner directive: an API outage is not a danger finding. An availability
        // failure (network, HTTP status, unusable payload) is recorded as
        // UNVERIFIED-advisory in paper mode — the same treatment as networks with
        // no reader. A successful read that reports real danger still vetoes.
        const unavailable = /aborted|timeout|fetch failed|HTTP_|UNPARSABLE|RPC_INVALID|RATE_LIMIT/i.test(detail);
        if (strict() || !unavailable) {
          add('ONCHAIN_METADATA', false, detail.slice(0, 190));
          return finish(candidate, snapshot, false, 'VETO: on-chain safety metadata unavailable (' + detail.slice(0, 120) + ').', checks, variant);
        }
        add('ONCHAIN_METADATA', true, 'UNVERIFIED (paper-mode advisory): ' + detail.slice(0, 160));
        return finish(candidate, snapshot, true, 'All safety gates passed (on-chain metadata UNVERIFIED: ' + detail.slice(0, 80) + ').', checks, variant);
      }
      if (!meta || typeof meta !== 'object' || (strict() || bondingCurve(meta)) && !hasEvidence(meta)) {
        add('SAFETY_EVIDENCE', false, 'missing or invalid authority, LP, holder or risk fields');
        return finish(candidate, snapshot, false, 'VETO: on-chain safety evidence missing or invalid.', checks, variant, meta);
      }
      const chainChecks = [
        { name: 'MINT_AUTHORITY_REVOKED', passed: meta.mintAuthorityRevoked === true, detail: String(meta.mintAuthorityRevoked) },
        { name: 'FREEZE_AUTHORITY_REVOKED', passed: meta.freezeAuthorityRevoked === true, detail: String(meta.freezeAuthorityRevoked) },
        // null = metric not computable by the reader (e.g. RPC fallback cannot
        // see LP lock or insider graphs) — recorded unverified, not fabricated.
        { name: 'LP_LOCKED_FLOOR', passed: bondingCurve(meta) || meta.maxLpLockedPct === null || meta.maxLpLockedPct >= p.minLpLockedPct, detail: bondingCurve(meta) ? 'bonding-curve (verified pre-migration liquidity)' : 'lpLockedPct=' + meta.maxLpLockedPct },
        { name: 'TOP10_HOLDER_CEILING', passed: typeof meta.top10HolderPct !== 'number' || meta.top10HolderPct <= (bondingCurve(meta) ? Math.min(p.maxTop10HolderPct, p.maxPumpTop10HolderPct) : p.maxTop10HolderPct), detail: 'top10Pct=' + meta.top10HolderPct },
        { name: 'INSIDER_HOLDER_CEILING', passed: meta.insiderHolderPct === null || meta.insiderHolderPct <= p.maxInsiderHolderPct, detail: 'insiderPct=' + meta.insiderHolderPct },
        { name: 'JEV_RISK_SCORE_CEILING', passed: meta.scoreNormalised === null || meta.scoreNormalised <= p.maxJevRiskScore, detail: 'score=' + meta.scoreNormalised }
      ];
      checks.push(...chainChecks);
      const failedChain = chainChecks.filter(c => !c.passed);
      if (failedChain.length) {
        return finish(candidate, snapshot, false, 'VETO: ' + failedChain.map(c => c.name + '(' + c.detail + ')').join(', ') + '.', checks, variant, meta);
      }
    }
    const verdict = existing.filter(e => e.type === 'JevVerdict' && e.network === candidate.network && e.epoch === candidate.epoch && e.payload.candidateId === candidate.id).at(-1);
    if (verdict && verdict.payload.action === 'REJECT') {
      add('JEV_VERDICT', false, 'action=' + verdict.payload.action);
      return finish(candidate, snapshot, false, 'VETO: Jev verdict REJECT for this candidate.', checks);
    }
    add('JEV_VERDICT', true, verdict ? 'action=' + verdict.payload.action : 'no verdict yet (advisory layer)');
    return finish(candidate, snapshot, true, 'All safety gates passed.', checks, variant, meta);
  }

  // One safety read fans out to RugCheck and its Solana-RPC fallback. A sweep
  // that publishes hundreds of candidates at once would otherwise fire hundreds
  // of concurrent on-chain reads, saturate the public endpoints, and starve the
  // wallet-capital verification on the same RPC — every BUY then vetoes. Reads
  // are therefore bounded by a small FIFO; verdicts land a few seconds later.
  const MAX_PARALLEL_EVALUATIONS = 3;
  const evaluationQueue = [];
  let evaluating = 0;
  function pump() {
    while (evaluating < MAX_PARALLEL_EVALUATIONS && evaluationQueue.length) {
      const job = evaluationQueue.shift();
      evaluating += 1;
      Promise.resolve().then(job).catch(() => {}).finally(() => { evaluating -= 1; pump(); });
    }
  }
  const schedule = job => { if (evaluationQueue.length < 256) { evaluationQueue.push(job); pump(); } };

  // Policy and provider data change over time: a candidate once rejected for
  // "liquidity below floor" under an older policy or a missing data point must
  // not stay condemned forever. Each fresh snapshot of the same token re-screens
  // such candidates once (variant includes the snapshot id => natural dedupe).
  // Data-dependent rejections only; danger rejections (on-chain, Jev) stay final.
  async function rescreen(quote, signal) {
    const events = runtime.snapshot().events;
    const candidates = events.filter(e => e.type === 'TokenCandidate' && e.network === quote.network && e.epoch === quote.epoch && e.payload.token === quote.payload.token);
    for (const cand of candidates) {
      const latest = events.filter(e => e.type === 'SafetyDecision' && e.payload.candidateId === cand.id).at(-1);
      if(!latest)continue; // Initial candidate evaluation owns the first request.
      const temporary=latest && /on-chain safety metadata unavailable.*(?:aborted|timeout|fetch failed|RUGCHECK_HTTP_(?:400|429|5\d\d))/i.test(latest.payload.reason||'');
      if (latest && (latest.payload.approved || !(temporary || /liquidity below floor/.test(latest.payload.reason || '')))) continue;
      // Retry unavailable evidence on a fresh quote, at most once per 30 seconds.
      // A real danger verdict remains terminal; an API outage is not a danger finding.
      if(temporary && Date.parse(quote.timestamp)-Date.parse(latest.timestamp)<30000)continue;
      try { await evaluate(cand, { signal, variant: 'rescreen/' + quote.id, snapshotOverride: quote }); }
      catch { /* a malformed candidate stays rejected; next snapshot tries again */ }
    }
  }

  // Jev runs after the gate in the delivery chain, so a fresh candidate is
  // approved before Jev's verdict exists. When Jev later REJECTs a candidate the
  // gate already approved, publish a superseding REJECTED SafetyDecision: paper
  // execution reads the LATEST verdict per candidate, so the buy is refused.
  function jevVeto(verdict) {
    const prior = runtime.snapshot().events
      .filter(e => e.type === 'SafetyDecision' && e.network === verdict.network && e.epoch === verdict.epoch && e.payload.candidateId === verdict.payload.candidateId)
      .at(-1);
    if (!prior || !prior.payload.approved) return;
    const candidate = runtime.get(verdict.payload.candidateId);
    if (!candidate) return;
    const event = derived(verdict, {
      producer: 'SAFETY_GATE', type: 'SafetyDecision', variant: 'jev-veto',
      status: 'REJECTED', evidence: [candidate.id, verdict.id],
      missing_evidence: ['VETO: Jev verdict REJECT for this candidate.'],
      confidence: 0, uncertainty: 1,
      payload: { candidateId: candidate.id, approved: false, reason: 'VETO: Jev verdict REJECT for this candidate.', checks: [{ name: 'JEV_VERDICT', passed: false, detail: 'action=' + verdict.payload.action }] }
    });
    if (!runtime.get(event.id)) runtime.publish(event);
  }

  return {
    start() {
      if (running) return; running = true; const ticket = ++generation;
      try {
        detach = runtime.subscribeDurable('safety.gate.v1.TokenCandidate', 'TokenCandidate', (e, context) => {
          if (!running || ticket !== generation || context.signal.aborted) throw Error('SAFETY_GATE_STOPPED');
          schedule(() => evaluate(e, context));
          return Promise.resolve();
        });
        const detachJev = runtime.subscribeDurable('safety.gate.v1.JevVerdict', 'JevVerdict', (e, context) => {
          if (!running || ticket !== generation || context.signal.aborted) throw Error('SAFETY_GATE_STOPPED');
          if (e.payload.action === 'REJECT') jevVeto(e);
        });
        const detachRescreen = runtime.subscribeDurable('safety.gate.v1.MarketSnapshot', 'MarketSnapshot', (e, context) => {
          if (!running || ticket !== generation || context.signal.aborted) throw Error('SAFETY_GATE_STOPPED');
          schedule(() => rescreen(e, context.signal));
          return Promise.resolve();
        });
        const first = detach;
        detach = () => { first(); detachJev(); detachRescreen(); };
      } catch (error) { running = false; throw error; }
    },
    stop() { running = false; generation++; detach?.(); detach = null; }
  };
}
module.exports = { createSafetyGate, DEFAULT_POLICY };
