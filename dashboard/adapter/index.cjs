'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { tokenIdentity } = require('../../runtime/contracts/token-identity.cjs');
const { createTradeStore } = require('../../core/trades/store.cjs');
const { createOverview } = require('./overview.cjs');
const { DEFAULTS: regimePolicy } = require('../../core/market-data/regime.cjs');
const { DEFAULT_POLICY: exitPolicy } = require('../../core/risk/exit-manager.cjs');
const ROLES = ['Meme Hunter', 'Não chính', 'Quant Learner', 'Forensic Analyst'];
const PRODUCERS = ['JEV', 'CODEX_1', 'CODEX_2', 'CODEX_3'];
const IDS = ['jev', 'codex-1', 'codex-2', 'codex-3'];
const PAPER_SETTLEMENT_CURRENCY = 'SOL';
const key = (network, token) => JSON.stringify([network, token]);
const REFERENCE = key('INDEX', 'SOL'); // Always-on SOL/USD reference chart; memes take focus only on buys.
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function createDashboardAdapter({ journalPath, tokenIdentities = null, newlyCreated = null, workMeter = null, takeProfitMultiple = null, runtime, tradeStore, capitalUsd = 10000, now = () => new Date(), maxQuoteAgeMs = 60000, evidenceRoot = null } = {}) {
  if (!runtime || typeof runtime.subscribe !== 'function' || typeof runtime.snapshot !== 'function') throw Error('INVALID_DASHBOARD_RUNTIME');
  if (!Number.isFinite(capitalUsd) || capitalUsd <= 0 || !Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs < 1 || typeof now !== 'function') throw Error('INVALID_DASHBOARD_CONFIG');
  const ledger = tradeStore ?? createTradeStore({ runtime, capitalUsd, now, maxQuoteAgeMs });
  const overview = createOverview({ runtime, journalPath });
  const listeners = new Set(); let closed = false;
  const evidenceCache = new Map(), ticks = new Map(), bars = new Map();
  const settlementHistory = [...(runtime.capitalHistoryGroups?.() ?? []).flat(), ...(runtime.capitalEvents?.() ?? [])].filter(e=>['WalletValuation','TradeResult'].includes(e.type));
  function savedBody(network, id) {
    if (!evidenceRoot || typeof id !== 'string' || !id.startsWith('geckoterminal.body/')) return null;
    const digest = id.slice('geckoterminal.body/'.length);
    if (!/^[a-f0-9]{64}$/.test(digest)) return null;
    const cacheKey = network + ':' + digest;
    if (evidenceCache.has(cacheKey)) return evidenceCache.get(cacheKey);
    let value = null;
    try { value = JSON.parse(fs.readFileSync(path.join(evidenceRoot, network, digest + '.body.json'), 'utf8')); } catch { value = null; }
    evidenceCache.set(cacheKey, value);
    return value;
  }
  function rowsOf(value) { return Array.isArray(value?.data) ? value.data : value?.data && typeof value.data === 'object' ? [value.data] : []; }
  function tickerOf(value, token) {
    for (const row of rowsOf(value)) {
      if (row?.type !== 'pool' || typeof row.attributes?.name !== 'string') continue;
      const base = row.relationships?.base_token?.data?.id;
      if (typeof base !== 'string' || !base.endsWith('_' + token)) continue;
      const name = row.attributes.name.split('/')[0].trim().replace(/\s+/g, '');
      if (/^[A-Za-z][A-Za-z0-9]{1,31}$/.test(name)) return name.toUpperCase();
    }
    return null;
  }
  function imageOf(value, token) {
    const included = Array.isArray(value?.included) ? value.included : [];
    for (const row of included) {
      if (row?.type !== 'token' || typeof row.id !== 'string' || !row.id.endsWith('_' + token)) continue;
      const image = row.attributes?.image_url;
      if (typeof image === 'string' && /^https:\/\/assets\.geckoterminal\.com\//.test(image)) return image;
    }
    return null;
  }
  function poolOf(value, token) {
    for (const row of rowsOf(value)) {
      if (row?.type !== 'pool' || typeof row.attributes?.address !== 'string') continue;
      const base = row.relationships?.base_token?.data?.id;
      if (typeof base === 'string' && base.endsWith('_' + token)) return row.attributes.address;
    }
    return null;
  }
  function printsOf(value, token) {
    const points = [];
    for (const row of rowsOf(value)) {
      if (row?.type !== 'trade') continue;
      const attributes = row.attributes;
      if (!attributes) continue;
      const from = attributes.from_token_address === token, to = attributes.to_token_address === token;
      if (from === to) continue;
      const price = Number(from ? attributes.price_from_in_usd : attributes.price_to_in_usd), at = Date.parse(attributes.block_timestamp);
      const volumeUsd = Number(attributes.volume_in_usd);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(at)) continue;
      points.push({ at, priceUsd: price, volumeUsd: Number.isFinite(volumeUsd) && volumeUsd >= 0 ? volumeUsd : 0 });
    }
    return points;
  }
  function snapshot() {
    const clock = now(), state = runtime.snapshot(), portfolio = ledger.snapshot();
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_DASHBOARD_CLOCK');
    overview.refresh();
    const liveMode = ledger.executionMode?.() === 'live' || runtime.executionMode?.() === 'live';
    const windows = overview.snapshot(state.network, clock, liveMode ? 'live' : 'paper');
    const day = windows.today.start, p = portfolio.performance;
    const active = state.events.filter(e => e.network === state.network && e.epoch === state.epoch);
    const scanEvent = active.findLast(e => e.type === 'ScanProgress');
    const scan = scanEvent ? { ...scanEvent.payload, found: scanEvent.payload.completed - scanEvent.payload.failed - scanEvent.payload.skipped, candidates: active.filter(e => e.type === 'TokenCandidate' && e.correlationId.startsWith(scanEvent.payload.runId + ':')).length } : null;
    // Real scan-run count: distinct scanner runs journaled on the active epoch.
    const scanRuns = new Set(active.filter(e => e.type === 'ScanProgress').map(e => e.payload.runId)).size;
    const symbols = new Map(state.events.filter(e => e.type === 'TokenCandidate').map(e => [key(e.network, e.payload.token), e.payload.symbol]));
    const images = new Map(), names = new Map();
    const identities = state.events.filter(e => e.type === 'MarketSnapshot' && Date.parse(e.payload.observedAt) <= clock.getTime()).sort((a,b)=>Date.parse(a.payload.observedAt)-Date.parse(b.payload.observedAt));
    for (const event of identities) {
      const id = key(event.network, event.payload.token), identity = tokenIdentity(event.payload);
      if (identity.tokenSymbol) symbols.set(id, identity.tokenSymbol);
      if (identity.imageUrl) images.set(id, identity.imageUrl);
      if (identity.tokenName) names.set(id, identity.tokenName);
    }
    // Saved Gecko identity takes precedence over fallback metadata, across epochs too.
    for (const event of identities) for (const ref of event.evidence) {
      const body = savedBody(event.network, ref); if (!body) continue;
      const id = key(event.network, event.payload.token), symbol = tickerOf(body, event.payload.token), image = imageOf(body, event.payload.token);
      if (symbol) symbols.set(id, symbol);
      if (image) images.set(id, image);
    }
    const identityRows = [...portfolio.positions, ...(ledger.history?.() ?? portfolio.trades), ...(newlyCreated?.() ?? [])];
    for (const row of identityRows) {
      const id = key(row.network, row.token), identity = tokenIdentities?.get(row.network, row.token);
      if (identity?.tokenSymbol && (!symbols.has(id) || row.token.startsWith(symbols.get(id)))) symbols.set(id, identity.tokenSymbol);
      if (identity?.tokenName) names.set(id, identity.tokenName);
      if (identity?.imageUrl && !images.has(id)) images.set(id, identity.imageUrl);
      if (tokenIdentities) void tokenIdentities.resolve(row.network, row.token);
    }
    const agents = PRODUCERS.map((producer, i) => {
      const scan = i === 0 ? active.findLast(e => e.type === 'AIActivityEvent' && e.producer === 'MARKET_DATA' && e.payload.agent === 'MARKET_DATA' && e.payload.task.startsWith('scan:')) : null;
      // Journal order is authoritative, including events sharing one timestamp.
      // An old Hunter result must not hide a newer scan start/failure/stop.
      const event = active.findLast(e => e.type === 'AIActivityEvent' &&
        (e.producer === producer && e.payload.agent === producer || e === scan));
      const progressEvent = scan ?? event;
      const tasks = new Map();
      for (const item of active) if (item.type === 'AIActivityEvent' && item.producer === producer && item.payload.agent === producer) tasks.set(item.payload.task, item.payload.state);
      const completed = tasks.size ? [...tasks.values()].filter(state => state === 'COMPLETED').length : null;
      return { id: IDS[i], role: ROLES[i], status: (scan ?? event)?.payload.state.toLowerCase() ?? 'waiting', task: event?.payload.message ?? scan?.payload.message ?? null, progress: progressEvent?.payload.progress == null ? null : progressEvent.payload.progress * 100, progressEventId: progressEvent?.id ?? null, progressProducer: progressEvent?.producer ?? null, completed, total: tasks.size || null, updatedAt: event?.timestamp ?? scan?.timestamp ?? null };
    });
    if(workMeter){const measured=workMeter.snapshot();for(const agent of agents)agent.work=measured[agent.id];}
    require('./progress.cjs').projectProgress(agents, active, portfolio, clock);
    const markets = Object.create(null); let activeToken = null;
    const samples = active.filter(e => e.type === 'MarketSnapshot' && e.evidence.length && !e.missing_evidence.length && e.evidence_quality > 0 && e.confidence > 0 && e.uncertainty < 1 && ['OBSERVED', 'COMPLETED'].includes(e.status)).sort((a, b) => Date.parse(a.payload.observedAt) - Date.parse(b.payload.observedAt));
    for (const event of samples) {
      const { token, price, observedAt } = event.payload, id = key(event.network, token), time = Date.parse(observedAt);
      if (time > clock.getTime()) continue;
      const market = markets[id] ??= { tokenId: token, network: event.network, symbol: symbols.get(id) ?? token.slice(0, 32), priceUsd: price, firstPriceUsd: price, updatedAt: observedAt, candles: [], points: [], priceSource: 'OBSERVED_SAMPLES', volumeSource: null };
      const lastPoint = market.points.at(-1);
      market.image = images.get(id);
      if (lastPoint?.at === time) lastPoint.priceUsd = price;
      else market.points.push({ at: time, priceUsd: price });
      if (market.points.length > 1440) market.points.shift();
      const bucket = Math.floor(time / 60000) * 60000, candle = market.candles.at(-1);
      if (candle?.at === bucket) { candle.high = Math.max(candle.high, price); candle.low = Math.min(candle.low, price); candle.close = price; }
      else market.candles.push({ at: bucket, open: price, high: price, low: price, close: price, volumeUsd: null });
      market.priceUsd = price; market.updatedAt = observedAt; activeToken = id;
    }
    // A quote older than the buy window is not a new entry. The open position still keeps the prices already observed.
    const held = new Set(portfolio.positions.filter(row => row.network === state.network).map(row => key(row.network, row.token)));
    for (const [id, market] of Object.entries(markets)) if (clock.getTime() - Date.parse(market.updatedAt) > maxQuoteAgeMs && !held.has(id)) delete markets[id];
    for (const id of held) {
      const market = markets[id];
      if (!market) continue;
      for (const sample of samples) {
        if (key(sample.network, sample.payload.token) !== id) continue;
        for (const ref of sample.evidence) {
          const body = savedBody(sample.network, ref);
          if (!body) continue;
          const pool = poolOf(body, market.tokenId);
          if (pool) market.poolAddress = pool;
          for (const point of printsOf(body, market.tokenId)) {
            if (point.at > clock.getTime()) continue;
            const existing = market.points.find(row => row.at === point.at);
            if (existing) existing.priceUsd = point.priceUsd;
            else market.points.push(point);
          }
        }
      }
      const rows = ticks.get(id);
      if (rows) for (const tick of rows) if (tick.at <= clock.getTime()) {
        const existing = market.points.find(row => row.at === tick.at);
        if (existing) existing.priceUsd = tick.priceUsd;
        else market.points.push({ at: tick.at, priceUsd: tick.priceUsd });
      }
      market.points.sort((a, b) => a.at - b.at);
      if (market.points.length > 1440) market.points.splice(0, market.points.length - 1440);
      market.candles = [];
      for (const point of market.points) {
        const bucket = Math.floor(point.at / 60000) * 60000, candle = market.candles.at(-1), volume = point.volumeUsd || 0;
        if (candle?.at === bucket) { candle.high = Math.max(candle.high, point.priceUsd); candle.low = Math.min(candle.low, point.priceUsd); candle.close = point.priceUsd; candle.volumeUsd = (candle.volumeUsd || 0) + volume; }
        else if (candle && point.priceUsd === candle.close && volume === 0) continue;
        else market.candles.push({ at: bucket, open: point.priceUsd, high: point.priceUsd, low: point.priceUsd, close: point.priceUsd, volumeUsd: volume });
      }
      market.firstPriceUsd = market.points[0].priceUsd;
      market.priceUsd = market.points.at(-1).priceUsd;
      const saved = bars.get(id);
      if (saved?.length) {
        market.candles = saved.map(candle => ({ ...candle }));
        const tick = rows?.at(-1);
        const last = market.candles.at(-1);
        if (tick && last) {
          const bucket = Math.floor(tick.at / 60000) * 60000;
          if (last.at === bucket) { last.high = Math.max(last.high, tick.priceUsd); last.low = Math.min(last.low, tick.priceUsd); last.close = tick.priceUsd; }
          else if (bucket > last.at && tick.priceUsd !== last.close) market.candles.push({ at: bucket, open: last.close, high: Math.max(last.close, tick.priceUsd), low: Math.min(last.close, tick.priceUsd), close: tick.priceUsd, volumeUsd: null });
        }
        market.firstPriceUsd = market.candles[0].open;
        market.priceUsd = market.candles.at(-1).close;
      }
      const span = market.candles.length > 1 ? market.candles.at(-1).at - market.candles[0].at : 0;
      market.historyStatus = market.candles.length < regimePolicy.minSamples || span < regimePolicy.historyWindowMs ? 'INSUFFICIENT' : 'SUFFICIENT';
      activeToken = id;
    }
    // SOL reference market: the chart always has a live feed; a meme takes focus
    // only while the ledger holds a bought position on it.
    const solTicks = ticks.get(REFERENCE);
    while (solTicks?.length && solTicks[0].at < clock.getTime() - 2 * 60 * 60 * 1000) solTicks.shift();
    if (state.network==='SOLANA' && solTicks?.length) {
      const market = markets[REFERENCE] ??= { tokenId: 'SOL', network: 'SOLANA', symbol: 'SOL', image: referenceImage, priceUsd: null, firstPriceUsd: null, updatedAt: null, candles: [], points: [], priceSource: 'REFERENCE_FEED', volumeSource: null };
      if (referenceImage) market.image = referenceImage;
      for (const tick of solTicks) if (tick.at <= clock.getTime()) {
        const existing = market.points.find(row => row.at === tick.at);
        if (existing) existing.priceUsd = tick.priceUsd;
        else market.points.push({ at: tick.at, priceUsd: tick.priceUsd });
      }
      market.points.sort((a, b) => a.at - b.at);
      if (market.points.length > 6000) market.points.splice(0, market.points.length - 6000);
      market.candles = [];
      for (const point of market.points) {
        const bucket = Math.floor(point.at / 60000) * 60000, candle = market.candles.at(-1);
        if (candle?.at === bucket) { candle.high = Math.max(candle.high, point.priceUsd); candle.low = Math.min(candle.low, point.priceUsd); candle.close = point.priceUsd; }
        else market.candles.push({ at: bucket, open: point.priceUsd, high: point.priceUsd, low: point.priceUsd, close: point.priceUsd, volumeUsd: null });
      }
      if (!market.points.length) delete markets[REFERENCE];
      else {
        market.firstPriceUsd = market.points[0].priceUsd;
        market.priceUsd = market.points.at(-1).priceUsd;
        market.updatedAt = new Date(market.points.at(-1).at).toISOString();
        market.historyStatus = 'SUFFICIENT';
        if (![...held].some(id => markets[id])) activeToken = REFERENCE;
      }
    }
    // Only an open BUY on the selected network can own chart focus.
    const focus=portfolio.trades.findLast(t=>t.network===state.network && t.side==='BUY' && portfolio.positions.some(p=>p.network===t.network&&p.token===t.token&&p.quantity>0));
    if(focus){
      const id=key(focus.network,focus.token);
      if(!markets[id]){
        const history=state.events.filter(e=>e.type==='MarketSnapshot'&&e.network===focus.network&&e.payload.token===focus.token&&e.evidence.length&&!e.missing_evidence.length&&e.evidence_quality>0&&e.confidence>0&&['OBSERVED','COMPLETED'].includes(e.status)&&Date.parse(e.payload.observedAt)<=clock.getTime()).sort((a,b)=>Date.parse(a.payload.observedAt)-Date.parse(b.payload.observedAt)).slice(-1440);
        const points=history.map(e=>({at:Date.parse(e.payload.observedAt),priceUsd:e.payload.price}));
        markets[id]={tokenId:focus.token,network:focus.network,symbol:symbols.get(id)||focus.token,priceUsd:points.at(-1)?.priceUsd??null,firstPriceUsd:points[0]?.priceUsd??null,updatedAt:history.at(-1)?.payload.observedAt??null,points,candles:[],priceSource:'OBSERVED_SAMPLES'};
        for(const e of history)for(const ref of e.evidence){const body=savedBody(e.network,ref);if(!body)continue;markets[id].symbol=tickerOf(body,focus.token)||markets[id].symbol;markets[id].image=imageOf(body,focus.token)||markets[id].image;markets[id].poolAddress=poolOf(body,focus.token)||markets[id].poolAddress;}
      }
      const observed=ticks.get(id)||[];
      for(const point of observed){if(point.at>clock.getTime())continue;const existing=markets[id].points.find(p=>p.at===point.at);if(existing)existing.priceUsd=point.priceUsd;else markets[id].points.push({...point});}
      markets[id].points.sort((a,b)=>a.at-b.at);
      const latest=markets[id].points.at(-1);if(latest){markets[id].priceUsd=latest.priceUsd;markets[id].updatedAt=new Date(latest.at).toISOString();}
      markets[id].network=focus.network;markets[id].focusTradeId=focus.id;markets[id].quoteStale=!markets[id].updatedAt||clock.getTime()-Date.parse(markets[id].updatedAt)>maxQuoteAgeMs;
      activeToken=id;
    }
    if (!markets[activeToken]) activeToken = Object.keys(markets).at(-1) ?? null;
    // One bounded pass over the journal: freshest MarketSnapshot + ATH market
    // cap per token, so N trade rows never rescan the whole event history.
    const statsByToken=new Map(),athByToken=new Map();
    for(const e of state.events){
      if(e.type!=='MarketSnapshot')continue;
      const id=e.network+'|'+e.payload.token;
      statsByToken.set(id,e);
      const mc=e.payload.marketCapUsd;
      if(Number.isFinite(mc)){const cur=athByToken.get(id);athByToken.set(id,cur==null?mc:Math.max(cur,mc));}
    }
    let livePnl = 0, liveKnown = false;
    const markedPositions = new Set();
    const history = ledger.history?.() ?? portfolio.trades;
    const tradeDetails = require('./trade-details.cjs').createTradeDetails(state.events, history, newlyCreated?.() || [], clock);
    const trades = history.filter(t=>t.network===state.network).slice().sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)).map(t => {
      const row = { ...t, tokenId: t.token, symbol: symbols.get(key(t.network, t.token)) ?? t.token.slice(0, 32), updatedAt: t.timestamp, entryPriceUsd: t.side === 'BUY' ? t.entryPrice : t.allocatedCostBasis / t.quantity, exitPriceUsd: t.exitPrice, pnlUsd: t.side === 'BUY' ? null : t.realizedPnl, pnlPct: t.realizedReturn === null ? null : 100 * t.realizedReturn, status: t.positionState === 'OPEN' ? 'open' : t.positionState === 'ARCHIVED' ? 'archived' : 'closed' };
      row.image = images.get(key(t.network, t.token));
      row.name = names.get(key(t.network, t.token));
      if (liveMode && t.mode === 'paper' && row.status === 'open') row.status = 'archived';
      // Owner directive 2026-10-01: every token row carries the full on-chain
      // profile — liquidity, market cap, creation time, 24h volume — joined
      // from the freshest observed MarketSnapshot (discovery record first for
      // the true birth timestamp when available).
      const stats=statsByToken.get(t.network+'|'+t.token);
      const sp=stats?.payload??{};
      const ageMs=Number.isFinite(sp.poolAgeMs)?sp.poolAgeMs:null;
      const observedMs=stats?Date.parse(stats.payload.observedAt):null;
      const born=(newlyCreated?.()||[]).find(r=>r.token===t.token&&r.network===t.network);
      row.liquidityUsd=Number.isFinite(sp.liquidityUsd)?sp.liquidityUsd:null;
      row.marketCapUsd=Number.isFinite(sp.marketCapUsd)?sp.marketCapUsd:null;
      row.volume24hUsd=Number.isFinite(sp.volume24hUsd)?sp.volume24hUsd:null;
      row.poolAgeMs=ageMs;
      row.tokenCreatedAt=born?.createdAt??(observedMs!=null&&ageMs!=null?new Date(observedMs-ageMs).toISOString():null);
      Object.assign(row, tradeDetails(t));
      row.athMarketCapUsd=athByToken.get(t.network+'|'+t.token)??null;
      const marketForMark=markets[key(t.network,t.token)];
      const mark=marketForMark?.priceUsd;
      const position = row.status === 'open' && t.side === 'BUY' ? portfolio.positions.find(p => p.network === t.network && p.token === t.token) : null;
      if (position) {
        const quoted = Number.isFinite(mark) && mark > 0;
        row.mark = quoted ? mark : 'entry';
        row.markStale = quoted && Boolean(marketForMark.quoteStale);
        row.markUpdatedAt = quoted ? marketForMark.updatedAt : null;
        row.pnlUsd = quoted ? mark * position.quantity - position.costBasis : 0;
        row.pnlPct = position.costBasis > 0 ? 100 * row.pnlUsd / position.costBasis : 0;
        const positionKey = key(t.network, t.token);
        if (!markedPositions.has(positionKey)) { livePnl += row.pnlUsd; liveKnown = true; markedPositions.add(positionKey); }
      }
      return row;
    });
    // Display-only settlement ledger. WalletValuation is real funding, not a paper reset.
    const settlementEvents = [...new Map([...settlementHistory, ...state.events].map(e=>[e.id,e])).values()];
    const funding = state.network === 'SOLANA' ? settlementEvents.findLast(e=>e.type==='WalletValuation' && e.network==='SOLANA' && e.payload.symbol==='SOL' && Date.parse(e.timestamp)<=clock.getTime()) : null;
    const solStart = funding ? Number(funding.payload.amount) : null;
    const references = (solTicks || []).filter(t=>t.at<=clock.getTime()).slice().sort((a,b)=>a.at-b.at);
    const solPriceUsd = references.at(-1)?.priceUsd ?? null;
    const solAnchor = state.network === 'SOLANA' ? runtime.solAnchor?.() : null;
    const solSeen = new Set(solAnchor?.fillsSeen ?? []);
    const settlements = new Map(); let solNet = 0, solComplete = true;
    for (const event of settlementEvents) {
      if (state.network!=='SOLANA' || event.network!=='SOLANA' || event.type!=='TradeResult' || event.payload.mode!=='paper' || Date.parse(event.timestamp)>clock.getTime()) continue;
      const fill = event.payload, price = references.findLast(t=>t.at<=Date.parse(event.timestamp))?.priceUsd ?? solPriceUsd;
      if (price == null) { if (!solSeen.has(event.id)) solComplete = false; continue; }
      // Executed prices already include slippage; fees are separate USD amounts.
      const buy = fill.side==='BUY', amount = (fill.quantity * (buy ? fill.entryPrice : fill.exitPrice) + (buy ? fill.fees : -fill.fees)) / price;
      settlements.set(event.id, { solPriceUsd:price, ...(buy ? { solSpent:amount } : { solReceived:amount }) });
      if (!solSeen.has(event.id)) solNet += (buy ? -amount : amount) * (solAnchor ? price / solPriceUsd : 1);
    }
    const solBase = solAnchor?.solBalance ?? solStart;
    const solBalanceRaw = solComplete && solBase != null ? solBase + solNet : null;
    const solBalance = solBalanceRaw == null ? null : Math.max(0, solBalanceRaw);
    const solShortfall = solBalanceRaw == null ? null : Math.max(0, -solBalanceRaw);
    const withdrawnSol = (runtime.paperWithdrawals?.() ?? []).reduce((sum, e) => sum + e.amountSol, 0);
    for (const trade of trades) Object.assign(trade, settlements.get(trade.id));
    const fillsById = new Map(trades.map(t=>[t.id,t]));
    const activities = active.filter(e => ['AIActivityEvent', 'TradeResult', 'SafetyDecision', 'JevVerdict'].includes(e.type) || (e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER')).slice(-200).reverse().map(e => {
      const fill = fillsById.get(e.id);
      const soldMessage = fill && fill.side !== 'BUY' ? `Đã bán ${fill.symbol} · ${fill.quantity.toLocaleString('en-US',{maximumSignificantDigits:7})} token` : null;
      const scan = e.type === 'AIActivityEvent' && e.producer === 'MARKET_DATA' && e.payload.agent === 'MARKET_DATA' && e.payload.task.startsWith('scan:');
      let message = scan ? `Market data: ${e.payload.message}`
        : e.type === 'AIActivityEvent' ? e.payload.message
          : e.type === 'TradeResult' ? soldMessage || `${e.payload.side} ${e.payload.token}`
            : e.type === 'SafetyDecision' ? (e.payload.approved ? `Safety pass: ${e.payload.candidateId}` : e.payload.reason)
              : e.type === 'JevVerdict' ? `Jev ${e.payload.action} (confidence ${e.payload.confidence == null ? '—' : e.payload.confidence.toFixed(2)})`
                : e.payload.reason;
      const settlement = settlements.get(e.id);
      if (settlement) message += settlement.solSpent != null ? ` · −${settlement.solSpent.toFixed(6)} SOL` : ` · +${settlement.solReceived.toFixed(6)} SOL`;
      const detail = soldMessage ? `${fill.pnlUsd < 0 ? '−' : '+'}$${Math.abs(fill.pnlUsd).toFixed(2)} (${fill.pnlPct.toFixed(2)}%)` : null;
      return { id: e.id, agentId: scan ? 'jev' : e.type === 'AIActivityEvent' ? IDS[PRODUCERS.indexOf(e.payload.agent)] ?? null : e.type === 'SafetyDecision' ? 'safety' : e.type === 'JevVerdict' ? 'jev' : e.producer === 'EXIT_MANAGER' ? 'risk' : null, producer: e.producer, source: e.source, occurredAt: e.timestamp, message, detail, evidence: [...e.evidence], correlationId: e.correlationId };
    });
    // Safety and Jev projections: latest verdict per candidate, journal order authoritative.
    const latestByCandidate = type => { const map = new Map(); for (const e of active) if (e.type === type) map.set(e.payload.candidateId, e); return map; };
    const safetyMap = latestByCandidate('SafetyDecision');
    const safetyRows = [...safetyMap.values()];
    const safety = {
      screened: safetyRows.length,
      approved: safetyRows.filter(e => e.payload.approved).length,
      rejected: safetyRows.filter(e => !e.payload.approved).length,
      recent: safetyRows.slice(-8).reverse().map(e => ({ candidateId: e.payload.candidateId, approved: e.payload.approved, reason: e.payload.reason, at: e.timestamp }))
    };
    const jevMap = latestByCandidate('JevVerdict');
    const jevRows = [...jevMap.values()];
    const jev = {
      verdicts: jevRows.length,
      actions: jevRows.reduce((acc, e) => { acc[e.payload.action] = (acc[e.payload.action] ?? 0) + 1; return acc; }, Object.create(null)),
      recent: jevRows.slice(-8).reverse().map(e => ({ candidateId: e.payload.candidateId, action: e.payload.action, confidence: e.payload.confidence, model: e.payload.model, at: e.timestamp }))
    };
    // Protection projection: every open position shows its actual protective levels.
    // Entry = authoritative average cost; stop/TP from the exit-manager policy;
    // high-water mark from observed prices since the entry fill (never invented).
    const protection = portfolio.positions.filter(row => row.network === state.network && row.quantity > 0).map(row => {
      const id = key(row.network, row.token);
      const entryFill = portfolio.trades.filter(t => t.network === row.network && t.token === row.token && t.side === 'BUY' && t.state === 'OPEN').at(-1);
      const entry = row.averageCost;
      const highs = samples.filter(e => key(e.network, e.payload.token) === id && (!entryFill || e.timestamp >= entryFill.timestamp)).map(e => e.payload.price);
      const highWater = highs.length ? Math.max(entry, ...highs) : entry;
      const exits = active.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER' && (!entryFill || e.timestamp >= entryFill.timestamp))
        .filter(e => { const snap = active.find(s => s.id === e.payload.snapshotId); return snap && snap.payload.token === row.token; });
      const positionRow = trades.find(t=>t.side==='BUY' && t.status==='open' && t.tokenId===row.token);
      return { tokenId: row.token, symbol: positionRow?.symbol ?? symbols.get(id) ?? row.token.slice(0, 32), sellBadge:positionRow?.sellBadge ?? null, quantity: row.quantity, entryPriceUsd: entry, priceUsd: markets[id]?.priceUsd ?? row.markPrice,
        stopUsd: entry * (1 - exitPolicy.stopDistance), takeProfitUsd: entry * (takeProfitMultiple ? takeProfitMultiple(state.network) : 1+exitPolicy.takeProfit), trailDistance: exitPolicy.trailDistance,
        highWaterUsd: highWater, trailingArmed: highWater > entry,
        exits: exits.map(e => ({ reason: e.payload.reason, at: e.timestamp })) };
    });
    const discoveries=(newlyCreated?.()||[]).filter(r=>r.network===state.network).map(row=>{
      const candidate=active.findLast(e=>e.type==='TokenCandidate'&&e.payload.token===row.token);
      const safe=candidate?safetyMap.get(candidate.id):null,verdict=candidate?jevMap.get(candidate.id):null;
      const fill=active.findLast(e=>e.type==='TradeResult'&&e.payload.token===row.token);
      const observation=active.findLast(e=>e.type==='MarketSnapshot'&&e.payload.token===row.token);
      let status='Chờ dữ liệu để kiểm tra';
      if(observation)status='Đang theo dõi / chưa đủ điều kiện';
      if(candidate)status='Chờ kiểm tra an toàn / JEV';
      if(safe)status=safe.payload.approved?'An toàn đạt · chờ quyết định':safe.payload.reason;
      if(verdict)status='JEV: '+verdict.payload.action;
      if(safe && !safe.payload.approved)status='Bị chặn: '+safe.payload.reason;
      if(fill)status=(fillsById.get(fill.id)?.sellBadge || (fill.payload.side==='BUY'?'Đã mua':'Đã bán'));
      const identityKey = key(row.network, row.token);
      return {...row,symbol:symbols.get(identityKey) ?? row.symbol,name:names.get(identityKey) ?? row.name,image:images.get(identityKey) ?? row.image,status,checkedAt:verdict?.timestamp||safe?.timestamp||observation?.timestamp||null,stale:clock.getTime()-Date.parse(row.observedAt)>maxQuoteAgeMs,decisionEvidence:[...(safe?.evidence||[]),...(verdict?.evidence||[])]};
    });
    for(const row of discoveries){
      const id=key(row.network,row.token);if(markets[id])continue;
      const points=(ticks.get(id)||[]).filter(p=>p.at<=clock.getTime());
      markets[id]={tokenId:row.token,network:row.network,symbol:row.symbol,image:row.image,poolAddress:row.poolAddress,discovery:true,priceSource:'OBSERVED_SAMPLES',points,candles:[],priceUsd:points.at(-1)?.priceUsd??null,firstPriceUsd:points[0]?.priceUsd??null,updatedAt:points.length?new Date(points.at(-1).at).toISOString():null,quoteStale:!points.length||clock.getTime()-points.at(-1).at>maxQuoteAgeMs};
    }
    const holdings = portfolio.positions.filter(p=>p.network===state.network && p.quantity>0).map(p=>{
      const row = trades.find(t=>t.side==='BUY' && t.status==='open' && t.tokenId===p.token);
      const mark = markets[key(p.network,p.token)]?.priceUsd ?? p.markPrice;
      return { tokenId:p.token, symbol:row?.symbol ?? symbols.get(key(p.network,p.token)) ?? p.token, image:row?.image ?? images.get(key(p.network,p.token)), quantity:p.quantity, priceUsd:mark, valueUsd:Number.isFinite(mark)?mark*p.quantity:null };
    });
    const valueUsd = holdings.every(h=>h.valueUsd!=null) ? holdings.reduce((s,h)=>s+h.valueUsd,0) : null;
    const settings = { paperCapitalUsd: p.paperCapitalUsd, capitalLedger: ledger.capitalHistory?.() ?? [] };
    const paperCapitalUsd = liveMode ? p.cash + p.capitalUsed : p.paperCapitalUsd, cashUsd = liveMode ? p.cash : paperCapitalUsd - p.capitalUsed;
    const paperWallet = { currency: PAPER_SETTLEMENT_CURRENCY, settlementCurrency:state.network==='SOLANA'?'SOL':PAPER_SETTLEMENT_CURRENCY, withdrawnSol, solStart, solPriceUsd, solBalance, solBalanceRaw, solShortfall, holdings, valueUsd, cashUsd, totalValueUsd:valueUsd==null?null:cashUsd+valueUsd };
    return freeze({ withdrawals: state.events.filter(e => e.type === 'AIActivityEvent' && e.producer === 'LIVE_EXECUTION' && e.payload.task === 'withdraw' && e.network === state.network).map(e => ({ id: e.id, message: e.payload.message, signature: e.evidence[0], occurredAt: e.timestamp })).reverse(), settings, discoveries, paperWallet, version: state.revision, network: state.network, epoch: state.epoch, asOf: clock.toISOString(), updatedAt: state.events.at(-1)?.timestamp ?? null, agents, scan, scanRuns, markets, activeToken, trades, activities, safety, jev, protection, overview: windows, summary: { day, ...windows.today, openPositions: portfolio.positions.length, capitalUsedUsd: p.capitalUsed, budgetUsd: p.budgetUsd, paperCapitalUsd, cashUsd, unrealizedPnlUsd: liveKnown ? livePnl : p.unrealizedPnl, equityUsd: paperWallet.totalValueUsd } });
  }
  function quote({ network, token, priceUsd, at, candles } = {}, deferRefresh = false) {
    if (closed || typeof network !== 'string' || typeof token !== 'string') return false;
    const id = key(network, token);
    if (Number.isFinite(priceUsd) && priceUsd > 0 && Number.isFinite(at)) {
      const rows = ticks.get(id) ?? [];
      rows.push({ priceUsd, at });
      const cutoff = at - 60 * 60 * 1000;
      while (rows.length && rows[0].at < cutoff) rows.shift();
      if (rows.length > 3600) rows.splice(0, rows.length - 3600);
      ticks.set(id, rows);
    }
    if (Array.isArray(candles) && candles.length) {
      const clean = [];
      for (const candle of candles) {
        if (!candle || ![candle.at, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
        if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) continue;
        clean.push({ at: candle.at, open: candle.open, high: Math.max(candle.open, candle.high, candle.close), low: Math.min(candle.open, candle.low, candle.close), close: candle.close, volumeUsd: Number.isFinite(candle.volumeUsd) && candle.volumeUsd >= 0 ? candle.volumeUsd : null });
      }
      if (clean.length) bars.set(id, clean.sort((a, b) => a.at - b.at).slice(-1440));
    }
    if (!ticks.has(id) && !bars.has(id)) return false;
    if (!deferRefresh) refresh();
    return true;
  }
  // A provider response is one update. Preserve point order while projecting
  // the dashboard only once, rather than once per historical trade print.
  function quotes(points) {
    let changed = false;
    try { for (const point of points) changed = quote(point, true) || changed; }
    finally { if (changed) refresh(); }
    return changed;
  }
  let referenceImage = null;
  function reference(priceUsd, at, image) { // SOL/USD reference samples; never a trade signal.
    if (closed || !Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(at)) return false;
    if (typeof image === 'string' && /^https:\/\/assets\.geckoterminal\.com\//.test(image)) referenceImage = image;
    const rows = ticks.get(REFERENCE) ?? [];
    rows.push({ priceUsd, at });
    const cutoff = at - 2 * 60 * 60 * 1000;
    while (rows.length && rows[0].at < cutoff) rows.shift();
    if (rows.length > 7200) rows.splice(0, rows.length - 7200);
    ticks.set(REFERENCE, rows);
    runtime.solReference?.(priceUsd, at);
    refresh();
    return true;
  }
  function refresh() { if (closed) return; const value = snapshot(); for (const listener of listeners) { try { listener(value); } catch { listeners.delete(listener); } } }
  const unsubscribe = runtime.subscribe('*', refresh);
  const unsubscribeIdentity = tokenIdentities?.subscribe(refresh);
  return Object.freeze({ snapshot, refresh, quote, quotes, reference, subscribe(listener) { if (closed || typeof listener !== 'function') throw Error('INVALID_DASHBOARD_SUBSCRIBER'); listeners.add(listener); return () => listeners.delete(listener); }, close() { closed = true; overview.close(); unsubscribe(); unsubscribeIdentity?.(); listeners.clear(); ticks.clear(); bars.clear(); } });
}
module.exports = { createDashboardAdapter };
