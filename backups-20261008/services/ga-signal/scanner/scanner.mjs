// LAB background scanner — one instance per SERVER PROCESS (not per tab). Polls Binance SPOT
// REST once per closed candle per symbol+timeframe, reruns the deterministic engine over a
// rolling window, appends new events to the shared journal and enqueues Telegram alerts.
// fetchWindow/fetchRange are injected so tests can replay candles without network.
import { runEngine } from '../engine/ga-engine.mjs';
import { fetchClosedWindow, fetchRange as defaultFetchRange } from '../lib/binance.mjs';
import { resolveLevels, buildStructures, atr14, candleClose, HIGHER_TIMEFRAME, timeframeSeconds } from '../level-engine.mjs';

const STEP = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const TICK = { default: 0.01 };

// The original engine's expiry rules remain independent of structural TP/SL hits.
function trendDirections(candles) {
  let slow = null, trend = null, slowSum = 0, trendSum = 0;
  return new Map(candles.map((c, i) => {
    if (i < 50) slowSum += c.close;
    if (i < 200) trendSum += c.close;
    if (i === 49) slow = slowSum / 50;
    else if (i >= 50) slow += 2 / 51 * (c.close - slow);
    if (i === 199) trend = trendSum / 200;
    else if (i >= 200) trend += 2 / 201 * (c.close - trend);
    return [c.time, slow === null || trend === null ? 0 : c.close > slow && slow > trend ? 1 : c.close < slow && slow < trend ? -1 : 0];
  }));
}

function breakoutLevel(candles, tick) {
  for (let i = candles.length - 2; i >= Math.max(20, candles.length - 9); i--) {
    const range = candles.slice(i - 20, i), c = candles[i];
    const high = Math.max(...range.map(b => b.high)), low = Math.min(...range.map(b => b.low));
    const buffer = Math.max(tick, .05 * atr14(candles.slice(0, i)));
    if (c.close > high + buffer) return high;
    if (c.close < low - buffer) return low;
  }
  return null;
}

export class Scanner {
  constructor({ config, journal, outbox, fetchWindow = fetchClosedWindow, fetchRange = null, now = Date.now, log = () => {} }) {
    this.config = config; this.journal = journal; this.outbox = outbox; this.fetchWindow = fetchWindow; this.fetchRange = fetchRange;
    this.now = now; this.log = log;
    this.fetchRange = fetchRange ?? (fetchWindow === fetchClosedWindow ? defaultFetchRange : null);
    this.htfCache = new Map();
    this.series = new Map(); // key -> {symbol, timeframe, primed, degraded, lastPollAt, lastError, lastCandleTime, alertFloor}
    this.timer = null; this.busy = false;
    for (const symbol of config.symbols) for (const timeframe of config.timeframes) {
      this.series.set(`${symbol}-${timeframe}`, { symbol, timeframe, primed: false, degraded: false, lastPollAt: null, lastError: null, lastCandleTime: null, alertFloor: null });
    }
  }
  start() {
    const intervalMs = this.config.scanner?.pollIntervalMs ?? 5000;
    this.timer = setInterval(() => { void this.pollAll(); }, intervalMs);
    void this.pollAll();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  state() {
    return { running: this.timer !== null, busy: this.busy, series: [...this.series.values()].map(({ symbol, timeframe, ...rest }) => ({ symbol, timeframe, ...rest })) };
  }

  #record(event) { return this.journal.append(event); }
  #alert(journalEvent) {
    void this.outbox.enqueue({ setup_id: journalEvent.setup_id, type: journalEvent.type, text: journalEvent.details.text, ts: this.now() });
  }

  async pollAll() {
    if (this.busy) return; // a slow poll must never stack workers
    this.busy = true;
    try {
      for (const series of this.series.values()) {
        try { await this.pollSeries(series); } catch (error) { series.lastError = error.message; this.log(`scan ${series.symbol} ${series.timeframe}: ${error.message}`); }
      }
    } finally { this.busy = false; }
  }

