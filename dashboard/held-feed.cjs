'use strict';
const NETWORKS={SOLANA:'solana',ETHEREUM:'eth',BSC:'bsc',ROBINHOOD:'robinhood'};
function createHeldFeed({store,fetchImpl=fetch,now=Date.now,intervalMs=60000}){
 let selected=null;
 let pending=false,closed=false,retryAt=0,status={state:'waiting'},timer=null;
 async function poll(){
  if(closed||pending||now()<retryAt)return;
  const state=store.snapshot(),market=state.markets[selected]||state.markets[state.activeToken],network=NETWORKS[market?.network];
  if(!(market?.focusTradeId||market?.discovery)||!network||!market.poolAddress)return;
  pending=true;const token=market.tokenId,pool=market.poolAddress;
  try{
   const response=await fetchImpl('https://api.geckoterminal.com/api/v2/networks/'+network+'/pools/'+encodeURIComponent(pool)+'/trades',{signal:AbortSignal.timeout(8000)});
   if(response.status===429){retryAt=now()+Math.max(30000,Number(response.headers.get('retry-after')||0)*1000);throw Error('RATE_LIMITED');}
   if(!response.ok)throw Error('HTTP_'+response.status);
   const body=await response.json();if(!Array.isArray(body.data))throw Error('INVALID_TRADE_RESPONSE');
   const points=[];
   for(const row of body.data){const a=row?.attributes;if(!a)continue;const from=a.from_token_address===token,to=a.to_token_address===token;if(from===to)continue;const at=Date.parse(a.block_timestamp),priceUsd=Number(from?a.price_from_in_usd:a.price_to_in_usd);if(Number.isFinite(at)&&at<=now()&&Number.isFinite(priceUsd)&&priceUsd>0)points.push({at,priceUsd});}
   points.sort((a,b)=>a.at-b.at);
   if(!closed){const quotes=points.map(point=>({network:market.network,token,...point}));if(typeof store.quotes==='function')store.quotes(quotes);else for(const quote of quotes)store.quote(quote);}
   status={state:points.length?'observed':'no-trades',network:market.network,token,pool,httpStatus:response.status,receivedAt:now(),count:points.length,lastTradeAt:points.at(-1)?.at??null};
  }catch(error){status={state:'unavailable',network:market.network,token,pool,error:error.message,receivedAt:now()};}finally{pending=false;}
 }
 timer=setInterval(poll,intervalMs);timer.unref?.();
 return {select(key){selected=key;return poll();},poll,status:()=>({...status}),close(){closed=true;clearInterval(timer);}};
}
module.exports={createHeldFeed};
