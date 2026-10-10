// LONG_SHORT:GA_SIGNAL — indicator/alert engine service for the Meme Trader Long/Short view.
// Ported from C:\GA_SIGNAL_LAB (engine files byte-identical). This is an INDICATOR/ALERT layer:
// it never routes orders, never touches the MEME:* namespace, and never publishes into the bot
// decision path. Engine files: ./engine (A/B/C rules), ./lib (journal + Binance REST), ./scanner,
// ./telegram (outbox: dedupe + retry; NOT_CONFIGURED until GA_TG_TOKEN/GA_TG_CHAT exist).
import fs from 'node:fs';
import path from 'node:path';
import { LabJournal } from './lib/journal.mjs';
import { Scanner } from './scanner/scanner.mjs';
import { Outbox } from './telegram/notify.mjs';

export const GA_SIGNAL_CONFIG = Object.freeze({
  namespace: 'LONG_SHORT:GA_SIGNAL',
  // PAXGUSDT = Binance-spot gold proxy (owner-requested "XAU"): same verified feed, ~XAUUSD price
  // region. PAXG is NOT XAUUSD — no forex spread/session semantics; label it as a proxy in the UI.
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'PAXGUSDT'],
  timeframes: ['5m', '15m', '1h', '4h', '1d'],
  variants: ['A', 'B', 'C'],
  scanner: { windowBars: 1000, warmupBars: 500, pollIntervalMs: 5000 },
});

