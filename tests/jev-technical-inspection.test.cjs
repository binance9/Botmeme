'use strict';
// Parser and authority-boundary unit checks, not a fabricated execution receipt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { TEST_FILES, sha256, collectSources, parseTap, compareSources, classify } = require('../services/jev/auditor/technical-inspection.cjs');
const good = 'TAP version 13\nok 1 - exact behavior verified\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
function evidence() {
  const before = { sources: [{ file: 'runtime/example.cjs', sha256: '1'.repeat(64) }], missing: [] };
  return { tap: parseTap(good), testRun: { exitCode: 0, problem: null }, integrityRun: { exitCode: 0, problem: null }, integrity: { scope: 'FILE_INTEGRITY_ONLY_NOT_ACCEPTANCE', legacyFilesChecked: 93, legacyFilesChanged: [], uiUnchanged: true }, before, after: structuredClone(before) };
}
test('technical inspection parser requires actual complete TAP counters plan and top-level results', () => {
  assert.equal(parseTap(good).satisfied, true);
  for (const malformed of ['', 'looks correct PASS verified', good.replace('ok 1', '# ok 1'), good.replace('1..1', '1..2'), good.replace('# tests 1', '# tests 9'), good.replace('# pass 1\n', ''), good + '# pass 1\n', good.replace('ok 1', 'ok 2')]) assert.equal(parseTap(malformed).satisfied, false);
});
test('technical inspection detects failure skip todo and cancellation without inventing completion', () => {
  const failed = good.replace('ok 1', 'not ok 1').replace('# pass 1', '# pass 0').replace('# fail 0', '# fail 1');
  assert.equal(parseTap(failed).negative, true); assert.equal(parseTap(failed).satisfied, false);
  for (const changed of [good.replace('behavior verified', 'behavior verified # SKIP'), good.replace('# pass 1', '# pass 0').replace('# skipped 0', '# skipped 1'), good.replace('# pass 1', '# pass 0').replace('# todo 0', '# todo 1'), good.replace('# pass 1', '# pass 0').replace('# cancelled 0', '# cancelled 1')]) assert.equal(parseTap(changed).satisfied, false);
});
test('technical inspection host success never becomes semantic PASS or FINAL PASS', () => {
  const result = classify(evidence());
  assert.equal(result.technical_status, 'SATISFIED'); assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.ok(result.missing_evidence.includes('INDEPENDENT_SEMANTIC_ACCEPTANCE_PENDING'));
  assert.ok(result.missing_evidence.includes('LIVE_PROVIDER_AND_WALLET_E2E_PENDING'));
});
test('technical inspection changed hashes missing files timeout and missing integrity stay unknown', () => {
  for (const mutate of [e => { e.after.sources[0].sha256 = '2'.repeat(64); }, e => { e.before.missing.push({ file: 'required.cjs', code: 'SOURCE_MISSING' }); }, e => { e.testRun.problem = 'TIMEOUT'; e.testRun.exitCode = null; }, e => { e.integrityRun.exitCode = null; }, e => { e.integrity = null; }]) {
    const e = evidence(); mutate(e); assert.equal(classify(e).technical_status, 'CHUA_XAC_MINH'); assert.equal(classify(e).status, 'CHUA_XAC_MINH');
  }
});
test('technical inspection real failure evidence dominates otherwise successful host evidence', () => {
  for (const mutate of [e => { e.tap.negative = true; }, e => { e.testRun.exitCode = 1; }, e => { e.integrity.uiUnchanged = false; }, e => { e.integrity.legacyFilesChanged.push({ file: 'legacy.cjs', unchanged: false }); }]) {
    const e = evidence(); mutate(e); assert.equal(classify(e).technical_status, 'FAILED'); assert.equal(classify(e).status, 'FAIL');
  }
});
test('technical inspection source enumeration covers new wiring and excludes legacy and model reviewer sources', () => {
  const collected = collectSources();
  assert.ok(collected.sources.some(s => s.file === 'runtime/contracts/index.cjs'));
  assert.ok(collected.sources.some(s => s.file === 'services/jev/hunter.cjs'));
  for (const file of ['runtime/application.cjs', 'dashboard/adapter/index.cjs', 'scripts/serve-meme-trader.cjs', 'public/meme-trader/wallet.js']) assert.ok(collected.sources.some(s => s.file === file));
  for (const entry of collected.sources) {
    assert.ok(!entry.file.includes('..')); assert.ok(!/MemePilot|PhuongAi|services\/jev\/auditor\/ollama/.test(entry.file));
    assert.equal(entry.sha256, sha256(fs.readFileSync(require('node:path').resolve(__dirname, '..', entry.file))));
  }
  const copy = structuredClone(collected); copy.missing = []; const same = structuredClone(copy);
  assert.equal(compareSources(copy, same), true); same.sources.pop(); assert.equal(compareSources(copy, same), false);
  assert.ok(Object.isFrozen(TEST_FILES)); assert.ok(TEST_FILES.every(file => /^tests\/[a-z-]+\.test\.cjs$/.test(file)));
});
