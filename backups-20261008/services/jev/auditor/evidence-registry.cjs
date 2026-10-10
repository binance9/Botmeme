'use strict';
const { canonical, sha256, validatePacket } = require('./contract.cjs');
const { entries: lines } = require('./anchors.cjs');
const { sourceContextResolver } = require('./source-context.cjs');
function buildRegistry(packet) {
  validatePacket(packet);
  const packet_hash = sha256(canonical(packet));
  const entries = [], seen = new Set();
  for (const [documentIndex, doc] of packet.documents.entries()) {
    const context = sourceContextResolver(doc);
    for (const line of lines(doc)) {
    if (!line.anchor) continue;
    const source_context = context(line);
    const entry = { scope: packet.scope, document_id: doc.id, kind: doc.kind, file: doc.file, document_hash: doc.sha256, anchor: line.anchor, quote: line.text, source_context: source_context ? Object.freeze(source_context) : null };
    const id = 'E' + doc.kind + documentIndex + '_' + line.anchor.replace(':', 'p') + '_' + sha256(canonical({ packet_hash, ...entry })).slice(0, 12);
    if (seen.has(id)) throw Error('EVIDENCE_ID_COLLISION');
    seen.add(id); entries.push(Object.freeze({ id, ...entry }));
  }
  }
  return Object.freeze({ packet_hash, registry_hash: sha256(canonical(entries)), entries: Object.freeze(entries) });
}
function renderPacket(packet) {
  const registry = buildRegistry(packet);
  const lookup = new Map(registry.entries.map(e => [e.document_id + ':' + e.anchor, e.id]));
  const result = ['REVIEW SCOPE: ' + packet.scope, 'CRITERIA: ' + canonical(packet.criteria), 'REGISTRY: ' + registry.registry_hash];
  for (const doc of packet.documents) {
    result.push('BEGIN ' + canonical({ id: doc.id, kind: doc.kind, file: doc.file, sha256: doc.sha256 }));
    let section = null;
    for (const line of lines(doc)) {
      if (section !== line.section) result.push(line.section === 'R' ? 'DECODED ACTUAL RUNTIME OUTPUT:' : 'EXACT DOCUMENT CONTENT:');
      section = line.section;
      result.push((line.anchor ? '[' + lookup.get(doc.id + ':' + line.anchor) + '] ' : '') + line.text);
    }
    result.push('END ' + doc.id);
  }
  result.push('Choose only the supplied E-prefixed evidence IDs, without brackets. Each criterion has separate selections for EVERY required evidence kind. Empty selections mean missing evidence, never support. You provide analysis only; the host evaluates proof obligations and computes acceptance.');
  return result.join('\n');
}
module.exports = { buildRegistry, renderPacket };