  #markGap(series, from, to, note) {
    series.degraded = true; series.lastError = `data gap: ${note}`;
    this.#record({ type: 'META', event_id: `gap-${series.symbol}-${series.timeframe}-${from}-${to}`,
      symbol: series.symbol, timeframe: series.timeframe, reason: 'DATA_GAP', details: { from, to, note } });
  }

  async higherStructures(symbol, timeframe, candles) {
    const higher = HIGHER_TIMEFRAME[timeframe];
    if (!higher || !this.fetchRange || !candles.length) return null;
    const step = timeframeSeconds(higher);
    const cutoff = Math.min(this.now() / 1000, candleClose(candles.at(-1), timeframe));
    const endTime = Math.floor(cutoff / step) * step - step;
    const startTime = Math.max(0, Math.floor(candles[0].time / step) * step - 1000 * step);
    const key = `${symbol}-${higher}`;
    const cached = this.htfCache.get(key);
    if (cached && cached.endTime === endTime && cached.startTime <= startTime) return cached;
    const fetched = await this.fetchRange({ symbol, timeframe: higher, startTime, endTime, nowMs: cutoff * 1000 });
    const rows = fetched.filter(b => b.closed !== false && b.time >= startTime && b.time <= endTime &&
      candleClose(b, higher) <= cutoff && (!b.symbol || b.symbol === symbol) && (!b.timeframe || b.timeframe === higher));
    rows.sort((a, b) => a.time - b.time);
    if (rows.some((b, i) => i && b.time - rows[i - 1].time !== step)) throw new Error('HTF_DATA_GAP');
    const value = { symbol, timeframe: higher, startTime, endTime, candles: rows,
      structures: buildStructures({ candles: rows, symbol, timeframe: higher, signalTime: cutoff }) };
    this.htfCache.set(key, value);
    return value;
  }

  async pollSeries(series) {
    const { symbol, timeframe } = series;
    const window = this.config.scanner?.windowBars ?? 1000;
    const warmupBars = this.config.scanner?.warmupBars ?? 500;
    const step = STEP[timeframe] ?? 900;
    // Skip the fetch entirely until the current candle has actually closed (2s padding): the
    // 5s poller would otherwise re-download every series ten times per candle for nothing.
    if (series.lastCandleTime != null && this.now() < (series.lastCandleTime + step) * 1000 + 2000) return;
    let { candles, gaps } = await this.fetchWindow({ symbol, timeframe, window, nowMs: this.now() });
    candles = candles.filter(b => b.closed !== false && candleClose(b, timeframe) <= this.now() / 1000 &&
      (!b.symbol || b.symbol === symbol) && (!b.timeframe || b.timeframe === timeframe));
    series.lastPollAt = this.now();
    if (candles.length < (this.config.scanner?.minHistory ?? warmupBars + 50)) {
      series.lastError = `insufficient history (${candles.length})`; return;
    }

    // Continuity vs the processing checkpoint: an outage longer than the window looks contiguous
    // inside a fresh fetch but silently skips candles. Backfill the hole before trusting signals.
    if (series.lastCandleTime != null && candles[0].time > series.lastCandleTime + step) {
      const from = series.lastCandleTime + step, to = candles[0].time - step;
      let backfilled = false;
      try {
        const backfill = await this.fetchRange?.({ symbol, timeframe, startTime: from, endTime: candles.at(-1).time, nowMs: this.now() });
        if (backfill?.length) {
          const closed = backfill.filter(b => b.closed !== false && candleClose(b, timeframe) <= this.now() / 1000 &&
            (!b.symbol || b.symbol === symbol) && (!b.timeframe || b.timeframe === timeframe));
          const merged = new Map([...candles.map(c => [c.time, c]), ...closed.map(c => [c.time, c])]);
          candles = [...merged.values()].sort((a, b) => a.time - b.time);
          backfilled = candles.every((c, i) => i === 0 || c.time - candles[i - 1].time === step);
        }
      } catch (error) { this.log(`backfill ${symbol} ${timeframe}: ${error.message}`); }
      if (!backfilled) { this.#markGap(series, from, to, 'checkpoint unreachable'); return; }
      this.#record({ type: 'META', event_id: `backfill-${symbol}-${timeframe}-${from}`,
        symbol, timeframe, reason: 'CHECKPOINT_BACKFILLED', details: { from, to } });
    }

    if (gaps.length) { this.#markGap(series, gaps[0].from, gaps.at(-1).to, `in-window x${gaps.length}`); return; }
    if (series.degraded) { series.degraded = false; series.lastError = null; }

    const tick = TICK[symbol] ?? TICK.default;
    const triggers = [];
    const higher = await this.higherStructures(symbol, timeframe, candles);
    for (const variant of this.config.variants) {
      // warmupBars inside the sliding window keep indicators converged; setups older than that can
      // never be (re)invented by a window shift, so journal identity stays exact across restarts.
      let result;
      try { result = runEngine({ candles, symbol, timeframe, variant, params: { tick, warmup: true, warmupBars } }); }
      catch (error) { series.lastError = `engine: ${error.message}`; return; }
      triggers.push(...result.events.filter(e => e.type === 'SETUP_CREATED'));
    }
    const fresh = [];
    const known = this.journal.events.filter(e => e.symbol === symbol && e.timeframe === timeframe &&
      e.type === 'SETUP_CREATED' && e.details?.reference && e.details?.targets?.length);
    const setups = new Map(known.map(e => [e.setup_id, { ...e, time: e.candle_time, setup: e.details.setup, receipts: {
      reference: e.details.reference, sl: e.details.sl, targets: e.details.targets, rr: e.details.rr } }]));
    const structuresAt = new Map();
    const rejected = new Set(this.journal.events.filter(e => e.type === 'META' && e.details?.type === 'NO_SIGNAL').map(e => e.event_id));
    for (const trigger of triggers) {
      if (setups.has(trigger.setup_id)) continue;
      if (rejected.has(`no-signal-${symbol}-${timeframe}-${trigger.time}`)) continue;
      const prefix = candles.filter(c => c.time <= trigger.time);
      const signalTime = candleClose(prefix.at(-1), timeframe);
      if (!structuresAt.has(signalTime)) structuresAt.set(signalTime, buildStructures({ candles: prefix, symbol, timeframe, signalTime }));
      const htfLevels = higher ? buildStructures({ ...higher, signalTime }) : {};
      const receipt = resolveLevels({ direction: trigger.side, entry: trigger.setup.entry_ref,
        atr14: atr14(prefix), tick, structures: structuresAt.get(signalTime), htfLevels,
        params: { symbol, timeframe, signalTime } });
      if (!receipt.accepted) {
        this.#record({ type: 'META', event_id: `no-signal-${symbol}-${timeframe}-${trigger.time}`,
          symbol, timeframe, candle_time: trigger.time, reason: receipt.reason,
          confirmed: true, details: { type: 'NO_SIGNAL', reason: receipt.reason, trigger_id: trigger.setup_id } });
        continue;
      }
      const { accepted, ...receipts } = receipt;
      const setup = { ...trigger.setup, sl: receipt.sl.price, zone: { lo: receipt.reference.bottom, hi: receipt.reference.top },
        trigger_level: trigger.variant === 'C' ? breakoutLevel(prefix, tick) : null,
        r_ref: Math.abs(trigger.setup.entry_ref - receipt.sl.price),
        tp1: receipt.targets[0]?.price, tp2: receipt.targets[1]?.price, tp3: receipt.targets[2]?.price };
      setups.set(trigger.setup_id, { ...trigger, setup, receipts });
    }
    const directions = trendDirections(candles);
    for (const trigger of setups.values()) {
      fresh.push(trigger);
      const { setup, receipts } = trigger;
      const d = trigger.side === 'LONG' ? 1 : -1;
      const prior = this.journal.events.filter(e => e.setup_id === trigger.setup_id);
      if (prior.some(e => ['SL_HIT', 'EXPIRED'].includes(e.type) || e.details?.completed)) continue;
      let hits = Math.max(0, ...prior.map(e => /^TP[123]_HIT$/.test(e.type) ? Number(e.type[2]) : 0));
      const lastProcessed = Math.max(trigger.time, ...prior.map(e => e.candle_time));
      const emit = (type, c, price, extra = {}) => fresh.push({ ...trigger, type, time: c.time, price, ...extra });
      for (const c of candles.filter(c => c.time > lastProcessed)) {
        const reached = price => d === 1 ? c.high >= price : c.low <= price;
        if (d === 1 ? c.low <= receipts.sl.price : c.high >= receipts.sl.price) {
          emit('SL_HIT', c, receipts.sl.price, { ambiguous: receipts.targets.slice(hits).some(t => reached(t.price)) }); break;
        }
        while (hits < receipts.targets.length && reached(receipts.targets[hits].price)) {
          const target = receipts.targets[hits++];
          emit(`TP${target.level}_HIT`, c, target.price, { completed: hits === receipts.targets.length });
        }
        if (hits === receipts.targets.length) break;
        const age = (c.time - setup.signal_time) / step;
        const invalid = trigger.variant === 'C' ? hits === 0 && Number.isFinite(setup.trigger_level) && d * (c.close - setup.trigger_level) < 0 : directions.get(c.time) !== d;
        if (invalid || age >= (trigger.variant === 'C' ? 24 : 36) && (trigger.variant === 'C' || hits === 0)) {
          emit('EXPIRED', c, c.close); break;
        }
      }
    }
    const order = { SETUP_CREATED: 0, TP1_HIT: 1, TP2_HIT: 2, TP3_HIT: 3, SL_HIT: 4, EXPIRED: 5 };
    fresh.sort((a, b) => a.time - b.time || order[a.type] - order[b.type]);
    // Alert floor: first sight marks visible history as seen so a restart can never telegraph old
    // setups; afterwards only events strictly newer than the last alerted candle are delivered.
    if (series.alertFloor == null) series.alertFloor = candles.at(-1).time;

    for (const event of fresh) {
      const details = { setup: event.setup, ...event.receipts, ambiguous: event.ambiguous === true, completed: event.completed === true };
      // Structured-event contract (LONG_SHORT:GA_SIGNAL): every engine emission is confirmed
      // (provisional state never leaves the engine); filter_state names the gate that allowed it.
      const filter_state = event.variant === 'C'
        ? (event.side === 'LONG' ? 'BREAKOUT_UP' : 'BREAKOUT_DOWN')
        : `${event.variant === 'B' ? 'ADX_QUALIFIED|' : ''}${event.side === 'LONG' ? 'TREND_UP' : 'TREND_DOWN'}`;
      const record = this.#record({
        type: event.type, event_id: `${event.setup_id}:${event.type}`, setup_id: event.setup_id, signal_id: event.setup_id,
        symbol: event.symbol, timeframe: event.timeframe, candle_time: event.time, price: event.price,
        side: event.side, variant: event.variant, source: 'ga-scanner', confirmed: true, filter_state,
        details: { ...details, text: alertText({ ...event, details }) },
      });
      if (!record.added || event.time < series.alertFloor) continue;
      series.alertFloor = Math.max(series.alertFloor, event.time);
      this.#alert(record.event);
    }
    series.primed = true;
    series.lastCandleTime = candles.at(-1).time;
    series.lastError = null;
  }
}

