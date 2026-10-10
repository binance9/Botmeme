'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./evidence.cjs');
const { canonical, sha256 } = require('./contract.cjs');
const normalizedPath = item => path.resolve(item.root, item.file).toLowerCase();
function policyRevision(packet, binding) {
  const files = binding?.protectedFiles;
  if (!Array.isArray(files) || !files.length || sha256(canonical(files)) !== binding.protectedDigest) throw Error('POLICY_REVISION_BINDING_INVALID');
  const diffDocs = packet?.documents?.filter(doc => doc.kind === 'diff');
  if (diffDocs?.length !== 1) throw Error('POLICY_COMPARISON_EVIDENCE_INVALID');
  const diff = JSON.parse(diffDocs[0].content);
  let comparison = null;
  if (diff.baseline !== null) {
    if (!/^[a-f0-9-]{36}$/.test(diff.baseline)) throw Error('POLICY_COMPARISON_EVIDENCE_INVALID');
    comparison = path.resolve(ROOT, 'data/audits', diff.baseline + '.json').toLowerCase();
    if (files.filter(item => normalizedPath(item) === comparison).length !== 1) throw Error('POLICY_COMPARISON_EVIDENCE_INVALID');
    // A receipt used as executable/config dependency is part of policy, even
    // if a caller also names it as comparison evidence. Never exclude it.
    if (binding.files?.some(file => path.resolve(binding.root, file).toLowerCase() === comparison) || binding.dependency?.imports?.some(row => row.resolved?.some(item => normalizedPath({ ...item, root: item.root ?? binding.root }) === comparison))) throw Error('POLICY_COMPARISON_IS_DEPENDENCY');
  }
  const policyFiles = files.filter(item => normalizedPath(item) !== comparison).map(item => {
    if (typeof item.root !== 'string' || typeof item.file !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('POLICY_REVISION_BINDING_INVALID');
    return { path: normalizedPath(item), sha256: item.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(policyFiles.map(item => item.path)).size !== policyFiles.length) throw Error('POLICY_REVISION_BINDING_INVALID');
  return sha256(canonical(policyFiles));
}
function capturedSourceHash(receipt) {
  const sources = receipt.packet?.documents?.filter(doc => doc.kind === 'source');
  if (!receipt.binding?.root || !sources?.length || sources.some(doc => typeof doc.file !== 'string' || !/^[a-f0-9]{64}$/.test(doc.sha256))) return null;
  return sha256(canonical({ root: receipt.binding.root, files: sources.map(doc => ({ file: doc.file, sha256: doc.sha256 })) }));
}
// A new model answer cannot erase an unresolved failure for unchanged source
// and verifier policy. A real fix changes the bound revision before re-review.
function unresolvedFailures(scope, source_hash, revision, currentId) {
  const directory = path.join(ROOT, 'data/audits');
  if (!fs.existsSync(directory)) return [];
  const failures = [];
  for (const name of fs.readdirSync(directory).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
    if (name === currentId + '.json') continue;
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
    catch { throw Error('AUDIT_HISTORY_UNREADABLE'); }
    if (receipt.result?.scope !== scope || receipt.result.status !== 'FAIL') continue;
    const captured = capturedSourceHash(receipt);
    // Unknown historical provenance remains a blocker; adding the new field
    // must not silently discard genuine earlier FAIL receipts.
    if (!captured || receipt.result.source_hash && receipt.result.source_hash !== captured) { failures.push(receipt.result.receipt_id ?? name.slice(0, -5)); continue; }
    if (captured !== source_hash) continue;
    let previousRevision;
    try { previousRevision = policyRevision(receipt.packet, receipt.binding); } catch { previousRevision = null; }
    if (!revision || !previousRevision || revision === previousRevision) failures.push(receipt.result.receipt_id ?? name.slice(0, -5));
  }
  return failures;
}
module.exports = { unresolvedFailures, policyRevision };
