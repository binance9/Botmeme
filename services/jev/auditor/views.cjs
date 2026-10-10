'use strict';
const { canonical } = require('./contract.cjs');
const { buildRegistry } = require('./evidence-registry.cjs');
const { entries: lines } = require('./anchors.cjs');
const { OBLIGATIONS } = require('./proofs.cjs');
function criterionView(packet, criterionId) {
  const criterion = packet.criteria.find(c => c.id === criterionId);
  if (!criterion) throw Error('INVALID_CRITERION_VIEW');
  const registry = buildRegistry(packet);
  const registered = Object.values(require('./profiles.cjs').profiles).some(p => p.scope === packet.scope && canonical(p.criteria) === canonical(packet.criteria));
  const docs = packet.documents.filter(d => !registered || d.kind === 'source' || criterion.evidenceKinds.includes(d.kind) || d.file === 'docs/JEV-AUDITOR.md');
  const ids = new Set(docs.map(d => d.id)), names = OBLIGATIONS[criterion.id] ?? [];
  const entries = registry.entries.filter(e => ids.has(e.document_id) && (e.kind !== 'runtime' || !registered || e.anchor.startsWith('R') && names.some(name => new RegExp('^(?:not )?ok \\d+ - ' + escapeRegex(name) + '(?:\\s+#.*)?$').test(e.quote))));
  return { criterion, registry_hash: registry.registry_hash, entries, documents: docs, manifest: {
    criterion_id: criterionId, packet_hash: registry.packet_hash,
    included: docs.map(d => ({ id: d.id, kind: d.kind, file: d.file, sha256: d.sha256 })),
    excluded: packet.documents.filter(d => !ids.has(d.id)).map(d => ({ id: d.id, kind: d.kind, file: d.file, sha256: d.sha256, reason: 'Not a model proof obligation for this criterion; retained in the complete host packet and binding.' })),
    allowed_evidence_ids: entries.map(e => e.id)
  } };
}
function renderView(packet, criterionId) {
  const view = criterionView(packet, criterionId), allowed = new Map(view.entries.map(e => [e.document_id + ':' + e.anchor, e.id]));
  const output = ['BOUNDED CRITERION: ' + canonical(view.criterion), 'PARENT SCOPE: ' + packet.scope, 'ORIGINAL REGISTRY: ' + view.registry_hash,
    'EXPLICIT VIEW COVERAGE: ' + canonical({ included: view.manifest.included, excluded: view.manifest.excluded })];
  for (const doc of view.documents) {
    output.push('BEGIN ' + doc.kind + ' ' + doc.id + ' ' + doc.file);
    let decoded = false;
    if (doc.kind === 'runtime') {
      try { const value = JSON.parse(doc.content); if (typeof value.output === 'string') { const { output: log, ...metadata } = value; output.push('RUNTIME METADATA (not a verifier result): ' + canonical(metadata)); decoded = true; } } catch {}
    }
    for (const line of lines(doc)) {
      if (decoded && line.section !== 'R') continue;
      const id = allowed.get(doc.id + ':' + line.anchor);
      output.push(id ? JSON.stringify({ evidence_id: id, quote: line.text }) : line.text);
    }
    output.push('END ' + doc.id);
  }
  output.push('Analyze ONLY ' + criterionId + '. Each JSON evidence record pairs one evidence_id with its exact quote. Copy the pair from the same record; neighboring records are different evidence. First select observations and explain those exact quotes; then record findings and missing facts; only then derive your reason and assessment. Before claiming a guard or verifier is absent, inspect the complete supplied source and decoded runtime logs. Runtime selections are actual required verifier records; all logs and failure diagnostics remain visible. SUPPORTS is not acceptance. Any ERROR stays a blocker even if other text says SUPPORTS.');
  return output.join('\n');
}
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
module.exports = { criterionView, renderView };
