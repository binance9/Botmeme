'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const bs58 = require('bs58'), nacl = require('tweetnacl');
const { VersionedTransaction, TransactionMessage, SystemProgram, PublicKey } = require('@solana/web3.js');
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const PRIORITY_FEE_MAX_LAMPORTS = 200000;
const REMOTE_FAIL_COOLDOWN_MS = 10 * 60000;
const INTENT_MAX_AGE_MS = 180000;
const MAX_CONCURRENT_SWAPS = 3;
function createLiveExecution({ runtime, tradeStore, now = () => new Date(), config = {} }) {
  const root = config.root ?? path.resolve(__dirname, '../..'), keyFile = path.join(root, 'wallet-key.env'), killFile = path.join(root, 'LIVE_KILL');
  const ledgerFile = path.join(root, 'live-state.json'), fetcher = config.fetcher ?? fetch;
  const { readKey, createKey } = require('./wallet-key.cjs');
  let owner = config.owner ?? null;
  try { const bytes = readKey(keyFile); try { const pair = nacl.sign.keyPair.fromSeed(bytes.subarray(0, 32)); try { if (bytes.length === 64 && Buffer.from(pair.secretKey).equals(bytes)) owner ??= bs58.encode(pair.publicKey); } finally { pair.secretKey.fill(0); } } finally { bytes.fill(0); } } catch {}
  const env = config.env ?? process.env;
  const caps = { position: Number(env.TRADING_MAX_POSITION_USD ?? 2), loss: Number(env.TRADING_MAX_DAILY_LOSS_USD ?? 5), reserve: Number(env.TRADING_MIN_SOL_RESERVE ?? .01) };
  const base = config.jupiterUrl ?? (env.JUPITER_API_KEY ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1');
  let ledger = { version: 1, owner, pending: null, fills: [], claimed: [] }, corrupt = false;
  try { if (fs.existsSync(ledgerFile)) { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); if (ledger.version !== 1 || ledger.owner !== owner || !Array.isArray(ledger.fills) || !Array.isArray(ledger.claimed) || ledger.claimed.some(id => typeof id !== 'string')) throw Error(); for (const fill of ledger.fills) { require('../../runtime/contracts/index.cjs').validateEvent(fill, { now }); if (fill.payload.mode !== 'live') throw Error(); } } } catch { corrupt = true; }
  let armed = false, detach = null, generation = 0, beforeArm = new Set(), balanceSol = null, balanceAt = null, timer = null;
  try {
    if (ledger.pendingOthers !== undefined && !Array.isArray(ledger.pendingOthers)) throw Error();
    const pending = [ledger.pending, ...(ledger.pendingOthers ?? [])].filter(Boolean);
    if ((!ledger.pending && pending.length) || pending.some(p => typeof p.signature !== 'string' || !p.signature) || new Set(pending.map(p => p.signature)).size !== pending.length) throw Error();
    if (ledger.reconciliations !== undefined && !Array.isArray(ledger.reconciliations)) throw Error();
    for (const entry of ledger.reconciliations ?? []) {
      require('../../runtime/contracts/index.cjs').validateEvent(entry.event, { now });
      if (entry.event.producer !== 'LIVE_EXECUTION' || entry.event.evidence[0] !== entry.pending.signature) throw Error();
    }
    if (ledger.withdrawals !== undefined && !Array.isArray(ledger.withdrawals)) throw Error();
    for (const entry of ledger.withdrawals ?? []) {
      require('../../runtime/contracts/index.cjs').validateEvent(entry.event, { now });
      if (entry.event.producer !== 'LIVE_EXECUTION' || entry.event.payload.task !== 'withdraw' || entry.event.evidence[0] !== entry.signature) throw Error();
    }
    if (ledger.closeouts !== undefined && (!Array.isArray(ledger.closeouts) || ledger.closeouts.some(c => typeof c?.token !== 'string' || !Number.isFinite(c.quantity) || c.quantity <= 0 || !Number.isFinite(c.costBasis) || c.costBasis < 0 || !Number.isFinite(c.averageCost) || c.averageCost < 0 || typeof c.at !== 'string' || typeof c.reason !== 'string' || !Array.isArray(c.evidence) || c.evidence.some(x => typeof x !== 'string' || !x.trim())))) throw Error();
  } catch { corrupt = true; }
  const remoteFailCooldowns = new Map();
  const simulationFailTokens = new Set();
  try {
    if (ledger.simulationFailTokens !== undefined && (!Array.isArray(ledger.simulationFailTokens) || ledger.simulationFailTokens.some(token => typeof token !== 'string'))) throw Error();
    for (const token of ledger.simulationFailTokens ?? []) simulationFailTokens.add(token);
    if (ledger.jupiterNoRouteCooldowns !== undefined && (!ledger.jupiterNoRouteCooldowns || typeof ledger.jupiterNoRouteCooldowns !== 'object' || Array.isArray(ledger.jupiterNoRouteCooldowns))) throw Error();
    // Ignore legacy transient failures; persist no-route and fresh simulation cooldowns.
    for (const [token, retryAfterMs] of Object.entries(ledger.jupiterNoRouteCooldowns ?? {})) {
      if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) throw Error();
      remoteFailCooldowns.set(token, retryAfterMs);
    }
  } catch { corrupt = true; }
  const queued = new Set(), awaitingSafety = new Map(), reservedTokens = new Set();
  const jobs = [], running = new Set(), activeSignatures = new Set(), reservedFunds = new Map();
  let inFlight = 0, reconciliation = null, exclusive = false;
  // Keep the legacy primary pending record; preserve every additional signed swap.
  // Only signatures still being confirmed by this process may bypass the lock.
  const pendingTransactions = () => [ledger.pending, ...(ledger.pendingOthers ?? [])].filter(Boolean);
  const otherFunds = intentId => [...reservedFunds].reduce((sum, [key, value]) => sum + (key === intentId ? 0 : value), 0);
  function addPending(pending) {
    if (ledger.pending) (ledger.pendingOthers ??= []).push(pending);
    else ledger.pending = pending;
    activeSignatures.add(pending.signature);
    save();
  }
  function clearPending(signature) {
    activeSignatures.delete(signature);
    const remaining = pendingTransactions().filter(p => p.signature !== signature);
    ledger.pending = remaining.shift() ?? null;
    ledger.pendingOthers = remaining;
    save();
  }
  function pumpQueue() {
    if (exclusive) return;
    while (running.size < MAX_CONCURRENT_SWAPS && jobs.length) {
      // Withdrawals form an exclusive barrier. Otherwise pick the oldest free token.
      const barrier = jobs.findIndex(job => job.token === null);
      const index = jobs.findIndex((job, i) => (barrier < 0 || i <= barrier) && (job.token === null ? running.size === 0 && i === 0 : !reservedTokens.has(job.token)));
      if (index < 0) return;
      const job = jobs.splice(index, 1)[0];
      if (job.token === null) exclusive = true;
      else reservedTokens.add(job.token);
      const work = Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        running.delete(work);
        if (job.token === null) exclusive = false;
        else reservedTokens.delete(job.token);
        pumpQueue();
      });
      running.add(work);
      if (exclusive) return;
    }
  }
  function enqueue(token, run) {
    return new Promise((resolve, reject) => { jobs.push({ token, run, resolve, reject }); pumpQueue(); });
  }
  async function drain() { while (running.size || jobs.length) await Promise.all([...running]); }
  const fail = code => { throw Object.assign(Error(code), { status: 409 }); };
  const id = (intent, suffix) => 'live.' + suffix + '/' + createHash('sha256').update(intent.id).digest('hex');
  const save = () => { ledger.jupiterNoRouteCooldowns = Object.fromEntries(remoteFailCooldowns); ledger.simulationFailTokens = [...simulationFailTokens]; delete ledger.remoteFailCooldowns; fs.writeFileSync(ledgerFile + '.tmp', JSON.stringify(ledger), { mode: 0o600, flush: true }); fs.renameSync(ledgerFile + '.tmp', ledgerFile); };
  const remoteCoolingDown = token => (remoteFailCooldowns.get(token) ?? 0) > now().getTime();
  function event(intent, suffix, type, payload, evidence = [], status = 'COMPLETED') {
    const state = runtime.status();
    return { id: intent ? id(intent, suffix) : 'live.control/' + randomUUID(), type, timestamp: now().toISOString(), producer: 'LIVE_EXECUTION', source: 'live.jupiter', evidence: intent ? [intent.id, intent.payload.riskDecisionId, ...evidence] : ['live.control'], status, correlationId: intent?.correlationId ?? 'live.control', network: intent?.network ?? state.network, epoch: intent?.epoch ?? state.epoch, confidence: 1, evidence_quality: 1, uncertainty: 0, missing_evidence: [], payload };
  }
  function activity(message, intent = null, suffix = 'failure', state = 'FAILED', evidence = []) {
    const e = event(intent, suffix, 'AIActivityEvent', { agent: 'LIVE_EXECUTION', task: intent?.id ?? 'live.control', state, progress: null, message }, evidence, state === 'FAILED' ? 'FAILED' : 'COMPLETED');
    if (!runtime.get(e.id)) runtime.publish(e);
  }
  function keypair() {
    if (!fs.existsSync(keyFile)) fail('LIVE LOCKED: wallet-key.env missing');
    let bytes;
    try {
      bytes = readKey(keyFile);
      if (bytes.length !== 64) throw Error();
      const pair = nacl.sign.keyPair.fromSeed(bytes.slice(0, 32));
      if (!Buffer.from(pair.secretKey).equals(Buffer.from(bytes)) || bs58.encode(pair.publicKey) !== owner) { pair.secretKey.fill(0); throw Error(); }
      return pair;
    } catch { fail('LIVE LOCKED: wallet-key.env invalid or wallet mismatch'); }
    finally { bytes?.fill(0); }
  }
  function gate() {
    if (corrupt) fail('LIVE LOCKED: ledger invalid');
    if (!Object.values(caps).every(v => Number.isFinite(v) && v > 0)) fail('LIVE LOCKED: invalid caps');
    if (fs.existsSync(killFile)) fail('LIVE_KILL: trading halted');
    if (pendingTransactions().some(p => !activeSignatures.has(p.signature))) fail('LIVE LOCKED: transaction reconciliation required');
    const today = now().toISOString().slice(0, 10);
    const loss = ledger.fills.filter(e => e.timestamp.startsWith(today)).reduce((sum, e) => sum + (e.payload.side === 'BUY' ? e.payload.fees : Math.max(0, -e.payload.realizedPnl)), 0);
    if (loss >= caps.loss) fail('LIVE_DAILY_LOSS_CAP');
  }
  function check(ticket) {
    if (!armed || ticket !== generation) fail('LIVE_STOPPED');
    gate();
    const pair = keypair(); pair.secretKey.fill(0);
  }
  async function json(url, options = {}, timeoutMs = 12000) {
    try {
      const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
      if (!response.ok || response.redirected) throw Error();
      return await response.json();
    } catch { fail('LIVE_REMOTE_UNAVAILABLE'); }
  }
  async function rpc(method, params, timeoutMs) {
    const endpoints = [...new Set([env.RPC_HTTP_ENDPOINT, config.rpcUrl, 'https://api.mainnet-beta.solana.com'].flat().filter(url => typeof url === 'string' && url.trim()))];
    // These calls are reads/simulations, or submit the exact same signed bytes.
    const retryable = ['getGenesisHash', 'getBalance', 'getTokenSupply', 'getTokenAccountsByOwner', 'getSignatureStatuses', 'getFeeForMessage', 'getTransaction', 'getLatestBlockhash', 'getAccountInfo', 'simulateTransaction', 'sendTransaction'].includes(method);
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) };
    let detail = '';
    for (const url of retryable ? endpoints : endpoints.slice(0, 1)) {
      try {
        const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeoutMs ?? 12000)) });
        if (!response.ok || response.redirected) { detail = `HTTP ${response.status} ${url.includes('helius') ? 'helius' : url.includes('mainnet-beta') ? 'mainnet-beta' : 'rpc'}`; continue; }
        const body = await response.json().catch(() => null);
        if (!body || body.error || !Object.hasOwn(body, 'result') || body.result === undefined) { detail = body?.error ? String(body.error.message ?? JSON.stringify(body.error)).slice(0, 300) : 'no result'; continue; }
        if (method === 'sendTransaction' && (typeof body.result !== 'string' || !body.result)) { detail = 'empty send result'; continue; }
        // Null is a valid read result (for example, a transaction not yet found).
        return body.result;
      } catch (error) {
        const timeout = ['TimeoutError', 'AbortError'].includes(error?.name) || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error?.cause?.code ?? error?.code);
        detail = timeout ? `timeout after ${timeoutMs ?? 12000}ms` : String(error?.cause?.code ?? error?.message ?? 'fetch failed').slice(0, 200);
      }
    }
    // Public RPC error text only (no keys, no transaction bytes) — same precedent
    // as balance-debug.log; without it a 250ms submit failure is undiagnosable.
    try { fs.appendFileSync(path.join(root, 'runtime', 'rpc-debug.log'), now().toISOString() + ' ' + method + ' ' + detail + '\n'); } catch {}
    fail('LIVE_RPC_FAILED');
  }
  async function jupiterJson(url, options, timeoutMs = 12000) {
    let response, body = '';
    const noRoute = value => /TOKEN_NOT_TRADABLE|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTES_FOUND|no routes? found|could not find any route/i.test(value);
    const remoteError = (detail, extra = {}) => Object.assign(Error('LIVE_REMOTE_UNAVAILABLE: ' + detail), { publicDiagnostic: true, ...extra });
    try {
      response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      // Read text first so malformed JSON cannot discard the public HTTP response.
      body = await response.text();
      const diagnostic = `HTTP ${response.status} ${body.slice(0, 120)}`;
      if (response.status !== 200 || response.redirected) throw remoteError(diagnostic, { httpStatus: response.status, noRoute: [400, 422].includes(response.status) && noRoute(body) });
      let value;
      try { value = JSON.parse(body); } catch { throw remoteError(diagnostic); }
      if (value && (noRoute(JSON.stringify(value)) || (Array.isArray(value.routePlan) && !value.routePlan.length))) throw remoteError(diagnostic + ' LIVE_NO_ROUTE', { noRoute: true });
      if (value?.error || value?.errorCode) throw remoteError(diagnostic);
      return value;
    } catch (error) {
      if (error.publicDiagnostic) throw error;
      const timeout = ['TimeoutError', 'AbortError'].includes(error?.name) || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error?.cause?.code ?? error?.code);
      throw remoteError(`${response ? `HTTP ${response.status} ${body.slice(0, 120)} ` : ''}${timeout ? `timeout after ${timeoutMs}ms` : 'response unavailable'}`, { timeout });
    }
  }
  function reconcilePending() {
    if (corrupt) fail('LIVE LOCKED: ledger invalid');
    if (!ledger.pending) return Promise.resolve();
    if (inFlight) fail('LIVE LOCKED: transaction reconciliation required');
    if (reconciliation) return reconciliation;
    reconciliation = (async () => {
      for (const pending of pendingTransactions()) {
        if (typeof pending.signature !== 'string' || !pending.signature) fail('LIVE LOCKED: transaction reconciliation required');
        const statuses = await rpc('getSignatureStatuses', [[pending.signature], { searchTransactionHistory: true }]);
        if (!Array.isArray(statuses?.value) || statuses.value.length !== 1) fail('LIVE_RPC_FAILED');
        const status = statuses.value[0];
        const confirmed = status?.err == null && ['confirmed', 'finalized'].includes(status?.confirmationStatus);
        if (status !== null && !status?.err && !confirmed) fail('LIVE LOCKED: transaction reconciliation required');
        if (inFlight || !pendingTransactions().includes(pending)) fail('LIVE LOCKED: transaction reconciliation required');
        const message = confirmed ? 'Giao dịch treo đã xác nhận trên chain' : 'Đã đối soát: giao dịch treo không lên chain — mở khóa';
        const audit = event(null, 'reconciled', 'AIActivityEvent', { agent: 'LIVE_EXECUTION', task: pending.intentId ?? 'withdraw', state: 'COMPLETED', progress: null, message });
        audit.evidence = [pending.signature];
        // Persist the resolution with the unlock, so a restart can replay the audit.
        if (confirmed && !ledger.claimed.includes(pending.intentId ?? pending.signature)) ledger.claimed.push(pending.intentId ?? pending.signature);
        (ledger.reconciliations ??= []).push({ pending, outcome: confirmed ? 'confirmed' : status === null ? 'not-found' : 'failed', event: audit });
        clearPending(pending.signature);
        if (!runtime.get(audit.id)) runtime.publish(audit);
      }
    })().finally(() => { reconciliation = null; });
    return reconciliation;
  }
  async function refreshBalance() {
    try { const result = await rpc('getBalance', [owner, { commitment: 'confirmed' }]); if (!Number.isSafeInteger(result?.value) || result.value < 0) throw Error(); balanceSol = result.value / 1e9; balanceAt = now().toISOString(); return result.value; }
    catch (error) { balanceSol = null; balanceAt = null; fail(error.message === 'LIVE_RPC_FAILED' ? 'LIVE_RPC_FAILED' : 'LIVE_BALANCE_UNAVAILABLE'); }
  }
  function price() {
    const hash = createHash('sha256').update('SOLANA:' + owner).digest('hex');
    const quote = runtime.snapshot().events.findLast(e => e.type === 'WalletValuation' && e.network === 'SOLANA' && e.payload.accountHash === hash);
    if (!quote || ![quote.timestamp, quote.payload.priceAt].every(at => now().getTime() - Date.parse(at) >= 0 && now().getTime() - Date.parse(at) <= 60000) || !(quote.payload.priceUsd > 0)) fail('LIVE_SOL_PRICE_STALE');
    return quote.payload.priceUsd;
  }
  function positions() {
    const rows = new Map();
    for (const e of ledger.fills) {
      const p = e.payload, row = rows.get(p.token) ?? { network: 'SOLANA', token: p.token, quantity: 0, costBasis: 0 };
      if (p.side === 'BUY') { row.quantity += p.quantity; row.costBasis += p.quantity * p.entryPrice + p.fees; }
      else { row.costBasis *= Math.max(0, 1 - p.quantity / row.quantity); row.quantity = Math.max(0, row.quantity - p.quantity); }
      row.averageCost = row.quantity ? row.costBasis / row.quantity : 0; row.lastFillId = e.id; rows.set(p.token, row);
    }
    // Operator close-outs subtract proven-unsellable remains (no route, no
    // liquidity, or an on-chain balance of zero) so no phantom row lingers.
    for (const c of ledger.closeouts ?? []) {
      const row = rows.get(c.token);
      if (!row || row.quantity <= 0) continue;
      row.costBasis *= Math.max(0, 1 - Math.min(c.quantity, row.quantity) / row.quantity);
      row.quantity = Math.max(0, row.quantity - c.quantity);
      row.averageCost = row.quantity ? row.costBasis / row.quantity : 0;
    }
    return [...rows.values()].filter(p => p.quantity > 0);
  }
  async function execute(intent, ticket, signal) {
    if (beforeArm.has(intent.id) || ledger.claimed.includes(intent.id) || runtime.get(id(intent, 'failure')) || runtime.snapshot().events.some(e => e.type === 'TradeResult' && e.payload.intentId === intent.id)) return;
    let pair;
    const capDetails = {};
    const capFail = (code, stage) => {
      // Only explicit numeric fields and constant source labels; never serialize RPCs, env or keys.
      const detail = JSON.stringify({ stage, ...capDetails }, (_, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value);
      throw Object.assign(Error(code + ': ' + detail), { publicDiagnostic: true });
    };
    inFlight++;
    try {
      check(ticket); if (signal?.aborted) fail('LIVE_STOPPED');
      const p = intent.payload, state = runtime.status(), risk = runtime.get(p.riskDecisionId), quote = runtime.get(p.snapshotId), decision = runtime.get(p.decisionId);
      if (intent.network !== 'SOLANA' || state.network !== 'SOLANA' || intent.epoch !== state.epoch) fail('LIVE_NETWORK_MISMATCH');
      if (p.mode !== 'live') fail('LIVE_PAPER_ONLY_INTENT');
      if (!['BUY', 'SELL'].includes(p.action)) fail('LIVE_ACTION_UNSUPPORTED');
      if (decision?.source?.startsWith('commander.manual-paper')) fail('LIVE_PAPER_ONLY_INTENT');
      if (now().getTime() - Date.parse(intent.timestamp) < 0 || now().getTime() - Date.parse(intent.timestamp) > INTENT_MAX_AGE_MS) fail('LIVE_INTENT_EXPIRED');
      // The evidence paired with an intent must survive the same queue window.
      if (!risk?.payload.approved || risk.payload.decisionId !== p.decisionId || (p.action !== 'BUY' && p.quantity > risk.payload.quantity) || now().getTime() - Date.parse(risk.timestamp) > INTENT_MAX_AGE_MS) fail('LIVE_RISK_REJECTED');
      // Operator exits accept the executable market quote; journal age is not a price limit.
      const manualExit = p.action === 'SELL' && decision?.payload.action === 'SELL' && decision.producer === 'CODEX_1' && decision.source === 'commander.manual-live-sell';
      if (!quote || (!manualExit && now().getTime() - Date.parse(quote.payload.observedAt) > INTENT_MAX_AGE_MS) || quote.missing_evidence.length || quote.evidence_quality < .7) fail('LIVE_QUOTE_STALE');
      if (p.action === 'BUY' && simulationFailTokens.has(p.token) && remoteCoolingDown(p.token)) fail('LIVE_REMOTE_FAIL_COOLDOWN');
      const events = runtime.snapshot().events.filter(e => e.network === intent.network && e.epoch === intent.epoch);
      if (manualExit && events.findLast(e => e.type === 'SafetyDecision' && e.payload.candidateId === p.candidateId)?.payload.approved === false) fail('LIVE_SAFETY_REJECTED');
      if (p.action === 'BUY') {
        const safety = events.findLast(e => e.type === 'SafetyDecision' && e.payload.candidateId === p.candidateId);
        if (!safety?.payload.approved) fail('LIVE_SAFETY_REJECTED');
        if (events.findLast(e => e.type === 'JevVerdict' && e.payload.candidateId === p.candidateId)?.payload.action === 'REJECT') fail('LIVE_JEV_REJECTED');
        if (events.findLast(e => e.type === 'StrategyLifecycleDecision' && e.payload.strategyVersion === p.strategyVersion)?.payload.stage === 'DISABLED') fail('LIVE_STRATEGY_DISABLED');
      }
      new PublicKey(p.token); if (p.token === SOL) fail('LIVE_INVALID_TOKEN');
      const usd = price(), requestedBudget = p.quantity * p.referencePrice, position = positions().find(row => row.token === p.token);
      // Owner directive (live test-buys): reference-price drift and over-budget requests only REDUCE sizing to
      // min(requestedBudget, risk exposure, owner cap) — they never reject an intent the risk engine approved.
      const numeric = value => typeof value === 'number' ? value : typeof value;
      Object.assign(capDetails, { intentQuantity: numeric(p.quantity), referencePrice: numeric(p.referencePrice), requestedBudget: numeric(requestedBudget), riskQuantity: numeric(risk.payload.quantity), maxExposureUsd: numeric(risk.payload.maxExposureUsd), snapshotPrice: numeric(quote.payload.price), positionCapUsd: caps.position, solPriceUsd: usd, referencePriceSource: 'ExecutionIntent.referencePrice', sizingPriceSource: 'MarketSnapshot.price', solPriceSource: 'WalletValuation.priceUsd' });
      if (p.action === 'BUY' && ![p.quantity, p.referencePrice, requestedBudget, risk.payload.quantity, risk.payload.maxExposureUsd, quote.payload.price].every(value => Number.isFinite(value) && value > 0)) capFail('LIVE_POSITION_CAP_FIELDS', 'inputs');
      const budget = p.action === 'BUY' ? Math.min(requestedBudget, risk.payload.maxExposureUsd, caps.position) : requestedBudget;
      let orderQuantity = p.action === 'BUY' ? Math.min(budget / quote.payload.price, risk.payload.quantity) : p.quantity;
      Object.assign(capDetails, { budget, orderQuantity });
      if (!Number.isFinite(orderQuantity) || orderQuantity <= 0) capFail('LIVE_POSITION_CAP_SIZE', 'division');
      if (p.action === 'BUY' && position) fail('LIVE_POSITION_ALREADY_OPEN');
      if (await rpc('getGenesisHash', []) !== MAINNET) fail('LIVE_NETWORK_MISMATCH');
      const balance = await refreshBalance();
      let amount, decimals;
      if (p.action === 'BUY') {
        decimals = (await rpc('getTokenSupply', [p.token, { commitment: 'confirmed' }])).value?.decimals;
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) fail('LIVE_TOKEN_BALANCE_INVALID');
        capDetails.quantityBeforeFloor = orderQuantity;
        orderQuantity = Math.floor(orderQuantity * 10 ** decimals) / 10 ** decimals;
        Object.assign(capDetails, { decimals, decimalsSource: 'getTokenSupply.value.decimals', balanceLamports: balance, balanceSource: 'getBalance confirmed', orderQuantity });
        if (!Number.isFinite(orderQuantity) || orderQuantity <= 0) capFail('LIVE_POSITION_CAP_SIZE', 'decimals-floor');
        // Leave rent/fee headroom inside the USD cap, plus a 1% quote buffer.
        amount = Math.floor((Math.min(orderQuantity * quote.payload.price / usd * 1e9, balance - otherFunds(intent.id) - caps.reserve * 1e9) - 2500000) / 1.01);
        if (!Number.isSafeInteger(amount) || amount <= 0) capFail('LIVE_RESERVE_OR_FEE_BUFFER', 'budget-headroom');
        reservedFunds.set(intent.id, Math.ceil(amount * 1.01 + 2500000));
      } else {
        if (!position || position.quantity <= 0) fail('LIVE_FULL_POSITION_SELL_REQUIRED');
        if (p.quantity > position.quantity + 1e-10) fail('LIVE_POSITION_QUANTITY_CHANGED');
        const accounts = await Promise.all(TOKEN_PROGRAMS.map(programId => rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])));
        if (accounts.some(result => !Array.isArray(result?.value))) fail('LIVE_TOKEN_BALANCE_INVALID');
        // jsonParsed tokenAmount has the same amount/decimals shape as receipt
        // uiTokenAmount. Do not decode fixed account layouts or add withheld fees.
        const amounts = accounts.flatMap(result => result.value)
          .map(a => a.account?.data?.parsed?.info).filter(info => info?.mint === p.token)
          .map(info => info.tokenAmount);
        if (!amounts.length) fail('LIVE_FULL_POSITION_SELL_REQUIRED');
        decimals = amounts[0]?.decimals;
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || amounts.some(a => a?.decimals !== decimals || typeof a.amount !== 'string' || !/^\d+$/.test(a.amount))) fail('LIVE_TOKEN_BALANCE_INVALID');
        const total = amounts.reduce((sum, a) => sum + BigInt(a.amount), 0n);
        if (total === 0n) fail('LIVE_FULL_POSITION_SELL_REQUIRED');
        amount = Number(total);
        if (!Number.isSafeInteger(amount) || amount <= 0 || Math.abs(amount / 10 ** decimals - position.quantity) > 1e-10) fail('LIVE_POSITION_BALANCE_MISMATCH');
        if (p.quantity !== position.quantity) amount = Math.min(amount, Math.floor(p.quantity * 10 ** decimals + 1e-8));
        if (amount <= 0) fail('LIVE_SELL_QUANTITY_TOO_SMALL');
        orderQuantity = amount / 10 ** decimals;
      }
      check(ticket);
      const inputMint = p.action === 'BUY' ? SOL : p.token, outputMint = p.action === 'BUY' ? p.token : SOL;
      const headers = { 'content-type': 'application/json', ...(env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : {}) };
      let q, tx, pump;
      async function buildTransaction() {
        // A reduced Pump order already includes the route's rent headroom.
        if (pump) {
          pump = await require('./pumpfun.cjs').buildPumpfun({ rpc, mint: p.token, owner, side: p.action, amount });
          tx = pump.tx;
          return;
        }
        try {
          if (remoteCoolingDown(p.token)) fail('LIVE_JUPITER_NO_ROUTE_COOLDOWN');
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              q = await jupiterJson(base + '/quote?' + new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: '100', swapMode: 'ExactIn' }), { headers }, 3000);
              break;
            } catch (error) {
              if (attempt || !(error.httpStatus === 429 || error.timeout)) throw error;
              activity(error.message + '; retry in 1500ms', intent, 'jupiter-retry', 'RUNNING');
              await new Promise(resolve => setTimeout(resolve, 1500));
              check(ticket); if (signal?.aborted) fail('LIVE_STOPPED');
            }
          }
          if (!q || q.inputMint !== inputMint || q.outputMint !== outputMint || q.inAmount !== String(amount) || q.swapMode !== 'ExactIn' || q.slippageBps !== 100 || !/^\d+$/.test(q.outAmount) || BigInt(q.outAmount) <= 0n) fail('LIVE_QUOTE_INVALID');
          remoteFailCooldowns.delete(p.token);
          simulationFailTokens.delete(p.token);
          check(ticket); if (signal?.aborted) fail('LIVE_STOPPED');
          const swap = await jupiterJson(base + '/swap', { method: 'POST', headers, body: JSON.stringify({ quoteResponse: q, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: 'veryHigh', maxLamports: PRIORITY_FEE_MAX_LAMPORTS } } }) });
          try { tx = VersionedTransaction.deserialize(Buffer.from(swap?.swapTransaction, 'base64')); } catch { fail('LIVE_SWAP_INVALID'); }
        } catch (error) {
          check(ticket); if (signal?.aborted) fail('LIVE_STOPPED');
          if (error.noRoute) { simulationFailTokens.delete(p.token); remoteFailCooldowns.set(p.token, now().getTime() + REMOTE_FAIL_COOLDOWN_MS); save(); }
          const reason = error.publicDiagnostic || /^LIVE_[A-Z_]+$/.test(error.message) ? error.message : 'LIVE_REMOTE_UNAVAILABLE';
          activity(reason + '; trying pumpfun', intent, 'jupiter-fallback', 'RUNNING');
          try {
            // Pump may create an ATA, creator vault and volume accumulator. Keep
            // 5m lamports total rent/fee headroom within the same owner budget.
            if (p.action === 'BUY') { amount -= 2500000; if (amount <= 0) fail('LIVE_RESERVE_OR_FEE_BUFFER'); }
              pump = await require('./pumpfun.cjs').buildPumpfun({ rpc, mint: p.token, owner, side: p.action, amount });
              tx = pump.tx;
          } catch (pumpError) {
              check(ticket); if (signal?.aborted) fail('LIVE_STOPPED');
              const pumpReason = /^LIVE_[A-Z_]+$/.test(pumpError.message) ? pumpError.message : 'LIVE_PUMPFUN_UNAVAILABLE';
              const detail = /^[a-zA-Z0-9_.-]{1,100}$/.test(pumpError.pumpCause ?? '') ? ': ' + pumpError.pumpCause : ': unexpected-builder-error';
              throw Object.assign(Error(`Jupiter: ${reason}; pumpfun: ${pumpReason}${detail}`), { publicDiagnostic: true });
          }
        }
      }
      let fee, after;
      for (let reductionAttempt = 0; reductionAttempt < 2; reductionAttempt++) {
        check(ticket); if (signal?.aborted) fail('LIVE_STOPPED');
        await buildTransaction();
        check(ticket);
        activity(pump ? 'route: pumpfun bonding curve' : 'route: jupiter', intent, 'route', 'RUNNING');
        if (tx.message.header.numRequiredSignatures !== 1 || tx.message.staticAccountKeys[0].toBase58() !== owner) fail('LIVE_SIGNER_MISMATCH');
        // Only Jupiter's route and its normal setup programs may be top-level instructions.
        const allowed = new Set(['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'ComputeBudget111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', ...TOKEN_PROGRAMS, '11111111111111111111111111111111']);
        if (pump) allowed.add(require('./pumpfun.cjs').PROGRAM.toBase58());
        for (const ix of tx.message.compiledInstructions) if (!allowed.has(tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58())) fail('LIVE_TRANSACTION_PROGRAM_REJECTED');
        fee = (await rpc('getFeeForMessage', [Buffer.from(tx.message.serialize()).toString('base64'), { commitment: 'confirmed' }])).value;
        if (!Number.isSafeInteger(fee) || fee < 0) fail('LIVE_FEE_UNAVAILABLE');
        const simulation = (await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [owner] } }])).value;
        after = simulation?.accounts?.[0]?.lamports;
        if (simulation?.err || !Number.isSafeInteger(after)) {
          if (p.action === 'BUY' && quote.payload.poolAgeMs >= 60000 && quote.payload.poolAgeMs <= 30 * 60000) {
            remoteFailCooldowns.set(p.token, now().getTime() + REMOTE_FAIL_COOLDOWN_MS);
            simulationFailTokens.add(p.token); save();
          }
          fail('LIVE_SIMULATION_FAILED');
        }
        if (after - fee < Math.ceil(caps.reserve * 1e9)) fail('LIVE_SOL_RESERVE');
        // Fees and 100bps slippage legitimately push realized spend slightly over the nominal budget.
        Object.assign(capDetails, { amountLamports: amount, route: pump ? 'pumpfun' : 'jupiter', afterLamports: after, afterSource: 'simulateTransaction.accounts[0].lamports', feeLamports: fee, feeSource: 'getFeeForMessage', spendUsd: (balance - after + fee) / 1e9 * usd, allowedSpendUsd: Math.min(caps.position, budget, risk.payload.maxExposureUsd) * 1.05, otherReservedLamports: otherFunds(intent.id) });
        if (p.action === 'BUY' && capDetails.spendUsd > capDetails.allowedSpendUsd) {
          if (reductionAttempt || capDetails.spendUsd > capDetails.allowedSpendUsd * 1.5) capFail('LIVE_POSITION_CAP_BALANCE', 'simulation-balance');
          const reducedAmount = Math.floor(amount * (capDetails.allowedSpendUsd / capDetails.spendUsd));
          Object.assign(capDetails, { reducedFrom: amount / 1e9 * usd, reducedTo: reducedAmount / 1e9 * usd });
          if (!Number.isSafeInteger(reducedAmount) || reducedAmount <= 0 || reducedAmount >= amount) capFail('LIVE_POSITION_CAP_BALANCE', 'simulation-balance');
          // Reduce the final amount computed after getTokenSupply/decimals flooring;
          // never recompute from the original quantity and undo this adjustment.
          amount = reducedAmount;
          continue;
        }
        if (capDetails.reducedFrom !== undefined) activity(`giảm size theo impact: ${capDetails.reducedFrom} -> ${capDetails.reducedTo} USD; ${JSON.stringify({ reducedFrom: capDetails.reducedFrom, reducedTo: capDetails.reducedTo, spendUsd: capDetails.spendUsd, allowedSpendUsd: capDetails.allowedSpendUsd })}`, intent, 'impact-reduction', 'COMPLETED');
        break;
      }
      check(ticket); if (signal?.aborted) fail('LIVE_STOPPED');
      // Recheck current balance immediately before signing; RPC simulation uses an earlier bank.
      const latest = await refreshBalance();
      const spend = Math.max(0, balance - after) + fee;
      if (latest - otherFunds(intent.id) - spend < Math.ceil(caps.reserve * 1e9)) fail('LIVE_SOL_RESERVE');
      reservedFunds.set(intent.id, spend);
      check(ticket);
      if (runtime.status().network !== intent.network || runtime.status().epoch !== intent.epoch) fail('LIVE_NETWORK_MISMATCH');
      pair = keypair();
      tx.signatures[0] = nacl.sign.detached(tx.message.serialize(), pair.secretKey);
      pair.secretKey.fill(0); pair = null;
      const signature = bs58.encode(tx.signatures[0]);
      ledger.initialUsd ??= balance / 1e9 * usd;
      ledger.claimed.push(intent.id); addPending({ intentId: intent.id, signature, at: now().toISOString() });
      activity('LIVE SUBMITTING', intent, 'submitted', 'RUNNING', [signature]);
      // No await between final kill/STOP check and broadcast. Never retry a signed intent.
      if (!armed || ticket !== generation || fs.existsSync(killFile) || signal?.aborted) { clearPending(signature); fail('LIVE_STOPPED'); }
      const receipt = await confirmTransaction(tx, signature);
      const meta = receipt.meta;
      const tokenSum = rows => rows.filter(row => row.owner === owner && row.mint === p.token).reduce((sum, row) => { decimals = row.uiTokenAmount.decimals; return sum + BigInt(row.uiTokenAmount.amount); }, 0n);
      const delta = tokenSum(meta.postTokenBalances ?? []) - tokenSum(meta.preTokenBalances ?? []);
      const quantity = Math.abs(Number(delta)) / 10 ** decimals, solDelta = (meta.postBalances[0] - meta.preBalances[0]) / 1e9, fees = meta.fee / 1e9 * usd;
      const value = (p.action === 'BUY' ? -solDelta : solDelta) * usd + (p.action === 'BUY' ? -fees : fees);
      if (pump && (decimals !== pump.decimals || (p.action === 'BUY' ? delta < pump.minimum : BigInt(meta.postBalances[0]) - BigInt(meta.preBalances[0]) + BigInt(meta.fee) < pump.minimum))) fail('LIVE_RECEIPT_INVALID_RECONCILE');
      if (!(quantity > 0) || !(value > 0) || !Number.isFinite(fees) || fees < 0 || (p.action === 'BUY' ? delta <= 0n : delta >= 0n || Math.abs(quantity - orderQuantity) > 1e-10)) fail('LIVE_RECEIPT_INVALID_RECONCILE');
      const fill = event(intent, 'fill', 'TradeResult', { mode: 'live', intentId: intent.id, token: p.token, candidateId: p.candidateId, snapshotId: p.snapshotId, signalIds: p.signalIds, strategyVersion: p.strategyVersion, decisionId: p.decisionId, riskDecisionId: p.riskDecisionId, side: p.action, quantity, entryPrice: p.action === 'BUY' ? value / quantity : position.averageCost, exitPrice: p.action === 'BUY' ? null : value / quantity, realizedPnl: p.action === 'BUY' ? 0 : value - fees - position.costBasis * quantity / position.quantity, fees, slippageBps: 100, state: p.action === 'BUY' ? 'OPEN' : 'CLOSED' }, [signature, 'sol-lamports/' + String(Math.abs(meta.postBalances[0] - meta.preBalances[0])), 'token-raw/' + String(delta), 'fee-lamports/' + meta.fee]);
      if (pump) { fill.source = 'live.pumpfun'; fill.payload.slippageBps = 1000; }
      require('../../runtime/contracts/index.cjs').validateEvent(fill, { now });
      if (!pump) remoteFailCooldowns.delete(p.token);
      ledger.fills.push(fill); save(); runtime.publish(fill);
      clearPending(signature);
      await refreshBalance();
    } catch (error) {
      // Public Jupiter response diagnostics are explicitly marked; arbitrary exceptions remain private.
      const message = error.publicDiagnostic || /^(LIVE_[A-Z_]+|LIVE LOCKED: [a-z .-]+|LIVE_KILL: trading halted)$/.test(error?.message ?? '') ? error.message : 'LIVE_EXECUTION_FAILED';
      activity(message, intent);
      if (fs.existsSync(killFile) || message === 'LIVE_STOPPED' || message === 'LIVE_DAILY_LOSS_CAP') disarm();
    } finally {
      pair?.secretKey.fill(0); inFlight--; reservedFunds.delete(intent.id);
      for (const pending of pendingTransactions()) if (pending.intentId === intent.id) activeSignatures.delete(pending.signature);
    }
  }
  function disarm() { armed = false; generation++; detach?.(); detach = null; awaitingSafety.clear(); clearInterval(timer); timer = null; }
  async function confirmTransaction(tx, signature) {
    const sent = await rpc('sendTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 10 }]);
    if (sent !== signature) fail('LIVE_SIGNATURE_MISMATCH');
    const deadline = Date.now() + 45000;
    for (let attempt = 0; attempt < 6 && Date.now() < deadline; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(config.pollMs ?? 7500, deadline - Date.now()))));
      if (Date.now() >= deadline) break;
      try {
        const statuses = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], Math.min(12000, deadline - Date.now()));
        const status = statuses.value?.[0];
        if (status?.err) { clearPending(signature); fail('LIVE_TRANSACTION_FAILED'); }
        if (['confirmed', 'finalized'].includes(status?.confirmationStatus)) {
          const receipt = await rpc('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }], Math.min(12000, deadline - Date.now()));
          if (receipt?.meta?.err) { clearPending(signature); fail('LIVE_TRANSACTION_FAILED'); }
          if (receipt?.meta) return receipt;
        }
      } catch (error) {
        // Transport/RPC failures are inconclusive; never rebroadcast the signed transaction.
        if (!['LIVE_REMOTE_UNAVAILABLE', 'LIVE_RPC_FAILED'].includes(error.message)) throw error;
      }
    }
    fail('LIVE_CONFIRMATION_UNKNOWN_RECONCILE');
  }
  function withdrawalActivity(entry) {
    if (!runtime.get(entry.event.id)) runtime.publish(entry.event);
  }
  if (!corrupt) for (const entry of ledger.withdrawals ?? []) withdrawalActivity(entry);
  if (!corrupt) for (const entry of ledger.reconciliations ?? []) withdrawalActivity(entry);
  async function withdraw(destinationAddress, amountSol, ticket) {
    let pair;
    inFlight++;
    const guard = () => {
      gate();
      if (ticket !== generation) fail('LIVE_STOPPED');
      if (runtime.status().network !== 'SOLANA') fail('LIVE_NETWORK_MISMATCH');
    };
    try {
      guard();
      let destination;
      try { destination = new PublicKey(destinationAddress); if (typeof destinationAddress !== 'string' || destination.toBase58() !== destinationAddress || destinationAddress === owner) throw Error(); }
      catch { fail('LIVE_DESTINATION_INVALID'); }
      const lamports = Math.round(amountSol * 1e9);
      if (typeof amountSol !== 'number' || !Number.isSafeInteger(lamports) || lamports <= 0 || Math.abs(lamports / 1e9 - amountSol) > 1e-15) fail('LIVE_AMOUNT_INVALID');
      if (await rpc('getGenesisHash', []) !== MAINNET) fail('LIVE_NETWORK_MISMATCH');
      const block = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: block.value.blockhash, instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: destination, lamports })] }).compileToV0Message());
      const fee = (await rpc('getFeeForMessage', [Buffer.from(tx.message.serialize()).toString('base64'), { commitment: 'confirmed' }])).value;
      if (!Number.isSafeInteger(fee) || fee < 0) fail('LIVE_FEE_UNAVAILABLE');
      const balance = await refreshBalance();
      if (lamports > balance) fail('LIVE_INSUFFICIENT_SOL');
      if (balance - lamports - fee < Math.ceil(caps.reserve * 1e9)) fail('LIVE_SOL_RESERVE');
      guard(); pair = keypair();
      tx.signatures[0] = nacl.sign.detached(tx.message.serialize(), pair.secretKey);
      pair.secretKey.fill(0); pair = null;
      const signature = bs58.encode(tx.signatures[0]);
      ledger.pending = { type: 'withdraw', destinationAddress, amountSol, signature, at: now().toISOString() }; save();
      if (ticket !== generation || fs.existsSync(killFile)) { ledger.pending = null; save(); fail('LIVE_STOPPED'); }
      const receipt = await confirmTransaction(tx, signature), meta = receipt.meta;
      if (!Number.isSafeInteger(meta.postBalances?.[0]) || meta.preBalances?.[0] - meta.postBalances[0] !== lamports + meta.fee) fail('LIVE_RECEIPT_INVALID_RECONCILE');
      balanceSol = meta.postBalances[0] / 1e9; balanceAt = now().toISOString();
      const message = `Đã rút ${amountSol} SOL · tx ${signature.slice(0, 12)}`;
      const entry = { signature, destinationAddress, amountSol, at: balanceAt, event: event(null, 'withdraw', 'AIActivityEvent', { agent: 'LIVE_EXECUTION', task: 'withdraw', state: 'COMPLETED', progress: null, message }, [signature]) };
      entry.event.evidence = [signature]; entry.event.source = 'live.solana.transfer';
      (ledger.withdrawals ??= []).push(entry); save(); withdrawalActivity(entry);
      ledger.pending = null; save();
      return { signature, amountSol, solBalance: balanceSol };
    } catch (error) { if (fs.existsSync(killFile) || error.message === 'LIVE_STOPPED' || error.message === 'LIVE_DAILY_LOSS_CAP') disarm(); throw error; }
    finally { pair?.secretKey.fill(0); inFlight--; }
  }
  return {
    withdrawTo(destinationAddress, amountSol) {
      const ticket = generation;
      return enqueue(null, () => withdraw(destinationAddress, amountSol, ticket));
    },
    status: () => ({ state: armed ? 'ARMED' : 'LOCKED', hasKey: fs.existsSync(keyFile), balanceSol, balanceAt, owner, caps: { ...caps }, pendingSignature: ledger.pending?.signature ?? null }),
    createWallet(confirm) {
      if (armed || ledger.pending || positions().length || corrupt) fail('LIVE_WALLET_BUSY');
      const exists = fs.existsSync(keyFile);
      if (exists && confirm !== 'REGENERATE') fail('LIVE_REGENERATE_CONFIRMATION_REQUIRED');
      if (ledger.fills.length) fail('LIVE_WALLET_HAS_HISTORY');
      owner = createKey(keyFile, exists); ledger.owner = owner; balanceSol = null; balanceAt = null; save();
      return { address: owner };
    },
    isArmed: () => armed,
    reconcile: () => inFlight ? Promise.resolve() : reconcilePending(),
    refreshBalance,
    portfolio() {
      let usd = 0; try { usd = price(); } catch {}
      const cash = (balanceSol ?? 0) * usd;
      const marks = runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot' && e.network === 'SOLANA');
      // Replay cost basis/cycles with sufficient internal cash, then replace cash
      // with RPC evidence. Paper PnL never participates in live risk sizing.
      const replayCash = ledger.fills.filter(e => e.payload.side === 'BUY').reduce((sum, e) => sum + e.payload.quantity * e.payload.entryPrice + e.payload.fees, cash);
      const result = require('../performance/project.cjs').projectPortfolio([...marks, ...ledger.fills].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)), { capitalUsd: replayCash, now });
      const p = result.performance;
      // Discovery stops watching aged pools. A missing mark on an existing
      // holding must not make independently verified cash unusable forever.
      // For risk limits only, value unpriced holdings at zero and charge their
      // entire cost as a loss. Keep position marks and reported PnL unknown.
      // Their cost must NOT also reserve exposure: valuing the position at zero
      // while reserving its cost double-counts the same dollars and starves
      // every new entry (14 unmarked holdings once blocked all orders).
      // Closed-out positions (proven unsellable, operator write-off) leave the
      // book entirely and their full cost basis is realized as a loss here.
      const closedTokens = new Set((ledger.closeouts ?? []).map(c => c.token));
      const rows = result.positions.filter(row => !closedTokens.has(row.token));
      const realizedWriteOffs = (ledger.closeouts ?? []).reduce((sum, c) => sum + c.costBasis, 0);
      const conservativeValue = rows.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);
      const pricedCapitalUsed = rows.reduce((sum, position) => sum + (position.marketValue == null ? 0 : position.costBasis), 0);
      const funded = usd > 0 && balanceAt && now().getTime() - Date.parse(balanceAt) >= 0 && now().getTime() - Date.parse(balanceAt) <= 60000;
      const equity = funded ? cash + conservativeValue : null;
      const riskPnl = conservativeValue - pricedCapitalUsed;
      const adjustedRealized = p.realizedPnl - realizedWriteOffs;
      const drawdown = ledger.initialUsd ? Math.max(0, -(adjustedRealized + riskPnl) / ledger.initialUsd) : pricedCapitalUsed > 0 ? 1 : 0;
      const hash = createHash('sha256').update('SOLANA:' + owner).digest('hex');
      const funding = runtime.snapshot().events.findLast(e => e.type === 'WalletValuation' && e.network === 'SOLANA' && e.payload.accountHash === hash);
      return { ...result, positions: rows, performance: { ...p, cash, equity, capitalUsed: pricedCapitalUsed, realizedPnl: adjustedRealized, valuationBasis: p.unrealizedPnl == null ? 'UNPRICED_HOLDINGS_ZERO' : 'MARKET', budgetUsd: cash, paperCapitalUsd: ledger.initialUsd ?? cash, maxDrawdown: equity == null ? null : drawdown, fundingId: funded ? funding?.id ?? null : null } };
    },
    async arm(confirm) {
      if (confirm !== 'LIVE_REAL_MONEY') fail('LIVE_CONFIRMATION_REQUIRED');
      if (armed) { await reconcilePending(); return; }
      try {
        await reconcilePending();
        gate(); const pair = keypair(); pair.secretKey.fill(0);
        if (runtime.status().network !== 'SOLANA') fail('LIVE_NETWORK_MISMATCH');
        if (await rpc('getGenesisHash', []) !== MAINNET) fail('LIVE_NETWORK_MISMATCH');
        if (await refreshBalance() <= 0) fail('LIVE_DEPOSIT_REQUIRED');
        gate();
        // Outbox replay never re-signs or re-sends a transaction.
        for (const fill of ledger.fills) if (!runtime.get(fill.id) && runtime.get(fill.payload.intentId)) runtime.publish(fill);
        beforeArm = new Set(runtime.snapshot().events.filter(e => e.type === 'ExecutionIntent').map(e => e.id));
        armed = true; const ticket = ++generation;
        const intake = (intent, context) => {
          if (queued.has(intent.id) || beforeArm.has(intent.id)) return;
          if (!armed || ticket !== generation || context.signal?.aborted) return;
          const token = intent.payload.token;
          if (intent.payload.mode === 'live' && intent.payload.action === 'BUY' && !runtime.snapshot().events.some(e => e.type === 'SafetyDecision' && e.network === intent.network && e.epoch === intent.epoch && e.payload.candidateId === intent.payload.candidateId)) {
            awaitingSafety.set(intent.id, { intent, context });
            activity('LIVE WAITING FOR SAFETY', intent, 'waiting-safety', 'WAITING');
            return;
          }
          awaitingSafety.delete(intent.id);
          activity('LIVE INTENT RECEIVED', intent, 'received', 'RUNNING'); queued.add(intent.id);
          // The bus has a 5s handler deadline. Acknowledge intake immediately;
          // Run up to three token lanes so analytics and STOP remain responsive.
          // After a crash, pre-arm intents are never revived; pending sends lock.
          // Owner directive: one failed intent (stale quote, RPC hiccup, veto) must NOT
          // disarm the whole engine — the activity trail records the failure; only
          // execute()'s internal catastrophic paths (daily-loss cap, kill switch) disarm.
          enqueue(token, () => execute(intent, ticket, context.signal)).catch(() => {});
        };
        const offIntent = runtime.subscribeDurable('live.v1.ExecutionIntent', 'ExecutionIntent', intake);
        const offSafety = runtime.subscribe('SafetyDecision', verdict => {
          for (const { intent, context } of awaitingSafety.values()) if (intent.network === verdict.network && intent.epoch === verdict.epoch && intent.payload.candidateId === verdict.payload.candidateId) intake(intent, context);
        });
        detach = () => { offIntent(); offSafety(); };
        timer = setInterval(() => { if (fs.existsSync(killFile) || !fs.existsSync(keyFile)) { activity(fs.existsSync(killFile) ? 'LIVE_KILL: trading halted' : 'LIVE LOCKED: wallet-key.env missing'); disarm(); } }, 100); timer.unref?.();
        activity('LIVE ARMED: real money execution enabled', null, 'armed', 'COMPLETED');
      } catch (error) { disarm(); const message = /^(LIVE_[A-Z_]+|LIVE LOCKED: [a-z .-]+|LIVE_KILL: trading halted)$/.test(error?.message ?? '') ? error.message : 'LIVE_ARM_FAILED'; activity(message); fail(message); }
    },
    start() {
      const lock = () => { try { gate(); const pair = keypair(); pair.secretKey.fill(0); activity('LIVE LOCKED: owner confirmation required'); } catch (error) { activity(error.message); } };
      if (!ledger.pending) { lock(); return; }
      try { return reconcilePending().then(lock, error => { activity(error.message); }); }
      catch (error) { activity(error.message); }
    },
    stop() { const was = armed; disarm(); if (was) activity('LIVE STOPPED', null, 'stopped', 'STOPPED'); },
    drain,
    // Operator close-out of a position proven unsellable on-chain: zero balance,
    // no Jupiter route with the bonding curve gone, or an empty pool. The books
    // must reflect reality — no phantom open rows, the loss realized at what the
    // chain can actually recover (zero), evidence recorded, no fake TradeResult.
    writeOff(token, reason, evidence) {
      if (corrupt) fail('LIVE LOCKED: ledger invalid');
      if (fs.existsSync(killFile)) fail('LIVE_KILL: trading halted');
      if (typeof token !== 'string' || typeof reason !== 'string' || !reason.trim() || reason.length > 300 || !Array.isArray(evidence) || !evidence.length || evidence.length > 8 || evidence.some(x => typeof x !== 'string' || !x.trim() || x.length > 300)) fail('LIVE_CLOSEOUT_INPUT_INVALID');
      const position = positions().find(row => row.token === token);
      if (!position || position.quantity <= 0) fail('LIVE_CLOSEOUT_NO_POSITION');
      (ledger.closeouts ??= []).push({ token, quantity: position.quantity, costBasis: position.costBasis, averageCost: position.averageCost, at: now().toISOString(), reason, evidence: [...evidence] });
      save();
      const message = 'Đã ghi sổ xoá bỏ vị thế ' + token.slice(0, 8) + ': ' + position.quantity + ' token, vốn ' + position.costBasis.toFixed(4) + ' USD — không thể bán on-chain.';
      activity(message, null, 'closeout', 'COMPLETED', evidence.slice(0, 4));
      return { quantity: position.quantity, costBasis: position.costBasis, averageCost: position.averageCost, message };
    }
  };
}
module.exports = { createLiveExecution, INTENT_MAX_AGE_MS };