export async function startGaSignalService({ dataDir, config = {}, autostart = true, now = Date.now, log = () => {}, fetchWindow, fetchRange } = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  const effective = {
    ...GA_SIGNAL_CONFIG, ...config,
    scanner: { ...GA_SIGNAL_CONFIG.scanner, ...(config.scanner ?? {}) },
    namespace: GA_SIGNAL_CONFIG.namespace, // namespace is not overridable
  };
  fs.mkdirSync(dataDir, { recursive: true });
  const journal = new LabJournal({ dir: dataDir, now });
  const outbox = new Outbox({ dir: dataDir, now });
  const scanner = new Scanner({ config: effective, journal, outbox, now, log, fetchWindow, fetchRange });
  // Preserve readable history when a torn journal needs operator recovery, but
  // never generate new signals or deliver queued alerts from an impaired source.
  if (autostart && !journal.loadError) scanner.start();
  let pump = null;
  if (!journal.loadError) {
    pump = setInterval(() => {
      if (journal.loadError) { scanner.stop(); clearInterval(pump); pump = null; return; }
      void outbox.pump();
    }, 5000);
    pump.unref?.();
  }
  log(journal.loadError ? `service blocked: ${journal.loadError.message}` : `service started: ${effective.symbols.length} symbols × ${effective.timeframes.length} TF × ${effective.variants.length} variants, data=${dataDir}, telegram=${outbox.simulated ? 'NOT_CONFIGURED' : 'READY'}`);

  const telegramStatus = () => ({
    configured: !outbox.simulated,
    status: journal.loadError ? 'BLOCKED_JOURNAL_INTEGRITY' : outbox.simulated ? 'NOT_CONFIGURED' : 'READY',
    counts: outbox.status().counts,
    lastError: journal.loadError?.message ?? outbox.status().lastError,
  });
  const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  const visible = event => event.type !== 'META' && Boolean(event.details?.reference && event.details?.sl && event.details?.targets?.length);

  async function handle(request, response, url) {
    const p = url.pathname;
    if (p === '/api/ga-signal/replay' && request.method === 'GET') {
      try {
        const report = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'replay-receipts.json'), 'utf8'));
        return json(response, 200, report);
      } catch (error) {
        return json(response, error.code === 'ENOENT' ? 404 : 500,
          { error: error.code === 'ENOENT' ? 'REPLAY_RECEIPTS_NOT_FOUND' : 'REPLAY_RECEIPTS_UNAVAILABLE' });
      }
    }
    if (p === '/api/ga-signal/state') {
      return json(response, 200, {
        serverTime: Date.now(), namespace: GA_SIGNAL_CONFIG.namespace,
        status: journal.loadError ? 'BLOCKED_JOURNAL_INTEGRITY' : 'READY',
        config: { symbols: GA_SIGNAL_CONFIG.symbols, timeframes: GA_SIGNAL_CONFIG.timeframes, variants: GA_SIGNAL_CONFIG.variants },
        scanner: scanner.state(), telegram: telegramStatus(), journal: { lastSeq: journal.seq, events: journal.events.length, appendable: !journal.loadError,
          loadError: journal.loadError ? { code: journal.loadError.code, message: journal.loadError.message } : null },
      });
    }
    if (p === '/api/ga-signal/events') {
      const since = Number(url.searchParams.get('since')) || 0;
      const symbol = url.searchParams.get('symbol'), timeframe = url.searchParams.get('timeframe');
      let events = journal.since(since).filter(visible);
      if (symbol) events = events.filter(event => event.symbol === symbol);
      if (timeframe) events = events.filter(event => event.timeframe === timeframe);
      return json(response, 200, { events, namespace: GA_SIGNAL_CONFIG.namespace });
    }
    if (p === '/api/ga-signal/setups') {
      const symbol = url.searchParams.get('symbol'), timeframe = url.searchParams.get('timeframe');
      const latest = new Map();
      for (const event of journal.events) {
        if (!event.setup_id || !visible(event)) continue;
        if (symbol && event.symbol !== symbol) continue;
        if (timeframe && event.timeframe !== timeframe) continue;
        latest.set(event.setup_id, event);
      }
      return json(response, 200, { setups: [...latest.values()], namespace: GA_SIGNAL_CONFIG.namespace });
    }
    if (p === '/api/ga-signal/snapshot') {
      // One-request payload for the overlay: avoids parallel fetches (the Long/Short page already
      // holds several SSE streams; the browser's per-origin HTTP/1.1 budget is the real constraint).
      const symbol = url.searchParams.get('symbol'), timeframe = url.searchParams.get('timeframe');
      const latest = new Map();
      const events = [];
      for (const event of journal.events) {
        if (!visible(event)) continue;
        if (symbol && event.symbol !== symbol) continue;
        if (timeframe && event.timeframe !== timeframe) continue;
        events.push(event);
        if (event.setup_id) latest.set(event.setup_id, event);
      }
      return json(response, 200, { events, setups: [...latest.values()], lastSeq: journal.seq, namespace: GA_SIGNAL_CONFIG.namespace });
    }
    if (p === '/api/ga-signal/stream') {
      if (journal.subscribers.size >= 32) return json(response, 503, { error: 'TOO_MANY_GA_STREAMS' });
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write('retry: 1000\n\n');
      response.write(`event: hello\ndata: ${JSON.stringify({ lastSeq: journal.seq, namespace: GA_SIGNAL_CONFIG.namespace })}\n\n`);
      const unsubscribe = journal.subscribe(record => {
        if (response.destroyed || !visible(record)) return;
        if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
        try { response.write(`event: signal\ndata: ${JSON.stringify(record)}\n\n`); } catch { response.destroy(); }
      });
      const beat = setInterval(() => { try { response.write(': heartbeat\n\n'); } catch { /* gone */ } }, 15000);
      beat.unref?.();
      request.on('close', () => { clearInterval(beat); unsubscribe(); });
      return;
    }
    if (p === '/api/ga-signal/telegram/test' && request.method === 'POST') {
      if (journal.loadError) return json(response, 503, { status: 'BLOCKED_JOURNAL_INTEGRITY', error: journal.loadError.code });
      if (outbox.simulated) return json(response, 200, { configured: false, status: 'NOT_CONFIGURED', detail: 'set GA_TG_TOKEN/GA_TG_CHAT (env) or secrets/telegram.json to enable real delivery' });
      // Configured: send exactly one real message, then prove dedupe (second identical enqueue is refused).
      const result = await outbox.sendTest();
      const probe = 'dedupe-probe';
      const first = outbox.enqueue({ setup_id: probe, type: 'TEST', text: `dedupe probe ${Date.now()}` });
      const second = outbox.enqueue({ setup_id: probe, type: 'TEST', text: 'ignored' });
      return json(response, 200, { configured: true, status: result.status, acked: result.acked ?? null, dedupe: { firstQueued: first.queued, secondQueued: second.queued } });
    }
    return json(response, 404, { error: 'UNKNOWN_GA_SIGNAL_ENDPOINT' });
  }

  return {
    handle, config: effective, journal, outbox, scanner,
    stop: () => { scanner.stop(); clearInterval(pump); },
  };
}
