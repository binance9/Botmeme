'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('../runtime/events/bus.cjs');
const at = '2026-09-24T10:00:00.000Z', now = () => new Date(at);
function event(id = 'snapshot-1') {
  return { id, type: 'MarketSnapshot', timestamp: at, producer: 'MARKET_DATA', source: 'recovery-contract-check', evidence: ['observed-record-1'], status: 'OBSERVED', correlationId: 'scan-1', network: 'SOLANA', epoch: 1, confidence: 0.8, evidence_quality: 0.8, missing_evidence: [], uncertainty: 0.2, payload: { token: 'token-1', price: 1, liquidityUsd: 10000, volume24hUsd: 20000, observedAt: at } };
}
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-recovery-')), journalPath = path.join(directory, 'events.jsonl'), runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('botmeme-recovery-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, journalPath, open(file = journalPath) { const runtime = createRuntime({ journalPath: file, now }); runtimes.push(runtime); return runtime; } };
}
test('durable consumer replays an actual persisted unacknowledged event once after restart', async t => {
  const f = setup(t), first = f.open();
  let unexpected = 0;
  const detach = first.subscribeDurable('hunter', 'MarketSnapshot', () => { unexpected++; });
  await first.flush(); detach();
  first.publish(event()); await first.flush(); await first.close();
  assert.equal(unexpected, 0);
  const records = fs.readFileSync(f.journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).value);
  assert.ok(records.some(r => r.kind === 'consumer' && r.consumerId === 'hunter'));
  assert.ok(records.some(r => r.kind === 'event' && r.event.id === 'snapshot-1'));
  assert.equal(records.filter(r => r.kind === 'ack').length, 0);
  const second = f.open(), seen = [];
  second.subscribeDurable('hunter', 'MarketSnapshot', e => seen.push(e.id)); await second.flush();
  assert.deepEqual(seen, ['snapshot-1']);
  assert.equal(second.publish(event()).duplicate, true); await second.flush();
  assert.deepEqual(seen, ['snapshot-1']);
});
test('durable acknowledgments prevent already processed events from replaying on restart', async t => {
  const f = setup(t), first = f.open(), seen = [];
  first.subscribeDurable('hunter', 'MarketSnapshot', e => seen.push(e.id));
  first.publish(event()); await first.flush(); await first.close();
  assert.deepEqual(seen, ['snapshot-1']);
  const second = f.open();
  second.subscribeDurable('hunter', 'MarketSnapshot', e => seen.push(e.id)); await second.flush();
  assert.deepEqual(seen, ['snapshot-1']);
  second.publish(event('snapshot-2')); await second.flush();
  assert.deepEqual(seen, ['snapshot-1', 'snapshot-2']);
});
test('failed durable delivery stays unacknowledged and retries on restart', async t => {
  const f = setup(t), first = f.open(); let attempts = 0;
  first.subscribeDurable('hunter', 'MarketSnapshot', () => { attempts++; throw Error('A real consumer failure in a bounded recovery test.'); });
  first.publish(event()); await first.flush();
  assert.equal(attempts, 1); assert.equal(first.snapshot().deliveryErrors.length, 1);
  await first.close();
  const second = f.open();
  second.subscribeDurable('hunter', 'MarketSnapshot', () => { attempts++; }); await second.flush(); await second.close();
  assert.equal(attempts, 2);
  const third = f.open(); third.subscribeDurable('hunter', 'MarketSnapshot', () => { attempts++; }); await third.flush();
  assert.equal(attempts, 2);
});
test('journal directory junction alias cannot acquire a second writer lock', async t => {
  const f = setup(t), actual = path.join(f.directory, 'actual'), alias = path.join(f.directory, 'alias');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const first = f.open(path.join(actual, 'events.jsonl'));
  try {
    assert.throws(() => f.open(path.join(alias, 'events.jsonl')), error => error.code === 'EEXIST');
    first.publish(event()); await first.flush();
    assert.equal(first.snapshot().events.length, 1, 'Failed alias opener must not remove the active writer lock');
    assert.throws(() => f.open(path.join(alias, 'events.jsonl')), error => error.code === 'EEXIST');
  } finally { await first.close(); fs.unlinkSync(alias); }
});
test('durable consumer identity retains its subscribed type across detach and restart', async t => {
  const f = setup(t), first = f.open();
  const detach = first.subscribeDurable('hunter', 'MarketSnapshot', () => {}); await first.flush();
  assert.throws(() => first.subscribeDurable('hunter', 'MarketSnapshot', () => {}), /INVALID_DURABLE_CONSUMER/);
  detach();
  assert.throws(() => first.subscribeDurable('hunter', 'TokenCandidate', () => {}), /INVALID_DURABLE_CONSUMER/);
  await first.close();
  const second = f.open();
  assert.throws(() => second.subscribeDurable('hunter', '*', () => {}), /INVALID_DURABLE_CONSUMER/);
  assert.doesNotThrow(() => second.subscribeDurable('hunter', 'MarketSnapshot', () => {}));
  await second.flush();
});

test('journal hard-link aliases cannot create independent writer identities', async t => {
  const f = setup(t), original = path.join(f.directory, 'hard-original.jsonl'), alias = path.join(f.directory, 'hard-alias.jsonl');
  const first = f.open(original); await first.close();
  fs.linkSync(original, alias);
  assert.throws(() => f.open(original), /RUNTIME_JOURNAL_HARDLINK_DENIED/);
  assert.throws(() => f.open(alias), /RUNTIME_JOURNAL_HARDLINK_DENIED/);
});
