'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApplication } = require('../runtime/application.cjs');
test('scanner resumes after close/reopen; explicit STOP persists across boot', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-scanner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { journalPath: path.join(dir, 'test.jsonl'), capitalUsd: 10000,
    providers: { SOLANA: { network: 'SOLANA', async discover() { return []; }, async snapshot() { throw Error('UNEXPECTED'); } } } };
  let app = createApplication(options); t.after(async () => { if (app) await app.close(); });
  await app.connect({ network: 'SOLANA', chainId: 'mainnet-beta', address: 'So11111111111111111111111111111111111111112', provider: 'test' });
  await app.start(); assert.equal(app.control().running, true);
  await app.close(); app = null;
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'scanner-state.json'))).running, true);
  app = createApplication(options); await app.setTakeProfit(10);
  assert.equal(app.control().running, true);
  await app.stop(); await app.close(); app = null;
  app = createApplication(options); await app.setTakeProfit(10);
  assert.equal(app.control().running, false);
  await app.close(); app = null;
});
