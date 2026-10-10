'use strict';
// Host verification evidence only. Never semantic acceptance or FINAL PASS.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../../..');
const LIMIT = 1024 * 1024;
const TEST_FILES = Object.freeze(['runtime-contracts', 'runtime-events', 'runtime-recovery', 'runtime-trace', 'market-data', 'hunter', 'trade-performance', 'quant', 'forensic', 'regime', 'commander', 'strategy-engine', 'risk', 'paper-execution', 'wallet-network', 'dexscreener', 'geckoterminal', 'dashboard-adapter', 'application-control', 'server-control', 'state-layer', 'jev-technical-inspection'].map(name => 'tests/' + name + '.test.cjs'));
const SOURCE_ROOTS = Object.freeze(['runtime', 'core', 'services/quant', 'services/forensic', 'services/commander', 'wallet', 'dashboard/adapter']);
const PINNED = Object.freeze(['services/jev/hunter.cjs', 'services/jev/auditor/technical-inspection.cjs', 'scripts/jev-inspect-runtime.cjs', 'scripts/check-audit-integrity.cjs', 'scripts/serve-meme-trader.cjs', 'public/meme-trader/index.html', 'public/meme-trader/wallet.js', 'public/meme-trader/wallet.css', 'package.json', 'package-lock.json']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
function inside(file) {
  const absolute = path.resolve(ROOT, file), relative = path.relative(ROOT, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('INSPECTION_PATH_DENIED');
  const actual = fs.realpathSync(absolute), rel = path.relative(fs.realpathSync(ROOT), actual);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('INSPECTION_PATH_DENIED');
  return absolute;
}
function collectSources() {
  const files = new Set(), missing = [];
  function visit(relative) {
    try {
      const absolute = inside(relative), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw Error('INSPECTION_LINK_DENIED');
      if (stat.isDirectory()) for (const child of fs.readdirSync(absolute).sort()) visit(relative + '/' + child);
      else if (stat.isFile() && /\.[cm]?js$/i.test(relative)) files.add(relative);
    } catch (error) { missing.push({ file: relative, code: error.code === 'ENOENT' ? 'SOURCE_MISSING' : 'SOURCE_UNREADABLE_OR_UNSAFE' }); }
  }
  SOURCE_ROOTS.forEach(visit);
  for (const relative of [...PINNED, ...TEST_FILES]) {
    try { const absolute = inside(relative); if (!fs.lstatSync(absolute).isFile() || fs.lstatSync(absolute).isSymbolicLink()) throw Error('NOT_FILE'); files.add(relative); }
    catch { missing.push({ file: relative, code: 'REQUIRED_FILE_MISSING_OR_UNSAFE' }); }
  }
  const sources = [];
  for (const file of [...files].sort()) {
    try { sources.push({ file, sha256: sha256(fs.readFileSync(inside(file))) }); }
    catch { missing.push({ file, code: 'SOURCE_READ_FAILED' }); }
  }
  return { sources, missing };
}
function parseTap(output) {
  const rows = [...output.matchAll(/^(not ok|ok) (\d+) - (.+)$/gm)].map(m => ({ status: m[1], number: Number(m[2]), name: m[3] }));
  const plans = [...output.matchAll(/^1\.\.(\d+)\s*$/gm)];
  const count = name => { const matches = [...output.matchAll(new RegExp('^# ' + name + '\\s+(\\d+)\\s*$', 'gm'))]; return matches.length === 1 ? Number(matches[0][1]) : null; };
  const tests = count('tests'), passed = count('pass'), failed = count('fail'), cancelled = count('cancelled'), skipped = count('skipped'), todo = count('todo');
  const complete = output.startsWith('TAP version 13\n') && plans.length === 1 && Number(plans[0][1]) === rows.length && rows.length > 0 && rows.every((r, i) => r.number === i + 1) && [tests, passed, failed, cancelled, skipped, todo].every(n => n !== null) && tests >= rows.length && passed + failed + cancelled + skipped + todo === tests;
  const negative = rows.some(r => r.status === 'not ok' && !/# TODO\b/.test(r.name)) || failed > 0;
  return { complete, tests, passed, failed, cancelled, skipped, todo, negative, satisfied: complete && !negative && passed === tests && cancelled === 0 && skipped === 0 && todo === 0 && rows.every(r => !/# (?:SKIP|TODO)\b/.test(r.name)) };
}
function compareSources(before, after) {
  return JSON.stringify(before.sources) === JSON.stringify(after.sources) && before.missing.length === 0 && after.missing.length === 0;
}
function classify({ tap, testRun, integrityRun, integrity, before, after }) {
  const missing = ['INDEPENDENT_SEMANTIC_ACCEPTANCE_PENDING', 'LIVE_PROVIDER_AND_WALLET_E2E_PENDING'];
  let technical_status = 'SATISFIED';
  if (before.missing.length || after.missing.length) missing.push('REQUIRED_SOURCE_OR_TEST_MISSING');
  if (!compareSources(before, after)) missing.push('SOURCE_COVERAGE_OR_HASH_CHANGED');
  if (!tap.satisfied) missing.push('COMPLETE_SUCCESSFUL_TEST_EVIDENCE_REQUIRED');
  if (testRun.problem || integrityRun.problem || testRun.exitCode !== 0 || integrityRun.exitCode !== 0) missing.push('HOST_COMMAND_EVIDENCE_INCOMPLETE');
  if (!integrity || integrity.scope !== 'FILE_INTEGRITY_ONLY_NOT_ACCEPTANCE' || !Number.isSafeInteger(integrity.legacyFilesChecked) || integrity.legacyFilesChecked < 1 || !Array.isArray(integrity.legacyFilesChanged) || typeof integrity.uiUnchanged !== 'boolean') missing.push('FROZEN_UI_LEGACY_COMPARISON_UNVERIFIED');
  if (missing.length > 2) technical_status = 'CHUA_XAC_MINH';
  if (tap.negative || testRun.exitCode !== null && testRun.exitCode !== 0 && !testRun.problem || integrityRun.exitCode !== null && integrityRun.exitCode !== 0 && !integrityRun.problem || integrity?.uiUnchanged === false || Array.isArray(integrity?.legacyFilesChanged) && integrity.legacyFilesChanged.length > 0) technical_status = 'FAILED';
  return { status: technical_status === 'FAILED' ? 'FAIL' : 'CHUA_XAC_MINH', technical_status, missing_evidence: missing };
}
function command(args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: ROOT, shell: false, windowsHide: true, timeout: 90000, maxBuffer: LIMIT, encoding: 'utf8' });
  const out = Buffer.from(result.stdout ?? ''), err = Buffer.from(result.stderr ?? '');
  const truncated = out.length + err.length > LIMIT;
  const stdout = out.subarray(0, LIMIT).toString('utf8'), stderr = err.subarray(0, Math.max(0, LIMIT - out.length)).toString('utf8');
  return { command: [process.execPath, ...args], cwd: ROOT, exitCode: result.status, durationMs: Date.now() - started, problem: result.error || truncated ? 'HOST_COMMAND_FAILED_OR_BOUNDED' : null, outputTruncated: truncated, stdout, stderr };
}
function runTechnicalInspection() {
  const receipt_id = randomUUID(), timestamp = new Date().toISOString(), before = collectSources();
  const available = TEST_FILES.filter(file => before.sources.some(s => s.file === file));
  const tests = available.length ? command(['--test', '--test-reporter=tap', ...available]) : { command: [], cwd: ROOT, exitCode: null, durationMs: 0, problem: 'NO_ALLOWED_TESTS', stdout: '', stderr: '' };
  let integrityRun;
  if (before.sources.some(s => s.file === 'scripts/check-audit-integrity.cjs')) integrityRun = command(['scripts/check-audit-integrity.cjs']);
  else integrityRun = { command: [], cwd: ROOT, exitCode: null, durationMs: 0, problem: 'INTEGRITY_COMMAND_MISSING', stdout: '', stderr: '' };
  const after = collectSources(), tap = parseTap(tests.stdout);
  let integrity = null;
  try { integrity = JSON.parse(integrityRun.stdout); } catch {}
  const outputDirectory = path.join(inside('data'), 'jev-inspections');
  if (fs.existsSync(outputDirectory)) inside('data/jev-inspections'); else fs.mkdirSync(outputDirectory);
  const raw = tests.stdout + '\n# INSPECTION STDERR\n' + tests.stderr;
  const logFile = path.join(outputDirectory, receipt_id + '.tap');
  fs.writeFileSync(logFile, raw, { flag: 'wx' });
  const integrityFile = path.join(outputDirectory, receipt_id + '.integrity.log');
  const integrityRaw = integrityRun.stdout + '\n# STDERR\n' + integrityRun.stderr;
  fs.writeFileSync(integrityFile, integrityRaw, { flag: 'wx' });
  const summarize = ({ stdout, stderr, ...metadata }) => ({ ...metadata, stdout_sha256: sha256(stdout), stderr_sha256: sha256(stderr) });
  const report = { receipt_id, timestamp, producer: 'JEV_AUDITOR', scope: 'RUNTIME_TECHNICAL_INSPECTION_NOT_SEMANTIC_ACCEPTANCE', ...classify({ tap, testRun: tests, integrityRun, integrity, before, after }), evidence: { before, after, tests: summarize(tests), tap, integrityRun: summarize(integrityRun), integrity, log: { file: path.relative(ROOT, logFile), sha256: sha256(raw) }, integrityLog: { file: path.relative(ROOT, integrityFile), sha256: sha256(integrityRaw) } } };
  const receiptFile = path.join(outputDirectory, receipt_id + '.json'); fs.writeFileSync(receiptFile, JSON.stringify(report, null, 2), { flag: 'wx' });
  return { file: receiptFile, report };
}
module.exports = { TEST_FILES, SOURCE_ROOTS, sha256, collectSources, parseTap, compareSources, classify, runTechnicalInspection };
