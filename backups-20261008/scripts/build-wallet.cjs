'use strict';
const fs = require('node:fs'), path = require('node:path');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');
(async () => {
  const result = await build({ entryPoints: [path.join(root, 'wallet/connection/okx-entry.mjs')], bundle: true, platform: 'browser', format: 'iife', write: false, minify: true, target: 'es2022', legalComments: 'inline' });
  // SDK resolves lexical global.localStorage. Keep pairing keys in this closure,
  // never replace the page's storage or persist wallet material on the server.
  const wrapper = `(function(){const records=new Map();const global=Object.create(globalThis);Object.defineProperty(global,'localStorage',{value:{getItem:k=>records.get(String(k))??null,setItem:(k,v)=>records.set(String(k),String(v)),removeItem:k=>records.delete(String(k)),clear:()=>records.clear(),key:i=>[...records.keys()][i]??null,get length(){return records.size}}});\n`;
  fs.writeFileSync(path.join(root, 'public/meme-trader/wallet-sdk.js'), wrapper + result.outputFiles[0].text + '\n})();\n');
})().catch(() => { console.error('WALLET_BUILD_FAILED'); process.exitCode = 1; });
