'use strict';
const { createHash, randomUUID } = require('node:crypto');
const chain = require('./chain.cjs');
function createOnchainDiscovery({ runtime, now = () => new Date(), env = process.env,
  connector = chain.connect, key = chain.key, prefilter = chain.filter,
  quoteReader = chain.createQuoteReader({ now }), timers = { setTimeout, clearTimeout } } = {}) {
  const cap = Number(env.ONCHAIN_MAX_CANDIDATES_PER_HOUR ?? 40);
  const maxTop10 = Number(env.ONCHAIN_MAX_TOP10_PCT ?? 30);
  const wsEndpoint = env.RPC_WEBSOCKET_ENDPOINT || 'wss://api.mainnet-beta.solana.com';
  const httpEndpoint = env.RPC_HTTP_ENDPOINT || 'https://api.mainnet-beta.solana.com';
  let running = false, generation = 0, session = null, retryTimer = null, attempt = 0, busy = false;
  const seen = new Set(), queue = [], pending = new Set();
  const counted = new Set();
  let published = [];
  const valid = ticket => running && generation === ticket && runtime.status().network === 'SOLANA';
  function event(id, type, payload, evidence, active, missing = []) {
    return { id, type, payload, timestamp: now().toISOString(), producer: ['TokenCandidate', 'SignalObservation'].includes(type) ? 'JEV' : 'MARKET_DATA',
      source: 'onchain-ws', evidence, status: 'OBSERVED', correlationId: id, network: 'SOLANA', epoch: active.epoch,
      confidence: 0.8, evidence_quality: 0.8, uncertainty: 0.2, missing_evidence: missing };
  }
  function audit(reason, task = 'onchain-ws') {
    if (!running || runtime.status().network !== 'SOLANA') return;
    try { runtime.publish(event('onchain.activity/' + randomUUID(), 'AIActivityEvent', {
      agent: 'MARKET_DATA', task, state: 'WAITING', progress: null, message: reason
    }, [], runtime.status())); } catch { /* backpressure/closed runtime must not escape socket callbacks */ }
  }
  function release() { const old = session; session = null; try { old?.transport.dispose(old.ids); } catch {} }
  function fault(ticket, error, reason) {
    if (!valid(ticket) || retryTimer) return;
    release(); audit('WEBSOCKET_RECONNECT');
    const rateLimited = [error?.status, error?.statusCode, error?.code, error?.response?.status, error?.response?.statusCode].some(code => Number(code) === 429)
      || /\b429\b|too many requests/i.test(String(error?.message ?? error ?? '') + ' ' + String(reason ?? ''));
    if (rateLimited) attempt = Math.max(attempt, 6);
    const delay = Math.min(60000, 1000 * 2 ** Math.min(attempt++, 6));
    retryTimer = timers.setTimeout(() => { retryTimer = null; if (valid(ticket)) open(ticket); }, delay);
    retryTimer?.unref?.();
  }
  function capacity() { published = published.filter(at => now().getTime() - at < 3600000); return published.length < cap; }
  async function processLog(job, ticket, current) {
    const active = runtime.status();
    let tx;
    for (let retry = 0; retry < 3; retry++) {
      tx = await current.transport.rpc.getParsedTransaction(job.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx || !valid(ticket) || session !== current) break;
      if (retry < 2) await new Promise(resolve => setTimeout(resolve, 250 * (retry + 1)));
    }
    for (const item of chain.extract(tx, job.program)) {
      if (!valid(ticket) || runtime.status().epoch !== active.epoch || session !== current) return;
      if (seen.has(item.token)) continue;
      if (!capacity()) { audit('HOURLY_CAP_REACHED', item.token); return; }
      try {
        const mint = await prefilter(current.transport.rpc, item, maxTop10);
        const quote = await quoteReader(current.transport.rpc, item, mint);
        if (!valid(ticket) || runtime.status().epoch !== active.epoch || session !== current) return;
        if (![quote.price, quote.liquidityUsd, quote.marketCapUsd].every(Number.isFinite) || quote.price <= 0 || quote.liquidityUsd < 0 || quote.marketCapUsd < 0) throw Error('POOL_QUOTE_UNVERIFIED');
        const suffix = createHash('sha256').update(active.epoch + ':' + item.token).digest('hex');
        const snapshotId = 'onchain.snapshot/' + suffix, candidateId = 'onchain.candidate/' + suffix;
        const missing = ['VOLUME_24H_UNAVAILABLE', 'SPOT_RESERVE_ESTIMATE'];
        if (!runtime.get(snapshotId)) runtime.publish(event(snapshotId, 'MarketSnapshot', {
          token: item.token, ...quote, volume24hUsd: 0, realVolumeUsd: 0, poolAgeMs: 0, observedAt: now().toISOString()
        }, ['solana-tx/' + job.signature], active, missing));
        const snapshot = runtime.get(snapshotId);
        runtime.publish(event(candidateId, 'TokenCandidate', { token: item.token, symbol: item.token.slice(0, 32), snapshotId,
          liquidityUsd: snapshot.payload.liquidityUsd, volume24hUsd: 0, rank: 1, anomalies: ['TOKEN_DISCOVERY', 'ONCHAIN_CREATE'], discoverySource: 'onchain-ws'
        }, [snapshotId], active, missing));
        seen.add(item.token); counted.add(candidateId); published.push(now().getTime()); attempt = 0;
        runtime.publish(event('onchain.signal/' + suffix, 'SignalObservation', {
          candidateId, snapshotId, signals: [{ name: 'price', value: snapshot.payload.price }]
        }, [candidateId, snapshotId], active, missing));
        audit('ONCHAIN_CREATE_ACCEPTED top10Pct=' + mint.top10Pct, item.token);
      } catch (error) {
        if (valid(ticket)) audit(safeReason(error), item.token);
      }
    }
  }
  function safeReason(error) {
    // Never persist raw RPC/WS errors: providers may echo URLs containing credentials.
    return /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message ?? '') ? error.message : 'ONCHAIN_RPC_UNAVAILABLE';
  }
  async function drain(ticket, current) {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && valid(ticket) && session === current) {
        const job = queue.shift();
        try { await processLog(job, ticket, current); }
        catch (error) { if (valid(ticket)) audit(safeReason(error), job.signature); }
        finally { pending.delete(job.signature); }
      }
    } finally {
      busy = false;
      if (queue.length && valid(generation) && session) void drain(generation, session);
      else if (!valid(generation)) { queue.length = 0; pending.clear(); }
    }
  }
  function open(ticket) {
    try {
      const current = { transport: connector({ httpEndpoint, wsEndpoint, onFault: (error, reason) => { if (session === current) fault(ticket, error, reason); } }), ids: [] };
      session = current;
      for (const program of [chain.PUMP, chain.RAYDIUM]) {
        current.ids.push(current.transport.rpc.onLogs(key(program), logs => {
          if (!valid(ticket) || session !== current || logs.err || typeof logs.signature !== 'string') return;
          const match = program === chain.PUMP ? /Instruction: Create(?:V2)?\b/ : /initialize2/i;
          if (!logs.logs?.some(line => match.test(line)) || pending.has(logs.signature)) return;
          if (!capacity() || queue.length >= 64) return;
          pending.add(logs.signature); queue.push({ signature: logs.signature, program }); void drain(ticket, current);
        }, 'confirmed'));
      }
    } catch (error) { if (error.code === 'MODULE_NOT_FOUND') audit('ONCHAIN_DEPENDENCY_UNAVAILABLE'); fault(ticket, error); }
  }
  return {
    start() {
      if (running || runtime.status().network !== 'SOLANA' || env.ONCHAIN_DISCOVERY_ENABLED === 'false') return;
      running = true; const ticket = ++generation;
      if (!Number.isInteger(cap) || cap < 1 || !Number.isFinite(maxTop10) || maxTop10 < 0 || maxTop10 > 100) { audit('ONCHAIN_CONFIG_INVALID'); return; }
      for (const entry of runtime.snapshot().events) if (entry.type === 'TokenCandidate' && entry.payload.discoverySource === 'onchain-ws' && entry.network === 'SOLANA') {
        seen.add(entry.payload.token);
        if (!counted.has(entry.id)) { counted.add(entry.id); published.push(Date.parse(entry.timestamp)); }
      }
      open(ticket);
    },
    stop() { running = false; generation++; timers.clearTimeout(retryTimer); retryTimer = null; queue.length = 0; pending.clear(); release(); },
    async flush() { while (busy || queue.length) await new Promise(resolve => setImmediate(resolve)); }
  };
}
module.exports = { createOnchainDiscovery };
