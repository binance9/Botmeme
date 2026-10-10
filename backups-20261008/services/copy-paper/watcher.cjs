'use strict';
// Event-driven chain subscriptions. RPC reads are caused by a notification or reconnect only.
// The public Solana RPC throttles per IP — and the wallet-capital verification
// shares it — so replay batches stay tiny, getTransaction calls are paced, and
// reads fall back across endpoints instead of hammering one throttled host.
const RPC_ENDPOINTS=(process.env.BOTMEME_COPY_RPC_URL?[process.env.BOTMEME_COPY_RPC_URL]:['https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com']);
const REPLAY_LIMIT=8,REPLAY_PACING_MS=400;
function createWatcher({ledger,wsUrl=process.env.BOTMEME_COPY_WS_URL||'wss://api.mainnet-beta.solana.com',WebSocketImpl=globalThis.WebSocket,fetchImpl=globalThis.fetch}={}){
 let socket,timer,closed=false,key='',generation=0,attempt=0,queue=Promise.resolve(),lastMessage=0,watchdog;
 const pending=new Map(),subscriptions=new Map();let sequence=0;
 const active=()=>ledger.snapshot().traders.filter(t=>t.enabled);
 const status=s=>active().forEach(t=>ledger.setStatus(t.id,s));
 async function rpc(method,params){let lastError=null;for(const rpcUrl of RPC_ENDPOINTS){try{const r=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('RPC_HTTP_'+r.status);const b=await r.json();if(b.error)throw Error('RPC_REJECTED');return b.result;}catch(error){lastError=error;}}throw lastError??Error('RPC_UNAVAILABLE');}
 async function receive(signature,replay,gen){if(closed||gen!==generation||ledger.has(signature))return;let tx;for(let i=0;i<3&&!tx;i++){if(replay)await new Promise(r=>setTimeout(r,REPLAY_PACING_MS));tx=await rpc('getTransaction',[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:0}]);if(!tx&&i<2)await new Promise(r=>setTimeout(r,750*(i+1)));}if(closed||gen!==generation)return;if(!tx)throw Error('TX_UNAVAILABLE');ledger.process(signature,tx,{replay});}
 function enqueue(signature,replay,gen){queue=queue.then(()=>receive(signature,replay,gen)).catch(()=>status('CHƯA XÁC MINH · không đọc/giải mã được giao dịch'));}
 function connect(){if(closed||!active().length)return;if(!RPC_ENDPOINTS.length||!wsUrl){status('CHƯA XÁC MINH · cần BOTMEME_COPY_RPC_URL / BOTMEME_COPY_WS_URL');return;}try{if(!['https:','http:'].includes(new URL(RPC_ENDPOINTS[0]).protocol)||!['wss:','ws:'].includes(new URL(wsUrl).protocol))throw Error();}catch{status('CHƯA XÁC MINH · RPC/WS không hợp lệ');return;}
  const gen=++generation;pending.clear();subscriptions.clear();status('ĐANG KẾT NỐI');
  try{socket=new WebSocketImpl(wsUrl);}catch{status('CHƯA XÁC MINH · WebSocket không mở được');return;}
  socket.addEventListener('open',()=>{lastMessage=Date.now();for(const t of active()){const id=++sequence;pending.set(id,t);socket.send(JSON.stringify({jsonrpc:'2.0',id,method:'logsSubscribe',params:[{mentions:[t.wallet]},{commitment:'finalized'}]}));}socket.send(JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'slotSubscribe',params:[]}));});
  socket.addEventListener('message',e=>{if(gen!==generation)return;lastMessage=Date.now();let m;try{m=JSON.parse(e.data);}catch{return;}if(pending.has(m.id)){const t=pending.get(m.id);pending.delete(m.id);if(m.error||!Number.isInteger(m.result)){ledger.setStatus(t.id,'CHƯA XÁC MINH · subscription bị từ chối');return;}subscriptions.set(m.result,t);attempt=0;ledger.setStatus(t.id,'REALTIME · finalized · Jupiter v6');
    // Recovery is observational: never place late copies. Bounded history cannot prove gap-free coverage.
    if(ledger.snapshot().historyCount)rpc('getSignaturesForAddress',[t.wallet,{limit:REPLAY_LIMIT,commitment:'finalized'}]).then(rows=>{if(gen!==generation)return;for(const r of (rows||[]).reverse())if(!r.err)enqueue(r.signature,true,gen);ledger.setStatus(t.id,'REALTIME · phục hồi tối đa '+REPLAY_LIMIT+' tx; gap CHƯA XÁC MINH');}).catch(()=>ledger.setStatus(t.id,'REALTIME · lịch sử gap CHƯA XÁC MINH'));
   }else if(m.method==='logsNotification'&&subscriptions.has(m.params?.subscription)){const v=m.params.result?.value;if(v&&!v.err)enqueue(v.signature,false,gen);}});
  socket.addEventListener('error',()=>{if(gen===generation)status('CHƯA XÁC MINH · lỗi WebSocket');});
  socket.addEventListener('close',()=>{if(closed||gen!==generation)return;status('MẤT KẾT NỐI · chưa xác minh khoảng gián đoạn');clearTimeout(timer);timer=setTimeout(connect,Math.min(30000,1000*2**Math.min(attempt++,5)));timer.unref?.();});
 }
 function reconcile(){const next=active().map(t=>t.id).sort().join(',');if(next===key)return;key=next;++generation;clearTimeout(timer);socket?.close();connect();}
 const unsubscribe=ledger.subscribe(reconcile);reconcile();watchdog=setInterval(()=>{if(socket?.readyState===1&&Date.now()-lastMessage>60000)socket.close();},15000);watchdog.unref?.();
 return {close(){closed=true;++generation;unsubscribe();clearTimeout(timer);clearInterval(watchdog);socket?.close();},idle:()=>queue};
}
module.exports={createWatcher};
