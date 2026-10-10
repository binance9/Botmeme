'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readInside } = require('./evidence.cjs');
const { canonical } = require('./contract.cjs');
const { assertFrozen } = require('./registry.cjs');
const { profiles } = require('./profiles.cjs');
const SCOPES = ['auditor-contract', 'auditor-agent', 'auditor-collector', 'auditor-dependencies', 'auditor-integrity', 'auditor-evidence-registry', 'auditor-acceptance', 'auditor-attribution', 'auditor-cli'];
function assertAuditorReady(receipts) {
  if (!receipts || canonical(Object.keys(receipts).sort()) !== canonical([...SCOPES].sort())) throw Error('AUDITOR_SCOPES_REQUIRED');
  for (const name of SCOPES) {
    const id = receipts[name];
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw Error('INVALID_AUDITOR_RECEIPT');
    const file = 'data/audits/' + id + '.json', receipt = JSON.parse(readInside(ROOT, file));
    const expected = profiles[name];
    if (receipt.result.receipt_id !== id || receipt.packet.scope !== expected.scope || canonical(receipt.packet.criteria) !== canonical(expected.criteria) || canonical(receipt.packet.documents.filter(d => d.kind === 'source').map(d => d.file)) !== canonical(expected.files)) throw Error('AUDITOR_SCOPE_MISMATCH');
    assertFrozen(path.join(ROOT, file), receipt.packet);
  }
  return true;
}
function writeAuditorGate(receipts) {
  assertAuditorReady(receipts);
  const file = path.join(ROOT, 'docs/audit/internal-auditor-gate.json');
  fs.writeFileSync(file, JSON.stringify({ status: 'PASS', scope: 'JEV Auditor bootstrap only', checkedAt: new Date().toISOString(), receipts, migrationPlan: 'CHUA_XAC_MINH', stage2Allowed: false }, null, 2));
  return file;
}
module.exports = { SCOPES, assertAuditorReady, writeAuditorGate };
