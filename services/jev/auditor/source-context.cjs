'use strict';
// Static location evidence only; no enclosing body is supplied as proof.
const acorn = require('acorn');
const { createHash } = require('node:crypto');
const none = () => null;
function sourceContextResolver(doc) {
  if (doc?.kind !== 'source' || !/\.[cm]?js$/i.test(doc.file ?? '') || typeof doc.content !== 'string') return none;
  const source = doc.content, hash = doc.sha256;
  if (createHash('sha256').update(source).digest('hex') !== hash) return none;
  let tree;
  try { tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); }
  catch { return none; }
  const functions = [];
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      let name = node.id?.name ?? null, headerStart = node.start;
      if (parent?.type === 'MethodDefinition' || parent?.type === 'Property' && parent.value === node) {
        headerStart = parent.start;
        if (!name && !parent.computed) name = parent.key.type === 'Identifier' ? parent.key.name : parent.key.type === 'Literal' ? String(parent.key.value) : null;
      } else if (!name && parent?.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') {
        // The declaration prefix provides exact evidence for the static binding.
        name = parent.id.name; headerStart = parent.start;
      }
      const bodyStart = node.body.start + (node.body.type === 'BlockStatement' ? 1 : 0);
      const bodyEnd = node.body.end - (node.body.type === 'BlockStatement' ? 1 : 0);
      functions.push({ node, name, headerStart, bodyStart, bodyEnd });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, node);
      } else if (value?.type) visit(value, node);
    }
  }
  try { visit(tree, null); } catch { return none; }
  return entry => {
    if (entry?.section !== 'L' || !entry.anchor || !Number.isInteger(entry.offset) || entry.offset < 0 || typeof entry.text !== 'string' || !entry.text.trim()) return null;
    const start = entry.offset, end = start + entry.text.length;
    if (source.slice(start, end) !== entry.text) return null;
    const meaningfulStart = start + entry.text.length - entry.text.trimStart().length;
    const meaningfulEnd = end - (entry.text.length - entry.text.trimEnd().length);
    const candidates = functions.filter(f => f.bodyStart <= meaningfulStart && f.bodyEnd >= meaningfulEnd).sort((a, b) => (a.node.end - a.node.start) - (b.node.end - b.node.start));
    const owner = candidates[0];
    if (!owner) return null;
    // A fragment crossing a nested declaration/body boundary is not attributed
    // to an arbitrary outer or neighboring function.
    if (functions.some(f => {
      const containedChild = meaningfulStart <= f.node.start && meaningfulEnd >= f.node.end &&
        (meaningfulStart < f.node.start || meaningfulEnd > f.node.end);
      return f !== owner && f.node.start < meaningfulEnd && f.node.end > meaningfulStart &&
        !(f.bodyStart <= owner.node.start && f.bodyEnd >= owner.node.end) && !containedChild;
    })) return null;
    const header = source.slice(owner.headerStart, owner.node.body.start);
    if (!header.trim() || header.length > 400) return null;
    return Object.freeze({ document_hash: hash, quote_start: start, quote_end: end, function_start: owner.node.start, function_end: owner.node.end, header_start: owner.headerStart, header_end: owner.node.body.start, header, name: owner.name });
  };
}
module.exports = { sourceContextResolver };
