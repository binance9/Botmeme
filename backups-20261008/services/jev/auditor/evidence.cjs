'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sha256, canonical, validatePacket } = require('./contract.cjs');
const { graph } = require('./dependencies.cjs');
const { describeDiff } = require('./diff.cjs');
const ROOT = path.resolve(__dirname, '../../..');
const LEGACY = 'C:/botcode 1/MemePilot';
function readInside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.includes(':')) throw Error('AUDIT_PATH_DENIED');
  const base = fs.realpathSync(root), resolved = fs.realpathSync(path.resolve(base, relative));
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) throw Error('AUDIT_PATH_DENIED');
  if (fs.statSync(resolved).size > 2 * 1024 * 1024) throw Error('AUDIT_FILE_TOO_LARGE');
  return fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '');
}
const document = (id, kind, file, content) => ({ id, kind, file, sha256: sha256(content), content });
const digestFiles = files => sha256(canonical(files.map(x => ({ file: x.file, sha256: x.sha256 }))));
const CHECKS = Object.freeze({
  auditor: ['--test', 'tests/auditor.test.cjs', 'tests/auditor-evidence.test.cjs'],
  'auditor-contract': ['--test', '--test-name-pattern=result coverage|requested packet criteria|packet requires|unknown document|PASS requires|PASS label|finding must|private credential|literal secrets|unquoted credential|structured credential|PASS observations|observation requires|verified quote|reason and observation|runtime observations|observation fields|serialized credential|multiline and escaped|serialized harmless|encoded or multiline|escaped JSON literals|credential screening depth', 'tests/auditor.test.cjs'],
  'auditor-agent': ['--test', '--test-name-pattern=readback |wire isolated attribution|wire semantic attribution|wire primary negatives|wire missing evidence|wire factual missing|wire valid ERROR|wire negative or unknown|valid FAIL|valid unknown|two malformed|reviewer cannot|provider outage|secret-bearing rejected|Ollama refuses|requests model|configured model attribution|malformed registry selection|every produced service outcome|invalid or credential-bearing audit input|dynamic schema', 'tests/auditor.test.cjs', 'tests/auditor-readback.test.cjs'],
  'auditor-collector': ['--test', '--test-name-pattern=readInside|source and resolved|runCheck|collector|genuine diff|diff rejects|initial diff', 'tests/auditor-evidence.test.cjs'],
  'auditor-integrity': ['--test', '--test-name-pattern=freeze|receipt|nonzero|sourceDigest|recordAudit|modified runtime|assertFrozen|revocation|host runtime|source changing|host outcome|runtime binding|v1 historical|persisted acceptance|bootstrap gate', 'tests/auditor-evidence.test.cjs', 'tests/auditor-cli.test.cjs'],
  'auditor-v2': ['--test', '--test-name-pattern=source context|receipt final acceptance|receipt freeze rejects missing|v2 |synthetic model support|runtime binding|persisted acceptance|v1 historical', 'tests/auditor-v2.test.cjs', 'tests/auditor-evidence.test.cjs', 'tests/auditor-source-context.test.cjs'],
  'auditor-cli': ['--test', 'tests/auditor-cli.test.cjs'],
  'auditor-attribution': ['--test', '--test-name-pattern=v2 attribution|v2 actual revoked|live attribution', 'tests/auditor-v2.test.cjs', 'scripts/audit-checks/attribution-calibration.cjs'],
  statistics: ['scripts/audit-checks/legacy-statistics.cjs'],
  state: ['--test', 'tests/state-layer.test.cjs']
});
for (const args of Object.values(CHECKS)) Object.freeze(args);
function runCheck(name, sourceDigest, protectedDigest) {
  const args = CHECKS[name]; if (!args) throw Error('UNKNOWN_AUDIT_CHECK');
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const executed = args.includes('--test') ? ['--test-reporter=tap', ...args] : args;
    const child = spawn(process.execPath, executed, { cwd: ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', size = 0, problem = null, settled = false;
    const finish = exitCode => { if (settled) return; settled = true; clearTimeout(timer); resolve({ check: name, command: [process.execPath, ...executed], cwd: ROOT, startedAt, finishedAt: new Date().toISOString(), exitCode, problem, sourceDigest, protectedDigest, output, outputSha256: sha256(output) }); };
    const timer = setTimeout(() => { problem = 'CHECK_TIMEOUT'; child.kill(); }, name === 'auditor-attribution' ? 190000 : 90000);
    const capture = chunk => { size += chunk.length; if (size > 64000) { problem = 'CHECK_OUTPUT_LIMIT'; child.kill(); return; } output += chunk.toString('utf8'); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', () => { problem = 'CHECK_START_FAILED'; finish(null); }); child.on('close', finish);
  });
}
async function collect({ scope, files, criteria, architecture, check, legacy = false, baselineFile = null }) {
  const root = legacy ? LEGACY : ROOT;
  const sources = files.map((file, index) => document('source-' + index, 'source', file, readInside(root, file)));
  const baseline = baselineFile ? JSON.parse(readInside(ROOT, baselineFile)) : null;
  const diff = describeDiff(sources, baseline, scope, legacy);
  // Validate sensitive source before running checks or invoking the reviewer.
  validatePacket({ scope, criteria, documents: sources });
  const sourceDigest = digestFiles(sources);
  const checkFiles = CHECKS[check]?.filter(arg => !arg.startsWith('--')); if (!checkFiles) throw Error('UNKNOWN_AUDIT_CHECK');
  const trustedFiles = [...fs.readdirSync(__dirname).filter(f => f.endsWith('.cjs')).map(f => 'services/jev/auditor/' + f), 'docs/JEV-AUDITOR.md', 'docs/AUTONOMOUS-INTELLIGENCE.md', 'package.json', 'package-lock.json', 'node_modules/acorn/package.json', ...checkFiles];
  if (baselineFile) trustedFiles.push(baselineFile);
  const trace = graph([...files.map(file => ({ root, file })), ...trustedFiles.map(file => ({ root: ROOT, file }))], [ROOT, LEGACY], readInside);
  const { protectedFiles } = trace;
  const dependency = { sourceDigest, entrypoints: files, imports: trace.imports, unresolved: trace.unresolved };
  if (architecture !== readInside(ROOT, 'docs/JEV-AUDITOR.md')) throw Error('ARCHITECTURE_CONTENT_MISMATCH');
  const protectedDigest = sha256(canonical(protectedFiles));
  dependency.protectedDigest = protectedDigest;
  const binding = { root, files, sourceDigest, protectedDigest, protectedFiles, dependency, check, sourceHashes: sources.map(d => ({ file: d.file, sha256: d.sha256 })) };
  const receipt = await runCheck(check, sourceDigest, protectedDigest);
  binding.runtimeDigest = sha256(canonical(receipt));
  if (!unchanged(binding)) throw Error('SOURCE_CHANGED_DURING_CHECK');
  const documents = [...sources,
    document('diff', 'diff', 'audit/diff.json', diff),
    document('architecture', 'architecture', 'docs/JEV-AUDITOR.md', architecture),
    document('autonomy', 'architecture', 'docs/AUTONOMOUS-INTELLIGENCE.md', readInside(ROOT, 'docs/AUTONOMOUS-INTELLIGENCE.md')),
    document('runtime', 'runtime', 'audit/runtime.json', canonical(receipt)),
    document('dependency', 'dependency', 'audit/dependency.json', canonical(dependency))
  ];
  const packet = validatePacket({ scope, criteria, documents });
  binding.packetHash = sha256(canonical(packet));
  // Comparison receipts remain fully tamper-bound above, but do not constitute
  // a source or policy fix. Noncanonical comparison provenance cannot authorize.
  try { binding.policyRevision = require('./history.cjs').policyRevision(packet, binding); }
  catch { binding.policyRevision = null; }
  return { packet, binding };
}
function unchanged(binding) {
  try {
    const current = binding.files.map((file, index) => document('source-' + index, 'source', file, readInside(binding.root, file)));
    if (digestFiles(current) !== binding.sourceDigest) return false;
    if (!Array.isArray(binding.protectedFiles) || !binding.protectedFiles.length || sha256(canonical(binding.protectedFiles)) !== binding.protectedDigest) return false;
    for (const dep of binding.protectedFiles) if (sha256(readInside(dep.root, dep.file)) !== dep.sha256) return false;
    for (const item of binding.dependency.imports) for (const dep of item.resolved ?? []) if (sha256(readInside(dep.root ?? binding.root, dep.file)) !== dep.sha256) return false;
    return true;
  } catch { return false; }
}
module.exports = { ROOT, LEGACY, CHECKS, readInside, document, collect, unchanged, runCheck };
