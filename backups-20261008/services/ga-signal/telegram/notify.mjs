// LAB Telegram outbox — durable queue with per-setup dedupe, retry with backoff and honest delivery states.
// Delivery is AT-LEAST-ONCE at best: a send whose ACK is lost is marked SENT_UNCONFIRMED, never "exactly once".
// Credentials come ONLY from env (GA_TG_TOKEN/GA_TG_CHAT) or secrets/telegram.json — never source/log/report.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const messageFor = event => {
  const dir = event.side === 'LONG' ? '🟢 UP' : '🔴 DOWN';
  const s = event.details?.setup ?? {};
  const spot = event.side === 'SHORT' ? '\n(note: DOWN is simulated — spot short not modeled)' : '';
  const levels = [s.entry_ref, s.sl, s.tp1, s.tp2, s.tp3].every(Number.isFinite)
    ? `Entry(ref) ${s.entry_ref}\nSL ${s.sl}\nTP1 ${s.tp1}\nTP2 ${s.tp2}\nTP3 ${s.tp3}\nR ${s.r_ref}` : '';
  const zone = s.zone ? `\nRef zone ${s.zone.lo}…${s.zone.hi}` : '';
  const reasons = s.reasons?.length ? `\nRules: ${s.reasons.join('; ')}` : '';
  const head = { SETUP_CREATED: `${dir} · ${event.variant} · setup ACTIVE`, TP1_HIT: `🎯 TP1 reached`, TP2_HIT: `🎯 TP2 reached`, TP3_HIT: `🎯 TP3 reached`, SL_HIT: `🛑 SL reached`, EXPIRED: `⏱ Setup EXPIRED` }[event.type] ?? event.type;
  const amb = event.details?.ambiguous ? '\n(ambiguous candle: conservative SL on remainder)' : '';
  return `${head}\n${event.variant} · ${event.symbol} · ${event.timeframe.toUpperCase()} · ${event.side}${spot}\n${levels}${zone}${reasons}${amb}\nsetup ${event.setup_id}\n(GA Signal LAB — tracking/simulation levels, not fills)`;
};

export class Outbox {
  // sender: async (text) => true (acked) | false (sent but unconfirmed); injected for tests/simulation.
  constructor({ dir, sender = null, now = Date.now, maxAttempts = 5, backoffMs = 3000, apiBase = 'https://api.telegram.org' } = {}) {
    if (typeof dir !== 'string' || !dir) throw new TypeError('dir is required');
    this.dir = dir; this.file = path.join(dir, 'outbox.jsonl');
    this.now = now; this.maxAttempts = maxAttempts; this.backoffMs = backoffMs; this.apiBase = apiBase;
    this.credentials = this.#loadCredentials();
    this.sender = sender ?? (this.credentials ? this.#httpSender() : null);
    this.items = new Map(); // msg_id -> {msg_id, setup_id, type, text, status, attempts, next_at, error, ts}
    this.simulated = !this.sender;
    this.#load();
  }
  #loadCredentials() {
    if (process.env.GA_TG_TOKEN && process.env.GA_TG_CHAT) return { token: process.env.GA_TG_TOKEN, chat_id: process.env.GA_TG_CHAT };
    const file = path.join(this.dir, '..', 'secrets', 'telegram.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.token && raw.chat_id) return { token: String(raw.token), chat_id: String(raw.chat_id) };
    } catch { /* absent secrets file -> simulation mode */ }
    return null;
  }
  #httpSender() {
    return async text => {
      try {
        const res = await fetch(`${this.apiBase}/bot${this.credentials.token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.credentials.chat_id, text }),
        });
        if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
        const body = await res.json().catch(() => null);
        return body?.ok === true;
      } catch { return false; }
    };
  }
  #load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        const item = this.items.get(record.msg_id);
        if (!item && record.kind === 'MSG') this.items.set(record.msg_id, record);
        else if (item && record.kind === 'STATUS') Object.assign(item, { status: record.status, attempts: record.attempts ?? item.attempts, error: record.error ?? item.error, next_at: record.next_at ?? item.next_at });
      } catch { /* torn tail — ignore */ }
    }
    // A crash mid-send leaves SENDING behind: treat it as unsent so delivery stays at-least-once.
    for (const item of this.items.values()) if (item.status === 'SENDING') item.status = 'PENDING';
  }
  #write(record) { fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`); }
  #status(msg_id, patch) {
    const item = this.items.get(msg_id);
    Object.assign(item, patch);
    this.#write({ kind: 'STATUS', msg_id, status: item.status, attempts: item.attempts, next_at: item.next_at ?? null, error: item.error ?? null, ts: this.now() });
  }
  msgId(setupId, type) { return createHash('sha256').update(`${setupId}|${type}`).digest('hex').slice(0, 24); }

  enqueue({ setup_id, type, text, ts }) {
    const msg_id = this.msgId(setup_id, type);
    const existing = this.items.get(msg_id);
    if (existing) return { queued: false, msg_id, status: existing.status };
    const item = { kind: 'MSG', msg_id, setup_id, type, text, status: 'PENDING', attempts: 0, next_at: this.now(), ts: ts ?? this.now() };
    this.items.set(msg_id, item);
    this.#write(item);
    return { queued: true, msg_id, status: item.status };
  }
  // One pump pass: send every due PENDING item. Serialized — a slow HTTP send must never let the
  // next tick double-send an item that is still awaiting its acknowledgement.
  async pump() {
    if (this.pumping) return 0;
    this.pumping = true;
    let processed = 0;
    try {
      for (const item of this.items.values()) {
        if (item.status !== 'PENDING' || item.next_at > this.now()) continue;
        processed++;
        if (this.simulated) { this.#status(item.msg_id, { status: 'SIMULATED', error: null }); continue; }
        this.#status(item.msg_id, { status: 'SENDING' });
        let acked = false, error = null;
        try { acked = await this.sender(item.text); if (!acked) error = 'send failed or unconfirmed'; }
        catch (caught) { error = caught.message; }
        const attempts = item.attempts + 1;
        if (acked === true) this.#status(item.msg_id, { status: 'SENT', attempts, error: null });
        else if (attempts >= this.maxAttempts) this.#status(item.msg_id, { status: 'FAILED', attempts, error });
        else this.#status(item.msg_id, { status: 'PENDING', attempts, error, next_at: this.now() + this.backoffMs * 2 ** (attempts - 1) });
      }
    } finally { this.pumping = false; }
    return processed;
  }
  async sendTest() {
    const text = `GA Signal LAB · telegram test · ${new Date(this.now()).toISOString()}${this.simulated ? '\nSIMULATION MODE (no credentials configured)' : ''}`;
    if (this.simulated) {
      const item = { kind: 'MSG', msg_id: this.msgId('lab-test', 'TEST'), setup_id: 'lab-test', type: 'TEST', text, status: 'PENDING', attempts: 0, next_at: this.now(), ts: this.now() };
      this.items.set(item.msg_id, item); this.#write(item);
      await this.pump();
      return { simulated: true, status: this.items.get(item.msg_id).status };
    }
    const acked = await this.sender(text);
    return { simulated: false, acked, status: acked === true ? 'SENT' : 'SENT_UNCONFIRMED' };
  }
  status() {
    const counts = { PENDING: 0, SENT: 0, SENT_UNCONFIRMED: 0, SIMULATED: 0, FAILED: 0 };
    for (const item of this.items.values()) counts[item.status] = (counts[item.status] ?? 0) + 1;
    return { configured: !this.simulated, simulated: this.simulated, counts, lastError: [...this.items.values()].reverse().find(item => item.error)?.error ?? null };
  }
}
