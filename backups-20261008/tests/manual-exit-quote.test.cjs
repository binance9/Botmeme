'use strict';
// Regression: a live position whose lineage (candidate/snapshot/decision/intent)
// only survives in rotated journal archives must be sellable through the normal
// operator exit. Boot revives the archived lineage (verbatim committed events),
// and the manual SELL fills against the real on-chain token balance.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const nacl = require('tweetnacl'), bs58 = require('bs58');
const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { createApplication } = require('../runtime/application.cjs');

const stamp = '2026-10-05T10:00:00.000Z', now = () => new Date(stamp);
const at = minutes => new Date(Date.parse(stamp) - minutes * 60000).toISOString();

test('live manual SELL of an archived-lineage position fills through the revived chain', async t => {  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-exitquote-'));
  const pair = nacl.sign.keyPair(), owner = bs58.encode(pair.publicKey);
  fs.writeFileSync(path.join(root, 'wallet-key.env'), 'TRADING_PRIVATE_KEY=' + bs58.encode(pair.secretKey));
  const token = bs58.encode(nacl.sign.keyPair().publicKey);

  const snapshot = { id: 'snap-aged', type: 'MarketSnapshot', producer: 'MARKET_DATA', timestamp: at(30), source: 'test', evidence: ['venue/test'], status: 'OBSERVED', correlationId: 'aged', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload: { token, price: 1, liquidityUsd: 1000, volume24hUsd: 1000, observedAt: at(30), marketCapUsd: 15000, poolAgeMs: 45 * 86400000, realVolumeUsd: 50000 } };
  const candidate = { id: 'cand-aged', type: 'TokenCandidate', producer: 'JEV', timestamp: at(29), source: 'test', evidence: ['venue/test'], status: 'OBSERVED', correlationId: 'aged', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload: { token, symbol: 'AGED', snapshotId: snapshot.id, liquidityUsd: 1000, volume24hUsd: 1000, rank: 1, anomalies: ['TOKEN_DISCOVERY', 'REAL_VOLUME'] } };
  const signal = { id: 'signal-aged', type: 'SignalObservation', producer: 'JEV', timestamp: at(28), source: 'test', evidence: ['venue/test'], status: 'OBSERVED', correlationId: 'aged', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload: { candidateId: candidate.id, snapshotId: snapshot.id, signals: [{ name: 'momentum', value: .1 }] } };
  const regime = { id: 'regime-aged', type: 'MarketRegimeState', producer: 'MARKET_DATA', timestamp: at(27), source: 'test', evidence: ['venue/test'], status: 'OBSERVED', correlationId: 'aged', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload: { regime: 'TRENDING', snapshotIds: [snapshot.id], reason: 'test regime.' } };
  const decision = { id: 'decision-aged', type: 'StrategyDecision', producer: 'CODEX_1', timestamp: at(26), source: 'commander.autonomous', evidence: [candidate.id, snapshot.id, signal.id], status: 'OBSERVED', correlationId: 'aged', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload: { candidateId: candidate.id, snapshotId: snapshot.id, signalIds: [signal.id], strategyVersion: 'meme-flow-v1', quantEvidenceIds: [], criticReportIds: [], regimeId: regime.id, action: 'BUY', disposition: 'TRADE', reason: 'Fresh meme entry.' } };
  const risk = { id: 'risk-aged', type: 'RiskDecision', producer: 'RISK_ENGINE', timestamp: at(25), source: 'risk.independent-veto', evidence: [decision.id], status: 'APPROVED', correlationId: 'aged', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload: { decisionId: decision.id, approved: true, quantity: 1, maxExposureUsd: 1, reason: 'approved.' } };
  const intent = { id: 'intent-aged', type: 'ExecutionIntent', producer: 'STRATEGY_ENGINE', timestamp: at(24), source: 'strategy_engine.service', evidence: [risk.id, decision.id, snapshot.id], status: 'APPROVED', correlationId: 'aged', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload: { mode: 'live', token, candidateId: candidate.id, snapshotId: snapshot.id, signalIds: [signal.id], strategyVersion: 'meme-flow-v1', decisionId: decision.id, riskDecisionId: risk.id, action: 'BUY', quantity: 1, referencePrice: 1 } };

  // The journal page that held this chain has been rotated into an archive; the
  // current journal is empty, and the live ledger still holds the open BUY.
  const journalPath = path.join(root, 'runtime.jsonl');
  fs.writeFileSync(journalPath + '.' + stamp.replace(/[:.]/g, '-') + '.archive', [snapshot, candidate, signal, regime, decision, risk, intent].map(e => JSON.stringify({ sequence: 1, previous: '0'.repeat(64), hash: '0'.repeat(64), value: { kind: 'event', event: e } })).join('\n') + '\n');
  fs.writeFileSync(journalPath, '');

  const fillId = 'live.fill/' + createHash('sha256').update('intent-aged').digest('hex');
  const fill = { id: fillId, type: 'TradeResult', producer: 'LIVE_EXECUTION', timestamp: stamp, source: 'live.jupiter', evidence: ['intent-aged', 'risk-aged', 'sig-aged'], status: 'COMPLETED', correlationId: 'aged', network: 'SOLANA', epoch: 1, confidence: 1, evidence_quality: 1, uncertainty: 0, missing_evidence: [],
    payload: { mode: 'live', intentId: 'intent-aged', token, candidateId: candidate.id, snapshotId: snapshot.id, signalIds: [signal.id], strategyVersion: 'meme-flow-v1', decisionId: decision.id, riskDecisionId: risk.id, side: 'BUY', quantity: 1, entryPrice: 1, exitPrice: null, realizedPnl: 0, fees: 0.01, slippageBps: 100, state: 'OPEN' } };
  fs.writeFileSync(path.join(root, 'live-state.json'), JSON.stringify({ version: 1, owner, pending: null, fills: [fill], claimed: ['intent-aged'], initialUsd: 20 }));

  const fetcher = async (url, init) => {
    const u = String(url);
    if (u.includes('dexscreener.com')) return new Response(JSON.stringify({ pairs: [{ chainId: 'solana', priceUsd: '1.25', liquidity: { usd: 42000 }, volume: { h24: 90000 } }] }), { status: 200 });
    if (u.includes('/quote')) {
      const q = new URL(u), input = q.searchParams.get('inputMint');
      return new Response(JSON.stringify({ inputMint: input, outputMint: q.searchParams.get('outputMint'), inAmount: q.searchParams.get('amount'), outAmount: '1000000', slippageBps: 100, swapMode: 'ExactIn' }), { status: 200 });
    }
    if (u.includes('/swap')) {
      const message = new (require('@solana/web3.js').TransactionMessage)({ payerKey: new PublicKey(owner), recentBlockhash: PublicKey.default.toBase58(), instructions: [require('@solana/web3.js').SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(token), lamports: 1 })] }).compileToV0Message();
      return new Response(JSON.stringify({ swapTransaction: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64') }), { status: 200 });
    }
    const { method, params } = JSON.parse(init.body);
    let value = {};
    if (method === 'getGenesisHash') value = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    else if (method === 'getBalance') value = { value: 500000000 };
    else if (method === 'getFeeForMessage') value = { value: 5000 };
    else if (method === 'getLatestBlockhash') value = { value: { blockhash: PublicKey.default.toBase58() } };
    else if (method === 'getTokenAccountsByOwner') value = { value: JSON.stringify(params).includes('TokenzQdBNbLq') ? [] : [{ account: { data: { parsed: { info: { mint: token, tokenAmount: { amount: '1000000', decimals: 6, uiTokenAmount: { amount: '1000000', decimals: 6, owner } } } } } } }] };
    else if (method === 'simulateTransaction') value = { value: { err: null, accounts: [{ lamports: 490000000 }] } };
    else if (method === 'sendTransaction') value = bs58.encode(VersionedTransaction.deserialize(Buffer.from(params[0], 'base64')).signatures[0]);
    else if (method === 'getSignatureStatuses') value = { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    else if (method === 'getTransaction') value = { meta: { err: null, fee: 5000, preBalances: [400000000, 1], postBalances: [401000000, 1], preTokenBalances: [{ owner, mint: token, uiTokenAmount: { amount: '1000000', decimals: 6 } }], postTokenBalances: [] }, transaction: { message: {} } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }), { status: 200 });
  };
  const application = createApplication({ journalPath, capitalUsd: 10000, now,
    providers: { SOLANA: { network: 'SOLANA', discover() { return []; }, snapshot() { throw Error('UNEXPECTED'); } } },
    // The boot-time gate re-screens revived candidates; a verified bonding-curve
    // token passes (as it would in production through the real RPC reader).
    safetyReaders: { SOLANA: { read: async () => ({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxLpLockedPct: null, top10HolderPct: 5, insiderHolderPct: null, scoreNormalised: null, lpStatus: 'bonding-curve' }) } },
    liveConfig: { root, fetcher, env: {} },
    valuationReader: { read: async session => ({ id: 'wallet-value/test', timestamp: stamp, source: 'test', evidence: ['balance/test', 'quote/test'], balance: { status: 'OBSERVED', symbol: 'SOL', amount: '0.500000000', observedAt: stamp }, rawQuote: '{}', quote: { price: '100', time: stamp, trade_id: null }, payload: { amount: '0.500000000', symbol: 'SOL', balanceAt: stamp, priceAt: stamp, priceUsd: 100, valueUsd: 50, accountHash: createHash('sha256').update(session.network + ':' + session.address).digest('hex') } }) } });
  t.after(() => application.close());
  // after() hooks run in registration order: the application (and its journal
  // lock) must close before the temp directory disappears.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await application.live('LIVE_REAL_MONEY');
  assert.equal(application.control().mode, 'live');
  const revived = application.runtime.snapshot().events.filter(e => e.id.endsWith('-aged'));
  assert.ok(revived.length >= 6, 'archived lineage must be revived into the runtime');
  const outcome = await application.sellLive({ tradeId: fillId, percent: 100, execute: true });
  assert.equal(outcome.status, 'FILLED', JSON.stringify({ status: outcome.status, reason: outcome.reason }));
  assert.equal(outcome.mode, 'live');
  assert.ok(outcome.fillId);
});

