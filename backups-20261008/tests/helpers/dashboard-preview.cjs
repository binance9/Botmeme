'use strict';
// Isolated visual QA only: in-memory synthetic PAPER positions, no production journal.
const { createApplication } = require('../../runtime/application.cjs');
const { createDashboardServer } = require('../../scripts/serve-meme-trader.cjs');
const { seedPosition } = require('./manual-paper-fixture.cjs');
(async () => {
  let clock = new Date(Date.now()-3600000); const now = () => clock;
  const app = createApplication({ now, capitalUsd:10000, providers:{} });
  for (const token of ['QA_FOMO','QA_LONG_TOKEN_NAME','QA_PEPE']) await seedPosition({...app,now},token);
  clock=new Date();
  for (const token of ['QA_FOMO','QA_LONG_TOKEN_NAME','QA_PEPE']) {
    const source=app.runtime.get(token+'/profit');
    app.runtime.publish({...source,id:token+'/latest',timestamp:clock.toISOString(),payload:{...source.payload,observedAt:clock.toISOString()}});
  }
  await app.runtime.flush();
  const server=createDashboardServer({application:app,now,copyWatch:false,copyPath:null});
  for (const token of ['QA_FOMO','QA_LONG_TOKEN_NAME','QA_PEPE']) {
    const end=Math.floor(clock.getTime()/60000)*60000;
    const candles=Array.from({length:75},(_,i)=>{const base=.001+i*.000016,close=base+(i%3===0?-.000015:.000012);return {at:end-(74-i)*60000,open:base,high:Math.max(base,close)+.00002,low:Math.min(base,close)-.00002,close,volumeUsd:200+i*4};});
    server.store.quote({network:'SOLANA',token,priceUsd:.00225,at:clock.getTime(),candles});
  }
  server.server.listen(7884,'127.0.0.1',()=>console.log('QA FIXTURE ONLY http://127.0.0.1:7884/meme-trader/'));
  process.on('SIGINT',()=>server.close().then(()=>process.exit()));
})().catch(error=>{console.error(error);process.exitCode=1;});
