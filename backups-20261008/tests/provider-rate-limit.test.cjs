'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRateLimit } = require('../core/market-data/providers/rate-limit.cjs');
test('a zero retry header backs off instead of hammering the provider', () => {
  let clock = 0; const gate = createRateLimit({ now: () => clock });
  for (const expected of [15000, 30000, 60000, 60000]) {
    assert.equal(gate.limited('0'), expected);
    clock += expected; assert.equal(gate.remaining(), 0);
  }
});
test('a server retry header is honored up to one minute', () => {
  let clock = Date.parse('2026-09-24T00:00:00Z'); const gate = createRateLimit({ now: () => clock });
  assert.equal(gate.limited('60'), 60000);
  assert.equal(gate.limited('3600'), 60000);
  clock += 59999; assert.equal(gate.remaining(), 1);
  gate.recovered(); assert.equal(gate.remaining(), 1, 'cannot reset before the deadline');
  clock += 1; gate.recovered(); assert.equal(gate.remaining(), 0);
});
test('HTTP date retry deadline is capped and a malformed header still pauses', () => {
  let clock = Date.parse('2026-09-24T00:00:00Z'); const gate = createRateLimit({ now: () => clock });
  assert.equal(gate.limited('Thu, 24 Sep 2026 00:30:00 GMT'), 60000);
  clock += 60000; gate.recovered();
  assert.equal(gate.limited('invalid'), 15000);
});
test('only completed recovery resets the pause', () => {
  let clock = 0; const gate = createRateLimit({ now: () => clock });
  gate.limited(null); assert.equal(gate.remaining(), 15000);
  clock += 15000; gate.recovered(); assert.equal(gate.remaining(), 0);
  assert.equal(gate.limited(null), 15000);
});
