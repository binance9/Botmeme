'use strict';
const fs=require('fs');const {NETWORKS}=require('./contracts/index.cjs');
function createTradingSettings(filename){
 let settings={};try{settings=JSON.parse(fs.readFileSync(filename,'utf8'));}catch(e){if(filename&&e.code!=='ENOENT')throw e;}
 const valid=(network,multiple)=>{if(!NETWORKS.includes(network)||![2,3,5,10].includes(multiple))throw Error('INVALID_TAKE_PROFIT');};
 const destinationValid=(network,address)=>{if(!NETWORKS.includes(network)||typeof address!=='string')throw Error('LIVE_DESTINATION_INVALID');if(address){try{if(new (require('@solana/web3.js').PublicKey)(address).toBase58()!==address)throw Error();}catch{throw Error('LIVE_DESTINATION_INVALID');}}};
 for(const [network,multiple] of Object.entries(settings))if(network!=='withdrawalDestinations')valid(network,multiple);
 for(const [network,address] of Object.entries(settings.withdrawalDestinations??{}))destinationValid(network,address);
 const save=next=>{if(filename){fs.writeFileSync(filename+'.tmp',JSON.stringify(next));fs.renameSync(filename+'.tmp',filename);}settings=next;};
 return {get:network=>settings[network]??2,set(network,multiple){valid(network,multiple);save({...settings,[network]:multiple});return multiple;},getDestination:network=>settings.withdrawalDestinations?.[network]??'',setDestination(network,address){destinationValid(network,address);save({...settings,withdrawalDestinations:{...settings.withdrawalDestinations,[network]:address}});return address;}};
}
module.exports={createTradingSettings};
