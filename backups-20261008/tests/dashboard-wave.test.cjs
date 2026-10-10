'use strict';
// Deterministic rendering cases, not claims of live market evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/meme-trader/app.js'), 'utf8');
const renderSource = source.slice(source.indexOf('  function chooseChart('), source.indexOf('  function connectionStatus() {'));
function render(points, interval = 60000, historyStatus = null) {
  const nodes = new Map();
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, { attributes: {}, dataset: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute(key, value) { this.attributes[key] = value; }, textContent: '', className: '' }); return nodes.get(selector); };
  const applied = [];
  const klinecharts = {
    registerOverlay: definition => applied.push({type:'overlay',definition}),
    init: (element, options) => { applied.push({ type: 'init', options }); return { applyNewData: data => applied.push({ type: 'new', data }), updateData: data => applied.push({ type: 'update', data }), createIndicator: (indicator, stacked, pane) => applied.push({type:'indicator',indicator,pane}), removeOverlay: () => {}, createOverlay: data => applied.push({type:'markers',data}), setStyles: () => {}, setPriceVolumePrecision: () => {}, resize: () => {} }; },
  };
  const market = points.length ? { symbol: 'Observed token', points, firstPriceUsd: points[0].priceUsd, priceUsd: points.at(-1).priceUsd, historyStatus } : null;
  const context = vm.createContext({ $, klinecharts, window:{MemeTradeView:require('../public/meme-trader/app.js'),innerHeight:768,scrollBy: options=>applied.push({type:'scroll',options})}, referenceFrame:null, esc: value=>String(value), document: { documentElement: { dataset: {} } }, getComputedStyle: () => ({ getPropertyValue: () => '' }), snapshot: { activeToken: 'token', markets: { token: market } }, interval, priceText: String, coinName: symbol => String(symbol ?? '—'), kChart: null, chartKey: null, chartFirst: null, chartCount: 0, chartPrecision:null, avatarDefault: '', fetch: () => Promise.reject(Error('no network in tests')), refHistory: { interval: null, candles: [] }, REFERENCE_QUERY: { 60000: '1m' } });
  vm.runInContext(renderSource + '\nrenderChart();', context);
  return { applied, aria: $('#price-chart').attributes['aria-label'], context, snapshot: context.snapshot, nodes };
}
const fresh = applied => applied.filter(call => call.type === 'new'), updates = applied => applied.filter(call => call.type === 'update');
test('candles render observed OHLC without invented data', () => {
  const { applied, aria } = render([{ at: 0, priceUsd: 10 }, { at: 15000, priceUsd: 12 }, { at: 45000, priceUsd: 11 }]);
  const data = fresh(applied).at(-1).data;
  assert.equal(data.length, 1);
  assert.deepEqual({ open: data[0].open, high: data[0].high, low: data[0].low, close: data[0].close, volume: data[0].volume }, { open: 10, high: 12, low: 10, close: 11, volume: 0 });
  assert.match(aria, /nến 1 phút/);
  assert.doesNotMatch(aria, /NaN|Infinity/);
});
test('missing history never receives an invented candle', () => {
  const empty = render([]);
  assert.equal(fresh(empty.applied).at(-1).data.length, 0);
  assert.match(empty.aria, /Chờ dữ liệu giá/);
  const single = render([{ at: 0, priceUsd: 10 }]);
  assert.equal(fresh(single.applied).at(-1).data.length, 1);
  const short = render([{ at: 0, priceUsd: 10 }], 60000, 'INSUFFICIENT');
  assert.equal(fresh(short.applied).at(-1).data.length, 1);
  assert.match(short.aria, /INSUFFICIENT HISTORY/);
});
test('wider timeframe aggregates the observed range', () => {
  const points = [{ at: 0, priceUsd: 20 }, { at: 60000, priceUsd: 10 }];
  const minute = render(points), five = render(points, 300000);
  assert.equal(fresh(minute.applied).at(-1).data.length, 2);
  assert.equal(fresh(five.applied).at(-1).data.length, 1);
  const wide = fresh(five.applied).at(-1).data[0];
  assert.equal(wide.open, 20);
  assert.equal(wide.close, 10);
  const down = five.applied.find(call => call.type === 'init').options.styles.candle.bar.downColor;
  assert.equal(down, '#f6465d');
  assert.match(five.aria, /nến 5 phút/);
});
test('sub-minute frames build from raw ticks', () => {
  const points = [{ at: 0, priceUsd: 10 }, { at: 1000, priceUsd: 11 }, { at: 61000, priceUsd: 12 }];
  const second = render(points, 1000);
  assert.equal(fresh(second.applied).at(-1).data.length, 3);
  assert.match(second.aria, /nến 1 giây/);
});
test('continuous streaming updates the live candle in place', () => {
  const run = render([{ at: 0, priceUsd: 10 }]);
  run.context.snapshot.markets.token.points.push({ at: 61000, priceUsd: 12 });
  vm.runInContext('renderChart();', run.context);
  const pushed = updates(run.applied).at(-1);
  assert.equal(pushed.data.timestamp, 60000);
  assert.equal(pushed.data.close, 12);
  assert.equal(fresh(run.applied).length, 1);
});

