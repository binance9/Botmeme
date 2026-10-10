// LAB signal journal — append-only JSONL, the single source shared by chart, history and Telegram.
// Mirrors the production BotJournal pattern (GA-TRADE-CHART bot-bridge/journal.mjs) with two
// LAB-specific differences per review: full-file reload (no 5k tail cap) and identity [event_id, type].
import fs from 'node:fs';
import path from 'node:path';

export const JOURNAL_TYPES = Object.freeze([
  'SETUP_CREATED', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'SL_HIT', 'EXPIRED',
  'META', // scanner status / data gaps / telegram notices (never a trading signal)
]);

export function validateJournalEvent(event) {
  if (!event || typeof event !== 'object') throw new TypeError('journal event must be an object');
  if (!JOURNAL_TYPES.includes(event.type)) throw new RangeError(`Invalid journal type: ${event.type}`);
  for (const key of ['event_id', 'symbol', 'timeframe']) {
    if (typeof event[key] !== 'string' || !event[key]) throw new TypeError(`journal ${key} must be a non-empty string`);
  }
  if (event.type !== 'META' && !Number.isFinite(event.candle_time)) throw new TypeError('journal candle_time must be finite');
  return event;
}

export class LabJournal {
  constructor({ dir, now = Date.now } = {}) {
    if (typeof dir !== 'string' || !dir) throw new TypeError('dir is required');
    this.dir = dir;
    this.file = path.join(dir, 'journal.jsonl');
    this.now = now;
    this.events = [];
    this.seq = 0;
    this.#seen = new Set();
    this.subscribers = new Set();
    this.loadError = null;
    this.#load();
  }
  #seen;
  #load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) return;
    const raw = fs.readFileSync(this.file, 'utf8');
    const lines = raw.split('\n');
    if (raw.length && !raw.endsWith('\n')) {
      this.loadError = this.#integrityError('JOURNAL_TORN_TAIL', lines.length,
        'unterminated last record; restore the journal before appending');
      lines.pop(); // Keep intact records readable; raw bytes remain untouched on disk.
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let event;
      try { event = validateJournalEvent(JSON.parse(line)); }
      catch (cause) {
        throw this.#integrityError('JOURNAL_CORRUPT_RECORD', i + 1, cause.message);
      }
      this.events.push(event);
      if (Number.isFinite(event.seq) && event.seq > this.seq) this.seq = event.seq;
      this.#seen.add(this.#identity(event));
    }
  }
  #integrityError(code, line, reason) {
    const error = new Error(`${code}: ${this.file}${line ? ` line ${line}` : ''}: ${reason}; original bytes preserved`);
    error.code = code;
    return error;
  }
  #assertAppendable() {
    if (this.loadError) throw this.loadError;
    // A previous failed write may have persisted only part of a record. Never
    // concatenate a retry onto it, even without restarting this journal instance.
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 10) {
          this.loadError = this.#integrityError('JOURNAL_TORN_TAIL', null,
            'unterminated last record; restore the journal before appending');
          throw this.loadError;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  #identity(event) { return JSON.stringify([event.event_id, event.type]); }
  subscribe(callback) { this.subscribers.add(callback); return () => this.subscribers.delete(callback); }

  append(event) {
    validateJournalEvent(event);
    this.#assertAppendable();
    const identity = this.#identity(event);
    if (this.#seen.has(identity)) {
      const existing = [...this.events].reverse().find(item => this.#identity(item) === identity);
      return { added: false, event: existing };
    }
    const record = Object.freeze({ ...event, seq: this.seq + 1, ts: Number.isFinite(event.ts) ? event.ts : this.now(), details: event.details ?? {} });
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    this.seq = record.seq;
    this.events.push(record);
    this.#seen.add(identity);
    for (const callback of this.subscribers) { try { callback(record); } catch { /* one bad SSE client must not kill the loop */ } }
    return { added: true, event: record };
  }
  tail(n = 500) { return this.events.slice(-n); }
  since(seq) { return this.events.filter(event => event.seq > seq); }
  // Latest journal state per setup_id (for the UI layer and /state).
  setupIndex() {
    const index = new Map();
    for (const event of this.events) {
      if (event.type === 'META' || !event.setup_id) continue;
      index.set(event.setup_id, event);
    }
    return index;
  }
}
