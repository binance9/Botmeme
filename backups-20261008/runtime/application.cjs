'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createRuntime } = require('./events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createHunter } = require('../services/jev/hunter.cjs');
const { createOnchainDiscovery } = require('../services/discovery-onchain/service.cjs');
const { createMarketData } = require('../core/market-data/service.cjs');
const { createRegimeEngine } = require('../core/market-data/regime.cjs');
const { createCommander } = require('../services/commander/service.cjs');
const { createQuant } = require('../services/quant/service.cjs');
const { createForensic } = require('../services/forensic/service.cjs');
const { createStrategyEngine } = require('../core/strategy/engine.cjs');
const { createRiskEngine } = require('../core/risk/engine.cjs');
const { createExitManager } = require('../core/risk/exit-manager.cjs');
const { createSafetyGate } = require('../core/safety/gate.cjs');
const { createRugCheckReader, createSolanaRpcSafetyReader, createFallbackSafetyReader } = require('../core/safety/rugcheck.cjs');
const { createManualPaperExecution: createPaperExecution } = require('./manual-paper-execution.cjs');
const { createConnectionStore } = require('../wallet/connection/store.cjs');
const { getNetworkAdapter } = require('../wallet/network/index.cjs');
const { createGeckoTerminal } = require('../core/market-data/providers/geckoterminal.cjs');
const { createRobinhoodPool } = require('../core/market-data/providers/robinhood-pool.cjs');
const { createJevDecision } = require('../services/jev/decision/service.cjs');

// An aged-out position may have no market quote left in the journal window, yet
// an operator exit needs a current price for the exit ticket. Fetch a real one
// from a public venue and publish it as ordinary MARKET_DATA evidence — same
// contract, same attribution rules, nothing synthesized. No venue answer
// returns null so the caller can refuse honestly.
async function emergencyExitQuote(runtime, token, network, epoch, now, fetcher = fetch) {
  const clock = now().toISOString();
  let sample = null, source = null;
  try {
    const response = await fetcher('https://api.dexscreener.com/latest/dex/tokens/' + encodeURIComponent(token), { redirect: 'error', signal: AbortSignal.timeout(8000) });
    const body = response.ok ? await response.json() : null;
    const pair = (Array.isArray(body?.pairs) ? body.pairs : []).filter(p => p?.chainId === 'solana' && Number(p?.priceUsd) > 0).sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0))[0];
    if (pair) { sample = { price: Number(pair.priceUsd), liquidityUsd: Math.max(0, Math.round(Number(pair.liquidity?.usd) || 0)), volume24hUsd: Math.max(0, Math.round(Number(pair.volume?.h24) || 0)) }; source = 'market-data.dexscreener.emergency-exit'; }
  } catch { /* fall through to the next venue */ }
  if (!sample) {
    try {
      const response = await fetcher('https://api.geckoterminal.com/api/v2/networks/solana/tokens/' + encodeURIComponent(token), { redirect: 'error', signal: AbortSignal.timeout(8000) });
      const price = Number(response.ok ? JSON.parse(await response.text())?.data?.attributes?.price_usd : NaN);
      if (Number.isFinite(price) && price > 0) { sample = { price, liquidityUsd: 0, volume24hUsd: 0 }; source = 'market-data.geckoterminal.emergency-exit'; }
    } catch { /* no venue answered */ }
  }
  if (!sample) return null;
  const { createHash } = require('node:crypto');
  const id = 'manual-exit-quote/' + createHash('sha256').update(token + ':' + clock).digest('hex');
  const existing = runtime.get(id);
  if (existing) return existing;
  const { validateEvent } = require('../runtime/contracts/index.cjs');
  const event = validateEvent({ id, type: 'MarketSnapshot', timestamp: clock, producer: 'MARKET_DATA', source,
    evidence: [source + '/' + createHash('sha256').update(token + ':' + sample.price).digest('hex').slice(0, 32)], status: 'OBSERVED', correlationId: 'manual-exit-quote', network, epoch,
    confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload: { token, ...sample, observedAt: clock } }, { now });
  runtime.publish(event);
  return event;
}