test('batched updates preserve every intermediate observed second and use candle style',()=>{
 const run=render([{at:0,priceUsd:10}],1000);
 run.context.snapshot.markets.token.points.push({at:1000,priceUsd:11},{at:2000,priceUsd:12},{at:3000,priceUsd:11});
 vm.runInContext('renderChart();',run.context);
 assert.deepEqual(updates(run.applied).map(c=>c.data.timestamp),[0,1000,2000,3000]);
 assert.equal(run.applied.find(c=>c.type==='init').options.styles.candle.type,'candle_solid');
});

test('volume pane matches candle colors; vertical wheel scrolls page while Ctrl-wheel stays available to chart',()=>{
 const run=render([{at:0,priceUsd:10}]);
 const styles=run.applied.find(c=>c.type==='init').options.styles;
 assert.equal(styles.indicator.bars[0].upColor,styles.candle.bar.upColor);
 assert.equal(styles.indicator.bars[0].downColor,styles.candle.bar.downColor);
 assert.equal(run.applied.find(c=>c.type==='indicator').indicator.name,'VOL');
 assert.ok(styles.candle.tooltip.custom.some(t=>t.value==='{volume}'));
 assert.equal(styles.crosshair.show,true);
 const wheel=run.nodes.get('#price-chart').listeners.wheel;
 let prevented=0,stopped=0;
 wheel({deltaX:0,deltaY:3,deltaMode:1,ctrlKey:false,preventDefault:()=>prevented++,stopImmediatePropagation:()=>stopped++});
 assert.equal(run.applied.at(-1).options.top,48);assert.equal(prevented,1);assert.equal(stopped,1);
 wheel({deltaX:0,deltaY:10,ctrlKey:true,preventDefault:()=>prevented++,stopImmediatePropagation:()=>stopped++});
 assert.equal(prevented,1);assert.equal(stopped,1);
});

const pick=vm.runInNewContext(source.slice(source.indexOf('  function chooseChart('),source.indexOf('  function renderChart()'))+';chooseChart');
const selectionView={asOf:'2026-09-27T16:00:00Z',activeToken:'dc',markets:{dc:{quoteStale:true,focusTradeId:'buy'},sol:{priceSource:'REFERENCE_FEED'}},trades:[{id:'buy',timestamp:'2026-09-25T01:00:00Z'}]};
test('old stale holding does not hide live reference chart',()=>assert.equal(pick(selectionView).key,'sol'));
test('explicit holding selection remains available',()=>assert.equal(pick(selectionView,'dc').key,'dc'));
test('new buy immediately focuses bought token',()=>assert.equal(pick({...selectionView,trades:[{id:'buy',timestamp:'2026-09-27T15:59:00Z'}]}).key,'dc'));
test('fresh holding stays selected',()=>assert.equal(pick({...selectionView,markets:{...selectionView.markets,dc:{quoteStale:false}}}).key,'dc'));
