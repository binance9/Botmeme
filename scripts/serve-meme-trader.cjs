'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../state/store.cjs');
const root = path.join(__dirname, '..', 'public', 'meme-trader');
const assets = { 'reference-stream.js': 'text/javascript; charset=utf-8', 'index.html': 'text/html; charset=utf-8', 'styles.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'klinecharts.min.js': 'text/javascript; charset=utf-8', 'wallet.js': 'text/javascript; charset=utf-8', 'wallet-sdk.js': 'text/javascript; charset=utf-8', 'wallet.css': 'text/css; charset=utf-8', 'reference.png': 'image/png' };
assets['copy-paper.js']='text/javascript; charset=utf-8';assets['copy-paper.css']='text/css; charset=utf-8';
assets['long-short.js']='text/javascript; charset=utf-8';assets['long-short.css']='text/css; charset=utf-8';
assets['ga-signal.js']='text/javascript; charset=utf-8';

function createDashboardServer(options = {}) {
  const { now } = options;
  const legacy = !options.application && Object.hasOwn(options, 'journalPath');
  const application = legacy ? null : options.application ?? require('../runtime/application.cjs').createApplication({ journalPath: path.join(__dirname, '..', 'data', 'runtime.jsonl'), now });
  const store = legacy ? createStore({ journalPath: options.journalPath, now }) : require('../dashboard/adapter/index.cjs').createDashboardAdapter({ journalPath:application.journalPath, tokenIdentities:application.tokenIdentities, newlyCreated:application.newlyCreated, takeProfitMultiple:application.takeProfitMultiple, workMeter: application.workMeter, runtime: application.runtime, tradeStore: application.tradeStore, now, maxQuoteAgeMs: 300000, evidenceRoot: path.join(__dirname, '..', 'data', 'market-evidence') });
  const heldFeed=application ? require('../dashboard/held-feed.cjs').createHeldFeed({store}) : null;
  const streams = new Set(); let closing;
  const copyStreams=new Set();
  const copy=options.copyPaper??require('../services/copy-paper/service.cjs').createCopyPaper({
    filename:options.copyPath??(legacy?null:path.join(__dirname,'../data/copy-paper.json')),
    isRunning:()=>{const c=application?.control();return c?.running===true&&c.mode==='paper'&&c.network==='SOLANA';},
    solPrice:()=>{const m=store.snapshot().markets?.[JSON.stringify(['INDEX','SOL'])];return m?{price:m.priceUsd,at:Date.parse(m.updatedAt)}:null;}
  });
  const copyWatcher=options.copyWatch===false||legacy?null:require('../services/copy-paper/watcher.cjs').createWatcher({ledger:copy});
  const botManager = application ? require('../services/bot-manager.cjs').createBotManager({ application }) : null;
  let gaSignalService = null; // lazy LONG_SHORT:GA_SIGNAL engine (started on first /api/ga-signal/* hit)
  // Compute one authoritative snapshot per heartbeat, independent of connected panes.
  const heartbeat = setInterval(() => { if (application && streams.size) store.refresh(); }, 15000);
  heartbeat.unref();
  const balances = require('../wallet/connection/balance.cjs').createBalanceReader();
  const refKlines = new Map(); // interval -> { at, value }; short cache for the reference chart history.
  // SOL/USD reference feed for the always-on chart. 1s Binance ticker with a
  // GeckoTerminal fallback; read-only public quotes, no key, never a trade signal.
  let solFeed = null;
  if (application && typeof store.reference === 'function') {
    const sample = url => fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) }).then(response => response.ok ? response.json() : Promise.reject(Error('REFERENCE_HTTP_' + response.status)));
    let solImage = null, referencePending = false;
    solFeed = setInterval(() => {
      if (referencePending) return;
      referencePending = true;
      sample('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT')
        .then(body => Number(body?.price))
        .catch(() => sample('https://api.geckoterminal.com/api/v2/networks/solana/tokens/So11111111111111111111111111111111111111112').then(body => { solImage = typeof body?.data?.attributes?.image_url === 'string' ? body.data.attributes.image_url : solImage; return Number(body?.data?.attributes?.price_usd); }))
        .then(price => { if (Number.isFinite(price) && price > 0) store.reference(price, Date.now(), solImage ?? undefined); })
        .catch(() => {}).finally(() => { referencePending = false; });
    }, 1000);
    solFeed.unref();
  }
  const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  async function readJson(request) {
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw Object.assign(Error('Use application/json'), { status: 415 });
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 65536) throw Object.assign(Error('Request exceeds 64 KiB'), { status: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(Error('Invalid JSON'), { status: 400 }); }
  }
  function exact(body, keys) { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) throw Object.assign(Error('Invalid request fields'), { status: 400 }); }
  const readRawBody = async request => { const chunks = []; for await (const chunk of request) { if (chunks.push(chunk) > 64) throw Object.assign(Error('Request exceeds 64 KiB'), { status: 413 }); } return Buffer.concat(chunks); };
  const server = http.createServer(async (request, response) => {
    try {
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (![expectedHost, `localhost:${server.address().port}`].includes(request.headers.host)) return json(response, 403, { error: 'Invalid host' });
      if (request.headers.origin && ![`http://${expectedHost}`, `http://localhost:${server.address().port}`].includes(request.headers.origin)) return json(response, 403, { error: 'Cross-origin access denied' });
      const pathname = new URL(request.url, `http://${expectedHost}`).pathname;
      if (application && pathname === '/api/paper/withdrawals') {
        if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        return json(response, 200, application.paperWithdrawals());
      }
      if (application && pathname === '/api/paper/withdraw') {
        if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        const body = await readJson(request); exact(body, ['amountSol']);
        const result = await application.withdrawPaperSol(body.amountSol);
        store.refresh(); return json(response, 200, result);
      }
      if (application && pathname === '/api/capital/ledger') {
        if (request.method === 'GET') return json(response, 200, application.paperCapital());
        if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        const body = await readJson(request);
        exact(body, body && Object.hasOwn(body, 'note') ? ['action','amountUsd','note'] : ['action','amountUsd']);
        if (!['deposit','withdraw'].includes(body.action)) return json(response, 400, { error: 'INVALID_CAPITAL_ADJUSTMENT' });
        const result = await application[body.action === 'deposit' ? 'depositPaper' : 'withdrawPaper'](body.amountUsd, body.note);
        store.refresh(); return json(response, 200, result);
      }
      if(pathname==='/api/copy/state'&&request.method==='GET')return json(response,200,copy.snapshot());
      if(pathname==='/api/copy/events'&&request.method==='GET'){
        if(copyStreams.size>=16)return json(response,503,{error:'TOO_MANY_COPY_STREAMS'});
        response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});copyStreams.add(response);
        const send=s=>{if(response.destroyed)return;if(response.writableLength>1048576){response.destroy();return;}response.write(`event: copy\ndata: ${JSON.stringify(s)}\n\n`);};
        const off=copy.subscribe(send);send(copy.snapshot());const beat=setInterval(()=>response.write(': heartbeat\n\n'),15000);beat.unref();
        request.on('close',()=>{off();clearInterval(beat);copyStreams.delete(response);});return;
      }
      if(['/api/copy/config','/api/copy/traders','/api/copy/trader'].includes(pathname)){
        if(request.method!=='POST')return json(response,405,{error:'METHOD_NOT_ALLOWED'});
        const body=await readJson(request);
        if(pathname==='/api/copy/config'){exact(body,['budgetUsd','buyUsd']);copy.configure(body);}
        else if(pathname==='/api/copy/traders'){exact(body,['name','wallet','chain']);copy.add(body);}
        else{exact(body,['id','enabled']);copy.toggle(body.id,body.enabled);}
        return json(response,200,copy.snapshot());
      }
      if (application && pathname === '/api/reference/klines' && request.method === 'GET') {
        const interval = new URL(request.url, `http://${expectedHost}`).searchParams.get('interval');
        const allowed = ['1s', '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
        if (!allowed.includes(interval)) return json(response, 400, { error: 'Invalid interval' });
        const cached = refKlines.get(interval);
        if (cached && Date.now() - cached.at < 10000) return json(response, 200, cached.value);
        let raw = null, lastError = null;
        for (let attempt = 0; attempt < 5 && !raw; attempt++) {
          try { raw = await fetch(`https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=${interval}&limit=500`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) }).then(r => { if (!r.ok) throw Error('REFERENCE_HTTP_' + r.status); return r.json(); }); } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1))); }
        }
        if (!raw) return json(response, 502, { error: 'REFERENCE_FETCH_FAILED', detail: String(lastError?.message ?? 'unknown').slice(0, 120) });
        const candles = (Array.isArray(raw) ? raw : []).map(row => ({ at: row[0], open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[7]) })).filter(c => [c.at, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) && c.open > 0 && c.close > 0);
        const value = { interval, symbol: 'SOL', candles };
        refKlines.set(interval, { at: Date.now(), value });
        return json(response, 200, value);
      }
      if (application && pathname === '/api/asset-image' && request.method === 'GET') {
        const target = new URL(request.url, `http://${expectedHost}`).searchParams.get('u');
        if (!target || target.length > 400 || !/^https:\/\/(?:assets\.geckoterminal\.com|cdn\.dexscreener\.com|dd\.dexscreener\.com|ipfs\.io|cf\.mirror\.world)\/[A-Za-z0-9._/?=&%~-]+$/.test(target)) return json(response, 400, { error: 'Invalid asset url' });
        const image = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(8000) });
        const type = image.headers.get('content-type') || '';
        if (!image.ok || !type.startsWith('image/')) return json(response, 502, { error: 'Asset unavailable' });
        const buffer = Buffer.from(await image.arrayBuffer());
        if (buffer.length > 524288) return json(response, 502, { error: 'Asset too large' });
        response.writeHead(200, { 'Content-Type': type, 'Content-Length': buffer.length, 'Cache-Control': 'public, max-age=86400' });
        return response.end(buffer);
      }
      if (application && pathname === '/api/wallet/balance' && request.method === 'GET') {
        const before = application.control();
        if (!before.wallet.connected) return json(response, 409, { error: 'WALLET_CONNECTION_REQUIRED' });
        const result = await balances.read(before.wallet.session), after = application.control();
        if (!after.wallet.connected || before.epoch !== after.epoch || JSON.stringify(before.wallet.session) !== JSON.stringify(after.wallet.session)) return json(response, 409, { error: 'WALLET_SESSION_CHANGED' });
        return json(response, 200, result);
      }
      if(application && pathname === '/api/orders/preview') {
        if(request.method!=='POST')return json(response,405,{error:'Method not allowed'});
        const body=await readJson(request);
        // Preview remains read-only unless execution is explicitly requested.
        if(body?.execute === true){
          const live = ['live', 'safe'].includes(application.control().mode);
          if(body.side==='BUY'){const result=await application[live?'buyLive':'buyPaper'](body);store.refresh();return json(response,result.status==='REJECTED'?409:result.status==='PENDING'?202:200,{...result,snapshot:{...store.snapshot(),control:application.control()}});}
          const result=await application[live?'sellLive':'sellPaper'](body);
          store.refresh();
          return json(response,result.status==='REJECTED'?409:result.status==='PENDING'?202:200,{...result,snapshot:{...store.snapshot(),control:application.control()}});
        }
        const result=require('../dashboard/order-preview.cjs').preview(body,store.snapshot(),application.control());
        return json(response,result.status,result.body);
      }
      if(heldFeed && pathname==='/api/chart/select' && request.method==='POST'){
        const body=await readJson(request);exact(body,['network','token']);const view=store.snapshot();
        const key=JSON.stringify([body.network,body.token]);
        if(body.network!==view.network||!view.markets[key])return json(response,409,{error:'MARKET_NOT_DISCOVERED'});
        await heldFeed.select(key);return json(response,200,heldFeed.status());
      }
      if(heldFeed && pathname==='/api/chart/feed' && request.method==='GET')return json(response,200,heldFeed.status());
      if (application && pathname === '/api/control' && request.method === 'GET') return json(response, 200, application.control());
      if (application && pathname === '/api/wallet/trading') {
        if (request.method === 'GET') return json(response, 200, await application.tradingBalance());
        if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        const body = await readJson(request); exact(body, ['confirm']);
        const result = await application.createTradingWallet(body.confirm);
        store.refresh(); return json(response, 200, result);
      }
      if (application && pathname === '/api/wallet/withdraw') {
        if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        const body = await readJson(request); exact(body, ['destinationAddress', 'amountSol']);
        const result = await application.withdrawTo(body.destinationAddress, body.amountSol);
        store.refresh(); return json(response, 200, result);
      }
      if (application && pathname === '/api/trading/withdrawal-destination') {
        if (request.method === 'GET') return json(response, 200, application.withdrawalDestination());
        if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        const body = await readJson(request); exact(body, ['network', 'destinationAddress']);
        await application.setWithdrawalDestination(body.network, body.destinationAddress);
        return json(response, 200, application.withdrawalDestination());
      }
      const controls = ['/api/trading/settings', '/api/control', '/api/network', '/api/wallet/connect', '/api/wallet/change', '/api/wallet/disconnect'];
      if (application && controls.includes(pathname)) {
        if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
        const body = await readJson(request);
        if (pathname === '/api/control') {
          exact(body, body.action === 'LIVE' ? ['action', 'confirm'] : ['action']); if (!['START', 'STOP', 'LIVE', 'DISARM'].includes(body.action)) return json(response, 400, { error: 'Invalid control action' });
          if (body.action === 'LIVE') await application.live(body.confirm);
          else await application[body.action === 'DISARM' ? 'disarm' : body.action === 'START' ? 'start' : 'stop']();
        } else if (pathname === '/api/trading/settings') { exact(body,['takeProfitMultiple']); await application.setTakeProfit(body.takeProfitMultiple); } else if (pathname === '/api/network') { exact(body, ['network']); await application.selectNetwork(body.network); }
        else if (pathname === '/api/wallet/connect') { exact(body, ['network', 'address', 'chainId', 'provider']); await application.connect(body); }
        else if (pathname === '/api/wallet/change') { exact(body, ['network', 'address', 'chainId', 'provider']); await application.followWallet(body); }
        else { exact(body, []); await application.disconnect(); }
        store.refresh(); return json(response, 200, application.control());
      }
      if (pathname === '/api/state' && request.method === 'GET') return json(response, 200, store.snapshot());
      if (pathname === '/api/events' && request.method === 'GET') {
        if (streams.size >= 32) return json(response, 503, { error: 'Too many streams' });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write('retry: 1000\n\n'); streams.add(response);
        const send = snapshot => {
          if (response.destroyed) return;
          if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
          const view = application ? { ...snapshot, control: application.control() } : snapshot;
          response.write(`id: ${snapshot.version}\nevent: state\ndata: ${JSON.stringify(view)}\n\n`);
        };
        const unsubscribe = store.subscribe(send);
        send(store.snapshot());
        const legacyHeartbeat = application ? null : setInterval(() => send(store.snapshot()), 15000);
        legacyHeartbeat?.unref();
        request.on('close', () => { clearInterval(legacyHeartbeat); unsubscribe(); streams.delete(response); });
        return;
      }
      if (pathname === '/api/events' && request.method === 'POST') {
        if (application) return json(response, 405, { error: 'Runtime events are published by internal producers only' });
        const event = await readJson(request);
        const result = store.publish(event);
        return json(response, result.duplicate ? 200 : 201, { version: result.version, currentVersion: result.snapshot.version, duplicate: result.duplicate });
      }
      // ---- UI-MERGE: LONG/SHORT service integration -------------------------
      // BotManager: real runtime ON/OFF for both bots (no strategy decisions here).
      if (botManager && pathname === '/api/bots/status' && request.method === 'GET') return json(response, 200, await botManager.status());
      if (botManager && pathname === '/api/bots/health' && request.method === 'GET') return json(response, 200, await botManager.health());
      if (botManager && pathname.startsWith('/api/bots/') && request.method === 'POST') {
        const [, , , bot, action] = pathname.split('/');
        if (!['meme', 'long-short'].includes(bot) || !['start', 'stop'].includes(action)) return json(response, 404, { error: 'UNKNOWN_BOT_OR_ACTION' });
        try { return json(response, 200, await botManager[action](bot)); }
        catch (error) { return json(response, error.status ?? 409, { error: error.message }); }
      }
      // Proxy the LONG/SHORT gateway (GA bridge + FreqTrade) on this origin so the
      // browser keeps a single web (:7883) while services run on their own ports.
      if (pathname.startsWith('/api/bot/') || pathname === '/api/bot') {
        const gateway = process.env.GA_GATEWAY ?? 'http://127.0.0.1:8932';
        const isStream = pathname === '/api/bot/stream';
        const abort = new AbortController();
        request.on('close', () => abort.abort());
        try {
          const proxied = await fetch(gateway + pathname + new URL(request.url, `http://${expectedHost}`).search, {
            method: request.method, headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
            body: ['GET', 'HEAD'].includes(request.method) ? undefined : await readRawBody(request),
            signal: isStream ? abort.signal : AbortSignal.timeout(30000),
          });
          const headers = { 'Content-Type': proxied.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-cache' };
          if (isStream) { headers['Connection'] = 'keep-alive'; headers['X-Accel-Buffering'] = 'no'; }
          response.writeHead(proxied.status, headers);
          if (proxied.body) await proxied.body.pipeTo(new WritableStream({ write: chunk => response.write(chunk), close: () => response.end(), abort: () => response.end() }));
          else response.end();
        } catch (error) { if (!response.headersSent) json(response, 502, { error: 'LONG_SHORT_GATEWAY_OFFLINE', detail: String(error.message).slice(0, 120) }); else response.end(); }
        return;
      }
      // LONG_SHORT:GA_SIGNAL — indicator/alert engine ported from C:\GA_SIGNAL_LAB (services/ga-signal/).
      // An alert layer, not a strategy: no order routing, no MEME:* events. The Long/Short overlay
      // reads it same-origin so the user never needs the :8933 lab server.
      if (pathname.startsWith('/api/ga-signal/')) {
        try {
          gaSignalService ??= await import('../services/ga-signal/service.mjs').then(module => module.startGaSignalService({
            dataDir: path.join(__dirname, '..', 'data', 'ga-signal'),
            log: message => console.log(`[ga-signal] ${message}`),
          }));
          return await gaSignalService.handle(request, response, new URL(request.url, `http://${expectedHost}`));
        } catch (error) {
          console.error(`[ga-signal] ${error.message}`);
          if (!response.headersSent) return json(response, 500, { error: 'GA_SIGNAL_SERVICE_ERROR' });
          return response.end();
        }
      }
      // GA Trade Chart component assets served same-origin (no iframe in the final build).
      if (pathname.startsWith('/ga-assets/')) {
        const gaRoot = path.resolve(process.env.GA_CHART_HOME ?? 'C:\\GA-TRADE-CHART');
        const relative = path.normalize(decodeURIComponent(pathname.slice('/ga-assets/'.length)));
        const target = path.resolve(gaRoot, relative);
        if (!target.startsWith(gaRoot + path.sep) || !['.mjs', '.js', '.css', '.json', '.png', '.sha256', '.md'].includes(path.extname(target).toLowerCase())) return json(response, 404, { error: 'Asset not found' });
        const gaMime = { '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.sha256': 'text/plain', '.md': 'text/plain; charset=utf-8' };
        fs.readFile(target, (error, data) => {
          if (error) { response.writeHead(404); return response.end('Not found'); }
          response.writeHead(200, { 'Content-Type': gaMime[path.extname(target).toLowerCase()], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          response.end(data);
        });
        return;
      }
      if (pathname.startsWith('/api/')) return json(response, 404, { error: 'Unknown endpoint; no order execution API is available' });
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); return response.end(); }
      if (pathname === '/' || pathname === '/meme-trader') { response.writeHead(302, { Location: '/meme-trader/' }); return response.end(); }
      const filename = pathname === '/meme-trader/' ? 'index.html' : pathname.startsWith('/meme-trader/') ? pathname.slice('/meme-trader/'.length) : '';
      if (!Object.hasOwn(assets, filename)) { response.writeHead(404); return response.end('Not found'); }
      fs.readFile(path.join(root, filename), (error, data) => {
        if (error) { response.writeHead(500); return response.end('Asset unavailable'); }
        response.writeHead(200, { 'Content-Type': assets[filename], 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        response.end(request.method === 'HEAD' ? undefined : data);
      });
    } catch (error) { console.error('ROUTE_ERROR', error && error.stack || error); const safeCode = typeof error.message === 'string' && /^[A-Z][A-Z0-9_:.-]{1,150}$/.test(error.message); if (!response.headersSent) json(response, error.status || (safeCode ? 409 : 500), { error: error.status || safeCode ? error.message : 'State service error' }); else response.end(); }
  });
  return { server, store, application, copy, close: () => closing ??= new Promise((resolve, reject) => {
    copyWatcher?.close();for(const stream of copyStreams)stream.end();copy.close();
    heldFeed?.close();
    clearInterval(heartbeat);
    if (solFeed) clearInterval(solFeed);
    for (const stream of streams) stream.end();
    server.close(async () => { try { await store.close(); if (application) await application.close(); resolve(); } catch (error) { reject(error); } }); server.closeIdleConnections();
  }) };
}
if (require.main === module) {
  const port = Number(process.env.BOTMEME_PORT ?? 7880);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('INVALID_DASHBOARD_PORT');
  const journal = process.env.BOTMEME_JOURNAL;
  let application;
  if (journal) {
    const dataRoot = path.resolve(__dirname, '../data'), filename = path.resolve(journal), relative = path.relative(dataRoot, filename);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('DASHBOARD_JOURNAL_OUTSIDE_DATA');
    application = require('../runtime/application.cjs').createApplication({ journalPath: filename });
  }
  const service = createDashboardServer(application ? { application } : {});
  service.server.listen(port, '127.0.0.1', () => console.log(`Botmeme: http://127.0.0.1:${port}/meme-trader/ — waiting for producers`));
  service.server.on('error', error => { console.error(error.message); service.close().catch(() => {}); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { service.close().then(() => process.exit(0)); });
}
module.exports = { createDashboardServer };
