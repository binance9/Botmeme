'use strict';
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { NETWORKS } = require('./contracts/index.cjs');
const invalid = code => { throw Object.assign(Error(code), { status: 400 }); };
function createCapitalLedger(filename, now = () => new Date()) {
  let entries = [];
  if (filename) try { entries = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const valid = e => e && typeof e.id === 'string' && Number.isFinite(Date.parse(e.at)) && NETWORKS.includes(e.network) && Number.isSafeInteger(e.eventCount) && e.eventCount >= 0 && ['deposit','withdraw'].includes(e.type) && Number.isFinite(e.amountUsd) && e.amountUsd > 0 && Number.isFinite(e.resultingCapitalUsd) && e.resultingCapitalUsd >= 0 && (e.note === undefined || typeof e.note === 'string');
  if (!Array.isArray(entries) || !entries.every(valid)) throw Error('INVALID_CAPITAL_LEDGER');
  return {
    entries: network => entries.filter(e => e.network === network).map(e => ({ ...e })),
    adjust({ type, amountUsd, note, network, eventCount, currentCapitalUsd }) {
      if (!['deposit','withdraw'].includes(type) || typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0 || (note !== undefined && (typeof note !== 'string' || note.length > 500))) invalid('INVALID_CAPITAL_ADJUSTMENT');
      if (type === 'withdraw' && amountUsd > currentCapitalUsd) invalid('INSUFFICIENT_PAPER_CAPITAL');
      const resultingCapitalUsd = currentCapitalUsd + (type === 'deposit' ? amountUsd : -amountUsd);
      const entry = { id: randomUUID(), at: now().toISOString(), type, amountUsd, ...(note === undefined ? {} : { note }), resultingCapitalUsd, network, eventCount };
      if (!valid(entry) || resultingCapitalUsd === currentCapitalUsd) invalid('INVALID_CAPITAL_ADJUSTMENT');
      const next = [...entries, entry];
      if (filename) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename + '.tmp', JSON.stringify(next)); fs.renameSync(filename + '.tmp', filename); }
      entries = next; return { ...entry };
    }
  };
}
// Compact accounting checkpoint, separate from the operational journal. Replay
// uses projectPortfolio too: never trust a fill's claimed realizedPnl as cash.
function projectCapitalHistory(groups, capitalUsd, now = () => new Date()) {
  let realizedPnl = 0;
  const trades = [];
  for (const [index, events] of groups.entries()) {
    for (const network of NETWORKS) {
      const subset = events.filter(e => e.network === network);
      if (!subset.length) continue;
      const base = subset.find(e => e.type === 'WalletValuation' && e.payload.valueUsd > 0)?.payload.valueUsd ?? capitalUsd;
      const p = require('../core/performance/project.cjs').projectPortfolio(subset, { capitalUsd: base, activeNetwork: network, now });
      realizedPnl += p.performance.realizedPnl;
      trades.push(...p.trades.map(t => ({ ...t, cycleId: 'archive-'+index+':'+t.cycleId, positionState: t.positionState === 'OPEN' ? 'ARCHIVED' : t.positionState })));
    }
  }
  return { realizedPnl, trades };
}
// Shared by checkpoint and trade store so base capital and legacy PnL cannot drift.
function projectCapitalPortfolio(events, { legacy = [], history, walletFunded = false, capitalUsd = 10000, ...options } = {}) {
  const network = options.activeNetwork ?? 'SOLANA';
  events = events.filter(e => e.network === network);
  const groups = legacy.map(g => g.filter(e => e.network === network));
  history ??= projectCapitalHistory(groups, capitalUsd, options.now);
  const seed = events.find(e => e.type === 'WalletValuation' && e.payload.valueUsd > 0);
  const base = walletFunded ? seed?.payload.valueUsd ?? groups.flat().findLast(e => e.type === 'WalletValuation' && e.payload.valueUsd > 0)?.payload.valueUsd ?? 0 : capitalUsd;
  const result = require('../core/performance/project.cjs').projectPortfolio(events, { ...options, capitalUsd: Math.max(0, base + history.realizedPnl) });
  result.trades.unshift(...history.trades);
  result.performance.realizedPnl += history.realizedPnl;
  return result;
}
function createCapitalAnchor(journalPath, capitalUsd = 10000) {
  const filename = path.join(path.dirname(journalPath), 'capital-anchor.json');
  let saved = { version: 1, events: [], archives: [], legacy: [], capitalUsd };
  try { saved = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (saved.version !== 1 || !Array.isArray(saved.events) || !Array.isArray(saved.archives)) throw Error('INVALID_CAPITAL_ANCHOR');
  const events = new Map(saved.events.map(e => [e.id, e]));
  let reference = null;
  function settleSol() {
    // Bootstrap from the newest legacy session plus the cumulative anchor/current
    // journal. Older legacy sessions contain abandoned positions from historical
    // resets; their raw buys are not outstanding cash debits in this paper session.
    const rows = [...new Map([...saved.legacy.slice(-1).flat(), ...events.values()].map(e => [e.id, e])).values()]
      .filter(e => e.network === 'SOLANA').sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp));
    const funding = rows.findLast(e => e.type === 'WalletValuation' && e.payload.symbol === 'SOL');
    const price = reference?.priceUsd ?? funding?.payload.priceUsd ?? saved.sol?.solPriceUsd;
    if (!(price > 0) || !Number.isFinite(price)) return;
    const start = Number(funding?.payload.amount ?? saved.sol?.solStart ?? saved.capitalUsd / price);
    if (!Number.isFinite(start)) return;
    const backfill = !saved.sol;
    const sol = saved.sol ?? { solBalance: start, solStart: start, fillsSeen: [] };
    const seen = new Set(sol.fillsSeen);
    // Mark superseded sessions as consumed too, so dashboard history cannot
    // replay their abandoned debits as new post-anchor flows.
    for (const e of saved.legacy.slice(0, -1).flat()) {
      if (e.network === 'SOLANA' && e.type === 'TradeResult' && e.payload.mode === 'paper') seen.add(e.id);
    }
    // Wallet observations may change funding, but must never erase paper flows.
    sol.solBalance += start - sol.solStart;
    sol.solStart = start;
    for (const e of rows) {
      if (e.type !== 'TradeResult' || e.payload.mode !== 'paper' || seen.has(e.id)) continue;
      const p = e.payload, buy = p.side === 'BUY';
      const fillPrice = backfill && p.solPriceUsd > 0 ? p.solPriceUsd : price;
      const flow = (buy ? -p.quantity * p.entryPrice : p.quantity * p.exitPrice) - (p.fees ?? 0);
      sol.solBalance += flow / fillPrice;
      seen.add(e.id);
    }
    saved.sol = { ...sol, fillsSeen: [...seen], solPriceUsd: price };
  }
  function compact(rows) {
    const keep = new Set();
    for (const network of NETWORKS) {
      const quotes = rows.filter(e => e.network === network && e.type === 'WalletValuation');
      keep.add(quotes.find(e => e.payload.valueUsd > 0)?.id); keep.add(quotes.at(-1)?.id);
    }
    return rows.filter(e => e.type === 'TradeResult' || keep.has(e.id));
  }
  function add(e) {
    if (e && (e.type === 'WalletValuation' || e.type === 'TradeResult' && e.payload.mode === 'paper')) events.set(e.id, e);
  }
  function readFile(file) {
    const result = [];
    const content = fs.readFileSync(file, 'utf8');
    if (content && !content.endsWith('\n')) throw Error('INCOMPLETE_CAPITAL_SOURCE');
    for (const line of content.split('\n')) if (line) { const r = JSON.parse(line), e = r.value?.event; if (e && (e.type === 'WalletValuation' || e.type === 'TradeResult' && e.payload.mode === 'paper')) result.push(e); }
    return compact(result);
  }
  const dir = path.dirname(journalPath), base = path.basename(journalPath);
  for (const name of fs.readdirSync(dir).filter(n => n.startsWith(base + '.') && n.endsWith('.archive')).sort()) {
    if (!saved.archives.includes(name)) { saved.legacy.push(readFile(path.join(dir, name))); saved.archives.push(name); }
  }
  function checkpoint() {
    settleSol();
    const rows = compact([...events.values()].sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp)));
    const ledger = createCapitalLedger(path.join(dir, 'capital-ledger.json'));
    const networks = {};
    for (const network of NETWORKS) {
      const subset = rows.filter(e => e.network === network);
      const groups = saved.legacy.map(g => g.filter(e => e.network === network));
      if (!subset.length && !groups.some(g => g.length)) continue;
      const adjustments = ledger.entries(network).map(e => ({ ...e, eventCount: subset.filter(x => Date.parse(x.timestamp) < Date.parse(e.at)).length }));
      const p = projectCapitalPortfolio(subset, { legacy: groups, capitalUsd: saved.capitalUsd, walletFunded: saved.capitalUsd === 0, capitalAdjustments: adjustments, activeNetwork: network }).performance;
      networks[network] = { paperCapitalUsd: p.paperCapitalUsd, realizedPnlUsd: p.realizedPnl };
    }
    saved = { ...saved, events: rows, networks };
    const fd = fs.openSync(filename + '.tmp', 'w');
    try { fs.writeFileSync(fd, JSON.stringify(saved)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(filename + '.tmp', filename);
    events.clear(); for (const e of rows) events.set(e.id, e);
  }
  return { add, checkpoint, sol: () => saved.sol ? structuredClone(saved.sol) : null,
    withdrawals: () => structuredClone(saved.withdrawals ?? []).reverse(),
    withdraw({ amountSol, toWallet, at, epoch }) {
      if (typeof amountSol !== 'number' || !Number.isFinite(amountSol) || amountSol <= 0) invalid('amountSol must be a finite number greater than 0');
      settleSol();
      const balance = saved.sol?.solBalance;
      if (!Number.isFinite(balance)) invalid('Paper SOL balance unavailable');
      // One lamport tolerance for floating-point settlement; never a chain fee.
      if (balance <= 0 || amountSol > balance + 1e-9) invalid('Insufficient paper SOL balance');
      if (balance - amountSol === balance) invalid('amountSol is too small');
      const entry = { id: 'paper-withdraw/' + randomUUID(), type: 'withdraw', amountSol, at, toWallet, epoch, amountUsd: amountSol * saved.sol.solPriceUsd };
      const before = structuredClone(saved);
      saved.sol.solBalance -= amountSol;
      saved.withdrawals = [...(saved.withdrawals ?? []), entry];
      try { checkpoint(); } catch (error) { saved = before; throw error; }
      return structuredClone(entry);
    },
    reference(priceUsd, at) {
      if (!(priceUsd > 0) || !Number.isFinite(priceUsd) || !Number.isFinite(at) || reference && at < reference.at) return;
      reference = { priceUsd, at };
      if (!saved.sol) checkpoint();
    }, events: () => [...events.values()], legacy: () => saved.legacy,
    importFile: file => readFile(file).forEach(add), registerArchive: file => saved.archives.push(path.basename(file)) };
}
module.exports = { createCapitalLedger, createCapitalAnchor, projectCapitalHistory, projectCapitalPortfolio };
