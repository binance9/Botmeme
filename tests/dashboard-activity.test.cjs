'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/meme-trader/app.js'), 'utf8');
const renderSource = source.slice(source.indexOf('  function activityLine(event) {'), source.indexOf('  function renderDiscoveries(){'));
function render(activities) {
  const node = {};
  const context = vm.createContext({ $: () => node, snapshot: { activities }, expanded: false,
    ids:['jev','codex-1','codex-2','codex-3'], names:['JEV','CODEX 1','CODEX 2','CODEX 3'], colors:['green','blue','purple','orange'], symbols:['a','b','c','d'],time: String,
    esc: value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) });
  vm.runInContext(renderSource+'\nrenderEvents();',context); return node.innerHTML;
}
const event = {id:'real-id',producer:'PAPER_EXECUTION',source:'paper.next-observation',correlationId:'decision-1',evidence:['intent-1'],occurredAt:'2026-09-24T10:00:00.000Z',agentId:'codex-3',message:'BUY token (paper)'};
test('execution activity follows actual producer, never a misleading CODEX 3 agentId',()=>{
  const html=render([event]); assert.match(html,/PAPER/);assert.doesNotMatch(html,/CODEX 3/);assert.match(html,/data-event-id="real-id"/);assert.match(html,/data-producer="PAPER_EXECUTION"/);
});
test('unattributed canned activity cannot appear as live AI evidence',()=>{
  const html=render([{agentId:'codex-2',message:'Learning from 3780 trades'}, {...event,producer:'UNKNOWN'}]);
  assert.doesNotMatch(html,/3780|BUY token|data-event-id/);
});
test('critic activity remains attributed to CODEX 3 and escapes event metadata',()=>{
  const html=render([{...event,producer:'CODEX_3',agentId:'codex-1',source:'critic"<script>',message:'Analyzing failed paper fill'}]);
  assert.match(html,/CODEX 3/);assert.doesNotMatch(html,/CODEX 1|<script>/);assert.match(html,/&lt;script&gt;/);
});
