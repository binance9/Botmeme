'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { sourceContextResolver } = require('../services/jev/auditor/source-context.cjs');
const digest = text => createHash('sha256').update(text).digest('hex');
function fixture(content, file = 'module.cjs') {
  const doc = { id: 'source-0', kind: 'source', file, content, sha256: digest(content) };
  const resolve = sourceContextResolver(doc);
  return { doc, resolve, quote(text, from = 0) { return resolve({ text, offset: content.indexOf(text, from), anchor: 'L1', section: 'L' }); } };
}
test('source context binds exact guard and function header offsets without body borrowing', () => {
  const f = fixture("function validate(value) {\n  if (!value) throw Error('EMPTY');\n}\n");
  const text = "  if (!value) throw Error('EMPTY');", c = f.quote(text);
  assert.equal(c.name, 'validate'); assert.equal(c.header, 'function validate(value) ');
  assert.equal(c.document_hash, f.doc.sha256);
  assert.equal(f.doc.content.slice(c.quote_start, c.quote_end), text);
  assert.equal(f.doc.content.slice(c.header_start, c.header_end), c.header);
  assert.equal(f.doc.content.slice(c.function_start, c.function_end), f.doc.content.trim());
  assert.deepEqual(Object.keys(c), ['document_hash', 'quote_start', 'quote_end', 'function_start', 'function_end', 'header_start', 'header_end', 'header', 'name']);
  assert.ok(Object.isFrozen(c)); assert.ok(!c.header.includes('throw'));
});
test('source context chooses deepest named or anonymous owner rather than outer function', () => {
  const f = fixture('function outer() { function inner() { return 1; } list.map(function () { return 2; }); }');
  assert.equal(f.quote('return 1;').name, 'inner');
  assert.equal(f.quote('return 2;').name, null);
  assert.equal(f.quote('return 2;').header, 'function () ');
  assert.equal(f.quote('function inner() { return 1; }'), null);
});

test('source context retains enclosing guards with complete callbacks but rejects partial nested spans', () => {
  const guard = 'if (items.some(item => !item.id)) throw Error("INVALID");';
  const f = fixture('function validate(items) { ' + guard + ' items.map(item => item.id); }');
  assert.equal(f.quote(guard).name, 'validate');
  assert.equal(f.quote('!item.id').name, null);
  assert.equal(f.quote('item => !item.id'), null);
  assert.equal(f.quote('if (items.some(item => !item'), null);
  assert.equal(f.quote('!item.id)) throw Error("INVALID");'), null);
  assert.equal(f.quote('!item.id)) throw Error("INVALID"); items.map(item => item.id'), null);
  const named = fixture('function outer() { if (items.some(function check(item) { return !item.id; })) throw Error("INVALID"); }');
  assert.equal(named.quote('if (items.some(function check(item) { return !item.id; })) throw Error("INVALID");').name, 'outer');
  assert.equal(named.quote('return !item.id;').name, 'check');
});
test('source context resolves static arrows methods and duplicate names by source ranges', () => {
  const f = fixture('const pick = x => x + 1; class A { run() { return 2; } [key]() { return 3; } } const o = { run() { return 4; } };');
  assert.equal(f.quote('x + 1').name, 'pick'); assert.equal(f.quote('x + 1').header, 'pick = x => ');
  const a = f.quote('return 2;'), b = f.quote('return 4;');
  assert.equal(a.name, 'run'); assert.equal(b.name, 'run'); assert.notEqual(a.function_start, b.function_start);
  assert.equal(f.quote('return 3;').name, null);
});
test('source context fails closed for cross-function fragments malformed source or unsupported files', () => {
  const text = 'function a() { return 1; } function b() { return 2; }', f = fixture(text);
  assert.equal(f.quote('return 1; } function b() { return 2;'), null);
  assert.equal(fixture('function a( {').quote('function a( {'), null);
  assert.equal(fixture(text, 'module.ts').quote('return 1;'), null);
  assert.equal(sourceContextResolver({ ...f.doc, kind: 'runtime' })({ text: 'return 1;', offset: text.indexOf('return'), section: 'L', anchor: 'L1' }), null);
  assert.equal(sourceContextResolver({ ...f.doc, sha256: '0'.repeat(64) })({ text: 'return 1;', offset: text.indexOf('return'), section: 'L', anchor: 'L1' }), null);
});
test('source context preserves UTF16 CRLF indentation and chunk offsets exactly', () => {
  const f = fixture('const label = "😀";\r\nfunction guard() {\r\n    return "🚀";\r\n}\r\n');
  const c = f.quote('    return "🚀";');
  assert.equal(c.name, 'guard'); assert.equal(c.quote_start, f.doc.content.indexOf('    return'));
  assert.equal(c.quote_end - c.quote_start, '    return "🚀";'.length);
  const chunk = f.quote('return "🚀"'); assert.equal(chunk.name, 'guard');
  assert.equal(f.resolve({ text: 'return "🚀"', offset: chunk.quote_start - 1, section: 'L', anchor: 'L3:2' }), null);
  assert.equal(f.resolve({ text: 'return "🚀"', offset: chunk.quote_start, section: 'R', anchor: 'R3' }), null);
});
test('source context rejects oversized headers and never invents dynamic assignment names', () => {
  const f = fixture('function long(' + Array.from({ length: 110 }, (_, i) => 'arg' + i).join(',') + ') { return 1; }');
  assert.equal(f.quote('return 1;'), null);
  const a = fixture('target[key] = function () { return 2; };');
  assert.equal(a.quote('return 2;').name, null);
});
