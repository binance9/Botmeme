'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { NETWORKS } = require('../../../runtime/contracts/index.cjs');
const { tokenIdentity } = require('../../../runtime/contracts/token-identity.cjs');
const { ENTRY_BAND } = require('../../risk/engine.cjs');
const ORIGIN = 'https://api.dexscreener.com', LIMIT = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const address = value => typeof value === 'string' && /^[A-Za-z0-9]{1,160}$/.test(value);
// Official contract: https://docs.dexscreener.com/api/reference
// Latest profiles are a discovery subset, not an exhaustive network universe.
// Pair creation time is NOT a price observation timestamp. The API has no
// documented upstream price timestamp. Legacy snapshot() remains readiness-only;
// batchQuotes() uses receipt time, matching Gecko reads for the paper fallback.
function createDexScreener({ network, chainId, fetcher = fetch, now = () => new Date(), evidenceDirectory } = {}) {
  if (!NETWORKS.includes(network) || typeof chainId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(chainId) || typeof fetcher !== 'function' || typeof now !== 'function' || typeof evidenceDirectory !== 'string' || !path.isAbsolute(evidenceDirectory)) throw Error('INVALID_DEXSCREENER_CONFIG');
  const directory = path.resolve(evidenceDirectory), known = new Set(), bornAt = new Map(), caps = new Map();
  const inBand = token => !caps.has(token) || caps.get(token) >= ENTRY_BAND[0] && caps.get(token) <= ENTRY_BAND[1];
  const young = token => !bornAt.has(token) || now().getTime() >= bornAt.get(token) && now().getTime() - bornAt.get(token) <= 30 * 60000;
  fs.mkdirSync(directory, { recursive: true });
  function immutable(name, bytes) {
    const target = path.join(directory, name);
    try { fs.writeFileSync(target, bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || !fs.readFileSync(target).equals(Buffer.from(bytes))) throw Error('DEXSCREENER_EVIDENCE_WRITE_FAILED'); }
  }
  async function request(route, signal, batch = false) {
    const url = ORIGIN + route, controller = new AbortController(); let reader, timer, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => { controller.abort(); rejectAbort(Error('DEXSCREENER_REQUEST_ENDED')); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, 10000);
    try {
      if (signal?.aborted) abort();
      const response = await Promise.race([fetcher(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal: controller.signal }), aborted]);
      if (!response || response.status !== 200 || response.redirected || response.url && response.url !== url || !response.body?.getReader) throw Error('DEXSCREENER_HTTP_FAILED');
      const length = response.headers?.get('content-length');
      if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > LIMIT)) throw Error('DEXSCREENER_RESPONSE_TOO_LARGE');
      const media = response.headers?.get('content-type');
      if (!media || !/^application\/json(?:\s*;|$)/i.test(media)) throw Error('DEXSCREENER_INVALID_CONTENT_TYPE');
      reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const part = await Promise.race([reader.read(), aborted]); if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw Error('DEXSCREENER_INVALID_BODY');
        size += part.value.byteLength; if (size > LIMIT) throw Error('DEXSCREENER_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(part.value));
      }
      const bytes = Buffer.concat(chunks); let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw Error('DEXSCREENER_INVALID_JSON'); }
      const rows = batch ? value?.pairs : value;
      if (!Array.isArray(rows) || rows.length > 10000) throw Error('DEXSCREENER_INVALID_RESPONSE');
      const clock = now(); if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_DEXSCREENER_CLOCK');
      const receivedAt = clock.toISOString(), bodyHash = hash(bytes);
      const receipt = Buffer.from(JSON.stringify({ url, network, chainId, receivedAt, bodyHash, status: 200 }));
      const receiptHash = hash(receipt);
      immutable(bodyHash + '.body.json', bytes); immutable(receiptHash + '.receipt.json', receipt);
      return { value, receivedAt, evidence: ['dexscreener.body/' + bodyHash, 'dexscreener.receipt/' + receiptHash], url };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} } }
  }
  return {
    network,
    profile: token => bornAt.has(token) || caps.has(token) ? { born: bornAt.get(token), band: caps.has(token) && inBand(token) } : null,
    async batchQuotes(tokens, { signal } = {}) {
      if (!Array.isArray(tokens) || tokens.some(token => !address(token))) throw Error('INVALID_DEXSCREENER_TOKEN');
      const wanted = [...new Set(tokens)].filter(young), samples = [];
      const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      for (let i = 0; i < wanted.length; i += 30) {
        const group = wanted.slice(i, i + 30);
        const response = await request('/latest/dex/tokens/' + group.join(','), signal, true);
        for (const token of group) {
          const births = response.value.pairs.filter(p => p?.chainId === chainId && p.baseToken?.address === token && Number.isSafeInteger(p.pairCreatedAt) && p.pairCreatedAt > 0).map(p => p.pairCreatedAt);
          if (births.length) bornAt.set(token, Math.min(...births, bornAt.get(token) ?? Infinity));
          // Missing creation metadata is unknown age, not evidence of expiry.
          if (!young(token)) { known.delete(token); continue; }
          const pair = response.value.pairs.filter(p => p?.chainId === chainId && p.baseToken?.address === token && typeof p.priceUsd === 'string' && Number.isFinite(Number(p.priceUsd)) && Number(p.priceUsd) > 0 && nonnegative(p.liquidity?.usd) && nonnegative(p.volume?.h24)).sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0];
          if (!pair) continue;
          if (nonnegative(pair.marketCap)) caps.set(token, pair.marketCap);
          const age = Date.parse(response.receivedAt) - pair.pairCreatedAt, txs = pair.txns?.m5;
          samples.push({ token, price: Number(pair.priceUsd), liquidityUsd: pair.liquidity.usd, volume24hUsd: pair.volume.h24,
            ...tokenIdentity({ tokenSymbol: pair.baseToken.symbol, tokenName: pair.baseToken.name, imageUrl: pair.info?.imageUrl }),
            ...(Number.isSafeInteger(pair.pairCreatedAt) && pair.pairCreatedAt > 0 && Number.isSafeInteger(age) && age >= 0 ? { poolAgeMs: age } : {}),
            ...(nonnegative(pair.marketCap) ? { marketCapUsd: pair.marketCap } : {}),
            ...(nonnegative(pair.volume.m5) && Number.isSafeInteger(txs?.buys) && txs.buys >= 0 && Number.isSafeInteger(txs?.sells) && txs.sells >= 0 && Number.isSafeInteger(txs.buys + txs.sells) ? { recentVolumeUsd: pair.volume.m5, recentTxs5m: txs.buys + txs.sells } : {}),
            observedAt: response.receivedAt, source: ORIGIN + '/latest/dex/tokens#dexscreener-fallback', evidence: response.evidence, confidence: .8, evidence_quality: .8, missing_evidence: [], uncertainty: .2 });
        }
      }
      return samples;
    },
    async discover({ signal } = {}) {
      const response = await request('/token-profiles/latest/v1', signal);
      for (const profile of response.value) if (profile?.chainId === chainId && address(profile.tokenAddress)) { known.delete(profile.tokenAddress); known.add(profile.tokenAddress); }
      while (known.size > 1000) known.delete(known.values().next().value);
      return [...known].filter(token => young(token) && inBand(token));
    },
    async snapshot(token, { signal } = {}) {
      if (!address(token)) throw Error('INVALID_DEXSCREENER_TOKEN');
      const response = await request('/token-pairs/v1/' + chainId + '/' + encodeURIComponent(token), signal);
      const pairs = response.value.filter(pair => pair?.chainId === chainId && pair.baseToken?.address === token && address(pair.pairAddress) && typeof pair.priceUsd === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(pair.priceUsd) && Number.isFinite(Number(pair.priceUsd)) && Number(pair.priceUsd) > 0 && typeof pair.liquidity?.usd === 'number' && Number.isFinite(pair.liquidity.usd) && pair.liquidity.usd > 0 && typeof pair.volume?.h24 === 'number' && Number.isFinite(pair.volume.h24) && pair.volume.h24 >= 0).sort((a, b) => b.liquidity.usd - a.liquidity.usd || a.pairAddress.localeCompare(b.pairAddress));
      if (!pairs.length) throw Error('DEXSCREENER_NO_VALID_PAIR');
      const pair = pairs[0];
      return { token, price: Number(pair.priceUsd), liquidityUsd: pair.liquidity.usd, volume24hUsd: pair.volume.h24, observedAt: response.receivedAt, source: response.url + '#' + pair.pairAddress, evidence: response.evidence, confidence: 0, evidence_quality: 0, missing_evidence: ['UPSTREAM_PRICE_TIMESTAMP_UNAVAILABLE'], uncertainty: 1 };
    }
  };
}
module.exports = { createDexScreener };
