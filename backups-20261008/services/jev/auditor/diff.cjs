'use strict';
const { canonical, validatePacket, sha256 } = require('./contract.cjs');
function lineHunks(before, after) {
  // Exact LCS for bounded modules; large inputs retain the truthful single span.
  if ((before.length + 1) * (after.length + 1) > 1000000) {
    let start = 0, end = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    return [{ beforeStartLine: start + 1, afterStartLine: start + 1, removed: before.slice(start, before.length - end), added: after.slice(start, after.length - end) }];
  }
  const width = after.length + 1, table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) table[i * width + j] = before[i] === after[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const hunks = []; let i = 0, j = 0, current = null;
  const flush = () => { if (current) hunks.push(current); current = null; };
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { flush(); i++; j++; continue; }
    current ??= { beforeStartLine: i + 1, afterStartLine: j + 1, removed: [], added: [] };
    if (j < after.length && (i === before.length || table[i * width + j + 1] > table[(i + 1) * width + j])) current.added.push(after[j++]);
    else current.removed.push(before[i++]);
  }
  flush(); return hunks;
}
function describeDiff(sources, baseline, scope, legacy) {
  if (!baseline) return canonical({ baseline: null, mode: legacy ? 'INITIAL_READ_ONLY_INSPECTION_NO_SOURCE_CHANGE' : 'INITIAL_MODULE_REVIEW', files: sources.map(d => ({ file: d.file, beforeSha256: null, afterSha256: d.sha256, sourceDocument: d.id, change: 'Full initial contents supplied in sourceDocument; no previous accepted baseline claimed' })) });
  validatePacket(baseline.packet);
  if (baseline.packet.scope !== scope || baseline.result?.packetHash !== sha256(canonical(baseline.packet))) throw Error('DIFF_BASELINE_MISMATCH');
  const previous = new Map(baseline.packet.documents.filter(d => d.kind === 'source').map(d => [d.file, d]));
  const current = new Map(sources.map(d => [d.file, d]));
  const changes = [...new Set([...previous.keys(), ...current.keys()])].map(file => {
    const before = previous.get(file), after = current.get(file);
    const oldLines = before?.content.split('\n') ?? [], newLines = after?.content.split('\n') ?? [];
    const hunks = lineHunks(oldLines, newLines);
    const delta = hunks.length <= 1 ? hunks[0] ?? { beforeStartLine: oldLines.length + 1, afterStartLine: newLines.length + 1, removed: [], added: [] } : { hunks };
    return { file, beforeSha256: before?.sha256 ?? null, afterSha256: after?.sha256 ?? null, sourceDocument: after?.id ?? null, ...delta };
  });
  return canonical({ mode: 'SOURCE_DELTA', baseline: baseline.result.receipt_id ?? baseline.result.id, baselineVerdictAtTime: baseline.result.status, baselineAcceptance: 'Historical comparison only; does not confer current acceptance', files: changes });
}
module.exports = { describeDiff, lineHunks };
