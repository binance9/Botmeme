'use strict';
// Isolated protocol-test transport. All inspected module imports are literal so
// the production dependency collector can bind this harness without exceptions.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registry = require('../services/jev/auditor/registry.cjs');
const { decide } = require('../services/jev/auditor/acceptance.cjs');
const { collect } = require('../services/jev/auditor/evidence.cjs');
const operations = Object.freeze({
  recordAudit: args => registry.recordAudit(args),
  recordOutcome: args => registry.recordOutcome(args),
  assertFrozen: args => registry.assertFrozen(args.file, args.packet),
  revokeAudit: args => registry.revokeAudit(args.file, args.evidence),
  decide: args => decide(args.packet, args.result, args.binding),
  collect: args => collect(args)
});

function invoke(root, operation, args) {
  if (!Object.hasOwn(operations, operation)) throw Error('UNKNOWN_FIXTURE_OPERATION');
  const env = { ...process.env };
  // The copied collector must run a genuine independent Node test command.
  // Inheriting Node's internal parent-test marker makes it silently skip files.
  if (operation === 'collect') delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [path.join(root, 'tests/auditor-fixture.cjs'), operation], {
    cwd: root, input: JSON.stringify(args), encoding: 'utf8', shell: false,
    windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, env
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw Error('FIXTURE_PROCESS_FAILED: ' + child.stderr);
  const response = JSON.parse(child.stdout);
  if (!response.ok) {
    const error = new Error(response.error.message);
    if (response.error.code) error.code = response.error.code;
    throw error;
  }
  return response.value;
}

if (require.main === module) {
  (async () => { try {
    const operation = process.argv[2];
    if (process.argv.length !== 3 || !Object.hasOwn(operations, operation)) throw Error('UNKNOWN_FIXTURE_OPERATION');
    const value = await operations[operation](JSON.parse(fs.readFileSync(0, 'utf8')));
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: { message: error.message, code: error.code ?? null } }));
  } })();
}
module.exports = { invoke };
