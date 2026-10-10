'use strict';
const {createHash}=require('node:crypto');
const JUPITER='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SOL='So11111111111111111111111111111111111111112';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(s){if(typeof s!=='string'||s.length>8192)throw Error('INVALID_BASE58');let n=0n;for(const c of s){const i=ALPHABET.indexOf(c);if(i<0)throw Error('INVALID_BASE58');n=n*58n+BigInt(i);}const hex=n.toString(16);return Buffer.concat([Buffer.alloc(s.match(/^1*/)[0].length),n?Buffer.from(hex.length%2?'0'+hex:hex,'hex'):Buffer.alloc(0)]);}
function validWallet(s){try{return typeof s==='string'&&s.length>=32&&s.length<=44&&base58(s).length===32;}catch{return false;}}
const routes=new Map(['route','route_with_token_ledger','shared_accounts_route','shared_accounts_route_with_token_ledger','shared_accounts_exact_out_route','exact_out_route'].map(n=>[createHash('sha256').update('global:'+n).digest().subarray(0,8).toString('hex'),n]));
// Conservative Jupiter v6 adapter. Unknown programs/instructions are not inferred from transfers.
// IDL: https://github.com/jup-ag/jupiter-cpi/blob/main/idl.json
function decode(tx,wallet){
 if(!tx?.meta||tx.meta.err||!Number.isSafeInteger(tx.slot)||!tx.transaction?.message)return {reason:'FAILED_OR_INCOMPLETE_TX'};
 const msg=tx.transaction.message,keys=msg.accountKeys.map(k=>typeof k==='string'?k:k.pubkey),wi=keys.indexOf(wallet);
 if(wi<0||!msg.accountKeys[wi]?.signer)return {reason:'NOT_TRADER_SIGNER'};
 const outer=msg.instructions||[];let verified=false;
 for(const ix of outer){if(ix.programId!==JUPITER)continue;let name;try{name=routes.get(base58(ix.data).subarray(0,8).toString('hex'));}catch{}if(!name)return {reason:'UNSUPPORTED_JUPITER_INSTRUCTION'};const authorityIndex=name.startsWith('shared_')?2:1;if(ix.accounts?.[authorityIndex]!==wallet)return {reason:'ROUTE_AUTHORITY_MISMATCH'};verified=true;}
 if(!verified)return {reason:'UNVERIFIED_SWAP_PROGRAM'};
 // Do not accept an unrelated top-level program (bridge/LP wrapper) alongside the swap.
 const allowed=new Set([JUPITER,'11111111111111111111111111111111','ComputeBudget111111111111111111111111111111','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']);
 if(outer.some(ix=>!allowed.has(ix.programId)))return {reason:'MIXED_OR_UNSUPPORTED_TX'};
 // Unknown raw System/Token instructions could hide additional transfers. Fail closed.
 if(outer.some(ix=>[...allowed].filter(p=>p!==JUPITER&&!p.startsWith('ComputeBudget')&&!p.startsWith('AToken')).includes(ix.programId)&&!ix.parsed))return {reason:'UNPARSED_OUTER_INSTRUCTION'};
 if(outer.some(ix=>ix.programId!==JUPITER&&/^(transfer|transferChecked|mintTo|burn)/i.test(ix.parsed?.type||'')))return {reason:'EXTRA_TRANSFER_OR_LP'};
 const balances=new Map(),ownedIndices=new Set();
 for(const [field,side]of [['preTokenBalances','pre'],['postTokenBalances','post']])for(const b of tx.meta[field]||[]){if(b.owner!==wallet)continue;if(!/^\d+$/.test(b.uiTokenAmount?.amount||'')||!Number.isInteger(b.uiTokenAmount.decimals))return {reason:'INVALID_BALANCE'};let v=balances.get(b.mint);if(!v){v={mint:b.mint,pre:0n,post:0n,decimals:b.uiTokenAmount.decimals};balances.set(b.mint,v);}if(v.decimals!==b.uiTokenAmount.decimals)return {reason:'DECIMAL_MISMATCH'};v[side]+=BigInt(b.uiTokenAmount.amount);ownedIndices.add(b.accountIndex);}
 const moved=[...balances.values()].map(v=>({...v,delta:v.post-v.pre})).filter(v=>v.delta&&v.mint!==SOL);
 const bases=moved.filter(v=>v.mint!==USDC);if(bases.length!==1)return {reason:'AMBIGUOUS_TOKEN_DELTAS'};
 const token=bases[0];let quote=balances.get(USDC),quoteDelta=quote?quote.post-quote.pre:0n,quoteMint=USDC,quoteDecimals=6;
 if(!quoteDelta){quoteMint=SOL;quoteDecimals=9;const before=tx.meta.preBalances,after=tx.meta.postBalances;if(![...ownedIndices,wi].every(i=>Number.isSafeInteger(before?.[i])&&Number.isSafeInteger(after?.[i])))return {reason:'UNSAFE_NATIVE_BALANCE'};
  // Include owned token-account lamports to cancel rent/WSOL-account movements.
  quoteDelta=[...new Set([wi,...ownedIndices])].reduce((s,i)=>s+BigInt(after[i])-BigInt(before[i]),0n)+(wi===0?BigInt(tx.meta.fee||0):0n);
 }
 if(!quoteDelta||(token.delta>0n)===(quoteDelta>0n))return {reason:'NO_VERIFIED_QUOTE_LEG'};
 const quantity=token.delta<0n?-token.delta:token.delta,quoteAmount=quoteDelta<0n?-quoteDelta:quoteDelta;
 const priceQuote=(Number(quoteAmount)/10**quoteDecimals)/(Number(quantity)/10**token.decimals);
 if(!Number.isFinite(priceQuote)||priceQuote<=0)return {reason:'INVALID_SWAP_PRICE'};
 if(token.delta<0n&&(token.pre<=0n||quantity>token.pre))return {reason:'INVALID_SELL_FRACTION'};
 return {swap:{chain:'SOLANA',token:token.mint,side:token.delta>0n?'BUY':'SELL',rawQuantity:String(quantity),decimals:token.decimals,traderPreRaw:String(token.pre),traderPostRaw:String(token.post),quoteMint,quoteSymbol:quoteMint===SOL?'SOL':'USDC',priceQuote,slot:tx.slot,time:tx.blockTime?new Date(tx.blockTime*1000).toISOString():null}};
}
module.exports={decode,validWallet,base58,JUPITER,SOL,USDC,routes};
