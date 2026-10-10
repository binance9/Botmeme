'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../services/jev/auditor/evidence.cjs');
const { profiles } = require('../services/jev/auditor/profiles.cjs');
const { SCOPES, assertAuditorReady } = require('../services/jev/auditor/gate.cjs');
test('CLI rejects unknown profiles and malformed baseline flags with a structured non-approval result', () => {
  for (const args of [['not-a-profile'], ['auditor-contract', '--baseline=../../private'], ['auditor-agent', '--exec=arbitrary']]) {
    const p = spawnSync(process.execPath, ['scripts/jev-audit.cjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
    assert.equal(p.status, 3);
    const result = JSON.parse(p.stderr);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.equal(result.receipt_id, result.id);
    assert.deepEqual(result.source.attempts, []);
    assert.ok(!p.stdout.includes('EVIDENCE_COLLECTED'));
  }
});
test('bootstrap gate requires every fixed official scope and cannot accept a subset or path traversal', () => {
  assert.deepEqual([...SCOPES].sort(), Object.keys(profiles).filter(n => n.startsWith('auditor-')).sort());
  assert.throws(() => assertAuditorReady({}), /AUDITOR_SCOPES_REQUIRED/);
  assert.throws(() => assertAuditorReady(Object.fromEntries(SCOPES.map(n => [n, '../unauthorized']))), /INVALID_AUDITOR_RECEIPT/);
});
