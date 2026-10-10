'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

// Exclusive writer; a crashed writer leaves a lock for explicit recovery rather
// than risking two writers or silently repairing a truncated financial journal.
// An orphaned lock (owner PID no longer alive) is recovered automatically so a
// hard-killed run cannot keep the next start from ever booting.
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function openJournal(filename, capitalUsd = 10000) {
  if (filename) {
    filename = path.resolve(filename);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    // The journal is an operational ledger: replaying a multi-day 100 MB file at
    // every boot starves startup. Oversized ledgers are archived verbatim (the
    // audit trail stays on disk) and the runtime opens a fresh page.
    filename = fs.existsSync(filename) ? fs.realpathSync(filename) : path.join(fs.realpathSync(path.dirname(filename)), path.basename(filename));
    if (fs.existsSync(filename) && fs.statSync(filename).nlink > 1) throw Error('RUNTIME_JOURNAL_HARDLINK_DENIED');
  }
  let fd = null, lockFd = null, closed = false, sequence = 0, previous = null, lastFsyncAt = 0;
  const records = [], lock = filename && filename + '.lock';
  let anchor = null, capitalEvents = [];
  // Windows fsync on an append-only journal costs 10-200 ms per call; syncing
  // every record pegged the event loop for seconds at a time and stalled the
  // whole dashboard. Records always reach the OS buffer immediately; the disk
  // is force-synced at most once per second (durable appends force one) — a
  // crash can lose at most the last second of records, never corrupt the file.
  const FSYNC_MIN_INTERVAL_MS = 1000;
  function close() {
    closed = true;
    if (fd !== null) { fs.closeSync(fd); fd = null; }
    if (lockFd !== null) { fs.closeSync(lockFd); lockFd = null; fs.unlinkSync(lock); }
  }
  try {
    if (filename) {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      try {
        lockFd = fs.openSync(lock, 'wx');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A lock owned by a LIVE process is a genuine concurrent writer — the
        // original EEXIST surfaces. Only an orphaned lock (dead owner PID) is
        // recovered automatically so a hard-killed run cannot block the next boot.
        const owner = Number(fs.readFileSync(lock, 'utf8').trim());
        if (processAlive(owner)) throw error;
        fs.rmSync(lock, { force: true });
        lockFd = fs.openSync(lock, 'wx');
      }
      fs.writeFileSync(lockFd, String(process.pid));
      anchor = require('../capital-ledger.cjs').createCapitalAnchor(filename, capitalUsd);
      // Checkpoint BEFORE rename and only AFTER acquiring the exclusive lock.
      // Repeated recovery is idempotent because accounting events retain IDs.
      if (fs.existsSync(filename) && fs.statSync(filename).size > 20 * 1024 * 1024) {
        const archive = filename + '.' + new Date().toISOString().replace(/[:.]/g, '-') + '.archive';
        anchor.importFile(filename); anchor.registerArchive(archive); anchor.checkpoint();
        fs.renameSync(filename, archive);
      }
      const content = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
      if (content && !content.endsWith('\n')) throw Error('INCOMPLETE_RUNTIME_JOURNAL');
      for (const line of content.split('\n').filter(Boolean)) {
        const record = JSON.parse(line);
        if (Object.keys(record).sort().join(',') !== 'hash,previous,sequence,value' || record.sequence !== sequence + 1 || record.previous !== previous || record.hash !== digest({ sequence: record.sequence, previous: record.previous, value: record.value })) throw Error('INVALID_RUNTIME_JOURNAL');
        records.push(record.value); sequence = record.sequence; previous = record.hash;
      }
      const currentIds = new Set(records.filter(r => r.kind === 'event').map(r => r.event.id));
      capitalEvents = anchor.events().filter(e => !currentIds.has(e.id));
      for (const r of records) if (r.kind === 'event') anchor.add(r.event);
      anchor.checkpoint();
      fd = fs.openSync(filename, 'a');
    }
  } catch (error) { close(); throw error; }
  return {
    solAnchor: () => anchor?.sol() ?? null,
    paperWithdrawals: () => anchor?.withdrawals() ?? [],
    withdrawSol: input => {
      if (closed) throw Error('RUNTIME_JOURNAL_CLOSED');
      if (!anchor) throw Object.assign(Error('Durable paper SOL ledger unavailable'), { status: 400 });
      return anchor.withdraw(input);
    },
    solReference: (priceUsd, at) => anchor?.reference(priceUsd, at),
    capitalEvents: structuredClone(capitalEvents),
    capitalHistoryGroups: structuredClone(anchor?.legacy() ?? []),
    records: structuredClone(records),
    append(value, durable = true) {
      if (closed) throw Error('RUNTIME_JOURNAL_CLOSED');
      const body = { sequence: sequence + 1, previous, value };
      const record = { ...body, hash: digest(body) };
      try {
        if (fd !== null) {
          fs.writeFileSync(fd, JSON.stringify(record) + '\n');
          const nowMs = Date.now();
          const fill = value.kind === 'event' && value.event.type === 'TradeResult';
          if (fill || durable && nowMs - lastFsyncAt >= FSYNC_MIN_INTERVAL_MS) { fs.fsyncSync(fd); lastFsyncAt = nowMs; }
          if (value.kind === 'event') anchor.add(value.event);
          if (fill) anchor.checkpoint();
        }
      }
      catch { closed = true; throw Error('RUNTIME_JOURNAL_WRITE_FAILED'); }
      sequence = record.sequence; previous = record.hash;
      return sequence;
    },
    close
  };
}
module.exports = { openJournal, canonical };
