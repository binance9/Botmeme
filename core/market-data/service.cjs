'use strict';
const { randomUUID } = require('node:crypto');
const { NETWORKS, validateEvent } = require('../../runtime/contracts/index.cjs');
const { tokenIdentity } = require('../../runtime/contracts/token-identity.cjs');
const SWEEP_MAX_AGE_MS = 30 * 60000;

// Provider interface: {network, discover({signal}), snapshot(token,{signal})}.
// No provider is substituted for another network, and no price is synthesized.
function hourCounts(events, clockMs) {
  const start = clockMs - 3600000, recent = event => Date.parse(event.timestamp) >= start, first = new Map();
  for (const event of events) {
    if (event.type !== 'MarketSnapshot') continue;
    const prior = first.get(event.payload.token);
    if (!prior || event.timestamp < prior) first.set(event.payload.token, event.timestamp);
  }
  let discovered = 0;
  for (const time of first.values()) if (Date.parse(time) >= start) discovered += 1;
  return {
    discovered,
    eligible: events.filter(event => recent(event) && event.type === 'TokenCandidate' && event.payload.anomalies.includes('TOKEN_DISCOVERY')).length,
    buy: events.filter(event => recent(event) && event.type === 'StrategyDecision' && event.payload.action === 'BUY').length,
    riskReject: events.filter(event => recent(event) && event.type === 'RiskDecision' && event.payload.approved === false).length,
    fill: events.filter(event => recent(event) && event.type === 'TradeResult' && event.payload.state === 'OPEN').length,
    sell: events.filter(event => recent(event) && event.type === 'TradeResult' && event.payload.side === 'SELL').length
  };
}
function createMarketData({ runtime, providers, now = () => new Date(), providerTimeoutMs = 15000 }) {
  if (!runtime || !providers || typeof providers !== 'object' || !Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs < 1) throw Error('INVALID_MARKET_SERVICE');
  let current = null, watchSession = null, quoteSequence = 0;
  const discoveredAt = new Map(), bornAt = new Map(), quoteOrder = new Map(), quoteAttempts = new Map(), alive = new Set();
  let attemptSequence = 0;
  const deadQuoteCooldownMs = 6 * 60 * 60000;
  async function scan() {
    if (current) throw Error('SCAN_ALREADY_RUNNING');
    const { network, epoch } = runtime.snapshot(), provider = providers[network];
    const session = network + ':' + epoch;
    if (watchSession !== session) { discoveredAt.clear(); bornAt.clear(); quoteOrder.clear(); quoteAttempts.clear(); alive.clear(); quoteSequence = 0; attemptSequence = 0; watchSession = session; }
    if (!NETWORKS.includes(network) || !provider || provider.network !== network || typeof provider.discover !== 'function' || typeof provider.snapshot !== 'function') throw Error('NETWORK_PROVIDER_UNVERIFIED');
    const controller = new AbortController(); current = controller;
    const runId = 'scan:' + randomUUID();
    let total = null, completed = 0, failed = 0, skipped = 0, kept = 0, watching = 0;
    const rateLimited = error => ['GECKOTERMINAL_HTTP_FAILED_429', 'GECKOTERMINAL_RATE_LIMIT_COOLDOWN', 'MARKET_RATE_LIMITED'].includes(error?.message);
    const active = () => {
      const state = runtime.snapshot();
      if (controller.signal.aborted || state.network !== network || state.epoch !== epoch) throw Error('SCAN_SESSION_ENDED');
    };
    async function call(method, ...args) {
      const request = new AbortController(); let timer;
      const timeoutMs = method === 'fallbackQuotes' ? Math.max(providerTimeoutMs, 30000) : providerTimeoutMs;
      const abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        return await Promise.race([
          Promise.resolve().then(() => provider[method](...args, { signal: request.signal })),
          new Promise((_, reject) => { request.signal.addEventListener('abort', () => reject(Error('PROVIDER_REQUEST_ENDED')), { once: true }); timer = setTimeout(abort, timeoutMs); if (controller.signal.aborted) abort(); })
        ]);
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
    }
    const progress = (suffix, state, reason = '', fraction = undefined) => {
      const common = { timestamp: now().toISOString(), producer: 'MARKET_DATA', source: 'market-data.discovery', evidence: [], status: state === 'FAILED' ? 'FAILED' : 'OBSERVED', correlationId: runId, network, epoch, confidence: 1, evidence_quality: 1, missing_evidence: [], uncertainty: 0 };
      const ratio = fraction === undefined ? (total ? completed / total : null) : fraction;
      const hour = hourCounts(runtime.snapshot().events, Date.parse(now().toISOString()));
      runtime.publish({ ...common, id: runId + ':' + suffix, type: 'AIActivityEvent', payload: { agent: 'MARKET_DATA', task: runId, state, progress: ratio, message: `Discovery processed ${completed}/${total ?? '?'} newest; kept ${kept}; failed ${failed}; unchanged/older ${skipped}. HOUR DISCOVERED ${hour.discovered} WATCHING ${watching} ELIGIBLE ${hour.eligible} BUY ${hour.buy} RISK_REJECT ${hour.riskReject} FILL ${hour.fill} SELL ${hour.sell}.${reason ? ' ' + reason : ''}` } });
      runtime.publish({ ...common, id: runId + ':' + suffix + ':counts', type: 'ScanProgress', payload: { runId, state, total, completed, failed, skipped } });
    };
    try {
      progress('started', 'RUNNING');
      const open = new Set(), prior = new Map(), decided = new Set();
      const clockMs = now().getTime();
      const discovered = (token, time) => {
        if (typeof token === 'string' && Number.isFinite(time)) discoveredAt.set(token, Math.min(discoveredAt.get(token) ?? time, time));
      };
      for (const event of runtime.snapshot().events) {
        if (event.network !== network || event.epoch !== epoch) continue;
        if (event.type === 'TokenCandidate' || event.type === 'MarketSnapshot') discovered(event.payload.token, Date.parse(event.timestamp));
        if (event.type === 'StrategyDecision') {
          const origin = runtime.get(event.payload.candidateId) || runtime.get(event.payload.snapshotId);
          if (origin?.network === network && origin.epoch === epoch) decided.add(origin.payload.token);
        }
        if (event.type === 'TradeResult') {
          if (event.payload.state === 'OPEN') open.add(event.payload.token);
          if (event.payload.state === 'CLOSED') open.delete(event.payload.token);
        }
        if (event.type === 'MarketSnapshot') {
          if (Number.isSafeInteger(event.payload.poolAgeMs)) bornAt.set(event.payload.token, Date.parse(event.payload.observedAt) - event.payload.poolAgeMs);
          alive.add(event.payload.token);
          const latest = prior.get(event.payload.token);
          if (!latest || event.payload.observedAt > latest.payload.observedAt) prior.set(event.payload.token, event);
        }
      }
      const breathe = () => new Promise(resolve => setImmediate(resolve));
      // Unknown age may mean a brand-new pool: keep it in the sweep and quote
      // once per screening pass. Drop known ages beyond 30 minutes; never invent
      // age from first-seen time or exempt open positions from the age limit.
      const inUniverse = token => {
        const profile = provider.profile?.(token);
        const born = bornAt.get(token) ?? profile?.born;
        if (!Number.isFinite(born)) return true;
        bornAt.set(token, born);
        const age = now().getTime() - born;
        if (age >= 0 && age <= SWEEP_MAX_AGE_MS) return true;
        discoveredAt.delete(token); alive.delete(token); quoteOrder.delete(token); quoteAttempts.delete(token);
        provider.forget?.(token);
        return false;
      };
      const cancelled = error => controller.signal.aborted || error?.message === 'SCAN_SESSION_ENDED' || runtime.snapshot().network !== network || runtime.snapshot().epoch !== epoch;
      const fresh = token => !decided.has(token) && clockMs >= discoveredAt.get(token) && clockMs - discoveredAt.get(token) < 30 * 60000;
      const priority = token => fresh(token) ? 0 : open.has(token) ? 1 : alive.has(token) ? 2 : 3;
      const oldestQuote = (a, b) => (Date.parse(prior.get(a)?.payload.observedAt) || 0) - (Date.parse(prior.get(b)?.payload.observedAt) || 0) || (quoteOrder.get(a) || 0) - (quoteOrder.get(b) || 0);
      const canQuote = token => !(quoteAttempts.get(token)?.retryAt > now().getTime());
      const attempted = batch => {
        for (const token of batch) quoteAttempts.set(token, { order: ++attemptSequence, retryAt: 0 });
      };
      const batchResult = (batch, samples) => {
        const returned = new Set(samples.map(sample => sample?.token));
        for (const token of batch) if (!returned.has(token)) quoteAttempts.get(token).retryAt = now().getTime() + deadQuoteCooldownMs;
      };
      const quoted = new Set(), handled = new Set();
      const deferred = new Set();
      let priceIndex = 0, limited = false, fallbackCalls = 0;
      const hasFallback = typeof provider.fallbackQuotes === 'function';
      const fallbackQuotes = async list => {
        const samples = [];
        list = list.filter(token => inUniverse(token) && !deferred.has(token) && canQuote(token));
        for (let i = 0; i < list.length && fallbackCalls < 4; i += 30) {
          active();
          const batch = list.slice(i, i + 30);
          fallbackCalls++;
          attempted(batch);
          try {
            const result = await call('fallbackQuotes', batch); active();
            batchResult(batch, result);
            samples.push(...result);
          }
          catch (error) {
            if (cancelled(error)) throw Error('SCAN_SESSION_ENDED');
            for (const token of batch) deferred.add(token);
          }
        }
        return samples;
      };
      const quotes = async list => {
        attempted(list);
        try {
          const samples = await call('quotes', list);
          active();
          if (!hasFallback) batchResult(list, samples);
          // Gecko cannot quote fallback-only identifiers absent from its own pool cache.
          const missing = list.filter(token => !samples.some(sample => sample.token === token));
          return hasFallback && missing.length ? [...samples, ...await fallbackQuotes(missing)] : samples;
        }
        catch (error) {
          if (cancelled(error) || !hasFallback) throw error;
          return fallbackQuotes(list);
        }
      };
      const record = sample => {
        // A deep (trades-verified) sample supersedes a screened quote for the
        // same token — the quote is only a pre-filter, never the final say.
        if (!sample || typeof sample.token !== 'string') return;
        if (sample.source?.includes('#dexscreener-fallback') && sample.marketCapUsd === undefined) {
          const previous = prior.get(sample.token);
          if (Number.isFinite(previous?.payload.marketCapUsd)) sample = { ...sample, marketCapUsd: previous.payload.marketCapUsd, source: sample.source + '+prior-marketCapUsd', evidence: [...new Set([...sample.evidence, ...previous.evidence])] };
        }
        const deep = sample.source && String(sample.source).includes('#trade');
        if (!deep && quoted.has(sample.token)) return;
        if (deep) quoted.delete(sample.token);
        const timestamp = now().toISOString();
        const event = validateEvent({ id: runId + ':price-' + priceIndex, type: 'MarketSnapshot', timestamp, producer: 'MARKET_DATA', source: sample.source,
          evidence: sample.evidence, status: sample.missing_evidence.length ? 'CHUA_XAC_MINH' : 'OBSERVED', correlationId: runId + ':price-' + priceIndex, network, epoch,
          confidence: sample.confidence, evidence_quality: sample.evidence_quality, missing_evidence: sample.missing_evidence, uncertainty: sample.uncertainty,
payload: { ...tokenIdentity(sample), ...(sample.tokenDecimals !== undefined ? { tokenDecimals: sample.tokenDecimals } : {}), token: sample.token, price: sample.price, liquidityUsd: sample.liquidityUsd, volume24hUsd: sample.volume24hUsd, observedAt: sample.observedAt, ...(Number.isFinite(sample.executableDepthUsd) && Number.isFinite(sample.priceImpactBps) ? { executableDepthUsd: sample.executableDepthUsd, priceImpactBps: sample.priceImpactBps, ...(Number.isFinite(sample.gasUsd) ? { gasUsd: sample.gasUsd } : {}) } : {}), ...(sample.marketCapUsd !== undefined ? { marketCapUsd: sample.marketCapUsd } : {}), ...(Number.isSafeInteger(sample.poolAgeMs) ? { poolAgeMs: sample.poolAgeMs, ...(sample.realVolumeUsd !== undefined ? { realVolumeUsd: sample.realVolumeUsd } : {}), ...(typeof sample.poolAddress === 'string' && sample.poolAddress ? { poolAddress: sample.poolAddress } : {}) } : {}), ...(Number.isFinite(sample.recentVolumeUsd) && Number.isSafeInteger(sample.recentTxs5m) ? { recentVolumeUsd: sample.recentVolumeUsd, recentTxs5m: sample.recentTxs5m } : {}) } }, { now });
        // Validate timestamps before deriving age so malformed observations do
        // not silently disappear or poison the age cache for later scans.
        if (Number.isSafeInteger(sample.poolAgeMs)) bornAt.set(sample.token, Date.parse(sample.observedAt) - sample.poolAgeMs);
        if (!inUniverse(sample.token)) return;
        priceIndex += 1;
        const previous = prior.get(sample.token);
        const marker = value => { const source = String(value || ''), state = source.match(/\/state\/([0-9a-fx]+)/), block = source.match(/\/block\/(\d+)/); return { state: state ? state[1] : '', block: block ? block[1] : '' }; };
        const nextMark = marker(event.source), prevMark = marker(previous && previous.source);
        if (previous && event.payload.observedAt === previous.payload.observedAt && event.payload.price !== previous.payload.price && !(nextMark.block && nextMark.block === prevMark.block)) throw Error('CONFLICTING_OBSERVATION_PRICE');
        if (previous && (nextMark.state && nextMark.state === prevMark.state || nextMark.block && nextMark.block === prevMark.block || event.payload.observedAt <= previous.payload.observedAt)) skipped++;
        else { runtime.publish(event); prior.set(sample.token, event); quoteOrder.set(sample.token, ++quoteSequence); }
        quoted.add(sample.token);
        alive.add(sample.token);
        if (quoteAttempts.has(sample.token)) quoteAttempts.get(sample.token).retryAt = 0;
      };
      const remember = async list => {
        if (!provider.usesChain || !list.length) return;
        const samples = await call('chainSnapshots', list); active();
        if (!Array.isArray(samples)) return;
        for (const sample of samples) {
          await breathe();
          if (controller.signal.aborted) throw Error('SCAN_SESSION_ENDED');
          try { record(sample); handled.add(sample.token); }
          catch (error) { if (cancelled(error)) throw Error('SCAN_SESSION_ENDED'); active(); failed++; if (sample?.token) handled.add(sample.token); }
        }
      };
      let known = (provider.usesChain || hasFallback) && typeof provider.watched === 'function' ? provider.watched().filter(token => typeof token === 'string' && token.length <= 160) : [];
      if (hasFallback) known.push(...open, ...prior.keys());
      known.push(...[...discoveredAt.keys()].filter(fresh));
      for (const token of known) discovered(token, clockMs);
      known = [...new Set(known)].filter(inUniverse).sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
      if (provider.usesChain) {
        try { await remember(known); } catch (error) { if (cancelled(error)) throw Error('SCAN_SESSION_ENDED'); }
      }
      if (provider.usesChain && typeof provider.chainDiscover === 'function') {
        try {
          const extra = await call('chainDiscover');
          if (Array.isArray(extra)) for (const token of extra) if (typeof token === 'string' && token && token.length <= 160 && !known.includes(token)) known.push(token);
        } catch (error) { if (cancelled(error)) throw Error('SCAN_SESSION_ENDED'); }
      }
      let tokens, fallbackDiscovery = false, discoveryIncomplete = false;
      try { tokens = await call('discover'); }
      catch (error) {
        active(); // A discovery request timeout does not end the scan session.
        discoveryIncomplete = true;
        if (network === 'SOLANA' && hasFallback && typeof provider.fallbackDiscover === 'function') {
          try {
            // Profiles supply identifiers only; the four-call budget is for quote batches.
            tokens = await call('fallbackDiscover'); active();
            if (!Array.isArray(tokens) || tokens.some(t => typeof t !== 'string' || !t || t.length > 160)) throw Error('INVALID_DISCOVERY_UNIVERSE');
            discoveryIncomplete = !tokens.some(token => !discoveredAt.has(token));
            tokens = [...new Set([...tokens, ...known, ...(provider.watched?.() ?? [])])];
            fallbackDiscovery = true;
          } catch (fallbackError) { active(); discoveryIncomplete = true; tokens = undefined; }
        }
        if (!tokens) {
          tokens = [...new Set(known)];
        }
        if (rateLimited(error) || fallbackDiscovery) limited = true;
      }
      active();
      if (!Array.isArray(tokens) || tokens.some(t => typeof t !== 'string' || !t || t.length > 160) || new Set(tokens).size !== tokens.length) throw Error('INVALID_DISCOVERY_UNIVERSE');
      if (!provider.usesChain && typeof provider.watch === 'function') {
        for (const token of open) {
          if (!inUniverse(token)) continue;
          if (tokens.includes(token)) continue;
          try { if (await provider.watch(token, { signal: controller.signal })) tokens.push(token); }
          catch (error) { if (cancelled(error)) throw Error('SCAN_SESSION_ENDED'); if (rateLimited(error)) { limited = true; break; } }
        }
      }
      // Non-chain watchlists must enter the same screening queue as discovery.
      // remember() only reads chain snapshots; it cannot re-quote Gecko tokens.
      if (!provider.usesChain || hasFallback) tokens = [...new Set([...tokens, ...known, ...open])];
      tokens = [...new Set([...tokens, ...[...discoveredAt.keys()].filter(fresh)])];
      tokens = tokens.filter(inUniverse);
      for (const token of tokens) discovered(token, clockMs);
      if (provider.usesChain && !limited) {
        try { await remember(tokens.filter(token => !handled.has(token))); }
        catch (error) { if (cancelled(error)) throw Error('SCAN_SESSION_ENDED'); }
      }
      if (typeof provider.census === 'function') watching = provider.census().watching;
      const swept = !discoveryIncomplete && !fallbackDiscovery && Number.isSafeInteger(provider.swept) && provider.swept >= tokens.length && provider.swept <= 200 ? provider.swept : tokens.length;
      total = provider.usesChain ? swept : tokens.length;
      kept = tokens.length;
      progress('listed', 'RUNNING', '', tokens.length ? 0 : null);
      // Empty successful batches cool down only their missing tokens. Fresh
      // candidates, positions and proven live pools precede the unknown queue;
      // unknown pools rotate by actual attempts, never by ancient observations.
      const pending = tokens.filter(token => inUniverse(token) && !handled.has(token) && canQuote(token)).sort((a, b) => priority(a) - priority(b) || (priority(a) < 3 ? oldestQuote(a, b) : (quoteAttempts.get(a)?.order || 0) - (quoteAttempts.get(b)?.order || 0)));
      pending.splice(150);
      // Batched screening: providers exposing quotes() can screen 30 pools per
      // single call. Deep /trades verification then runs only on pools whose
      // headline turnover justifies it — the difference between seconds and
      // hours per sweep when a chain mints hundreds of pools per minute.
      const screenFirst = typeof provider.quotes === 'function' && !provider.usesChain;
      if (screenFirst) {
      const screen = async () => {
        const groups = [];
        for (let i = 0; i < pending.length && (!limited || hasFallback); i += 30) {
          const group = pending.slice(i, i + 30).filter(inUniverse);
          if (!group.length) continue;
          try {
            const samples = limited ? await fallbackQuotes(group) : await quotes(group); active();
            if (!Array.isArray(samples)) break;
            for (const sample of samples) {
              await breathe();
              if (controller.signal.aborted) throw Error('SCAN_SESSION_ENDED');
              try { record(sample); } catch (error) { if (cancelled(error)) throw Error('SCAN_SESSION_ENDED'); active(); failed++; }
              if (sample?.token) handled.add(sample.token);
            }
            // Let the delivery chain drain between batches — a 30-sample burst
            // must not flood the bus into RUNTIME_BACKPRESSURE.
            await runtime.flush();
          } catch (error) {
            if (cancelled(error)) throw Error('SCAN_SESSION_ENDED');
            active();
            for (const token of group) deferred.add(token);
            if (rateLimited(error)) limited = true;
            // A failed batch remains pending; it is not completed token work.
          }
        }
          // Deep-verify only pools whose headline turnover crossed the bar —
          // including pools already screened (their screened quote carries no
          // 5-minute trades, which is exactly what the deep pass adds). Budget:
          // 2 deep passes per scan — quotes already carry headline volume.
          const hot = pending.filter(token => inUniverse(token) && Number.isFinite(bornAt.get(token)) && !deferred.has(token) && canQuote(token) && (provider.profile?.(token)?.volume24hUsd ?? 0) >= 200)
            .sort((a, b) => (provider.profile?.(b)?.band ? 1 : 0) - (provider.profile?.(a)?.band ? 1 : 0))
            .slice(0, 2);
          for (const token of hot) {
            if (limited) break;
            active();
            try {
              const sample = await call('snapshot', token); active();
              if (sample.token !== token) throw Error('PROVIDER_TOKEN_MISMATCH');
              record(sample);
            } catch (error) {
              if (cancelled(error)) throw Error('SCAN_SESSION_ENDED');
              active();
              if (rateLimited(error)) { limited = true; break; }
              else failed++;
            }
            handled.add(token);
            await runtime.flush();
          }
        };
        await screen();
        completed = handled.size;
        progress('screened', 'RUNNING', '', tokens.length ? completed / tokens.length : null);
      }
      let attempt = handled.size;
      if (provider.usesChain) {
        if (pending.length && !limited && !(provider.retryAfterMs?.() > 0) && typeof provider.quotes === 'function') {
          try {
            const samples = await quotes(pending); active();
            if (Array.isArray(samples)) for (const sample of samples) {
              await breathe();
              if (controller.signal.aborted) throw Error('SCAN_SESSION_ENDED');
              try { record(sample); } catch (error) { if (cancelled(error)) throw Error('SCAN_SESSION_ENDED'); active(); failed++; }
              if (sample?.token) handled.add(sample.token);
            }
          } catch (error) {
            if (cancelled(error)) throw Error('SCAN_SESSION_ENDED');
            active();
            if (rateLimited(error)) limited = true;
            else failed++;
          }
        } else if (pending.length && limited) { /* queued until the cooldown ends */ }
        else if (pending.length && provider.retryAfterMs?.() > 0) limited = true;
        attempt = handled.size;
        completed = attempt;
        if (pending.length) progress('queued', 'RUNNING', '', tokens.length ? attempt / tokens.length : null);
      } else if (!screenFirst) for (const token of pending) {
        active();
        try {
          const sample = await call('snapshot', token); active();
          if (sample.token !== token) throw Error('PROVIDER_TOKEN_MISMATCH');
          record(sample);
        } catch (error) {
          if (cancelled(error)) throw Error('SCAN_SESSION_ENDED');
          active();
          if (rateLimited(error)) { limited = true; break; }
          else failed++;
        }
        handled.add(token);
        attempt += 1;
        completed = attempt;
        progress('check-' + attempt, 'RUNNING', '', tokens.length ? attempt / tokens.length : null);
        await runtime.flush();
        if (limited) break;
      }
      if (hasFallback && tokens.some(token => !handled.has(token)) && fallbackCalls < 4) {
        try {
          const samples = await fallbackQuotes(pending.filter(token => !handled.has(token)));
          for (const sample of samples) { await breathe(); active(); record(sample); handled.add(sample.token); }
          await runtime.flush();
        } catch (error) { if (cancelled(error)) throw Error('SCAN_SESSION_ENDED'); }
      }
      const unfinished = tokens.some(token => !handled.has(token));
      if (discoveryIncomplete || (limited && !fallbackDiscovery) || unfinished) {
        completed = handled.size;
        progress('paused', 'PARTIAL_FAILURE', discoveryIncomplete ? 'Discovery unavailable or supplied no new tokens; known candidates were processed using available quote evidence.' : limited ? 'Provider rate limited; remaining pools stay queued.' : 'Snapshot incomplete; no synthetic price was added.');
        return { runId, network, epoch, total, completed, failed, skipped, status: 'PARTIAL_FAILURE' };
      }
      completed = provider.usesChain ? swept : handled.size;
      if (!failed && !fallbackCalls && typeof provider.recovered === 'function') provider.recovered();
      progress('finished', failed ? 'PARTIAL_FAILURE' : 'COMPLETED');
      return { runId, network, epoch, total, completed, failed, skipped, status: failed ? 'PARTIAL_FAILURE' : 'COMPLETED' };
    } catch (error) {
      const session = runtime.snapshot();
      if (session.network === network && session.epoch === epoch) progress('aborted', controller.signal.aborted ? 'STOPPED' : 'FAILED', controller.signal.aborted ? 'Scan stopped.' : rateLimited(error) ? 'Provider rate limited; waiting for retry.' : 'Discovery unavailable; no fallback data.');
      if (controller.signal.aborted || session.network !== network || session.epoch !== epoch) throw Error('SCAN_SESSION_ENDED');
      const failure = Error(rateLimited(error) ? 'MARKET_RATE_LIMITED' : 'MARKET_DISCOVERY_FAILED');
      if (rateLimited(error)) {
        let delay;
        try { delay = provider.retryAfterMs?.(); } catch {}
        failure.retryAfterMs = Number.isSafeInteger(delay) && delay > 0 ? delay : 2000;
      }
      throw failure;
    } finally { if (current === controller) current = null; }
  }
  return { scan, stop() { current?.abort(); } };
}
module.exports = { createMarketData };