function createApplication({ journalPath, now = () => new Date(), providers, scanIntervalMs = 120000, capitalUsd, valuationReader, liveConfig, safetyReaders, discoveryConfig } = {}) {
  if (!Number.isSafeInteger(scanIntervalMs) || scanIntervalMs < 1000) throw Error('INVALID_SCAN_INTERVAL');
  const runtime = createRuntime({ journalPath, now, capitalUsd: capitalUsd ?? 0 });
  const capitalLedger = require('./capital-ledger.cjs').createCapitalLedger(journalPath ? path.join(path.dirname(path.resolve(journalPath)), 'capital-ledger.json') : null, now);
  const tradingSettings=require('./trading-settings.cjs').createTradingSettings(journalPath ? path.join(path.dirname(path.resolve(journalPath)),'trading-settings.json') : null);
  const wallet = createConnectionStore({ network: runtime.status().network });
  const sessionPath = journalPath ? path.join(path.dirname(path.resolve(journalPath)), 'wallet-session.json') : null;
  const rememberSession = () => {
    if (!sessionPath) return;
    const sessions = wallet.saved();
    try {
      if (!sessions.length) fs.rmSync(sessionPath, { force: true });
      else fs.writeFileSync(sessionPath, JSON.stringify({version:2,sessions}));
    } catch { /* a missing session file must not block paper control */ }
  };
  if (sessionPath) {
    try {
      const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      wallet.restore(saved.version===2 ? saved.sessions : [saved]);
    } catch { /* start still requires an explicit wallet connection */ }
  }
  const walletFunded = capitalUsd === undefined;
  let fundingError = null;
  let liveSession = false;
  const paperStore = createTradeStore({ runtime, now, capitalLedger, capitalUsd: capitalUsd ?? 0, walletFunded, fundingAllowed: quote => {
    const session = wallet.snapshot().session;
    return session && !fundingError && quote.payload.accountHash === require('node:crypto').createHash('sha256').update(session.network + ':' + session.address).digest('hex');
  } });
  const liveEnv = liveConfig?.env ?? process.env;
  const tokenIdentities = require('../core/market-data/token-identity.cjs').createTokenIdentityStore({ filename: journalPath ? path.join(path.dirname(path.resolve(journalPath)), 'token-identities.json') : undefined, fetcher: liveConfig?.fetcher, rpcUrl: liveEnv.RPC_HTTP_ENDPOINT || liveConfig?.rpcUrl });
  const cacheIdentity = event => { if (event.type === 'MarketSnapshot') tokenIdentities.put(event.network, event.payload.token, event.payload); };
  runtime.snapshot().events.forEach(cacheIdentity);
  const detachIdentity = runtime.subscribe('MarketSnapshot', cacheIdentity);
  const liveExecution = require('../core/execution/live.cjs').createLiveExecution({ runtime, tradeStore: paperStore, now, config: { ...liveConfig, env: liveEnv, rpcUrl: liveEnv.RPC_HTTP_ENDPOINT || liveConfig?.rpcUrl } });
  liveSession = liveExecution.status().hasKey;
  const tradeStore = { ...paperStore, executionMode: () => liveSession ? 'live' : 'paper',
    history: () => [paperStore.snapshot(), liveExecution.portfolio()].flatMap((portfolio, index) => {
      const mode = index ? 'live' : 'paper';
      return portfolio.trades.map(trade => ({ ...trade, mode, cycleId: mode + ':' + trade.cycleId }));
    }),
    maxEntryUsd: () => liveSession ? liveExecution.status().caps.position : Infinity,
    snapshot: options => liveSession ? liveExecution.portfolio() : paperStore.snapshot(options) };
  const valuer = valuationReader ?? require('../wallet/connection/valuation.cjs').createValuationReader({ now });
  let fundingRequest = null;
  function refreshFunding() {
    // Public balance reads must not queue ahead of START/STOP or overlap each other.
    if (!fundingRequest) fundingRequest = readFunding().finally(() => { fundingRequest = null; });
    return fundingRequest;
  }
  async function readFunding() {
    const trading = liveSession;
    if (trading) await liveExecution.refreshBalance();
    if (!walletFunded && !trading) return;
    const session = trading ? { network: 'SOLANA', address: liveExecution.status().owner, chainId: 'mainnet-beta', provider: 'local' } : wallet.snapshot().session, before = runtime.status();
    if (!session) throw Error('WALLET_CONNECTION_REQUIRED');
    try {
      // Public RPC/price endpoints occasionally stall while a scan is saturating
      // the same connection; a transient timeout must not gate the bot out of
      // trading. Bounded retry, session-change still fails immediately.
      let quote = null, lastError = null;
      for (let attempt = 0; attempt < 4 && !quote; attempt++) {
        try { quote = await valuer.read(session); }
        catch (error) {
          if (['WALLET_SESSION_CHANGED', 'WALLET_CONNECTION_REQUIRED'].includes(error.message)) throw error;
          lastError = error;
          await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        }
      }
      if (!quote) throw lastError ?? Error('WALLET_BALANCE_UNVERIFIED');
      if (closed || runtime.status().epoch !== before.epoch || (trading ? !liveSession || liveExecution.status().owner !== session.address : JSON.stringify(wallet.snapshot().session) !== JSON.stringify(session))) throw Error('WALLET_SESSION_CHANGED');
      if (journalPath) {
        const fs = require('node:fs'), dir = path.join(path.dirname(journalPath), 'capital-evidence');
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, quote.id.split('/').at(-1) + '.json'), JSON.stringify(quote), { flag: 'wx' });
      }
      runtime.publish({ id: quote.id, type: 'WalletValuation', timestamp: quote.timestamp, producer: 'RUNTIME', source: quote.source, evidence: quote.evidence, status: 'OBSERVED', correlationId: quote.id, network: before.network, epoch: before.epoch, confidence: 1, evidence_quality: 1, missing_evidence: [], uncertainty: 0, payload: quote.payload });
      fundingError = null;
    } catch (error) {
      fundingError = 'WALLET_CAPITAL_UNVERIFIED';
      try { require('node:fs').appendFileSync(require('node:path').join(__dirname, '..', 'runtime', 'funding-debug.log'), new Date().toISOString() + ' ' + String(error && error.stack || error).slice(0, 500) + '\n'); } catch {}
      throw Error(fundingError);
    }
  }
  const workMeter=require('./work-meter.cjs').createWorkMeter({filename:journalPath ? journalPath+'.work.jsonl' : undefined});
  // Journal rotation archives verbatim history while the live ledger (live-state.json)
  // keeps the full position lineage. Without reviving that lineage an operator exit
  // cannot pass the trace contract (candidate/snapshot/intent events are only in
  // archives), so open live positions could never be sold after a rotation. Revive
  // exactly the dependency closure of open-position fills from the archives — real
  // committed events, published in chronological order, nothing synthesized.
  function reviveAgedLineage() {
    try {
      const liveRoot = liveConfig?.root ?? path.resolve(__dirname, '..');
      const ledgerFile = path.join(liveRoot, 'live-state.json');
      if (!fs.existsSync(ledgerFile) || !journalPath) return;
      const fills = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).fills ?? [];
      const needed = new Set();
      const queue = [];
      const push = id => { if (typeof id === 'string' && id && !needed.has(id)) { needed.add(id); queue.push(id); } };
      for (const fill of fills) { push(fill.id); const p = fill.payload ?? {}; for (const key of ['intentId', 'decisionId', 'riskDecisionId', 'candidateId', 'snapshotId']) push(p[key]); for (const id of p.signalIds ?? []) push(id); }
      if (!queue.length) return;
      const dir = path.dirname(path.resolve(journalPath)), base = path.basename(journalPath);
      const pages = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.archive')).sort().map(f => path.join(dir, f)); pages.push(journalPath);
      const found = new Map();
      const REFERENCES = { candidateId: 1, snapshotId: 1, signalIds: 1, decisionId: 1, riskDecisionId: 1, intentId: 1, regimeId: 1 };
      // A discovered event can pull ids that sit BEFORE it in the same page, so
      // rescan until a full pass adds nothing (closure is then complete).
      let size = -1;
      while (found.size !== size) {
        size = found.size;
        for (const page of pages) {
          if (!fs.existsSync(page)) continue;
          for (const line of fs.readFileSync(page, 'utf8').split('\n')) {
            if (!line) continue;
            let event; try { const record = JSON.parse(line); event = record.value?.kind === 'event' ? record.value.event : null; } catch { continue; }
            if (!event || !needed.has(event.id) || found.has(event.id)) continue;
            found.set(event.id, event);
            const payload = event.payload ?? {};
            for (const [field] of Object.entries(REFERENCES)) { const value = payload[field]; if (Array.isArray(value)) value.forEach(push); else push(value); }
          }
        }
      }
      const chronological = [...found.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      let revived = 0;
      for (const event of chronological) {
        if (runtime.get(event.id)) continue;
        try { runtime.publish(event); revived++; } catch { /* an event that no longer validates stays archived-only */ }
      }
      if (revived) require('node:fs').appendFileSync(path.join(__dirname, '..', 'runtime', 'funding-debug.log'), now().toISOString() + ` revived ${revived} archived lineage events for open live positions\n`);
    } catch { /* lineage revival is best-effort; live trading gates still apply */ }
  }
  reviveAgedLineage();
  const inputs = { runtime: { ...workMeter.wrapRuntime(runtime), executionMode: () => liveSession ? 'live' : 'paper' }, tradeStore, now };
  // Both execution modes share the same chain. Use the configured RPC endpoint
  // in safety reads as well as execution; mode is read dynamically by the gate.
  const readers = safetyReaders ?? { SOLANA: createFallbackSafetyReader({
    primary: createRugCheckReader({ now }),
    fallback: createSolanaRpcSafetyReader({ rpcUrl: liveEnv.RPC_HTTP_ENDPOINT || liveConfig?.rpcUrl, fetcher: liveConfig?.fetcher })
  }) };
  // Analytics keep running in live mode; paper settlement is gated by executionMode.
  // Safety gate runs FIRST on every candidate (hard fail-closed veto), Jev decision runs
  // next (advisory verdict; its REJECT supersedes an approval), and the exit manager adds
  // protective SL/TP/trailing exits for open meme positions. Paper execution enforces the
  // safety verdict on every BUY (requireSafetyVerdict: true in production wiring).
  const modules = [createHunter(inputs), createRegimeEngine(inputs), createQuant(inputs), createForensic(inputs), createCommander(inputs), createSafetyGate({ ...inputs, readers }), createJevDecision(inputs), createRiskEngine({ ...inputs, policy: { manualExitMaxQuoteAgeMs: Number.MAX_SAFE_INTEGER } }), createStrategyEngine(inputs), createExitManager({...inputs,takeProfitMultiple:network=>tradingSettings.get(network)}), createPaperExecution({ ...inputs, policy: { requireSafetyVerdict: true, maxIntentAgeMs: 900000, maxQuoteAgeMs: 900000 } })];
  const networkIds = { SOLANA: 'solana', ETHEREUM: 'eth', BSC: 'bsc', ROBINHOOD: 'robinhood' };
  // Start acquisition last, after consumers; reverse stop disconnects it first.
  modules.push(createOnchainDiscovery({ ...inputs, ...discoveryConfig }));
  const sources = providers ?? (() => {
    const evidenceRoot = path.resolve(__dirname, '../data/market-evidence');
    const chain = createRobinhoodPool({ now, evidenceDirectory: path.join(evidenceRoot, 'ROBINHOOD') });
    return Object.fromEntries(Object.entries(networkIds).map(([network, networkId]) => [network, createGeckoTerminal({ network, networkId, now, evidenceDirectory: path.join(evidenceRoot, network), chain: network === 'ROBINHOOD' ? chain : null })]));
  })();
  const market = createMarketData({ runtime, providers: sources, now, providerTimeoutMs: 30000 });
  let running = false, closed = false, timer = null, scan = null, controlQueue = Promise.resolve(), lastScan = null, lastError = null;
  const runningPath = journalPath ? path.join(path.dirname(path.resolve(journalPath)), 'scanner-state.json') : null;
  const rememberRunning = value => {
    if (!runningPath) return;
    fs.mkdirSync(path.dirname(runningPath), { recursive: true });
    fs.writeFileSync(runningPath + '.tmp', JSON.stringify({ version: 1, running: value }));
    fs.renameSync(runningPath + '.tmp', runningPath);
  };
  const mode = () => liveSession ? liveExecution.isArmed() ? 'live' : 'safe' : 'paper';
  const control = () => ({ running, scanIntervalMs, network: runtime.status().network, epoch: runtime.status().epoch, mode: mode(), live: liveExecution.status(), paperExit: !liveSession, takeProfitMultiple:tradingSettings.get(runtime.status().network), wallet: wallet.snapshot(), lastScan, lastError, fundingError });
  function serialize(action) {
    const result = controlQueue.then(() => { if (closed) throw Error('APPLICATION_CLOSED'); return action(); });
    controlQueue = result.catch(() => {}); return result;
  }
  function schedule(delay) {
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      if (!running) return;
      let retryDelay = scanIntervalMs;
      scan = Promise.resolve().then(async () => {
        // Resolve a prior ambiguous send before the next sweep; outages retain pending and ARMED.
        if (liveSession && running) await liveExecution.reconcile().catch(() => {});
        if (!running) throw Error('APPLICATION_STOPPED');
        const finish=workMeter.begin('jev','market.scan');return Promise.resolve().then(()=>market.scan()).then(value=>{finish(value.status==='COMPLETED'?'completed':'partial');return value;},error=>{finish('failed');throw error;});
      }).then(result => { lastScan = result; lastError = result.status==='COMPLETED' ? null : 'MARKET_SCAN_PARTIAL'; retryDelay = scanIntervalMs; }, error => {
        lastError = error.message === 'WALLET_CAPITAL_UNVERIFIED' ? error.message : error.message === 'MARKET_RATE_LIMITED' ? 'MARKET_RATE_LIMITED' : 'MARKET_SCAN_UNAVAILABLE';
        retryDelay = scanIntervalMs;
      }).finally(() => {
        scan = null;
        // REST source has no push stream. Only acquisition is paced; AI work is event-driven.
        // Long server-directed waits are sliced only to fit Node's timer range;
        // the provider cooldown still prevents an early HTTP request.
        schedule(Math.min(retryDelay, 2147483647));
      });
    }, delay);
    timer.unref?.();
  }
  async function halt(persist = true) {
    liveExecution.stop();
    if (persist) rememberRunning(false);
    running = false; clearTimeout(timer); timer = null;
    market.stop();
    for (const module of modules.slice().reverse()) module.stop();
    if (scan) await Promise.race([scan.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
  }
  function resume() {
    if (!sources[runtime.status().network]) throw Error('NETWORK_PROVIDER_UNVERIFIED');
    if (!liveSession) liveExecution.start();
    modules.forEach(module => module.start()); rememberRunning(true); running = true; schedule(0);
  }
  // Wallet valuation has its own read-only cadence. A throttled token scanner
  // must not prevent fresh wallet capital from reaching the common state.
  const fundingTimer = setInterval(() => {
    if (!closed && (liveSession || wallet.isConnected())) refreshFunding().catch(() => {});
  }, 25000);
  fundingTimer?.unref?.();
  if (runningPath) {
    let saved; try { saved = JSON.parse(fs.readFileSync(runningPath, 'utf8')); } catch { /* first boot */ }
    if (saved?.version === 1 && saved.running === true) serialize(async () => {
      try {
        if (!wallet.isConnected()) throw Error('WALLET_CONNECTION_REQUIRED');
        resume(); refreshFunding().catch(() => {});
      } catch (error) { await halt(false); lastError = error.message; }
    }).catch(() => {});
  }
  function withdrawalActivity(entry) {
    if (runtime.get(entry.id)) return;
    runtime.publish({ id: entry.id, type: 'AIActivityEvent', timestamp: entry.at, producer: 'RUNTIME', source: 'paper.withdraw', evidence: [entry.id + '/ledger'], status: 'COMPLETED', correlationId: entry.id, network: 'SOLANA', epoch: entry.epoch, confidence: 1, evidence_quality: 1, missing_evidence: [], uncertainty: 0,
      payload: { agent: 'RUNTIME', task: entry.id, state: 'COMPLETED', progress: null, message: `Đã rút ${entry.amountSol} SOL về ví chính (mô phỏng)` } });
  }
  // The durable withdrawal doubles as an outbox if publication was interrupted.
  runtime.paperWithdrawals().forEach(withdrawalActivity);
  const paperCapital = () => ({ mode: 'paper', network: runtime.status().network, paperCapitalUsd: tradeStore.snapshot().performance.paperCapitalUsd, entries: tradeStore.capitalHistory() });
  const adjustPaper = (type, amountUsd, note) => serialize(() => {
    const state = runtime.snapshot();
    capitalLedger.adjust({ type, amountUsd, note, network: state.network, eventCount: state.events.filter(e => e.network === state.network).length, currentCapitalUsd: tradeStore.snapshot().performance.paperCapitalUsd });
    return paperCapital();
  });
  function manualLive(side, body) {
    // Serialize submission with mode changes, but keep STOP responsive during RPC settlement.
    return serialize(async () => {
      if (!liveSession || !liveExecution.isArmed()) throw Object.assign(Error('LIVE_NOT_ARMED'), { status: 409 });
      const fields = side === 'SELL' ? ['execute', 'percent', 'tradeId'] : ['execute', 'token'];
      if (!body || Array.isArray(body) || body.execute !== true || (body.side !== undefined && body.side !== side) || Object.keys(body).some(key => ![...fields, 'side', 'writeOff', 'evidence'].includes(key)) ||
          (side === 'SELL' ? !Number.isFinite(body.percent) || body.percent <= 0 || body.percent > 100 || typeof body.tradeId !== 'string' : typeof body.token !== 'string' || !body.token.trim() || body.token.length > 160) ||
          (body.writeOff !== undefined && body.writeOff !== true) ||
          (body.evidence !== undefined && (!Array.isArray(body.evidence) || !body.evidence.length || body.evidence.length > 8 || body.evidence.some(x => typeof x !== 'string' || !x.trim() || x.length > 300)))) {
        throw Object.assign(Error('INVALID_LIVE_' + (side === 'SELL' ? 'EXIT' : 'ENTRY') + '_REQUEST'), { status: 400 });
      }
      await liveExecution.reconcile();
      const state = runtime.snapshot(), portfolio = liveExecution.portfolio();
      const trade = side === 'SELL' ? portfolio.trades.find(row => row.id === body.tradeId && row.side === 'BUY' && row.positionState === 'OPEN') : null;
      const token = side === 'SELL' ? trade?.token : body.token;
      if (side === 'SELL' && (!trade || !portfolio.positions.some(row => row.token === token && row.network === state.network && row.quantity > 0))) throw Object.assign(Error('OPEN_POSITION_NOT_FOUND'), { status: 409 });
      // Operator write-off: the chain has proven the exit impossible (no route
      // with the venue gone, or a zero on-chain balance). Second click after an
      // UNSELLABLE receipt closes the position out of the books with evidence.
      if (side === 'SELL' && body.writeOff === true) {
        const outcome = liveExecution.writeOff(token, 'Operator close-out after a proven impossible on-chain exit: ' + (body.evidence ?? []).join(' | ').slice(0, 280), body.evidence ?? []);
        return { submitted: true, mode: 'live', side: 'SELL', status: 'CLOSED_OUT', tradeId: body.tradeId, quantity: outcome.quantity, costBasis: outcome.costBasis, reason: outcome.message };
      }
      const events = state.events.filter(e => e.network === state.network && e.epoch === state.epoch);
      let quote = events.filter(e => e.type === 'MarketSnapshot' && e.payload.token === token).sort((a, b) => Date.parse(a.payload.observedAt) - Date.parse(b.payload.observedAt)).at(-1);
      const candidate = events.findLast(e => e.type === 'TokenCandidate' && e.payload.token === token);
      const regime = events.findLast(e => e.type === 'MarketRegimeState');
      // An aged-out position can have no market quote left in the journal window.
      // An operator exit still deserves a real, current observation: fetch one from
      // a public venue and publish it as ordinary MARKET_DATA evidence — never an
      // entry-basis guess. No venue answer → the operator is told, not faked.
      if (side === 'SELL' && !quote && trade) quote = await emergencyExitQuote(runtime, token, state.network, state.epoch, now, liveConfig?.fetcher);
      if (!quote || (side === 'BUY' && (!candidate || !regime))) return { submitted: false, mode: 'live', side, status: 'REJECTED', reason: 'LIVE_MARKET_EVIDENCE_MISSING', fillId: null, intentId: null, quantity: null };
      const id = 'manual-live/' + require('node:crypto').randomUUID();
      // The trace contract requires a resolvable candidateId. An aged-out position
      // may have neither a candidate nor a resolvable recorded one — the freshly
      // fetched exit quote is then the honest stand-in evidence anchor.
      const decisionCandidateId = candidate?.id ?? (trade?.candidateId && events.some(e => e.id === trade.candidateId) ? trade.candidateId : quote.id);
      runtime.publish({ id, type: 'StrategyDecision', timestamp: now().toISOString(), producer: 'CODEX_1', source: 'commander.manual-live-' + side.toLowerCase(),
        evidence: [quote.id, ...(trade ? [trade.id] : [candidate.id, regime.id])], status: 'APPROVED', correlationId: id, network: state.network, epoch: state.epoch,
        confidence: quote.confidence, evidence_quality: quote.evidence_quality, uncertainty: quote.uncertainty, missing_evidence: [],
        payload: { candidateId: decisionCandidateId, snapshotId: quote.id, signalIds: [], strategyVersion: 'meme-flow-v1', quantEvidenceIds: [], criticReportIds: [],
          ...(side === 'SELL' ? { sellPercent: body.percent } : {}),
          regimeId: regime?.id ?? trade.id, action: side, disposition: side === 'BUY' ? 'TRADE' : 'EXIT', reason: 'Operator requested LIVE ' + side + (side === 'SELL' ? ' of ' + body.percent + '% of the current position.' : ' within the live position cap.') + (quote.source?.includes('emergency-exit') ? '; quoted from a public venue for an aged-out position' : '') } });
      return { submitted: true, mode: 'live', side, ...(side === 'SELL' ? { percent: body.percent } : {}), decisionId: id };
    }).then(async result => {
      // A write-off close-out never enters the trade pipeline — its status is final.
      if (!result.submitted || result.status === 'CLOSED_OUT') return result;
      await runtime.flush();
      await liveExecution.drain();
      const events = runtime.snapshot().events.filter(e => e.correlationId === result.decisionId);
      const fill = events.find(e => e.type === 'TradeResult' && e.payload.mode === 'live');
      const risk = events.find(e => e.type === 'RiskDecision');
      const intent = events.find(e => e.type === 'ExecutionIntent');
      const failure = events.find(e => e.type === 'AIActivityEvent' && e.status === 'FAILED');
      const pending = liveExecution.status().pendingSignature;
      // A no-route/no-liquidity/no-balance failure is a definitive on-chain
      // verdict: surface it as UNSELLABLE so the operator can close the
      // position out of the books on the next click instead of retrying forever.
      const unsellable = !fill && !pending && failure && /NO_RO?UTES?_FOUND|NO_ROUTE\b|LIVE_PUMPFUN_UNAVAILABLE|LIVE_FULL_POSITION_SELL_REQUIRED|LIVE_POSITION_BALANCE_MISMATCH/.test(failure.payload.message);
      return { ...result, status: fill ? 'FILLED' : pending ? 'PENDING' : unsellable ? 'UNSELLABLE' : failure || risk?.payload.approved === false ? 'REJECTED' : 'PENDING',
        fillId: fill?.id ?? null, intentId: intent?.id ?? null, quantity: fill?.payload.quantity ?? null,
        ...(unsellable ? { writeOffAvailable: true, evidence: ['live execution: ' + failure.payload.message.slice(0, 260)] } : {}),
        reason: fill ? 'Live order filled.' : failure?.payload.message ?? risk?.payload.reason ?? 'Awaiting live pipeline receipt.' };
    });
  }
  return {
    journalPath,
    runtime, tradeStore, wallet, control, mode, workMeter, tokenIdentities,
    drainLive: () => liveExecution.drain(),
    createTradingWallet: confirm => serialize(async () => {
      if (liveExecution.isArmed()) throw Error('LIVE_WALLET_BUSY');
      await halt(); await liveExecution.drain();
      const result = liveExecution.createWallet(confirm); liveSession = true; return result;
    }),
    tradingBalance: async () => { await liveExecution.refreshBalance(); return liveExecution.status(); },
    withdrawalDestination: () => ({ network: runtime.status().network, destinationAddress: tradingSettings.getDestination(runtime.status().network) }),
    setWithdrawalDestination: (network, address) => serialize(() => tradingSettings.setDestination(network, address)),
    withdrawTo: (destinationAddress, amountSol) => liveExecution.withdrawTo(destinationAddress, amountSol),
    disarm: () => serialize(async () => { await halt(); liveSession = true; return control(); }),
    live: confirm => serialize(async () => {
      if (confirm !== 'LIVE_REAL_MONEY') throw Error('LIVE_CONFIRMATION_REQUIRED');
      await halt();
      liveSession = true;
      try { await liveExecution.arm(confirm); await refreshFunding(); resume(); }
      catch (error) { await halt(); throw error; }
      return control();
    }),
    paperCapital,
    paperWithdrawals: () => runtime.paperWithdrawals(),
    withdrawPaperSol: amountSol => serialize(() => {
      const state = control(), session = state.wallet.session;
      if (state.mode !== 'paper' || state.network !== 'SOLANA' || !state.wallet.connected || session?.network !== 'SOLANA') throw Object.assign(Error('Connect the main SOLANA wallet in paper mode first'), { status: 400 });
      const entry = runtime.withdrawSol({ amountSol, toWallet: session.address, at: now().toISOString(), epoch: state.epoch });
      withdrawalActivity(entry);
      return { mode: 'paper', entry, solBalance: Math.max(0, runtime.solAnchor().solBalance), withdrawnSol: runtime.paperWithdrawals().reduce((sum, row) => sum + row.amountSol, 0) };
    }),
    depositPaper: (amountUsd, note) => adjustPaper('deposit', amountUsd, note),
    withdrawPaper: (amountUsd, note) => adjustPaper('withdraw', amountUsd, note),
    // Serialize operator exits with STOP/network changes; never restart the scanner.
    sellPaper: body => serialize(() => { if (liveSession) throw Error('LIVE_PAPER_CONTROLS_DISABLED'); return require('../services/commander/manual-exit.cjs').executeManualExit({ runtime, tradeStore, now }, body); }),
    buyPaper: body => serialize(() => { if (liveSession) throw Error('LIVE_PAPER_CONTROLS_DISABLED'); return require('../services/commander/manual-entry.cjs').executeManualEntry({ runtime, tradeStore, now }, body); }),
    sellLive: body => manualLive('SELL', body),
    buyLive: body => manualLive('BUY', body),
    newlyCreated:()=>sources[runtime.status().network]?.newlyCreated?.() ?? [],
    takeProfitMultiple:network=>tradingSettings.get(network),
    setTakeProfit:multiple=>serialize(async()=>{tradingSettings.set(runtime.status().network,multiple);return control();}),
    start: () => serialize(async () => {
      if (!liveSession && !wallet.isConnected()) throw Error('WALLET_CONNECTION_REQUIRED');
      if (!sources[runtime.status().network]) throw Error('NETWORK_PROVIDER_UNVERIFIED');
      if (!running) {
        // Acquisition can run while capital is unavailable. The existing funding gate still prevents unfunded paper orders.
        try { resume(); refreshFunding().catch(() => {}); }
        catch (error) { await halt(); throw error; }
      }
      return control();
    }),
    stop: () => serialize(async () => { await halt(); return control(); }),
    connect: input => serialize(async () => { await halt(); wallet.connect(input); rememberSession(); await refreshFunding().catch(() => {}); return control(); }),
    disconnect: () => serialize(async () => { await halt(); wallet.disconnect(); rememberSession(); return control(); }),
    followWallet: input => serialize(async () => {
      if (!wallet.isConnected()) throw Error('WALLET_CONNECTION_REQUIRED');
      const wasRunning = running;
      await halt();
      try {
        const session = getNetworkAdapter(input?.network).validateSession(input);
        runtime.selectNetwork(session.network); wallet.selectNetwork(session.network);
        wallet.connect(session); lastScan = null; lastError = null; rememberSession();
        await refreshFunding().catch(() => {}); if (wasRunning && !fundingError) resume();
      } catch (error) {
        await halt(); wallet.disconnect(); rememberSession(); lastError = 'WALLET_NETWORK_UNVERIFIED'; throw error;
      }
      return control();
    }),
    selectNetwork: network => serialize(async () => {
      getNetworkAdapter(network); await halt(); runtime.selectNetwork(network); wallet.selectNetwork(network); rememberSession(); fundingError=null; lastScan = null; lastError = null; if(wallet.isConnected())refreshFunding().catch(()=>{}); return control();
    }),
    close: () => serialize(async () => { clearInterval(fundingTimer); detachIdentity(); tokenIdentities.close(); try { await halt(false); await liveExecution.drain(); } finally { closed = true; await runtime.close(); } })
  };
}
module.exports = { createApplication };
