'use strict';
const { entryBand, ENTRY_BAND } = require('../../risk/engine.cjs');
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { NETWORKS } = require('../../../runtime/contracts/index.cjs');
const ORIGIN = 'https://api.geckoterminal.com', LIMIT = 1024 * 1024;
// One public-IP request budget across active network adapters in this process.
let queue = Promise.resolve(), lastStart = -Infinity, pending = 0, spacingMs = 0;
const cooldown = require('./rate-limit.cjs').createRateLimit();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const address = value => typeof value === 'string' && /^[A-Za-z0-9]{1,160}$/.test(value);
const numeric = value => typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));
// Public API: https://apiguide.geckoterminal.com/changelogs
// Field contract: https://docs.coingecko.com/reference/pool-trades-contract-address
// Discovery is new pools only. Each page is one request covering many pools.
function createGeckoTerminal({ network, networkId, fetcher = fetch, now = () => new Date(), evidenceDirectory, chain = null } = {}) {
  if (!NETWORKS.includes(network) || typeof networkId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(networkId) || typeof fetcher !== 'function' || typeof now !== 'function' || typeof evidenceDirectory !== 'string' || !path.isAbsolute(evidenceDirectory)) throw Error('INVALID_GECKOTERMINAL_CONFIG');
  if(fetcher===fetch)spacingMs=Math.max(spacingMs,3000);
  const directory = path.resolve(evidenceDirectory), known = new Map(), watchFile = path.join(directory, 'watchlist.json');
  const newPools = new Map();
  const fallback = network === 'SOLANA' && networkId === 'solana' ? require('./dexscreener.cjs').createDexScreener({ network, chainId: 'solana', fetcher, now, evidenceDirectory }) : null;
  fs.mkdirSync(directory, { recursive: true });
  function quoteMeta(pool) {
    const id = pool?.relationships?.quote_token?.data?.id;
    const quoteToken = typeof id === 'string' && id.startsWith(networkId + '_') ? id.slice(networkId.length + 1) : null;
    return { quoteToken, quoteNative: pool?.attributes?.quote_token_price_native_currency ?? null };
  }
  function saveWatch() {
    const tokens = {};
    for (const [token, row] of known) tokens[token] = { poolAddress: row.poolAddress, born: row.born, evidence: row.evidence || [], receivedAt: row.receivedAt || null, quoteToken: row.quoteToken || null, quoteNative: row.quoteNative || null, fee: Number.isInteger(row.fee) ? row.fee : null, spacing: Number.isInteger(row.spacing) ? row.spacing : null, hooks: row.hooks || null, liquidityUsd: Number.isFinite(row.liquidityUsd) ? row.liquidityUsd : null, marketCapUsd: Number.isFinite(row.marketCapUsd) ? row.marketCapUsd : null, realVolumeUsd: Number.isFinite(row.realVolumeUsd) ? row.realVolumeUsd : null, volume24hUsd: Number.isFinite(row.volume24hUsd) ? row.volume24hUsd : null, band: row.band === true };
    const next = watchFile + '.tmp';
    fs.writeFileSync(next, JSON.stringify({ tokens }));
    fs.renameSync(next, watchFile);
  }
  function loadWatch() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(watchFile, 'utf8')); } catch { return; }
    const tokens = saved?.tokens;
    if (!tokens || typeof tokens !== 'object') return;
    for (const [token, row] of Object.entries(tokens)) {
      if (!address(token) || !row || !address(row.poolAddress)) continue;
      known.set(token, { token, poolAddress: row.poolAddress, born: row.born, watch: true, band: row.band === true, evidence: Array.isArray(row.evidence) ? row.evidence : [], receivedAt: row.receivedAt, quoteToken: row.quoteToken, quoteNative: row.quoteNative, fee: row.fee, spacing: row.spacing, hooks: row.hooks, liquidityUsd: row.liquidityUsd, marketCapUsd: row.marketCapUsd, realVolumeUsd: row.realVolumeUsd, volume24hUsd: row.volume24hUsd, pool: null });
    }
  }
  loadWatch();
  function immutable(name, bytes) {
    const target = path.join(directory, name);
    try { fs.writeFileSync(target, bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || !fs.readFileSync(target).equals(Buffer.from(bytes))) throw Error('GECKOTERMINAL_EVIDENCE_WRITE_FAILED'); }
  }
  async function request(route, signal) {
    const url = ORIGIN + route, controller = new AbortController(); let reader, timer, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => { controller.abort(); rejectAbort(Error('GECKOTERMINAL_REQUEST_ENDED')); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, 10000);
    try {
      if (signal?.aborted) abort();
      const response = await Promise.race([fetcher(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal: controller.signal }), aborted]);
      if (response?.status === 429) { cooldown.limited(response.headers?.get('retry-after')); if(fetcher===fetch)spacingMs=Math.min(15000,Math.max(3000,spacingMs*2)); }
      if (response && Number.isInteger(response.status) && response.status !== 200) throw Error('GECKOTERMINAL_HTTP_FAILED_' + response.status);
      if (!response || response.redirected || response.url && response.url !== url || !response.body?.getReader) throw Error('GECKOTERMINAL_HTTP_FAILED');
      const length = response.headers?.get('content-length');
      if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > LIMIT)) throw Error('GECKOTERMINAL_RESPONSE_TOO_LARGE');
      const media = response.headers?.get('content-type');
      if (!media || !/^application\/json(?:\s*;|$)/i.test(media)) throw Error('GECKOTERMINAL_INVALID_CONTENT_TYPE');
      reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const part = await Promise.race([reader.read(), aborted]); if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw Error('GECKOTERMINAL_INVALID_BODY');
        size += part.value.byteLength; if (size > LIMIT) throw Error('GECKOTERMINAL_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(part.value));
      }
      const bytes = Buffer.concat(chunks); let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw Error('GECKOTERMINAL_INVALID_JSON'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data')) throw Error('GECKOTERMINAL_INVALID_RESPONSE');
      const clock = now(); if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_GECKOTERMINAL_CLOCK');
      const receivedAt = clock.toISOString(), bodyHash = hash(bytes);
      const receipt = Buffer.from(JSON.stringify({ url, network, networkId, receivedAt, bodyHash, status: 200 }));
      const receiptHash = hash(receipt);
      immutable(bodyHash + '.body.json', bytes); immutable(receiptHash + '.receipt.json', receipt);
      if(url.includes('/new_pools') && Array.isArray(value.data)) {
        for(const pool of value.data){
          const identity=poolIdentity(pool),born=createdMs(pool?.attributes);
          if(!identity || born===null || born>Date.parse(receivedAt))continue;
          const a=pool.attributes,meta=(value.included||[]).find(t=>t?.id===networkId+'_'+identity.token)?.attributes;
          const money=v=>numeric(v)?Number(v):null;
          newPools.set(identity.poolAddress,{...identity,network,symbol:typeof meta?.symbol==='string'?meta.symbol:typeof a.name==='string'?a.name.split('/')[0].trim():identity.token,image:typeof meta?.image_url==='string'&&/^https:\/\/assets\.geckoterminal\.com\//.test(meta.image_url)?meta.image_url:null,createdAt:new Date(born).toISOString(),observedAt:receivedAt,marketCapUsd:money(a.market_cap_usd),fdvUsd:money(a.fdv_usd),liquidityUsd:money(a.reserve_in_usd),source:url,evidence:['geckoterminal.body/'+bodyHash,'geckoterminal.receipt/'+receiptHash]});
        }
        const sorted=[...newPools.values()].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
        newPools.clear();for(const row of sorted.slice(0,200))newPools.set(row.poolAddress,row);
      }
      return { value, receivedAt, evidence: ['geckoterminal.body/' + bodyHash, 'geckoterminal.receipt/' + receiptHash], url };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} } }
  }
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    let timer; const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(Error('GECKOTERMINAL_REQUEST_ENDED')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  });
  function paced(route, signal) {
    if (++pending > 64) { pending--; return Promise.reject(Error('GECKOTERMINAL_BACKPRESSURE')); }
    const task = queue.then(async () => {
      if (signal?.aborted) throw Error('GECKOTERMINAL_REQUEST_ENDED');
      if (cooldown.remaining() > 0) throw Error('GECKOTERMINAL_RATE_LIMIT_COOLDOWN');
      while (performance.now() - lastStart < spacingMs) await wait(Math.ceil(spacingMs - (performance.now() - lastStart)), signal);
      lastStart = performance.now();
      return request(route, signal);
    });
    queue = task.catch(() => {}).finally(() => { pending--; });
    return task;
  }
  const WATCH_MS = 30 * 60000, MIN_REAL_VOLUME_USD = 100;
  const NEW_POOL_PAGES = 2, DEEP_PASSES_PER_SCAN = 2;
  // Enriches chain-adopted watchlist entries with real GeckoTerminal pool
  // metadata: pool_created_at replaces the adopt-clock born, market cap comes
  // from market_cap_usd/fdv_usd, and headline 24h volume fills realVolumeUsd
  // where no verified trade-sum exists (documented paper-mode relaxation).
  async function refreshGtPools(signal) {
    for (let page = 1; page <= 2; page++) {
      const response = await paced('/api/v2/networks/' + networkId + '/new_pools?include=base_token&page=' + page, signal);
      if (!Array.isArray(response.value.data) || !response.value.data.length) return;
      let matched = 0;
      for (const pool of response.value.data) {
        const addr = typeof pool?.attributes?.address === 'string' ? pool.attributes.address.toLowerCase() : null;
        if (!addr) continue;
        for (const row of known.values()) {
          if (String(row.poolAddress || '').toLowerCase() !== addr) continue;
          matched++;
          const born = createdMs(pool.attributes);
          if (Number.isFinite(born)) row.born = born;
          const cap = capUsd(pool.attributes);
          if (cap !== null) row.marketCapUsd = cap;
          if (numeric(pool.attributes.reserve_in_usd) && Number(pool.attributes.reserve_in_usd) > 0) row.liquidityUsd = Number(pool.attributes.reserve_in_usd);
          if (numeric(pool.attributes.volume_usd?.h24)) {
            row.volume24hUsd = Number(pool.attributes.volume_usd.h24);
            if (!Number.isFinite(row.realVolumeUsd)) row.realVolumeUsd = row.volume24hUsd;
          }
        }
      }
      if (matched === 0) return; // fresh-pool pages hold nothing for this watchlist
    }
    saveWatch();
  }
  function createdMs(attributes) {
    const raw = attributes?.pool_created_at;
    if (typeof raw !== 'string') return null;
    const time = Date.parse(raw);
    return Number.isFinite(time) ? time : null;
  }
  function capUsd(attributes) {
    const raw = attributes?.market_cap_usd ?? attributes?.fdv_usd;
    return numeric(raw) ? Number(raw) : null;
  }
  function freshMeme(pool, receivedAt) {
    const born = createdMs(pool?.attributes), cap = capUsd(pool?.attributes), received = Date.parse(receivedAt);
    if (born === null || cap === null || cap > ENTRY_BAND[1] || cap < ENTRY_BAND[0]) return null;
    const age = received - born;
    if (!Number.isFinite(age) || age < 0 || age > WATCH_MS) return null;
    return { born, cap, age };
  }
  function poolIdentity(pool) {
    const poolAddress = pool?.attributes?.address, base = pool?.relationships?.base_token?.data;
    if (pool?.type !== 'pool' || !address(poolAddress) || pool.id !== networkId + '_' + poolAddress || base?.type !== 'token' || typeof base.id !== 'string' || !base.id.startsWith(networkId + '_')) return null;
    const token = base.id.slice(networkId.length + 1);
    return address(token) ? { poolAddress, token } : null;
  }
  let swept = 0, admitted = 0;
  const NEWEST = 200;
  const rows = packet => packet.value.data.map(pool => ({ identity: poolIdentity(pool), pool, evidence: packet.evidence, receivedAt: packet.receivedAt })).filter(row => {
    const born = createdMs(row.pool?.attributes), age = Date.parse(row.receivedAt) - born;
    return row.identity && (born === null || age >= 0 && age <= WATCH_MS) && numeric(row.pool.attributes.reserve_in_usd) && Number(row.pool.attributes.reserve_in_usd) >= 0 && numeric(row.pool.attributes.volume_usd?.h24);
  });
  function admit(row) {
    // Unknown creation time remains eligible for screening; deep verification
    // still requires its own age evidence. Do not fabricate a birth timestamp.
    const cap = capUsd(row.pool.attributes);
    const meme = createdMs(row.pool.attributes) === null && cap !== null && cap >= ENTRY_BAND[0] && cap <= ENTRY_BAND[1]
      ? { born: null, cap } : freshMeme(row.pool, row.receivedAt);
    if (!meme || known.has(row.identity.token)) return;
    // Volume thường nổ SAU vài phút sống; chặn admit theo vol24h đã loại nhầm
    // cả pool mới nhất. Giữ mọi pool trong cửa sổ tuổi, dedupe theo pool.
    if(known.size>=NEWEST){
      const oldest=[...known.entries()].sort((a,b)=>(a[1].born||0)-(b[1].born||0))[0];
      if(!oldest || meme.born<=(oldest[1].born||0))return;
      known.delete(oldest[0]);
    }
    for (const entry of known.values()) if (entry.poolAddress === row.identity.poolAddress) return;
    const quote = quoteMeta(row.pool);
    known.set(row.identity.token, { ...row.identity, ...quote, evidence: row.evidence, pool: row.pool, receivedAt: row.receivedAt, born: meme.born, watch: true, liquidityUsd: Number(row.pool.attributes.reserve_in_usd), marketCapUsd: meme.cap, volume24hUsd: Number(row.pool.attributes.volume_usd.h24) });
    admitted += 1;
  }
  function expire() {
    const clock = now();
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) return;
    for (const [token, row] of known) if (Number.isFinite(row.born) && (row.born > clock.getTime() || clock.getTime() - row.born > WATCH_MS)) known.delete(token);
  }
  return {
    network,
    get usesChain() { return Boolean(chain); },
    ...(fallback ? { fallbackDiscover: context => fallback.discover(context), fallbackQuotes: (tokens, context) => fallback.batchQuotes(tokens, context) } : {}),
    get swept() { return swept; },
    newlyCreated: () => [...newPools.values()].filter(r=>now().getTime()-Date.parse(r.createdAt)<=WATCH_MS).map(r=>({...r,evidence:[...r.evidence]})),
    watched: () => { expire(); return [...known.keys()]; },
    forget: token => known.delete(token),
    profile(token) {
      const row = known.get(token);
      return row ? { token, liquidityUsd: Number.isFinite(row.liquidityUsd) ? row.liquidityUsd : 0, volume24hUsd: Number.isFinite(row.volume24hUsd) ? row.volume24hUsd : 0, watch: row.watch !== false, born: row.born, band: row.band === true } : fallback?.profile(token) ?? null;
    },
    census: () => ({ discovered: admitted, watching: known.size }),
    adopt(rows) {
      if (!Array.isArray(rows)) return [];
      const added = [];
      for (const row of rows) {
        if (!row || !address(row.token) || !address(row.poolAddress) || Number.isFinite(row.born) && (row.born > now().getTime() || now().getTime() - row.born > WATCH_MS)) continue;
        const current = known.get(row.token);
        if (current) {
          current.poolAddress = row.poolAddress;
          if (row.quoteToken) current.quoteToken = row.quoteToken;
          if (row.quoteNative) current.quoteNative = row.quoteNative;
          if (Number.isInteger(row.fee)) current.fee = row.fee;
          if (Number.isInteger(row.spacing)) current.spacing = row.spacing;
          if (typeof row.hooks === 'string') current.hooks = row.hooks;
          if (Number.isFinite(row.born)) current.born = row.born;
          continue;
        }
        if (known.size >= 200) continue;
        known.set(row.token, { token: row.token, poolAddress: row.poolAddress, quoteToken: row.quoteToken || null, quoteNative: row.quoteNative || null, fee: row.fee, spacing: row.spacing, hooks: row.hooks || null, born: Number.isFinite(row.born) ? row.born : null, watch: true, evidence: [], liquidityUsd: null, pool: null });
        added.push(row.token);
      }
      if (rows.length) saveWatch();
      return added;
    },
    async chainDiscover(context = {}) {
      if (!chain || typeof chain.discoverPools !== 'function') return [];
      const found = await chain.discoverPools(context);
      this.adopt(found);
      return Array.isArray(found) ? found.map(row => row.token).filter(token => known.has(token)) : [];
    },
    async chainSnapshots(tokens, context = {}) {
      if (!chain || !Array.isArray(tokens)) return [];
      // Owner directive: GeckoTerminal pool metadata applies to chain-discovered
      // networks too. New-pool pages carry pool_created_at (real pool age),
      // market_cap_usd/fdv_usd and headline 24h volume for the same addresses.
      // Chain-adopted entries otherwise have no age/cap/volume, which starves
      // the meme path. Verification stays on-chain (price/depth); GT only fills
      // the metadata fields. Volume from GT is the documented relaxation: real
      // GT figures, headline 24h scope, used only where no trade-sum exists.
      try { await refreshGtPools(context.signal); } catch { /* metadata is best-effort */ }
      const entries = [];
      for (const token of tokens) {
        const row = known.get(token);
        if (!row) continue;
        entries.push({ token, poolAddress: row.poolAddress, born: row.born, evidence: row.evidence || [], quoteToken: row.quoteToken, quoteNative: row.quoteNative, fee: row.fee, spacing: row.spacing, hooks: row.hooks, marketCapUsd: row.marketCapUsd, realVolumeUsd: row.realVolumeUsd, volume24hUsd: Number.isFinite(row.volume24hUsd) ? row.volume24hUsd : null });
      }
      return chain.quoteMany(entries, context);
    },
    async quotes(tokens, { signal } = {}) {
      expire();
      const wanted = (Array.isArray(tokens) ? tokens : []).filter(token => known.has(token));
      const samples = [];
      for (let index = 0; index < wanted.length; index += 30) {
        const group = wanted.slice(index, index + 30);
        const response = await paced('/api/v2/networks/' + networkId + '/pools/multi/' + group.map(token => known.get(token).poolAddress).join(','), signal);
        if (!Array.isArray(response.value.data)) throw Error('GECKOTERMINAL_INVALID_DISCOVERY');
        for (const row of rows(response)) {
          if (!group.includes(row.identity.token)) continue;
          const price = Number(row.pool.attributes.base_token_price_usd);
          if (!Number.isFinite(price) || price <= 0) continue;
          const entry = known.get(row.identity.token);
          entry.pool = row.pool; entry.receivedAt = row.receivedAt; entry.liquidityUsd = Number(row.pool.attributes.reserve_in_usd); entry.volume24hUsd = Number(row.pool.attributes.volume_usd.h24);
          entry.evidence = [...new Set([...(entry.evidence || []), ...row.evidence])];
          const source = ORIGIN + '/api/v2/networks/' + networkId + '/pools/' + entry.poolAddress + '#pool-price';
          // Owner directive: quote-path samples must carry the same meme metadata
          // as deep snapshots (pool age, market cap) — without them the safety
          // gate vetoes every quote-only token with "pool age undefined".
          const cap = capUsd(row.pool.attributes);
          if (cap !== null) entry.marketCapUsd = cap;
          const born = Number.isFinite(entry.born) ? entry.born : createdMs(row.pool.attributes);
          const ageMs = Number.isFinite(born) ? Date.parse(row.receivedAt) - born : null;
          // GT headline 24h volume fills realVolumeUsd on the quote path — the
          // documented paper-mode relaxation (same as chain-adopted entries);
          // the deep trades pass replaces it with a verified trade sum.
          const realVolumeUsd = Number.isFinite(entry.realVolumeUsd) ? entry.realVolumeUsd : entry.volume24hUsd;
          const recent = row.pool.attributes.volume_usd?.m5, txs = row.pool.attributes.transactions?.m5;
          samples.push({ token: row.identity.token, price, liquidityUsd: entry.liquidityUsd, volume24hUsd: entry.volume24hUsd, observedAt: row.receivedAt, ...(Number.isSafeInteger(ageMs) && ageMs >= 0 ? { poolAgeMs: ageMs, marketCapUsd: cap, realVolumeUsd } : {}), ...(numeric(recent) && Number(recent) >= 0 ? { recentVolumeUsd: Number(recent), recentTxs5m: Number.isSafeInteger(txs?.buys + txs?.sells) ? txs.buys + txs.sells : 0 } : {}), source, evidence: entry.evidence, confidence: .8, evidence_quality: .8, missing_evidence: [], uncertainty: .2 });
        }
      }
      saveWatch();
      return samples;
    },
    retryAfterMs: () => cooldown.remaining(),
    recovered: () => cooldown.recovered(),
    async discover({ signal } = {}) {
      const collected = [], seen = new Set();
      const limited = error => /429|RATE_LIMIT/.test(String(error?.message));
      expire();
      admitted = 0;
      let page = 1;
      try {
        // A sweep budgets NEW_POOL_PAGES requests for the newest feed and leaves
        // the rest of the per-minute request window for quotes and wide sweeps —
        // burning it all on discovery starves the actual screening.
        while (collected.length < NEWEST && page <= NEW_POOL_PAGES) {
          const response = await paced('/api/v2/networks/' + networkId + '/new_pools?include=base_token&page=' + page, signal);
          if (!Array.isArray(response.value.data) || response.value.data.length > 1000) throw Error('GECKOTERMINAL_INVALID_DISCOVERY');
          if (!response.value.data.length) break;
          for (const row of rows(response)) {
            if (seen.has(row.identity.token)) continue;
            seen.add(row.identity.token);
            collected.push(row);
            if (collected.length >= NEWEST) break;
          }
          const next = response.value.links?.next;
          if (collected.length >= NEWEST || typeof next !== 'string' || !/[?&]page=\d+/.test(next)) break;
          page += 1;
        }
      } catch (error) {
        // Let the service budget discovery fallback even with an existing watchlist.
        if (fallback) { for (const row of collected) admit(row); swept = collected.length; throw error; }
        if (!limited(error) || (!known.size && !collected.length)) throw error;
      }
      // Age and market cap are applied after the newest sweep, not before it.
      // A pool that already qualified stays until it ages out of the watch window.
      for (const row of collected) admit(row);
      // Only the fresh feed enters the sweep; old-band rotation is dormant.
      saveWatch();
      swept = collected.length;
      if (networkId === 'robinhood' && known.size < 15) {
        for (const dex of ['pons-v2', 'uniswap-v2-robinhood']) {
          if (known.size >= NEWEST) break;
          let response;
          try { response = await paced('/api/v2/networks/robinhood/dexes/' + dex + '/pools?include=base_token&page=1', signal); }
          catch (error) { if (String(error.message).includes('404') || limited(error)) continue; throw error; }
          if (!Array.isArray(response.value.data) || response.value.data.length > 1000) continue;
          for (const row of rows(response)) admit(row);
        }
      }
      return [...known.keys()].sort((a,b)=>(known.get(b).born||0)-(known.get(a).born||0));
    },
    async watch(token, { signal } = {}) {
      expire();
      if (!address(token)) return false;
      if (known.has(token)) { known.get(token).watch = true; return true; }
      const response = await paced('/api/v2/networks/' + networkId + '/tokens/' + encodeURIComponent(token) + '/pools?page=1', signal);
      const row = (Array.isArray(response.value.data) ? response.value.data : []).map(pool => ({ identity: poolIdentity(pool), pool })).find(item => item.identity?.token === token);
      if (!row || !freshMeme(row.pool, response.receivedAt)) return false;
      const quote = quoteMeta(row.pool);
      known.set(token, { ...row.identity, ...quote, evidence: response.evidence, pool: row.pool, receivedAt: response.receivedAt, born: createdMs(row.pool.attributes), watch: true, liquidityUsd: Number(row.pool.attributes.reserve_in_usd), volume24hUsd: Number(row.pool.attributes.volume_usd?.h24) });
      saveWatch();
      return true;
    },
    async snapshot(token, { signal } = {}) {
      if (!address(token) || !known.has(token)) throw Error('GECKOTERMINAL_TOKEN_NOT_DISCOVERED');
      const discovery = known.get(token), route = '/api/v2/networks/' + networkId + '/pools/' + discovery.poolAddress;
      if (signal?.aborted) throw Error('GECKOTERMINAL_REQUEST_ENDED');
      const age = now().getTime() - Date.parse(discovery.receivedAt);
      const poolResponse = age >= 0 && age <= 30000 ? { value: { data: discovery.pool }, evidence: discovery.evidence } : await paced(route, signal);
      const pool = poolResponse.value.data, identity = poolIdentity(pool);
      if (!identity || identity.token !== token || identity.poolAddress !== discovery.poolAddress || !numeric(pool.attributes.reserve_in_usd) || Number(pool.attributes.reserve_in_usd) <= 0 || !numeric(pool.attributes.volume_usd?.h24) || Number(pool.attributes.volume_usd.h24) < 0) throw Error('GECKOTERMINAL_POOL_UNVERIFIED');
      const tradeResponse = await paced(route + '/trades', signal);
      if (!Array.isArray(tradeResponse.value.data) || tradeResponse.value.data.length > 1000) throw Error('GECKOTERMINAL_INVALID_TRADES');
      const trades = [];
      for (const trade of tradeResponse.value.data) {
        const a = trade?.attributes;
        if (trade?.type !== 'trade' || typeof trade.id !== 'string' || !trade.id.startsWith(networkId + '_') || trade.id.length > 500 || !a || !address(a.tx_hash) || !Number.isSafeInteger(a.block_number) || a.block_number < 0 || typeof a.block_timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(a.block_timestamp)) continue;
        const from = a.from_token_address === token, to = a.to_token_address === token;
        if (from === to) continue;
        const price = from ? a.price_from_in_usd : a.price_to_in_usd, time = Date.parse(a.block_timestamp);
        if (!numeric(price) || Number(price) <= 0 || !Number.isFinite(time) || time > Date.parse(tradeResponse.receivedAt)) continue;
        const canonicalTime = a.block_timestamp.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => '.' + (fraction ?? '').padEnd(3, '0') + 'Z');
        if (new Date(time).toISOString() !== canonicalTime) continue;
        const volumeUsd = numeric(a.volume_in_usd) ? Number(a.volume_in_usd) : 0;
        trades.push({ id: trade.id, tx: a.tx_hash, price: Number(price), time, volumeUsd });
      }
      trades.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      const watchedPrice = () => {
        const price = Number(pool.attributes.base_token_price_usd);
        if (!discovery.watch || !Number.isFinite(price) || price <= 0) return null;
        const born = createdMs(pool.attributes) ?? discovery.born;
        const recent = trades.filter(row => row.time >= Date.parse(tradeResponse.receivedAt) - 300000);
        return { token, price, liquidityUsd: Number(pool.attributes.reserve_in_usd), volume24hUsd: Number(pool.attributes.volume_usd.h24), observedAt: tradeResponse.receivedAt, ...(Number.isFinite(born) ? { poolAgeMs: Date.parse(tradeResponse.receivedAt) - born, marketCapUsd: capUsd(pool.attributes), realVolumeUsd: trades.reduce((sum, row) => sum + row.volumeUsd, 0) } : {}), recentVolumeUsd: recent.reduce((sum, row) => sum + row.volumeUsd, 0), recentTxs5m: new Set(recent.map(row => row.tx)).size, source: (poolResponse.url || route) + '#pool-price', evidence: [...new Set([...(discovery.evidence || []), ...(poolResponse.evidence || []), ...tradeResponse.evidence])], confidence: .8, evidence_quality: .8, missing_evidence: [], uncertainty: .2 };
      };
      if (!trades.length) {
        const watched = watchedPrice();
        if (watched) return watched;
        throw Error('GECKOTERMINAL_TIMESTAMPED_TRADE_UNVERIFIED');
      }
      // Fresh sweep entries and retained band entries share the same cap band.
      // of the 12h age window — a months-old pool is exactly the target here.
      const meme = freshMeme(pool, tradeResponse.receivedAt) ?? (() => {
        if (discovery.band !== true) return null;
        const cap = capUsd(pool.attributes) ?? discovery.marketCapUsd;
        const band = entryBand(Date.parse(tradeResponse.receivedAt) - discovery.born);
        if (!band) return null;
        const [min, max] = band;
        if (!Number.isFinite(cap) || cap < min || cap > max || !Number.isFinite(discovery.born)) return null;
        return { born: discovery.born, cap, age: Date.parse(tradeResponse.receivedAt) - discovery.born };
      })();
      if (!meme) {
        const watched = watchedPrice();
        if (watched) return watched;
        throw Error('GECKOTERMINAL_NOT_A_NEW_MEME');
      }
      const live = trades.filter(row => row.time >= meme.born && row.volumeUsd > 0);
      const realVolumeUsd = live.reduce((sum, row) => sum + row.volumeUsd, 0);
      const largest = live.reduce((max, row) => Math.max(max, row.volumeUsd), 0);
      const txCount = new Set(live.map(row => row.tx)).size;
      // Trailing five-minute window: real traded volume and distinct
      // transactions (public trade data exposes tx hashes, the closest honest
      // proxy for "different wallets" without a graph provider).
      const recentCutoff = Date.parse(tradeResponse.receivedAt) - 5 * 60 * 1000;
      const recent = live.filter(row => row.time >= recentCutoff);
      const recentVolumeUsd = recent.reduce((sum, row) => sum + row.volumeUsd, 0);
      const recentTxs5m = new Set(recent.map(row => row.tx)).size;
      // Headline 24h volume is not accepted. Real volume is the sum of priced
      // trades since the pool was born, from more than one transaction, and not
      // a single print wearing a dust trade. A watched pool still keeps its
      // live price so the next polls can finish the five-snapshot history.
      if (txCount < 2 || realVolumeUsd < MIN_REAL_VOLUME_USD || largest >= realVolumeUsd * 0.98) {
        const watched = watchedPrice();
        if (watched) return watched;
        throw Error('GECKOTERMINAL_VOLUME_UNVERIFIED');
      }
      const trade = trades[0];
      const livePrice = Number(pool.attributes.base_token_price_usd);
      const price = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : trade.price;
      // Score measures documented validation coverage, not profit probability or
      // independently verified on-chain truth. Single indexed provider caps it.
      // observedAt is this read, so the next 60s poll is a new real snapshot.
      discovery.realVolumeUsd = realVolumeUsd; discovery.marketCapUsd = meme.cap; discovery.volume24hUsd = Number(pool.attributes.volume_usd.h24); discovery.liquidityUsd = Number(pool.attributes.reserve_in_usd);
      saveWatch();
      return { token, price, poolAddress: discovery.poolAddress, liquidityUsd: Number(pool.attributes.reserve_in_usd), volume24hUsd: Number(pool.attributes.volume_usd.h24), observedAt: tradeResponse.receivedAt, poolAgeMs: meme.age, marketCapUsd: meme.cap, realVolumeUsd, recentVolumeUsd, recentTxs5m, source: tradeResponse.url + '#trade-sha256=' + hash(trade.id), evidence: [...new Set([...discovery.evidence, ...poolResponse.evidence, ...tradeResponse.evidence])], confidence: .8, evidence_quality: .8, missing_evidence: [], uncertainty: 1 - .8 };
    }
  };
}
module.exports = { createGeckoTerminal };
