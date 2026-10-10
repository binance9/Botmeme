'use strict';
// Runtime acceptance uses an isolated real HTTP/SSE server and an isolated journal.
// Deterministic test inputs are never sent to the owner's production dashboard.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createDashboardServer } = require('../scripts/serve-meme-trader.cjs');
const output = path.join(__dirname,'artifacts','realtime-state');
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'botmeme-realtime-ui-'));
const journalPath = path.join(profile,'events.jsonl');
app.setPath('userData',profile);
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.commandLine.appendSwitch('disable-gpu');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const receipt={checks:[],errors:[],requests:[],journalPath};
let win, mirror, service, dashboardURL, origin, eventId=0;
const check=(name,condition)=>{assert.ok(condition,name);receipt.checks.push(name);console.log('PASS '+name);};
const inspect=()=>win.webContents.executeJavaScript(`(() => {
 const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
 return {theme:document.documentElement.dataset.theme,version:Number(document.documentElement.dataset.stateVersion),progress:[...document.querySelectorAll('.agent-percent')].map(x=>x.textContent),chart:document.querySelector('#price-chart').innerHTML,chartAria:document.querySelector('#price-chart').getAttribute('aria-label'),events:document.querySelector('#activity-list').innerText,trades:document.querySelector('#trade-rows').innerText,pnl:document.querySelector('#pnl').textContent,total:Number(document.querySelector('#total-trades').textContent),open:Number(document.querySelector('#open-trades').textContent),bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth,agents:[...document.querySelectorAll('.agent-card')].map(x=>{const r=x.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}),rects:{sidebar:rect('.sidebar'),header:rect('.topbar'),chart:rect('.chart-panel'),trades:rect('.trades-panel'),overview:rect('.overview-panel'),activity:rect('.activity-panel')},colors:{page:getComputedStyle(document.documentElement).backgroundColor,text:getComputedStyle(document.body).color}};
})()`);
const settleFrame=()=>win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
const click=async selector=>{await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);await settleFrame();};
async function until(fn,label,timeout=7000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(60);}throw new Error('Timed out: '+label);}
async function capture(name){await settleFrame();fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
const make=(type,source,data,occurredAt=new Date().toISOString())=>({id:'ui-test-'+(++eventId),type,source,occurredAt,data});
async function post(e){const response=await fetch(origin+'/api/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(e)});assert.equal(response.status,201,await response.clone().text());const result=await response.json();await until(()=>win.webContents.executeJavaScript(`Number(document.documentElement.dataset.stateVersion)===${result.currentVersion}`),'render event '+e.id);return result;}
app.whenReady().then(async()=>{
 fs.mkdirSync(output,{recursive:true});
 check('PASS UI stylesheet unchanged',createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../public/meme-trader/styles.css'))).digest('hex')==='8fcb09970e47142ee3278bc95b3631352272aab9ed5e564d7cbb1c1d5cc3c59f');
 check('PASS UI artwork unchanged',createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../public/meme-trader/reference.png'))).digest('hex')==='f28e2b8fbaf8b7af90c72ffd5c75b739ab812fc798ea0545bec4a955db195ff1');
 service=createDashboardServer({journalPath});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const port=service.server.address().port;origin=`http://127.0.0.1:${port}`;dashboardURL=origin+'/meme-trader/';
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{receipt.requests.push(details.url);callback({});});
 const options={show:false,frame:false,width:1536,height:1024,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}};
 win=new BrowserWindow(options);win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)receipt.errors.push(message);});
 await win.loadURL(dashboardURL);await until(()=>win.webContents.executeJavaScript('document.documentElement.dataset.stateVersion==="0"'),'initial SSE snapshot');await settleFrame();
 const initial=await inspect();receipt.initial=initial;
 check('Light theme default',initial.theme==='light');
 check('Four AI cards retain one desktop row',initial.agents.length===4&&initial.agents.every(a=>a.y===75&&a.height>=270&&a.height<=320));
 check('Reference sidebar and header unchanged',initial.rects.sidebar.width===222&&initial.rects.header.height===60);
 check('Reference lower panel geometry unchanged',Math.abs(initial.rects.chart.y-initial.rects.overview.y)<1&&initial.rects.chart.y>=360&&initial.rects.chart.y<=400&&initial.rects.chart.width>initial.rects.overview.width);
 check('CODEX 3 is Forensic Analyst',await win.webContents.executeJavaScript('document.querySelectorAll(".agent-identity p")[3].textContent==="Forensic Analyst"'));
 check('Initial state has no fabricated progress, price, activity or trades',initial.progress.every(x=>x==='—')&&initial.chartAria.includes('Chờ dữ liệu giá')&&initial.events.includes('Chờ event')&&initial.total===0&&initial.open===0);
 await capture('desktop-waiting');await pause(2300);const idle=await inspect();
 check('No producer means no autonomous market, progress or ledger changes',idle.version===0&&idle.chart===initial.chart&&idle.events===initial.events&&idle.trades===initial.trades);
 mirror=new BrowserWindow({...options,width:1024});await mirror.loadURL(dashboardURL);
 await post(make('scan.started','scanner',{runId:'ui-scan',total:4}));
 check('Starting scan alone is 0 percent',(await inspect()).progress[0]==='0%');
 await post(make('scan.item','scanner',{runId:'ui-scan',itemId:'one',tokenId:'token-test',symbol:'TEST',candidate:true}));
 check('One completed item of four is 25 percent',(await inspect()).progress[0]==='25%');
 for(let i=1;i<=3;i++)await post(make('ai.work','codex-'+i,{taskId:'work-'+i,task:i===3?'Điều tra phí giao dịch':'Xử lý tác vụ được giao',status:'running',completed:i,total:4}));
 check('AI progress derives from received work counts',(await inspect()).progress.join(',')==='25%,25%,50%,75%');
 const unsafeText='<img src=x onerror="window.__injected=true">';
 await post(make('activity.logged','codex-3',{message:unsafeText}));
 check('Producer activity is rendered as text, never executable markup',await win.webContents.executeJavaScript(`document.querySelector('#activity-list').innerText.includes('<img')&&!window.__injected&&!document.querySelector('#activity-list img')`));
 await post(make('portfolio.configured','operator',{budgetUsd:1000}));
 for(const [offset,price] of [[120000,10],[60000,11],[0,12]])await post(make('market.tick','market',{tokenId:'token-test',symbol:'TEST',priceUsd:price,volumeUsd:100},new Date(Date.now()-offset).toISOString()));
 const buy=make('trade.filled','paper-ledger',{fillId:'ui-buy',positionId:'ui-position',mode:'paper',tokenId:'token-test',symbol:'TEST',side:'BUY',quantity:10,priceUsd:10,feeUsd:1});
 await post(buy);let current=await inspect();
 check('BUY synchronizes trade, overview, chart identity and activity',current.total===1&&current.open===1&&current.trades.includes('Buy')&&current.events.includes('BUY TEST')&&await win.webContents.executeJavaScript('document.querySelector("#token-symbol").textContent==="TEST"'));
 check('BUY capital includes fees',await win.webContents.executeJavaScript('document.querySelector("#capital-value").textContent==="$101.00"'));
 const beforeRetry=current.version;const retry=await fetch(origin+'/api/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(buy)});assert.equal(retry.status,200);await pause(100);
 check('Retried fill does not create another trade',(await inspect()).total===1&&(await inspect()).version===beforeRetry);
 await post(make('trade.filled','paper-ledger',{fillId:'ui-sell-part',positionId:'ui-position',mode:'paper',tokenId:'token-test',symbol:'TEST',side:'SELL',quantity:4,priceUsd:12,feeUsd:.5}));
 current=await inspect();check('Partial SELL keeps one position and realizes exactly 7.10 USD',current.total===2&&current.open===1&&current.pnl==='+$7.10');
 await post(make('trade.filled','paper-ledger',{fillId:'ui-sell-rest',positionId:'ui-position',mode:'paper',tokenId:'token-test',symbol:'TEST',side:'SELL',quantity:6,priceUsd:11,feeUsd:.5}));
 current=await inspect();check('Full SELL closes position and reconciles net realized PnL',current.total===3&&current.open===0&&current.pnl==='+$12.00'&&current.trades.includes('Đã đóng'));
 await until(()=>mirror.webContents.executeJavaScript(`Number(document.documentElement.dataset.stateVersion)===${current.version}`),'second dashboard');
 check('Both dashboards receive the same atomic state',await mirror.webContents.executeJavaScript('document.querySelector("#pnl").textContent==="+$12.00"&&document.querySelector("#total-trades").textContent==="3"&&document.querySelector("#open-trades").textContent==="0"'));
 await capture('desktop-light');await click('#theme-toggle');const dark=await inspect();
 check('Dark theme remains functional',dark.theme==='dark'&&dark.colors.page!==initial.colors.page);await capture('desktop-dark');
 await win.webContents.reload();await until(()=>win.webContents.executeJavaScript(`Number(document.documentElement.dataset.stateVersion)===${current.version}`),'reload snapshot');
 check('Reload restores authoritative state and theme',(await inspect()).theme==='dark'&&(await inspect()).pnl==='+$12.00');await click('#theme-toggle');
 await click('[data-interval="300000"]');check('Chart interval control remains functional',await win.webContents.executeJavaScript('document.querySelector("#price-chart").getAttribute("aria-label").includes("nến 5 phút")'));
 await click('#show-activity');check('Activity expands in existing panel',await win.webContents.executeJavaScript('document.querySelector("#show-activity").getAttribute("aria-expanded")==="true"'));await click('#show-activity');
 await service.close();await until(()=>win.webContents.executeJavaScript('document.querySelector("#stream-status").textContent==="OFFLINE"'),'disconnect indicator');
 check('Disconnected browser preserves last state but marks it offline',(await inspect()).pnl==='+$12.00');
 service=createDashboardServer({journalPath});await new Promise(resolve=>service.server.listen(port,'127.0.0.1',resolve));
 await until(()=>win.webContents.executeJavaScript('document.querySelector("#stream-status").textContent==="LIVE"'),'SSE reconnect');
 check('Reconnect and server restart restore state without double-counting',(await inspect()).total===3&&(await inspect()).version===current.version);
 receipt.viewports=[];
 for(const width of [1366,1024,768,390,320]){
  win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width,height:1024},viewPosition:{x:0,y:0},deviceScaleFactor:1,viewSize:{width,height:1024},scale:1});
  await until(async()=>(await win.webContents.executeJavaScript('innerWidth'))===width,'viewport '+width);await settleFrame();const s=await inspect();receipt.viewports.push({width,state:s});
  check('No horizontal overflow at '+width,s.bodyWidth<=s.viewport);
  check('Chart canvas renders at '+width,await win.webContents.executeJavaScript('document.querySelector("#price-chart canvas")!==null&&document.querySelector("#price-chart").clientWidth>=160'));
  check('Information order unchanged at '+width,s.rects.trades.y>s.rects.chart.y&&(width>1150||s.rects.overview.y>s.rects.trades.y));
  if(width===390||width===768){await capture(width+'-light');await click('#theme-toggle');await capture(width+'-dark');await click('#theme-toggle');}
 }
 // The expected SSE disconnect logs are browser transport diagnostics, not JS errors.
 const jsErrors=receipt.errors.filter(message=>!message.includes('net::ERR_'));
 check('No renderer JavaScript errors',jsErrors.length===0);
 check('No external API or wallet calls',receipt.requests.every(url=>url.startsWith(origin+'/')||url.startsWith('data:')));
 receipt.status='PASS';
}).catch(error=>{receipt.status='FAIL';receipt.failure=error.stack;console.error(error.stack);}).finally(async()=>{
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'acceptance.json'),JSON.stringify(receipt,null,2));
 for(const window of [win,mirror])if(window&&!window.isDestroyed())window.destroy();
 if(service)await service.close();app.exit(receipt.status==='PASS'?0:1);
});
