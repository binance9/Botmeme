'use strict';
// Real read-only facts for reviewing the existing plan. This is not an AI verdict
// and never starts legacy runtime, tests, wallets, signers or network providers.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ROOT, LEGACY, readInside } = require('../services/jev/auditor/evidence.cjs');
const planText = readInside(ROOT, 'docs/audit/memepilot-migration.json');
const plan = JSON.parse(planText), failures = [], names = new Set(), counts = {};
for (const row of plan.decisions) {
  if (names.has(row.file)) failures.push({ file: row.file, code: 'DUPLICATE_DECISION' });
  names.add(row.file);
  for (const key of ['file', 'purpose', 'quality', 'decision', 'destination', 'reason', 'risks', 'sha256']) if (typeof row[key] !== 'string' || !row[key].trim()) failures.push({ file: row.file, code: 'MISSING_' + key });
  if (!['KEEP', 'PORT', 'REWRITE', 'DROP'].includes(row.decision)) failures.push({ file: row.file, code: 'INVALID_DECISION' });
  counts[row.decision] = (counts[row.decision] ?? 0) + 1;
  if (!Array.isArray(row.currentDependencies) || row.currentDependencies.includes(',')) failures.push({ file: row.file, code: 'INVALID_DEPENDENCY_METADATA' });
  if (row.decision === 'DROP' && row.destination.startsWith('tests/v2')) failures.push({ file: row.file, code: 'DROP_CANNOT_PORT' });
  try {
    readInside(LEGACY, row.file); // Canonical path checks before raw-byte hashing.
    const hash = createHash('sha256').update(fs.readFileSync(path.join(LEGACY, row.file))).digest('hex');
    if (hash !== row.sha256) failures.push({ file: row.file, code: 'LEGACY_SOURCE_CHANGED' });
  } catch { failures.push({ file: row.file, code: 'LEGACY_SOURCE_UNAVAILABLE' }); }
}
if (names.size !== 85) failures.push({ code: 'EXPECTED_EXISTING_85_DECISIONS' });
if (plan.autonomyContract !== 'docs/AUTONOMOUS-INTELLIGENCE.md') failures.push({ code: 'MISSING_AUTONOMY_CONTRACT' });
const requiredDrops = ['src/robinhood-signer.mjs', 'src/robinhood-autopilot.mjs', 'src/live-trade.mjs'];
for (const file of requiredDrops) if (plan.decisions.find(r => r.file === file)?.decision !== 'DROP') failures.push({ file, code: 'FORBIDDEN_LEGACY_EXECUTION' });
for (const file of ['src/runtime.mjs', 'src/server.mjs', 'src/paper-engine.mjs']) if (plan.decisions.find(r => r.file === file)?.decision !== 'REWRITE') failures.push({ file, code: 'WHOLESALE_LEGACY_IMPORT_FORBIDDEN' });
console.log(JSON.stringify({ kind: 'MIGRATION_PLAN_FACT_CHECK_NOT_ACCEPTANCE', timestamp: new Date().toISOString(), planSha256: createHash('sha256').update(planText).digest('hex'), decisionsChecked: names.size, counts, failures, legacyWrites: false, legacyExecution: false, stage2Authorized: false }, null, 2));
process.exitCode = failures.length ? 1 : 0;
