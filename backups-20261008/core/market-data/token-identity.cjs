'use strict';
const fs = require('node:fs'), path = require('node:path');
const { PublicKey } = require('@solana/web3.js');
const { tokenIdentity } = require('../../runtime/contracts/token-identity.cjs');
const PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
function decodeMetadata(account, mint) {
  if (account?.owner !== PROGRAM.toBase58() || account.data?.[1] !== 'base64') return {};
  const bytes = Buffer.from(account.data[0], 'base64');
  if (bytes.length < 65 || bytes[0] !== 4 || !bytes.subarray(33, 65).equals(new PublicKey(mint).toBuffer())) return {};
  let offset = 65;
  function read(max) {
    if (offset + 4 > bytes.length) throw Error('METADATA_TRUNCATED');
    const length = bytes.readUInt32LE(offset); offset += 4;
    if (length > max || offset + length > bytes.length) throw Error('METADATA_LENGTH');
    const value = bytes.subarray(offset, offset + length).toString('utf8').replace(/\0/g, '').trim(); offset += length;
    return value;
  }
  return { ...tokenIdentity({ tokenName: read(32), tokenSymbol: read(10) }), uri: read(200) };
}
function createTokenIdentityStore({ filename, fetcher = fetch, rpcUrl = process.env.RPC_HTTP_ENDPOINT || 'https://api.mainnet-beta.solana.com', now = Date.now } = {}) {
  const cache = new Map(), pending = new Map(), attempts = new Map(), listeners = new Set();
  const key = (network, mint) => JSON.stringify([network, mint]);
  let closed = false;
  try { for (const [id, value] of JSON.parse(fs.readFileSync(filename, 'utf8'))) cache.set(id, value); } catch {}
  function put(network, mint, value) {
    const id = key(network, mint), old = cache.get(id) ?? {}, clean = tokenIdentity(value);
    if (typeof value?.uri === 'string' && value.uri.length <= 200) clean.uri = value.uri;
    for (const field of ['twitter', 'telegram', 'website']) {
      try { const url = new URL(value?.[field]); if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 400) clean[field] = url.href; } catch {}
    }
    // Existing verified identity wins; quote fallbacks fill only missing fields.
    const next = { ...clean, ...old };
    if (!Object.keys(next).length || JSON.stringify(next) === JSON.stringify(old) || closed) return old;
    cache.set(id, next);
    if (filename) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename + '.tmp', JSON.stringify([...cache])); fs.renameSync(filename + '.tmp', filename); }
    for (const listener of listeners) listener();
    return next;
  }
  async function json(url, options = {}) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('IDENTITY_UNAVAILABLE');
    return response.json();
  }
  function resolve(network, mint) {
    const id = key(network, mint), old = cache.get(id) ?? {};
    if (closed || network !== 'SOLANA' || old.tokenName && old.tokenSymbol && old.imageUrl) return Promise.resolve(old);
    if (pending.has(id)) return pending.get(id);
    if (now() - (attempts.get(id) ?? -Infinity) < 60000 || pending.size >= 4) return Promise.resolve(old);
    let pubkey; try { pubkey = new PublicKey(mint); } catch { return Promise.resolve(old); }
    attempts.set(id, now());
    const work = (async () => {
      const pda = PublicKey.findProgramAddressSync([Buffer.from('metadata'), PROGRAM.toBuffer(), pubkey.toBuffer()], PROGRAM)[0];
      const results = await Promise.allSettled([
        json(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pda.toBase58(), { encoding: 'base64', commitment: 'confirmed' }] }) }).then(body => decodeMetadata(body.result?.value, mint)),
        json('https://frontend-api.pump.fun/coins/' + mint).then(body => {
          if (body.mint && body.mint !== mint) return {};
          return { ...body, ...tokenIdentity({ tokenName: body.name, tokenSymbol: body.symbol, imageUrl: body.image_uri ?? body.imageUrl }) };
        })
      ]);
      for (const result of results) if (result.status === 'fulfilled') put(network, mint, result.value);
      return cache.get(id) ?? {};
    })().catch(() => cache.get(id) ?? {}).finally(() => pending.delete(id));
    pending.set(id, work); return work;
  }
  return { get: (network, mint) => cache.get(key(network, mint)) ?? {}, put, resolve,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { closed = true; listeners.clear(); } };
}
module.exports = { createTokenIdentityStore, decodeMetadata, PROGRAM };
