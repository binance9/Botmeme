'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {decode,validWallet,USDC}=require('./solana.cjs');
function createCopyPaper({filename=null,isRunning=()=>false,solPrice=()=>null,now=()=>Date.now()}={}){
 let state={version:1,mode:'paper',budgetUsd:0,buyUsd:0,cashUsd:0,traders:[],positions:{},history:[],seen:{}};
 if(filename&&fs.existsSync(filename)){state=JSON.parse(fs.readFileSync(filename,'utf8'));if(state.version!==1||state.mode!=='paper')throw Error('INVALID_COPY_STORE');}
 const listeners=new Set(),status=new Map();let closed=false;
 function commit(next){if(closed)throw Error('COPY_CLOSED');if(filename){fs.mkdirSync(path.dirname(filename),{recursive:true});const temp=filename+'.tmp';const fd=fs.openSync(temp,'w');try{fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,filename);}state=next;for(const cb of listeners)cb(snapshot());}
 function snapshot(){return structuredClone({...state,seen:undefined,traders:state.traders.map(t=>({...t,realtime:status.get(t.id)||'CHƯA XÁC MINH'})),history:state.history,historyCount:state.history.length,decoder:'SOLANA · Jupiter v6 only; other swaps CHƯA XÁC MINH',running:isRunning()});}
 function configure({budgetUsd,buyUsd}){if(!Number.isFinite(budgetUsd)||budgetUsd<0||!Number.isFinite(buyUsd)||buyUsd<0||buyUsd>budgetUsd||budgetUsd>1000000)throw Error('INVALID_COPY_BUDGET');const next=structuredClone(state);const spent=next.budgetUsd-next.cashUsd;if(budgetUsd<spent)throw Error('COPY_BUDGET_IN_USE');next.cashUsd+=budgetUsd-next.budgetUsd;Object.assign(next,{budgetUsd,buyUsd});commit(next);}
 function add({name,wallet,chain}){if(chain!=='SOLANA')throw Error('CHAIN_CHUA_XAC_MINH');if(typeof name!=='string'||!name.trim()||name.length>80||!validWallet(wallet))throw Error('INVALID_TRADER');if(state.traders.some(t=>t.wallet===wallet&&t.chain===chain))throw Error('TRADER_EXISTS');if(state.traders.length>=20)throw Error('TRADER_LIMIT');const next=structuredClone(state);next.traders.push({id:randomUUID(),name:name.trim(),wallet,chain,enabled:true,addedAt:now()});commit(next);return snapshot();}
 function toggle(id,enabled){const next=structuredClone(state),t=next.traders.find(t=>t.id===id);if(!t||typeof enabled!=='boolean')throw Error('INVALID_TRADER');t.enabled=enabled;commit(next);}
 function process(signature,tx,{replay=false}={}){
  if(state.seen[signature])return {duplicate:true};if(!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)||tx?.transaction?.signatures?.[0]!==signature)throw Error('TX_SIGNATURE_MISMATCH');
  const next=structuredClone(state),rows=[];const at=now();
  for(const trader of next.traders.filter(t=>t.enabled)){
   const decoded=decode(tx,trader.wallet);if(!decoded.swap){if(decoded.reason!=='NOT_TRADER_SIGNER')status.set(trader.id,'CHƯA XÁC MINH: '+decoded.reason);continue;}
   const swap=decoded.swap,key=trader.id+':'+swap.token;let pos=next.positions[key]||{raw:'0',costUsd:0,decimals:swap.decimals,traderId:trader.id,token:swap.token};
   const sol=solPrice(),usdRate=swap.quoteMint===USDC?1:(Number.isFinite(sol?.price)&&sol.price>0&&at-sol.at>=0&&at-sol.at<=60000?sol.price:null),priceUsd=usdRate?swap.priceQuote*usdRate:null;
   const row={id:signature+':'+trader.id,txHash:signature,traderId:trader.id,trader:trader.name,wallet:trader.wallet,...swap,observedAt:new Date(at).toISOString(),priceUsd,copyRaw:'0',copyQuantity:0,copyPriceUsd:null,status:'WATCH_ONLY',reason:null};
   const fresh=swap.time&&at-Date.parse(swap.time)>=-5000&&at-Date.parse(swap.time)<=120000;
   if(replay||!fresh||Date.parse(swap.time)<trader.addedAt||swap.slot<=(trader.lastSlot??-1)){row.reason='HISTORY_STALE_OR_UNORDERED_NO_FILL';}
   else if(!isRunning()){row.reason='PAPER_STOPPED';}
   else if(!priceUsd){row.reason='USD_PRICE_CHUA_XAC_MINH';}
   else if(swap.side==='BUY'){
    const spend=Math.min(next.buyUsd,next.cashUsd);const raw=Math.floor(spend/priceUsd*10**swap.decimals);
    if(!Number.isSafeInteger(raw)||raw<=0)row.reason='NO_COPY_BUDGET_OR_UNSAFE_QUANTITY';
    else {const q=BigInt(raw),cost=Number(q)/10**swap.decimals*priceUsd;if(cost>next.cashUsd+1e-9)throw Error('COPY_BUDGET_EXCEEDED');pos.raw=String(BigInt(pos.raw)+q);pos.costUsd+=cost;next.cashUsd-=cost;Object.assign(row,{copyRaw:String(q),copyQuantity:Number(q)/10**swap.decimals,copyPriceUsd:priceUsd,status:'PAPER_FILLED'});}
   }else{
    const held=BigInt(pos.raw),sold=BigInt(swap.rawQuantity),before=BigInt(swap.traderPreRaw);const q=held*sold/before;
    if(!q)row.reason='NO_COPY_POSITION_OR_DUST';else{const fraction=Number(q)/Number(held),cost=pos.costUsd*fraction;pos.raw=String(held-q);pos.costUsd-=cost;next.cashUsd+=Number(q)/10**swap.decimals*priceUsd;Object.assign(row,{copyRaw:String(q),copyQuantity:Number(q)/10**swap.decimals,copyPriceUsd:priceUsd,status:'PAPER_FILLED',sellFraction:Number(sold)/Number(before)});}
   }
   trader.lastSlot=Math.max(trader.lastSlot??-1,swap.slot);next.positions[key]=pos;rows.push(row);status.set(trader.id,'ĐÃ NHẬN SWAP · '+row.status);
  }
  next.seen[signature]={slot:tx.slot,at};next.history.push(...rows);commit(next);return {duplicate:false,rows};
 }
 return {snapshot,configure,add,toggle,process,has:s=>!!state.seen[s],setStatus(id,s){status.set(id,s);for(const cb of listeners)cb(snapshot());},subscribe(cb){listeners.add(cb);return()=>listeners.delete(cb);},close(){closed=true;listeners.clear();}};
}
module.exports={createCopyPaper};
