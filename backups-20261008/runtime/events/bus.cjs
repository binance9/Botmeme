'use strict';
const { validateEvent, NETWORKS, TYPES } = require('../contracts/index.cjs');
const { openJournal, canonical } = require('../telemetry/journal.cjs');
const { validateTrace, REFERENCES } = require('../state/trace.cjs');

// The journal is an append-only audit ledger, but keeping EVERY event alive as
// live objects starves the process: snapshot()/get() used to deep-clone the
// whole store per call, so a multi-day journal (100k+ events) blocked the event
// loop for seconds at a time and every outbound fetch timed out. The bus now
// (a) serves cached shallow snapshots and reference gets — events are immutable
// by contract — and (b) garbage-collects old, unreferenced events from memory
// while the journal on disk keeps the complete history. Ancestors referenced by
// retained events are always retained with them, so trace validation never
// observes a missing parent.
const RETAIN_MS = 2 * 60 * 60 * 1000, MAX_EVENTS = 60000;
const ESSENTIAL = new Set(['TradeResult', 'StrategyLifecycleDecision', 'WalletValuation', 'ProposalCritique', 'BacktestResult', 'WalkForwardResult', 'StrategyProposal']);
function referencesOf(event) {
  const ids = [];
  for (const [field] of Object.entries(REFERENCES)) {
    const value = event.payload[field];
    if (value == null) continue;
    for (const id of Array.isArray(value) ? value : [value]) if (typeof id === 'string') ids.push(id);
  }
  return ids;
}
function createRuntime({ journalPath, capitalUsd = 10000, network = 'SOLANA', now = () => new Date(), maxPending = 512, handlerTimeoutMs = 5000, logger = console.error } = {}) {
  if (!NETWORKS.includes(network) || !Number.isSafeInteger(maxPending) || maxPending < 1 || !Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs < 1) throw Error('INVALID_RUNTIME_CONFIG');
  const journal = openJournal(journalPath, capitalUsd), events = new Map(), subscribers = new Map(), errors = [];
  const controllers = new Set();
  const checkpoints = new Set(), rejected = new Set(), failureLogs = new Map();
  const consumerTypes = new Map(), acknowledgments = new Map(), attached = new Set();
  let active = { network, epoch: 1 }, revision = 0, closed = false, pending = 0, fatal = null, deliveries = Promise.resolve();
  const refCounts = new Map();
  let snapshotCache = null;
  // Readers (snapshot/get) receive private, lazily-built shallow copies. Events
  // are immutable once published, so one clone per event is reused across every
  // read until the event is collected — full deep clones per read are what
  // drowned the event loop on large journals.
  const clones = new Map();
  const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const key of Object.keys(value)) freeze(value[key]); } return value; };
  // One frozen copy per published event, reused by every reader: snapshot/get
  // stay O(reads) instead of deep-cloning the whole store, and a caller cannot
  // mutate shared state — assignments on frozen objects throw in strict mode.
  const cloneOf = event => { let copy = clones.get(event.id); if (!copy) { copy = freeze({ ...event, payload: { ...event.payload } }); clones.set(event.id, copy); } return copy; };
  const track = event => { for (const id of referencesOf(event)) refCounts.set(id, (refCounts.get(id) ?? 0) + 1); };
  const untrack = event => { for (const id of referencesOf(event)) { const next = (refCounts.get(id) ?? 1) - 1; if (next <= 0) refCounts.delete(id); else refCounts.set(id, next); } };
  function evict(clock) {
    if (events.size <= MAX_EVENTS) return;
    const candidates = [];
    for (const event of events.values()) {
      if (ESSENTIAL.has(event.type)) continue;
      if (clock.getTime() - Date.parse(event.timestamp) < RETAIN_MS) continue;
      if ((refCounts.get(event.id) ?? 0) > 0) continue;
      candidates.push(event);
    }
    candidates.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const event of candidates) {
      if (events.size <= MAX_EVENTS) break;
      if (!events.has(event.id) || (refCounts.get(event.id) ?? 0) > 0) continue;
      events.delete(event.id); untrack(event); clones.delete(event.id);
    }
    snapshotCache = null;
  }
  function verify(event) {
    if (event.network !== active.network || event.epoch !== active.epoch) throw Error('STALE_NETWORK_EVENT');
    validateTrace(event, events);
  }
  try {
    for (const record of journal.records) {
      if (record.kind === 'network' && Object.keys(record).sort().join(',') === 'epoch,kind,network' && NETWORKS.includes(record.network) && record.epoch === active.epoch + 1) active = { network: record.network, epoch: record.epoch };
      else if (record.kind === 'initial' && revision === 0 && Object.keys(record).sort().join(',') === 'epoch,kind,network' && NETWORKS.includes(record.network) && record.epoch === 1) active = { network: record.network, epoch: 1 };
      else if (record.kind === 'event' && Object.keys(record).sort().join(',') === 'event,kind') {
        const event = validateEvent(record.event, { now });
        if (events.has(event.id)) throw Error('DUPLICATE_JOURNAL_EVENT');
        verify(event); events.set(event.id, event); track(event);
      } else if (record.kind === 'delivery-error' && Object.keys(record).sort().join(',') === 'code,eventId,kind,type' && record.code === 'CONSUMER_FAILED' && events.get(record.eventId)?.type === record.type) {
        errors.push({ eventId: record.eventId, type: record.type, code: record.code }); if (errors.length > 100) errors.shift();
      } else if (record.kind === 'consumer' && Object.keys(record).sort().join(',') === 'consumerId,kind,type' && /^[\w.-]{1,100}$/.test(record.consumerId) && !consumerTypes.has(record.consumerId) && (record.type === '*' || TYPES.includes(record.type))) {
        consumerTypes.set(record.consumerId, record.type); acknowledgments.set(record.consumerId, new Set());
      } else if (record.kind === 'ack' && Object.keys(record).sort().join(',') === 'consumerId,eventId,kind' && consumerTypes.has(record.consumerId) && events.has(record.eventId) && (consumerTypes.get(record.consumerId) === '*' || consumerTypes.get(record.consumerId) === events.get(record.eventId).type) && !acknowledgments.get(record.consumerId).has(record.eventId)) {
        acknowledgments.get(record.consumerId).add(record.eventId);
      } else if (record.kind === 'checkpoint' && Object.keys(record).sort().join(',') === 'key,kind' && typeof record.key === 'string' && /^commander\.[a-f0-9]{64}$/.test(record.key)) {
        checkpoints.add(record.key);
      } else throw Error('INVALID_RUNTIME_RECORD');
      revision++;
    }
    if (!revision) revision = journal.append({ kind: 'initial', ...active });
  } catch (error) { journal.close(); throw error; }
  function publish(input) {
    if (closed) throw Error('RUNTIME_CLOSED');
    if (fatal) throw fatal;
    let event;
    try { event = validateEvent(input, { now }); }
    catch (error) {
      if (!/^INVALID_EVENT_[A-Z_]+$/.test(error.message)) throw error;
      // Permanent failure: preserve the first throwing call for fail-closed
      // callers, but terminate exception-driven retries with an explicit result.
      const producer = require('../contracts/types.cjs').PRODUCERS.includes(input?.producer) ? input.producer : 'UNKNOWN';
      const type = TYPES.includes(input?.type) ? input.type : 'UNKNOWN';
      const key = producer + ':' + type + ':' + error.message;
      const time = Date.now(), last = failureLogs.get(key);
      if (last === undefined || time - last >= 60000) {
        failureLogs.set(key, time);
        try { logger(JSON.stringify({ code: error.message, producer, type, retryable: false })); } catch {}
      }
      // Group by producer/type/code, not event id: retrying producers may
      // regenerate UUIDs and timestamps for the very same invalid payload.
      if (rejected.has(key)) return { rejected: true, retryable: false, code: error.message };
      rejected.add(key);
      error.retryable = false;
      throw error;
    }
    const previous = events.get(event.id);
    if (previous) {
      if (canonical(previous) !== canonical(event)) throw Error('EVENT_ID_COLLISION');
      return { duplicate: true, id: event.id };
    }
    verify(event);
    if (pending >= maxPending) throw Error('RUNTIME_BACKPRESSURE');
    revision = journal.append({ kind: 'event', event }); events.set(event.id, event); track(event);
    evict(now());
    const listeners = [...(subscribers.get(event.type) ?? []), ...(subscribers.get('*') ?? [])];
    enqueue([event], listeners);
    return { duplicate: false, id: event.id };
  }
  function enqueue(batch, listeners) {
    pending++;
    deliveries = deliveries.then(async () => {
      try {
        for (const event of batch) {
        // Work queued for an old session stays in history, never in the new scanner.
        if (fatal) return;
        if (event.epoch !== active.epoch || event.network !== active.network) continue;
        for (const { handler, consumerId } of listeners) {
          if (event.epoch !== active.epoch || event.network !== active.network) break;
          if (consumerId && acknowledgments.get(consumerId).has(event.id)) continue;
          const controller = new AbortController(); controllers.add(controller);
          let timer;
          try {
            await Promise.race([
              Promise.resolve().then(() => handler(structuredClone(event), { signal: controller.signal })),
              new Promise((_, reject) => {
                controller.signal.addEventListener('abort', () => reject(Error('CONSUMER_ABORTED')), { once: true });
                timer = setTimeout(() => controller.abort(), handlerTimeoutMs);
              })
            ]);
            if (consumerId && !controller.signal.aborted) {
              // Ack journaling is durability-light (no fsync): handlers are
              // idempotent (deterministic derived ids + runtime.get dedupe), so
              // losing the last acks on a crash only causes bounded redelivery.
              // A full fsync per ack made the delivery chain fall behind the
              // scanner and choke publishers with RUNTIME_BACKPRESSURE.
              revision = journal.append({ kind: 'ack', consumerId, eventId: event.id }, false);
              acknowledgments.get(consumerId).add(event.id);
            }
          } catch {
            const failure = { eventId: event.id, type: event.type, code: 'CONSUMER_FAILED' };
            revision = journal.append({ kind: 'delivery-error', ...failure }, false);
            errors.push(failure); if (errors.length > 100) errors.shift();
          } finally { clearTimeout(timer); controllers.delete(controller); }
          await new Promise(resolve => setImmediate(resolve));
        }
        }
      } finally { pending--; }
    }).catch(() => { fatal = Error('RUNTIME_DELIVERY_PERSISTENCE_FAILED'); });
  }
  function subscribe(type, handler, consumerId = null) {
    if (closed || fatal || type !== '*' && !TYPES.includes(type) || typeof handler !== 'function') throw Error('INVALID_RUNTIME_SUBSCRIBER');
    if (consumerId !== null) {
      if (typeof consumerId !== 'string' || !/^[\w.-]{1,100}$/.test(consumerId) || attached.has(consumerId) || consumerTypes.has(consumerId) && consumerTypes.get(consumerId) !== type) throw Error('INVALID_DURABLE_CONSUMER');
      if (pending >= maxPending) throw Error('RUNTIME_BACKPRESSURE');
      if (!consumerTypes.has(consumerId)) {
        revision = journal.append({ kind: 'consumer', consumerId, type });
        consumerTypes.set(consumerId, type); acknowledgments.set(consumerId, new Set());
      }
      attached.add(consumerId);
    }
    const listener = { handler, consumerId };
    if (!subscribers.has(type)) subscribers.set(type, new Set());
    subscribers.get(type).add(listener);
    if (consumerId) {
      const clock = now();
      const matching = [...events.values()].filter(e => (type === '*' || e.type === type) && !acknowledgments.get(consumerId).has(e.id) && (ESSENTIAL.has(e.type) || clock.getTime() - Date.parse(e.timestamp) <= RETAIN_MS));
      // A crashed session can leave thousands of unacked events; replaying them
      // all starves the bus (RUNTIME_BACKPRESSURE chokes fresh publishers, the
      // wallet valuation among them) while every handler dedupes or discards
      // stale entries anyway. Redelivery is bounded to the newest window.
      const bounded = matching.length > 200 ? matching.slice(-200) : matching;
      enqueue(bounded, [listener]);
    }
    return () => { subscribers.get(type)?.delete(listener); attached.delete(consumerId); };
  }
  return {
    publish,
    hasCheckpoint: key => checkpoints.has(key),
    checkpoint(key) {
      if (closed || fatal) throw fatal || Error('RUNTIME_CLOSED');
      if (!/^commander\.[a-f0-9]{64}$/.test(key)) throw Error('INVALID_CHECKPOINT');
      if (!checkpoints.has(key)) { revision = journal.append({ kind: 'checkpoint', key }); checkpoints.add(key); }
    },
    selectNetwork(next) {
      if (closed || !NETWORKS.includes(next)) throw Error('INVALID_NETWORK_SELECTION');
      if (fatal) throw fatal;
      if (active.network === next) return structuredClone(active);
      const change = { network: next, epoch: active.epoch + 1 };
      revision = journal.append({ kind: 'network', ...change }); active = change;
      for (const controller of controllers) controller.abort();
      return structuredClone(active);
    },
    subscribe,
    subscribeDurable: (consumerId, type, handler) => subscribe(type, handler, consumerId),
    capitalEvents: () => structuredClone(journal.capitalEvents),
    solAnchor: () => journal.solAnchor(),
    paperWithdrawals: () => journal.paperWithdrawals(),
    withdrawSol: input => {
      if (closed || fatal) throw fatal || Error('RUNTIME_CLOSED');
      return journal.withdrawSol(input);
    },
    solReference: (priceUsd, at) => journal.solReference(priceUsd, at),
    capitalHistoryGroups: () => structuredClone(journal.capitalHistoryGroups),
    status: () => ({ ...active, revision, pending }),
    // Cached shallow snapshot over lazily-cloned events: one array per revision,
    // one private copy per event, no deep clone of the store per read.
    snapshot: () => {
      if (snapshotCache && snapshotCache.revision === revision) return snapshotCache.value;
      const value = { ...active, revision, pending, events: [...events.values()].map(cloneOf), deliveryErrors: errors.slice() };
      snapshotCache = { revision, value };
      return value;
    },
    get: id => { const event = events.get(id); return event ? { ...event, payload: { ...event.payload } } : null; },
    async flush() { while (pending) { await deliveries; if (pending && !closed) await new Promise(resolve => setTimeout(resolve, 25)); } if (fatal) throw fatal; },
    async close() { if (closed) return; closed = true; try { while (pending) await deliveries; } finally { subscribers.clear(); journal.close(); } }
  };
}
module.exports = { createRuntime, MAX_EVENTS, RETAIN_MS };