export function alertText(event) {
  const s = event.details?.setup ?? {};
  const dir = event.side === 'LONG' ? '🟢 UP' : '🔴 DOWN';
  const head = { SETUP_CREATED: `${dir} · setup ACTIVE`, TP1_HIT: '🎯 TP1 reached', TP2_HIT: '🎯 TP2 reached', TP3_HIT: '🎯 TP3 reached', SL_HIT: '🛑 SL reached', EXPIRED: '⏱ setup EXPIRED' }[event.type] ?? event.type;
  const receipt = event.details;
  const levels = receipt?.sl?.reason && receipt.sl.anchor_id
    ? `Entry(ref) ${s.entry_ref} | SL ${receipt.sl.price} (${receipt.sl.reason})\n${(receipt.targets ?? []).map(t => `TP${t.level} ${t.price} (${t.reason})`).join(' | ')}` : '';
  const zone = s.zone ? `\nRef zone ${s.zone.lo} … ${s.zone.hi}` : '';
  const reasons = s.reasons?.length ? `\nRules: ${s.reasons.join('; ')}` : '';
  const spot = event.side === 'SHORT' ? '\n(DOWN mô phỏng — spot không có short)' : '';
  const amb = event.details?.ambiguous ? '\n(nến ambiguous — SL bảo thủ cho phần còn lại)' : '';
  return `${head}\n${event.variant} · ${event.symbol} · ${event.timeframe.toUpperCase()} · ${event.side}${spot}\n${levels}${zone}${reasons}${amb}\nsetup ${event.setup_id}\nGA Signal LAB — mức theo dõi/mô phỏng, không phải khớp lệnh`;
}
