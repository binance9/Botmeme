const {test}=require('node:test'),assert=require('node:assert/strict');
const {create,normalize}=require('C:/Botmeme/public/meme-trader/reference-stream.js');
const {preview}=require('C:/Botmeme/dashboard/order-preview.cjs');
const message=(frame='1s')=>({e:'kline',s:'SOLUSDT',k:{s:'SOLUSDT',i:frame,t:1790522412000,o:'121.7',h:'121.8',l:'121.6',c:'121.75',q:'23'}});
test('real frame preserves exchange time and OHLC without generating ticks',()=>{
 assert.deepEqual(normalize(message(),'1s'),{timestamp:1790522412000,open:121.7,high:121.8,low:121.6,close:121.75,volume:23});
 for(const bad of [{...message(),s:'BTCUSDT'},message('1m'),{...message(),k:{...message().k,c:'NaN'}},{...message(),k:{...message().k,h:'120'}}])assert.equal(normalize(bad,'1s'),null);
});
test('switch closes old stream; delayed old frames ignored; close cancels reconnect',()=>{
 const sockets=[],timers=new Map(),rows=[];let id=0;
 class WS{constructor(url){this.url=url;sockets.push(this);}close(){this.closed=true;this.onclose?.();}emit(value){this.onmessage({data:JSON.stringify(value)});}}
 const client=create({onCandle:c=>rows.push(c),onStatus:()=>{},WebSocketImpl:WS,setTimer:fn=>{timers.set(++id,fn);return id;},clearTimer:id=>timers.delete(id)});
 client.select(1000);client.select(1000);assert.equal(sockets.length,1);
 sockets[0].emit(message());assert.equal(rows.length,1);
 client.select(60000);assert.equal(sockets[0].closed,true);sockets[0].emit(message());assert.equal(rows.length,1);
 sockets[1].emit(message('1m'));assert.equal(rows.length,2);
 sockets[1].close();assert.equal(timers.size,1);const fn=[...timers.values()][0];timers.clear();fn();assert.equal(sockets.length,3);
 client.close();assert.equal(timers.size,0);assert.equal(sockets[2].closed,true);
});
test('manual ticket validates 10..100% and never treats paper amount as live balance',()=>{
 const snapshot={trades:[{id:'paper1',status:'open',network:'ROBINHOOD',tokenId:'test-token',quantity:588546}]},control={wallet:{connected:true,session:{network:'SOLANA'}}};
 for(const percent of [10,35,100]){const p=preview({tradeId:'paper1',side:'SELL',percent},snapshot,control);assert.equal(p.status,200);assert.equal(p.body.submitted,false);assert.equal(p.body.quantity,null);assert.ok(p.body.reasons.includes('WALLET_NETWORK_MISMATCH'));}
 for(const percent of [0,9,101,NaN,50.5])assert.equal(preview({tradeId:'paper1',side:'SELL',percent},snapshot,control).status,400);
 assert.equal(preview({tradeId:'missing',side:'BUY',percent:100},snapshot,control).status,409);
});
