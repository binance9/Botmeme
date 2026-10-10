'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { canonical, sha256, validatePacket } = require('./contract.cjs');
const { assertNoSecrets } = require('./secrets.cjs');
const { unchanged, ROOT } = require('./evidence.cjs');
const { decide, blocked } = require('./acceptance.cjs');
const VERSION = 'jev-auditor/2';
function canonicalDirectory(directory) {
  if (path.resolve(directory).toLowerCase() !== path.resolve(ROOT, 'data/audits').toLowerCase()) throw Error('AUDIT_REGISTRY_PATH_DENIED');
}
function recordAudit({ directory, packet, result, binding }) {
  canonicalDirectory(directory);
  if (!/^[a-f0-9-]{36}$/.test(result.id) || result.receipt_id !== result.id || result.packetHash !== sha256(canonical(packet)) || result.scope !== packet.scope) throw Error('AUDIT_RECEIPT_MISMATCH');
  validatePacket(packet); assertNoSecrets(result);
  if (!unchanged(binding)) throw Error('SOURCE_CHANGED_DURING_REVIEW');
  const file = path.join(directory, result.id + '.json');
  const revoked = fs.existsSync(file.replace(/\.json$/, '.revoked.json'));
  const derived = result.analysis ? decide(packet, result, binding, { revoked }) : blocked(packet, result, result.missing_evidence?.[0] ?? 'ATTRIBUTED_ANALYSIS_REQUIRED', binding);
  if (result.status === 'PASS' && derived.status !== 'PASS') throw Error('PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES');
  const frozen = derived.status === 'PASS';
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: VERSION, packet, result: derived, binding, frozen, collectedBy: 'internal-fixed-command-evidence-collector' }, null, 2), { flag: 'wx' });
  return { file, frozen, result: derived };
}
function assertFrozen(file, packet) {
  canonicalDirectory(path.dirname(file));
  if (fs.existsSync(file.replace(/\.json$/, '.revoked.json'))) throw Error('AUDIT_FREEZE_REVOKED');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (receipt.version !== VERSION || !receipt.frozen || path.basename(file) !== receipt.result.id + '.json' || receipt.result.receipt_id !== receipt.result.id || receipt.result.status !== 'PASS' || receipt.result.packetHash !== sha256(canonical(packet)) || canonical(receipt.packet) !== canonical(packet) || !unchanged(receipt.binding)) throw Error('AUDIT_FREEZE_INVALID');
  const derived = decide(packet, receipt.result, receipt.binding);
  const fields = ['status', 'scope', 'findings', 'root_causes', 'evidence', 'evidence_ids', 'missing_evidence', 'required_fixes', 'affected_files', 'checks', 'source_hash', 'registry_hash', 'proof_obligations', 'attribution_proofs', 'authority'];
  if (derived.status !== 'PASS' || fields.some(key => canonical(derived[key]) !== canonical(receipt.result[key]))) throw Error('AUDIT_FREEZE_INVALID');
  return true;
}
function revokeAudit(file, { reason, evidence }) {
  canonicalDirectory(path.dirname(file));
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof reason !== 'string' || !reason.trim() || !Array.isArray(evidence) || !evidence.length) throw Error('REVOCATION_EVIDENCE_REQUIRED');
  assertNoSecrets({ reason, evidence });
  const target = file.replace(/\.json$/, '.revoked.json');
  if (target === file) throw Error('INVALID_RECEIPT_PATH');
  fs.writeFileSync(target, JSON.stringify({ receipt_id: receipt.result.receipt_id ?? receipt.result.id, timestamp: new Date().toISOString(), reason, evidence }, null, 2), { flag: 'wx' });
  return target;
}
function recordOutcome(args) {
  try { return recordAudit(args); }
  catch (error) {
    if (!['SOURCE_CHANGED_DURING_REVIEW', 'PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES'].includes(error.message)) throw error;
    const { directory, packet, result, binding } = args;
    canonicalDirectory(directory);
    assertNoSecrets(result);
    const rejected = blocked(packet, result, error.message, binding);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, result.id + '.json');
    fs.writeFileSync(file, JSON.stringify({ version: 'jev-auditor/rejected-evidence/2', packet, result: rejected, reviewed_result: result, binding, frozen: false, collectedBy: 'internal-fixed-command-evidence-collector' }, null, 2), { flag: 'wx' });
    return { file, frozen: false, result: rejected };
  }
}
module.exports = { VERSION, recordAudit, recordOutcome, assertFrozen, revokeAudit };
