'use strict';
// Read-only manual order check. A paper journal is never a wallet balance.
function preview(body, snapshot, control) {
  if(!body||Object.keys(body).sort().join(',')!=='percent,side,tradeId'||!['BUY','SELL'].includes(body.side)||!Number.isInteger(body.percent)||body.percent<10||body.percent>100||typeof body.tradeId!=='string') return {status:400,body:{error:'INVALID_ORDER_REQUEST'}};
  const trade=snapshot.trades.find(t=>t.tradeId===body.tradeId||t.id===body.tradeId);
  if(!trade||trade.status!=='open')return {status:409,body:{error:'OPEN_POSITION_NOT_FOUND'}};
  const reasons=['LIVE_EXECUTION_NOT_CONFIGURED'];
  if(!control.wallet?.connected)reasons.push('WALLET_CONNECTION_REQUIRED');
  else if(control.wallet.session?.network!==trade.network)reasons.push('WALLET_NETWORK_MISMATCH');
  return {status:200,body:{status:'BLOCKED',side:body.side,percent:body.percent,network:trade.network,token:trade.tokenId,positionMode:'paper',walletBalance:null,quantity:null,reasons,submitted:false}};
}
module.exports={preview};
