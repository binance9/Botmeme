'use strict';
// Live critic calibration against real revoked observations, never a module PASS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const contractReceipt = require('../../data/audits/6b410dfd-0c95-4433-b5db-70958345a48a.json');
const agentReceipt = require('../../data/audits/c376210a-188c-4fd2-8df9-d645d27883e7.json');
const { buildRegistry } = require('../../services/jev/auditor/evidence-registry.cjs');
const { buildAttributionInput } = require('../../services/jev/auditor/attribution.cjs');
const { OllamaReviewer } = require('../../services/jev/auditor/ollama.cjs');
const { assertNoSecrets } = require('../../services/jev/auditor/secrets.cjs');

function calibration() {
  const documents = [contractReceipt, agentReceipt].flatMap(r => r.packet.documents.filter(d => d.kind === 'source')).map((d, index) => ({ ...d, id: 'historical-source-' + index }));
  const criterion = { id: 'claim-attribution', requirement: 'Check whether each exact quoted source supports its attached claim. This calibration cannot authorize any module.', evidenceKinds: ['source'] };
  const packet = { scope: 'Live attribution calibration only', criteria: [criterion], documents };
  const entries = buildRegistry(packet).entries;
  const oldObservation = (record, id, match) => record.result.checks.find(c => c.criterion_id === id).observations.find(o => o.quote.includes(match));
  const bad = [
    oldObservation(contractReceipt, 'contract', 'const id = value'),
    oldObservation(contractReceipt, 'secrets', 'for (const cause of result.root_causes)'),
    oldObservation(agentReceipt, 'model-boundary', 'answer = await reviewer.review')
  ];
  assert.ok(bad.every(Boolean), 'The actual historical counterexamples must remain present.');
  const observations = bad.map(o => ({ evidence_id: entries.find(e => e.quote === o.quote).id, explanation: o.explanation }));
  const good = entries.find(e => e.file.endsWith('/secrets.cjs') && e.quote.includes('if (quoted.test(value) || bearer.test(value)'));
  assert.ok(good);
  observations.push({ evidence_id: good.id, explanation: 'This statement throws SECRET_LITERAL_DENIED when one of the three named pattern tests matches, or the private-key header pattern matches.' });
  const analysis = { criteria: { [criterion.id]: { assessment: 'SUPPORTS', reason: 'Each quoted statement directly establishes its attached behavior.', observations: { source: observations }, findings: [], missing_evidence: [] } } };
  return { input: buildAttributionInput(packet, analysis, criterion.id), badIds: observations.slice(0, 3).map(o => o.evidence_id), goodId: good.id };
}

for (const run of [1, 2]) test('live attribution critic rejects real misattributions and accepts supported control run ' + run, { timeout: 90000 }, async () => {
  const { input, badIds, goodId } = calibration();
  const checked = await new OllamaReviewer({ timeoutMs: 85000 }).verifyAttribution(input);
  const record = { id: randomUUID(), timestamp: new Date().toISOString(), scope: 'LIVE_ATTRIBUTION_CALIBRATION_NOT_MODULE_ACCEPTANCE', input, ...checked, badIds, goodId };
  assertNoSecrets(record);
  const directory = path.resolve(__dirname, '../../data/attribution-checks');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, record.id + '.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
  for (const id of badIds) assert.notEqual(checked.validation.observations[id].relation, 'SUPPORTED', 'An actual false attribution must be vetoed: ' + id);
  assert.equal(checked.validation.observations[goodId].relation, 'SUPPORTED', 'The critic must distinguish direct evidence from blanket rejection.');
  assert.notEqual(checked.validation.status, 'SUPPORTED');
});
