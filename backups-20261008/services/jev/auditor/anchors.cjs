'use strict';
// Addresses are deterministic references to immutable packet text, not generated
// evidence. Keep the full document visible, including short unanchored lines.
function sections(doc) {
  const result = [{ prefix: 'L', text: doc.content }];
  if (doc.kind === 'runtime') { try { const output = JSON.parse(doc.content).output; if (typeof output === 'string') result.push({ prefix: 'R', text: output }); } catch {} }
  return result;
}
function entries(doc) {
  const result = [];
  for (const section of sections(doc)) {
    let lineOffset = 0;
    section.text.split('\n').forEach((raw, lineIndex) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const chunks = [];
      let offset = 0;
      // The quote contract counts UTF-16 units. Preserve complete lines within
      // its 400-unit budget and never split a surrogate pair or strand a tiny tail.
      while (line.length - offset > 400) {
        let end = offset + 400;
        if (line.length - end < 12) end = line.length - 12;
        if (/[\uD800-\uDBFF]/.test(line[end - 1]) && /[\uDC00-\uDFFF]/.test(line[end])) end--;
        chunks.push(line.slice(offset, end));
        offset = end;
      }
      chunks.push(line.slice(offset));
      let partOffset = 0;
      chunks.forEach((text, part) => {
        result.push({ section: section.prefix, anchor: text.trim().length >= 12 && text.length <= 400 ? section.prefix + (lineIndex + 1) + (chunks.length > 1 ? ':' + (part + 1) : '') : null, text, offset: lineOffset + partOffset });
        partOffset += text.length;
      });
      lineOffset += raw.length + 1;
    });
  }
  return result;
}
function catalogue(packet) {
  return new Map(packet.documents.map(doc => [doc.id, new Map(entries(doc).filter(e => e.anchor).map(e => [e.anchor, e.text]))]));
}
function renderDocument(doc) {
  let section = null;
  return entries(doc).map(entry => {
    const heading = section !== entry.section ? (entry.section === 'R' ? 'DECODED OUTPUT OF THIS SAME RUNTIME DOCUMENT:\n' : 'EXACT DOCUMENT TEXT:\n') : '';
    section = entry.section;
    return heading + (entry.anchor ? '[' + entry.anchor + '] ' : '') + entry.text;
  }).join('\n');
}
module.exports = { catalogue, renderDocument, entries };
