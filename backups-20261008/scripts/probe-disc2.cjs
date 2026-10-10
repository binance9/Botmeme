'use strict';
process.chdir('C:/Botmeme');
const { createGeckoTerminal } = require('../core/market-data/providers/geckoterminal.cjs');
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const evidenceDirectory = 'C:/Botmeme/data/market-evidence/SOLANA';
fs.mkdirSync(evidenceDirectory, { recursive: true });
const calls = [];
const fetcher = async (url, opts) => {
  const t0 = Date.now();
  const res = await fetch(url, opts);
  calls.push({ u: url.replace('https://api.geckoterminal.com', '').slice(0, 50), ms: Date.now() - t0, s: res.status });
  return res;
};
const gt = createGeckoTerminal({ network: 'SOLANA', networkId: 'solana', fetcher, evidenceDirectory });
(async () => {
  try {
    const tokens = await gt.discover();
    console.log('OK:', tokens.length, 'token');
  } catch (e) { console.log('DISCOVER THROW:', e.message); }
  console.log('calls:', JSON.stringify(calls, null, 0).slice(0, 400));
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
