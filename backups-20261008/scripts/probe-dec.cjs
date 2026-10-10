'use strict';
// Vì sao candidate 9B4 (sig 08:45:04) bị NO_ACTION 'stale' khi age chỉ vài giây?
// Chạy plan() thật với world qua throughId = sig.id — đúng thứ tự runtime.
const fs = require('node:fs');
process.chdir('C:/Botmeme');
const lines = fs.readFileSync('C:/Botmeme/data/runtime.jsonl', 'utf8').split('\n').filter(Boolean);
const map = new Map(); const events = [];
for (const line of lines) { let r; try { r = JSON.parse(line); } catch { continue; } const e = r.value && r.value.event; if (e) { map.set(e.id, e); events.push(e); } }
const sig = [...map.values()].filter(e => e.type === 'SignalObservation' && e.timestamp.slice(11, 19) === '08:45:04').at(-1);
const cand = map.get(sig.payload.candidateId);
const dec = events.find(e => e.type === 'StrategyDecision' && e.payload.candidateId === cand.id && e.timestamp.includes('T08:45:05'));
const prior = events.slice(0, events.findIndex(e => e.id === dec.id) + 1);
const { buildWorld } = require('../services/commander/world.cjs');
const { plan } = require('../services/commander/decision.cjs');
const runtime = { snapshot: () => ({ events: prior, revision: prior.length, deliveryErrors: [] }) };
const performance = { equity: 23.07, maxDrawdown: 0.0003, capitalUsed: 0, cash: 23.07, budgetUsd: 23.07 };
const tradeStore = { snapshot: () => ({ trades: [], positions: [], performance }) };
const world = buildWorld(runtime, tradeStore, dec.id);
console.log('world: history', world.history.length, '| regimes', world.regimes.length);
const result = plan(world, cand, sig, new Date(dec.timestamp));
console.log('plan() →', JSON.stringify({ action: result && result.action, reason: result && String(result.reason).slice(0, 80) }));
