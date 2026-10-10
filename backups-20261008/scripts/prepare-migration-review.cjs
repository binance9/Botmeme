'use strict';
// Correct the existing plan metadata only. This never approves or ports a module.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ROOT, LEGACY, readInside } = require('../services/jev/auditor/evidence.cjs');
const { importsOf } = require('../services/jev/auditor/dependencies.cjs');
const { sha256, canonical } = require('../services/jev/auditor/contract.cjs');
const file = path.join(ROOT, 'docs/audit/memepilot-migration.json');
const beforeText = fs.readFileSync(file, 'utf8'), plan = JSON.parse(beforeText.replace(/^\uFEFF/, ''));
if (plan.decisions.length !== 85 || plan.status !== 'PENDING_INTERNAL_JEV_AUDITOR') throw Error('UNEXPECTED_PLAN_BASELINE');
const beforeRows = structuredClone(plan.decisions);
const additions = {
  'src/ceo.mjs': 'The new commander requires persistent world state, objectives, uncertainty, task planning, evidence synthesis, risk awareness, an auditable NO_ACTION decision and failure recovery; a subprocess transport alone is not a decision brain.',
  'src/ceo-schema.json': 'New decision contracts must include confidence, evidence_quality, missing_evidence, uncertainty, regime, network, strategy version and the full causal evidence chain.',
  'src/runtime.mjs': 'Rewrite event-driven autonomous observation/decision/learning orchestration, START/STOP, durable tasks, module isolation and network-switch cancellation; never auto-BUY on candidate arrival.',
  'src/paper-policy.mjs': 'Implement the retained invariants behind an independent Risk Engine with unconditional veto, exposure/sizing/liquidity/concentration/drawdown/cooldown limits. Regime and uncertainty constrain risk.',
  'src/paper-engine.mjs': 'Keep strategy evaluation, independent risk approval, intent creation and paper fills separate; all actions require approved immutable evidence and network identity.',
  'src/store.mjs': 'Persist candidates, positions, strategies/champion/challengers, regime, AI tasks, failures, risk state, decision journal, performance attribution and unresolved anomalies.',
  'src/solana-source.mjs': 'The hunter proactively ranks candidates for the active network; switching away cancels or quarantines SOL work and rejects stale cross-network results.',
  'src/source.mjs': 'Discovery must use the selected network universe and verified provider capabilities; no hidden fallback to another chain.',
  'src/wallet-connection.mjs': 'Changing active network must drive the matching hunter/provider subscriptions. Existing positions/history retain original network identity; unsupported Robinhood/provider capability remains CHUA_XAC_MINH.'
};
for (const row of plan.decisions) {
  if (row.decision === 'DROP' && row.file.startsWith('tests/')) {
    row.destination = 'none; historical evidence only';
    row.reason = 'Do not port this test artifact because it targets excluded live execution, autopilot or legacy UI. Preserve it only as historical audit evidence.';
  }
  if (['src/gmgn.mjs', 'public-desk/wallet-providers.mjs'].includes(row.file)) row.currentDependencies = importsOf(readInside(LEGACY, row.file), row.file);
  if (row.file === 'src/solana-source.mjs') row.risks = row.risks.replace('JEV granular review supports decoder PORT but requires independent SDK/deployed-layout proof for quotes: CHUA_XAC_MINH, excluded from approved port.', 'Historical auxiliary classifier suggested decoder PORT; this has no acceptance authority. SDK/deployed-layout proof for quotes remains CHUA_XAC_MINH and is excluded from any authorized port.');
  if (additions[row.file] && !row.reason.includes(additions[row.file])) row.reason += ' ' + additions[row.file];
  if (row.file === 'src/paper-policy.mjs') row.destination = 'core/risk; core/market-data/validation';
  if (row.file === 'src/paper-engine.mjs') row.destination = 'core/strategy; core/risk; core/execution; core/trades; core/performance';
}
const missing = [
  'Autonomous commander with durable world state, uncertainty, planning, NO_ACTION, decision journal and failure recovery',
  'Independent Risk Engine veto and regime-sensitive sizing/exposure/cooldown',
  'Confidence, evidence_quality, missing_evidence and uncertainty in typed AI results',
  'Proactive degradation, missed-opportunity, abstention and performance-attribution feedback',
  'Network-switch cancellation, stale-event rejection, network-qualified history and capability gates'
];
plan.missingCapabilities = [...new Set([...plan.missingCapabilities, ...missing])];
plan.note = 'Existing decisions are proposals only. Historical TypeSafe labels have no acceptance authority. Every row requires a current internal JEV Auditor review; CHUA_XAC_MINH cannot authorize a port. Autonomy requirements are mandatory future acceptance criteria, not implemented capabilities.';
plan.autonomyContract = 'docs/AUTONOMOUS-INTELLIGENCE.md';
const rows = plan.decisions.map((after, i) => ({ file: after.file, before: beforeRows[i], after })).filter(r => canonical(r.before) !== canonical(r.after));
const afterText = JSON.stringify(plan, null, 2);
if (canonical(JSON.parse(beforeText.replace(/^\uFEFF/, ''))) === canonical(plan)) { console.log('PLAN_ALREADY_PREPARED'); process.exit(0); }
const revision = { id: randomUUID(), timestamp: new Date().toISOString(), kind: 'METADATA_CORRECTION_NOT_ACCEPTANCE', beforeSha256: sha256(beforeText), afterSha256: sha256(afterText), rows, addedRequirements: missing, authority: 'Owner autonomy requirements and independent implementation review; pending JEV migration acceptance' };
fs.writeFileSync(path.join(ROOT, 'docs/audit/migration-plan-revision-' + revision.id + '.json'), JSON.stringify(revision, null, 2), { flag: 'wx' });
fs.writeFileSync(file, afterText);
const markdown = path.join(ROOT, 'docs/audit/MEMEPILOT-AUDIT.md');
const escape = x => String(x).replaceAll('|', '\\|').replaceAll('\n', ' ');
let body = fs.readFileSync(markdown, 'utf8').replace('original JEV receipts', 'historical auxiliary classifier receipts');
for (const row of plan.decisions) {
  const line = '| ' + [row.file, row.purpose, row.currentDependencies.join(', '), row.quality, row.decision, row.destination, row.reason, row.risks].map(escape).join(' | ') + ' |';
  body = body.split('\n').map(old => old.startsWith('| ' + row.file + ' |') ? line : old).join('\n');
}
if (!body.includes('## Autonomous intelligence requirements')) body += '\n\n## Autonomous intelligence requirements\n\nThe binding owner contract is docs/AUTONOMOUS-INTELLIGENCE.md. Commander reasoning/state, independent risk veto, regime, autonomous feedback and network-aware scanning are mandatory future acceptance requirements. They are not implemented or accepted by this migration map.\n';
fs.writeFileSync(markdown, body);
console.log(JSON.stringify({ status: 'PENDING_INTERNAL_JEV_AUDITOR', decisions: plan.decisions.length, correctedRows: rows.length, revision: revision.id, legacyWrites: false, portAuthorized: false }));
