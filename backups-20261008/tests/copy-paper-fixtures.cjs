'use strict';
// Synthetic RPC fixtures, exclusively for isolated tests. Never feed production.
const {JUPITER,USDC,SOL}=require('../services/copy-paper/solana.cjs');
const {createHash}=require('node:crypto');
const wallet=SOL,token='TokenSyntheticFixtureOnly';
function b58(b){const a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+b.toString('hex')),s='';while(n){s=a[Number(n%58n)]+s;n/=58n;}return s;}
function tx({side='BUY',before=0,quantity=100,slot=1,now=Date.now(),sig=String(slot%9+1).repeat(88)}={}){
 const amount=n=>({amount:String(Math.round(n*1e6)),decimals:6});const balance=(mint,i,n)=>({mint,accountIndex:i,owner:wallet,uiTokenAmount:amount(n)});
 const after=side==='BUY'?before+quantity:before-quantity;
 return {slot,blockTime:Math.floor(now/1000),transaction:{signatures:[sig],message:{accountKeys:[{pubkey:wallet,signer:true}],instructions:[{programId:JUPITER,accounts:['Token',wallet],data:b58(createHash('sha256').update('global:route').digest().subarray(0,8))}]}},meta:{err:null,fee:5000,preTokenBalances:[balance(token,1,before),balance(USDC,2,10000)],postTokenBalances:[balance(token,1,after),balance(USDC,2,10000+(side==='BUY'?-quantity:quantity))]}};
}
module.exports={tx,wallet,token};