test('a zero-balance ledger position is refused once, then closes out with evidence on retry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-ghost-'));
  const pair = nacl.sign.keyPair(), owner = bs58.encode(pair.publicKey);
  fs.writeFileSync(path.join(root, 'wallet-key.env'), 'TRADING_PRIVATE_KEY=' + bs58.encode(pair.secretKey));
  const token = bs58.encode(nacl.sign.keyPair().publicKey);
  const fillId = 'live.fill/' + createHash('sha256').update('intent-ghost').digest('hex');
  const fill = { id: fillId, type: 'TradeResult', producer: 'LIVE_EXECUTION', timestamp: stamp, source: 'live.jupiter', evidence: ['intent-ghost', 'risk-ghost', 'sig-ghost'], status: 'COMPLETED', correlationId: 'ghost', network: 'SOLANA', epoch: 1, confidence: 1, evidence_quality: 1, uncertainty: 0, missing_evidence: [],
    payload: { mode: 'live', intentId: 'intent-ghost', token, candidateId: 'cand-ghost', snapshotId: 'snap-ghost', signalIds: ['signal-ghost'], strategyVersion: 'meme-flow-v1', decisionId: 'decision-ghost', riskDecisionId: 'risk-ghost', side: 'BUY', quantity: 58567.579837, entryPrice: 0.000016, exitPrice: null, realizedPnl: 0, fees: 0.01, slippageBps: 100, state: 'OPEN' } };
  fs.writeFileSync(path.join(root, 'live-state.json'), JSON.stringify({ version: 1, owner, pending: null, fills: [fill], claimed: ['intent-ghost'], initialUsd: 20 }));
  // Production-shape lineage: the ghost position's chain survives in archives.
  const ago = m => new Date(Date.parse(stamp) - m * 60000).toISOString();
  const mkGhost = (id, type, producer, minutesAgo, payload, status = 'OBSERVED') => ({ id, type, producer, timestamp: ago(minutesAgo), source: 'test', evidence: ['venue/ghost'], status, correlationId: 'ghost', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload });
  const gSnapshot = mkGhost('snap-ghost', 'MarketSnapshot', 'MARKET_DATA', 40, { token, price: 0.000016, liquidityUsd: 1000, volume24hUsd: 1000, observedAt: ago(40), marketCapUsd: 15000, poolAgeMs: 45 * 86400000, realVolumeUsd: 50000 });
  const gCandidate = mkGhost('cand-ghost', 'TokenCandidate', 'JEV', 39, { token, symbol: 'GHOST', snapshotId: gSnapshot.id, liquidityUsd: 1000, volume24hUsd: 1000, rank: 1, anomalies: ['TOKEN_DISCOVERY', 'REAL_VOLUME'] });
  const gSignal = mkGhost('signal-ghost', 'SignalObservation', 'JEV', 38, { candidateId: gCandidate.id, snapshotId: gSnapshot.id, signals: [{ name: 'momentum', value: .1 }] });
  const gRegime = mkGhost('regime-ghost', 'MarketRegimeState', 'MARKET_DATA', 37, { regime: 'TRENDING', snapshotIds: [gSnapshot.id], reason: 'test regime.' });
  const gDecision = { ...mkGhost('decision-ghost', 'StrategyDecision', 'CODEX_1', 36, { candidateId: gCandidate.id, snapshotId: gSnapshot.id, signalIds: [gSignal.id], strategyVersion: 'meme-flow-v1', quantEvidenceIds: [], criticReportIds: [], regimeId: gRegime.id, action: 'BUY', disposition: 'TRADE', reason: 'entry.' }), source: 'commander.autonomous', evidence: [gCandidate.id, gSnapshot.id, gSignal.id] };
  const gRisk = { ...mkGhost('risk-ghost', 'RiskDecision', 'RISK_ENGINE', 35, { decisionId: gDecision.id, approved: true, quantity: 58567.579837, maxExposureUsd: 0.94, reason: 'approved.' }), source: 'risk.independent-veto', evidence: [gDecision.id], status: 'APPROVED' };
  const gIntent = { ...mkGhost('intent-ghost', 'ExecutionIntent', 'STRATEGY_ENGINE', 34, { mode: 'live', token, candidateId: gCandidate.id, snapshotId: gSnapshot.id, signalIds: [gSignal.id], strategyVersion: 'meme-flow-v1', decisionId: gDecision.id, riskDecisionId: gRisk.id, action: 'BUY', quantity: 58567.579837, referencePrice: 0.000016 }), source: 'strategy_engine.service', evidence: [gRisk.id, gDecision.id, gSnapshot.id], status: 'APPROVED' };
  const ghostJournal = path.join(root, 'runtime.jsonl');
  fs.writeFileSync(ghostJournal + '.ghost.archive', [gSnapshot, gCandidate, gSignal, gRegime, gDecision, gRisk, gIntent].map(e => JSON.stringify({ sequence: 1, previous: '0', hash: '0', value: { kind: 'event', event: e } })).join('\n') + '\n');
  fs.writeFileSync(ghostJournal, '');
  const fetcher = async (url, init) => {
    const u = String(url);
    if (u.includes('dexscreener.com')) return new Response(JSON.stringify({ pairs: [{ chainId: 'solana', priceUsd: '0.0000034', liquidity: { usd: 0 }, volume: { h24: 0 } }] }), { status: 200 });
    const { method, params } = JSON.parse(init.body);
    let value = {};
    if (method === 'getGenesisHash') value = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    else if (method === 'getBalance') value = { value: 500000000 };
    else if (method === 'getTokenAccountsByOwner') value = { value: [] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }), { status: 200 });
  };
  const application = createApplication({ journalPath: ghostJournal, capitalUsd: 10000, now,
    providers: { SOLANA: { network: 'SOLANA', discover() { return []; }, snapshot() { throw Error('UNEXPECTED'); } } },
    safetyReaders: { SOLANA: { read: async () => ({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxLpLockedPct: null, top10HolderPct: 5, insiderHolderPct: null, scoreNormalised: null, lpStatus: 'bonding-curve' }) } },
    liveConfig: { root, fetcher, env: {} },
    valuationReader: { read: async session => ({ id: 'wallet-value/g', timestamp: stamp, source: 'test', evidence: ['balance/g', 'quote/g'], balance: { status: 'OBSERVED', symbol: 'SOL', amount: '0.500000000', observedAt: stamp }, rawQuote: '{}', quote: { price: '100', time: stamp, trade_id: null }, payload: { amount: '0.500000000', symbol: 'SOL', balanceAt: stamp, priceAt: stamp, priceUsd: 100, valueUsd: 50, accountHash: createHash('sha256').update(session.network + ':' + session.address).digest('hex') } }) } });
  t.after(() => application.close());
  await application.live('LIVE_REAL_MONEY');
  const first = await application.sellLive({ tradeId: fillId, percent: 100, execute: true });
  assert.equal(first.status, 'UNSELLABLE', JSON.stringify(first));
  assert.equal(first.writeOffAvailable, true);
  assert.equal(first.reason, 'LIVE_FULL_POSITION_SELL_REQUIRED');
  const retry = await application.sellLive({ tradeId: fillId, percent: 100, execute: true, writeOff: true, evidence: ['live execution: LIVE_FULL_POSITION_SELL_REQUIRED (on-chain balance 0, two RPC endpoints)'] });
  assert.equal(retry.status, 'CLOSED_OUT', JSON.stringify(retry));
  assert.equal(retry.quantity, 58567.579837);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'live-state.json'), 'utf8'));
  assert.equal(ledger.closeouts.length, 1);
  assert.equal(ledger.closeouts[0].token, token);
  assert.ok(ledger.closeouts[0].costBasis > 0);
  assert.ok(application.runtime.snapshot().events.some(e => e.type === 'AIActivityEvent' && e.payload.message.includes('xoá bỏ')));
  const positions = application.tradeStore.snapshot().positions;
  assert.equal(positions.length, 0, 'the ghost must leave the book');
  assert.ok(application.tradeStore.snapshot().performance.realizedPnl < 0, 'the write-off realizes the loss');
});
