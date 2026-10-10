'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Index only immutable journal fills. Epoch changes never reset performance.
function createOverview({ runtime, journalPath } = {}) {
  const ids = new Set(), networks = new Map(), files = new Map();
  let ready = !journalPath, error = null, pending = null, lastRead = -Infinity;
  function add(event) {
    if (event?.type !== 'TradeResult' || !['paper', 'live'].includes(event.payload.mode) || ids.has(event.id)) return;
    const at = Date.parse(event.timestamp), p = event.payload;
    if (!Number.isFinite(at) || !Number.isFinite(p.realizedPnl)) throw Error('INVALID_OVERVIEW_FILL');
    ids.add(event.id);
    const key = event.network + ':' + p.mode;
    let index = networks.get(key);
    if (!index) networks.set(key, index = { rows: [], dirty: false });
    index.rows.push({ at, realized: p.state === 'CLOSED' ? p.realizedPnl : 0, closed: p.state === 'CLOSED' ? 1 : 0, win: p.state === 'CLOSED' && p.realizedPnl > 0 ? 1 : 0 });
    index.dirty = true;
  }
  for (const group of runtime.capitalHistoryGroups?.() ?? []) for (const event of group) add(event);
  for (const event of runtime.capitalEvents?.() ?? []) add(event);
  for (const event of runtime.snapshot().events) add(event);
  const off = runtime.subscribe('TradeResult', add);
  async function read() {
    const dir = path.dirname(journalPath), base = path.basename(journalPath);
    const names = (await fs.promises.readdir(dir)).filter(n => n === base || n.startsWith(base + '.') && n.endsWith('.archive')).sort();
    if (!names.includes(base)) throw Error('OVERVIEW_JOURNAL_MISSING');
    for (const name of names) {
      const filename = path.join(dir, name), stat = await fs.promises.stat(filename);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      const previous = files.get(filename);
      const start = previous?.identity === identity && previous.offset <= stat.size ? previous.offset : 0;
      if (start === stat.size) continue;
      // Consume complete lines only; an in-flight append is retried next refresh.
      let offset = start;
      const stream = fs.createReadStream(filename, { start, end: stat.size - 1 });
      let tail = Buffer.alloc(0);
      try {
        for await (const chunk of stream) {
          tail = Buffer.concat([tail, chunk]);
          let end;
          while ((end = tail.indexOf(10)) !== -1) {
            const record = JSON.parse(tail.subarray(0, end).toString('utf8'));
            if (record.value?.kind === 'event') add(record.value.event);
            offset += end + 1;
            tail = tail.subarray(end + 1);
          }
        }
      } finally { stream.destroy(); }
      files.set(filename, { identity, offset });
    }
    ready = true; error = null;
  }
  function refresh(force = false) {
    if (!journalPath) return Promise.resolve();
    if (pending) return pending;
    if (!force && Date.now() - lastRead < 15000) return Promise.resolve();
    lastRead = Date.now();
    pending = read().catch(e => { error = e.message; }).finally(() => { pending = null; });
    return pending;
  }
  function window(network, start, end) {
    if (!ready || error) return { totalTrades: null, realizedPnlUsd: null, winRate: null, closedTrades: null };
    const index = networks.get(network);
    if (!index) return { totalTrades: 0, realizedPnlUsd: 0, winRate: null, closedTrades: 0 };
    if (index.dirty) {
      index.rows.sort((a,b) => a.at-b.at);
      let realized = 0, closed = 0, wins = 0;
      for (const row of index.rows) { realized += row.realized; closed += row.closed; wins += row.win; row.sum = { realized, closed, wins }; }
      index.dirty = false;
    }
    const rows = index.rows;
    function bound(time, inclusive) {
      let lo = 0, hi = rows.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].at < time || inclusive && rows[mid].at === time) lo = mid + 1; else hi = mid; }
      return lo;
    }
    const a = bound(start, false), b = bound(end, true), zero = { realized: 0, closed: 0, wins: 0 };
    const before = rows[a-1]?.sum ?? zero, after = rows[b-1]?.sum ?? zero;
    const closed = after.closed-before.closed;
    return { totalTrades: b-a, realizedPnlUsd: after.realized-before.realized, closedTrades: closed, winRate: closed ? 100*(after.wins-before.wins)/closed : null };
  }
  function snapshot(network, clock, mode = 'paper') {
    // Include committed fills even before asynchronous subscribers are delivered.
    for (const event of runtime.snapshot().events) add(event);
    const day = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate());
    const month = new Date(clock.getFullYear(), clock.getMonth(), 1);
    return { status: error ? 'error' : ready ? 'ready' : 'loading', error,
      today: { start: day.toISOString(), ...window(network + ':' + mode, +day, +clock) },
      month: { start: month.toISOString(), ...window(network + ':' + mode, +month, +clock) } };
  }
  refresh();
  return { snapshot, refresh, close: off };
}
module.exports = { createOverview };
