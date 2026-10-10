'use strict';
// Run with node_modules/electron/dist/electron.exe tests/live-wallet-ui.cjs.
// Hidden Chromium, fixture HTTP only; never connects to the running dashboard.
const { app, BrowserWindow } = require('electron');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../public/meme-trader');
const address = 'So11111111111111111111111111111111111111112';
const state = { network: 'SOLANA', mode: 'paper', running: false, wallet: { connected: false }, live: { state: 'LOCKED', hasKey: false, owner: null, balanceSol: null, caps: { position: 1 } } };
let arms = 0, win;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Content-Type', 'application/json');
  if (pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(':fixture\n\n'); return; }
  if (pathname === '/api/control') {
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (body.action === 'LIVE' && body.confirm === 'LIVE_REAL_MONEY') { arms++; state.mode = 'live'; state.live.state = 'ARMED'; state.running = true; }
      else if (body.action === 'DISARM') { state.mode = 'safe'; state.live.state = 'LOCKED'; state.running = false; }
    }
    res.end(JSON.stringify(state)); return;
  }
  if (pathname === '/api/wallet/trading') { state.mode = 'safe'; Object.assign(state.live, { hasKey: true, owner: address, balanceSol: .05, balanceAt: new Date().toISOString() }); res.end(JSON.stringify({ address })); return; }
  const file = pathname === '/' ? 'index.html' : path.basename(pathname);
  if (!['index.html', 'wallet.js', 'wallet.css', 'styles.css'].includes(file)) { res.end('{}'); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  let text = fs.readFileSync(path.join(root, file), 'utf8');
  if (file === 'index.html') text = text.replace(/<script\b[^>]*src="[^"]*"[^>]*><\/script>/g, tag => tag.includes('wallet.js') ? tag : '');
  res.end(text);
});
async function run() {
  await app.whenReady(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors = []; win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = code => js(`new Promise((resolve,reject)=>{const start=Date.now();const tick=()=>{if(${code})resolve(true);else if(Date.now()-start>5000)reject(Error('UI timeout'));else setTimeout(tick,25);};tick();})`);
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
  await wait("document.querySelector('.live-badge')?.getAttribute('role') === 'button'");
  await js("document.getElementById('wallet-summary').click()");
  await wait("!document.getElementById('trading-create').disabled");
  await js("document.getElementById('trading-create').click()");
  await wait("document.getElementById('trading-address').textContent.length > 30 && !document.getElementById('trading-copy').disabled");
  assert.equal(await js("document.getElementById('trading-address').textContent"), address);
  await js("Object.defineProperty(navigator, 'clipboard', {value:{writeText:async text=>{window.copied=text;}}});document.getElementById('trading-copy').click()");
  await wait('window.copied'); assert.equal(await js('window.copied'), address);
  await wait("document.querySelector('.live-badge').getAttribute('aria-disabled') === 'false'");
  await js("document.querySelector('.live-badge').click()"); await wait("document.querySelector('dialog').open");
  await js("document.querySelector('dialog input').value='WRONG';document.querySelector('dialog button[value=arm]').click()");
  assert.equal(arms, 0); assert.equal(await js("document.querySelector('dialog').open"), true);
  await wait("document.querySelector('.live-badge').getAttribute('aria-disabled') === 'false'");
  await js("document.querySelector('dialog input').value='LIVE';document.querySelector('dialog button[value=arm]').click()");
  await wait("document.querySelector('.live-badge').textContent.includes('LIVE-ARMED')"); assert.equal(arms, 1);
  await wait("document.querySelector('.live-badge').getAttribute('aria-disabled') === 'false'");
  await js("document.querySelector('.live-badge').click()"); await wait("document.querySelector('.live-badge').textContent.includes('SAFE')");
  assert.equal(state.mode, 'safe'); assert.equal(arms, 1); assert.deepEqual(errors, []);
  console.log('PASS hidden Chromium: onboarding, public address, copy, invalid confirmation blocked, LIVE-ARMED, DISARM -> safe; no renderer errors');
}
run().then(() => { win?.destroy(); server.closeAllConnections(); server.close(); app.exit(0); }, error => { console.error(error.message); win?.destroy(); server.closeAllConnections(); server.close(); app.exit(1); });
