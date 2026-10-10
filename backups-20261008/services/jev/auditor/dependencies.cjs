'use strict';
const acorn = require('acorn');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createRequire, isBuiltin } = require('node:module');
const { sha256 } = require('./contract.cjs');
function importsOf(source, file) {
  if (file.endsWith('.json') || file.endsWith('.md')) return [];
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: file.endsWith('.mjs') ? 'module' : 'commonjs' });
  const found = [];
  const add = node => found.push(node?.type === 'Literal' && typeof node.value === 'string' ? node.value : '<DYNAMIC_DEPENDENCY>');
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' && node.source || node.type === 'ExportAllDeclaration') add(node.source);
    if (node.type === 'ImportExpression') add(node.source);
    if (node.type === 'CallExpression' && (node.callee?.type === 'Identifier' && node.callee.name === 'require' || node.callee?.type === 'MemberExpression' && node.callee.object?.name === 'module' && node.callee.property?.name === 'require')) add(node.arguments.length === 1 ? node.arguments[0] : null);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  };
  visit(ast); return [...new Set(found)];
}
function graph(entries, roots, read) {
  const queue = [...entries], visited = new Set(), protectedFiles = [], imports = [], unresolved = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (queue.length > 300) throw Error('DEPENDENCY_GRAPH_TOO_LARGE');
    const item = queue[cursor], absolute = path.resolve(item.root, item.file), key = absolute.toLowerCase();
    if (visited.has(key)) continue; visited.add(key);
    const content = read(item.root, item.file);
    protectedFiles.push({ ...item, sha256: sha256(content) });
    // Pin the only approved third-party parser and lockfile; do not claim its vendor
    // implementation was independently audited by the reasoning model.
    if (item.file.replaceAll('\\', '/').startsWith('node_modules/')) continue;
    let specs;
    try { specs = importsOf(content, item.file); } catch { unresolved.push(item.file + ':PARSE_FAILED'); continue; }
    const row = { ...item, imports: specs, resolved: [] }; imports.push(row);
    for (const spec of specs) {
      if (isBuiltin(spec)) continue;
      try {
        let target;
        if (spec.startsWith('file:')) target = fileURLToPath(spec);
        else if (spec.startsWith('.') || spec === 'acorn') target = createRequire(absolute).resolve(spec);
        else throw Error('DEPENDENCY_NOT_APPROVED');
        const owner = roots.find(root => { const rel = path.relative(root, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
        if (!owner) throw Error('DEPENDENCY_OUTSIDE_ROOT');
        const file = path.relative(owner, target).replaceAll('\\', '/');
        const value = read(owner, file); row.resolved.push({ spec, root: owner, file, sha256: sha256(value) }); queue.push({ root: owner, file });
      } catch { unresolved.push(item.file + ':' + spec); }
    }
  }
  return { protectedFiles, imports, unresolved };
}
module.exports = { importsOf, graph };
