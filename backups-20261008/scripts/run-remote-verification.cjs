'use strict';
// Host evidence collector. It never grants JEV semantic acceptance.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TEST_FILES, parseTap } = require('../services/jev/auditor/technical-inspection.cjs');
const root = path.resolve(__dirname, '..');
if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== '--auditor') throw Error('UNKNOWN_VERIFICATION_MODE');
const tests = process.argv[2] === '--auditor'
  ? ['auditor', 'auditor-cli', 'auditor-evidence', 'auditor-readback', 'auditor-source-context', 'auditor-v2', 'auditor-llamacpp', 'auditor-reviewer-identity'].map(name => 'tests/' + name + '.test.cjs')
  : TEST_FILES;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
function verify() {
  return manifest.map(entry => {
    const filename = path.resolve(root, entry.file), relative = path.relative(root, filename);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('MANIFEST_PATH_DENIED');
    return { file: entry.file, sha256: hash(fs.readFileSync(filename)), expected: entry.sha256 };
  });
}
const before = verify();
if (before.some(entry => entry.sha256 !== entry.expected)) throw Error('REMOTE_SOURCE_HASH_MISMATCH');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
fs.writeFileSync(path.join(root, 'runtime-tests.tap'), stdout, { flag: 'wx' });
fs.writeFileSync(path.join(root, 'runtime-tests.stderr'), stderr, { flag: 'wx' });
const after = verify(), unchanged = JSON.stringify(before) === JSON.stringify(after);
const receipt = { scope: 'REMOTE_COMPONENT_TESTS_NOT_FULL_BOT_ACCEPTANCE', timestamp: new Date().toISOString(), hostname: os.hostname(), platform: process.platform, node: process.version, tests, exitCode: result.status, boundedError: result.error ? 'REMOTE_TEST_COMMAND_INCOMPLETE' : null, unchanged, manifest_sha256: hash(fs.readFileSync(path.join(root, 'manifest.json'))), stdout_sha256: hash(stdout), stderr_sha256: hash(stderr), tap: parseTap(stdout), before, after };
fs.writeFileSync(path.join(root, 'runtime-tests.receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ scope: receipt.scope, exitCode: receipt.exitCode, unchanged, tap: receipt.tap }));
process.exitCode = result.status === 0 && unchanged && receipt.tap.satisfied ? 0 : 1;
