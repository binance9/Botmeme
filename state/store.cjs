'use strict';
const fs = require('node:fs');
const path = require('node:path');

const AGENTS = [
  { id: 'jev', name: 'JEV', role: 'Meme Hunter' },
  { id: 'codex-1', name: 'CODEX 1', role: 'Commander' },
  { id: 'codex-2', name: 'CODEX 2', role: 'Quant Learner' },
  { id: 'codex-3', name: 'CODEX 3', role: 'Forensic Analyst' }
];
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, label, limit = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(`Invalid ${label}`);
  return value;
}
function number(value, label, min = 0, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) fail(`Invalid ${label}`);
  return value;
}
function keys(object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail('Expected an object');
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(`Unexpected field: ${key}`);
}
function identity(value, label) {
  text(value, label, 120);
  if (!/^[\w:./-]+$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail(`Invalid ${label}`);
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('occurredAt must be an ISO UTC timestamp');
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0,19) !== value.slice(0,19)) fail('Invalid calendar timestamp');
  return normalized;
}
function stable(value) { return JSON.stringify(value, function(_key, item) { return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item; }); }
function day(at) { return new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
const usd = value => Number(value.toFixed(8)); // Paper ledger precision: 10^-8 USD.
const quantity = value => Number(value.toPrecision(15));
function initialState() {
  return { version: 0, updatedAt: null, budgetUsd: null, activeToken: null,
    agents: AGENTS.map(a => ({ ...a, status: 'waiting', task: 'Chờ dữ liệu', taskId: null, completed: 0, total: null, progress: null, updatedAt: null })),
    scan: null, scanRuns: [], markets: {}, positions: {}, fills: [], activities: [] };
}
function actor(state, source) { return state.agents.find(a => a.id === source); }
function requireSource(event, allowed) { if (!allowed.includes(event.source)) fail(`Source ${event.source} cannot publish ${event.type}`, 403); }
function addActivity(state, event, agentId, message) {
  state.activities.unshift({ id: event.id, type: event.type, agentId, source: event.source, message, occurredAt: event.occurredAt });
  state.activities.length = Math.min(state.activities.length, 200);
}
function token(state, tokenId, symbol) {
  identity(tokenId, 'tokenId'); text(symbol, 'symbol', 24);
  const existing = state.markets[tokenId];
  if (existing && existing.symbol !== symbol) fail('Token symbol conflicts with existing identity', 409);
  if (!existing) state.markets[tokenId] = { tokenId, symbol, priceUsd: null, firstPriceUsd: null, updatedAt: null, candles: [] };
  return state.markets[tokenId];
}

/** Apply exactly one validated producer event; never generates work, prices or trades. */
function reduce(previous, event) {
  const state = structuredClone(previous), data = event.data;
  const jev = actor(state, 'jev');
  switch (event.type) {
    case 'scan.started': {
      requireSource(event, ['scanner']); keys(data, ['runId', 'total']);
      identity(data.runId, 'runId'); number(data.total, 'total', 0, true);
      if (jev.updatedAt && event.occurredAt < jev.updatedAt) fail('Stale scanner event', 409);
      if (state.scan?.status === 'running') fail('A scan is already running', 409);
      if (state.scanRuns.includes(data.runId)) fail('Scan runId must be new', 409);
      state.scanRuns.push(data.runId);
      state.scan = { runId: data.runId, total: data.total, completed: 0, failed: 0, found: 0, candidates: 0, items: [], tokens: [], status: 'running' };
      Object.assign(jev, { taskId: data.runId, task: 'Đang quét token...', status: 'running', completed: 0, total: data.total, progress: 0, updatedAt: event.occurredAt });
      addActivity(state, event, 'jev', `Bắt đầu quét ${data.total} hạng mục`);
      break;
    }
    case 'scan.item': {
      requireSource(event, ['scanner']); keys(data, ['runId', 'itemId', 'tokenId', 'symbol', 'candidate', 'error']);
      identity(data.itemId, 'itemId');
      const scan = state.scan;
      if (!scan || scan.status !== 'running' || scan.runId !== data.runId) fail('No matching running scan', 409);
      if (event.occurredAt < jev.updatedAt) fail('Stale scanner event', 409);
      if (scan.items.includes(data.itemId)) fail('Scan item already counted', 409);
      if (scan.completed >= scan.total) fail('Scan exceeds declared total', 409);
      if (data.error !== undefined) {
        text(data.error, 'error');
        if (data.tokenId !== undefined || data.symbol !== undefined || data.candidate !== undefined) fail('Failed item cannot also be a discovery');
        scan.failed++;
      } else if (data.tokenId !== undefined) {
        token(state, data.tokenId, data.symbol);
        if (typeof data.candidate !== 'boolean') fail('candidate must be boolean');
        if (!scan.tokens.includes(data.tokenId)) { scan.tokens.push(data.tokenId); scan.found++; if (data.candidate) scan.candidates++; }
      } else if (data.candidate !== undefined || data.symbol !== undefined) fail('Discovery requires tokenId');
      scan.items.push(data.itemId); scan.completed++;
      Object.assign(jev, { completed: scan.completed, progress: Math.floor(100 * scan.completed / scan.total), updatedAt: event.occurredAt });
      addActivity(state, event, 'jev', data.error ? `Lỗi quét ${data.itemId}: ${data.error}` : `Đã quét ${scan.completed}/${scan.total}${data.symbol ? ` • ${data.symbol}` : ''}`);
      break;
    }
    case 'scan.finished':
    case 'scan.failed': {
      requireSource(event, ['scanner']); keys(data, event.type === 'scan.failed' ? ['runId', 'error'] : ['runId']);
      const scan = state.scan;
      if (!scan || scan.status !== 'running' || scan.runId !== data.runId) fail('No matching running scan', 409);
      if (event.occurredAt < jev.updatedAt) fail('Stale scanner event', 409);
      if (event.type === 'scan.finished' && scan.completed !== scan.total) fail('Cannot finish an incomplete scan', 409);
      if (event.type === 'scan.failed') text(data.error, 'error');
      scan.status = event.type === 'scan.failed' || scan.failed > 0 ? 'error' : 'done';
      Object.assign(jev, { status: scan.status, task: scan.status === 'error' ? 'Quét có lỗi' : 'Đã hoàn tất quét', updatedAt: event.occurredAt });
      addActivity(state, event, 'jev', data.error || `Quét xong ${scan.completed}/${scan.total} • ${scan.failed} lỗi`);
      break;
    }
    case 'ai.work': {
      requireSource(event, ['codex-1', 'codex-2', 'codex-3']); keys(data, ['taskId', 'task', 'status', 'completed', 'total']);
      identity(data.taskId, 'taskId'); text(data.task, 'task'); number(data.completed, 'completed', 0, true); number(data.total, 'total', 0, true);
      if (!['running', 'done', 'error', 'waiting'].includes(data.status)) fail('Invalid AI status');
      if (data.completed > data.total || (data.status === 'done' && data.completed !== data.total)) fail('Invalid AI work counts');
      const agent = actor(state, event.source);
      if (agent.updatedAt && event.occurredAt < agent.updatedAt) fail('Stale AI event', 409);
      if (agent.taskId === data.taskId && (data.completed < agent.completed || data.total !== agent.total)) fail('Work counters cannot regress or change denominator', 409);
      Object.assign(agent, data, { progress: data.total ? Math.floor(100 * data.completed / data.total) : 0, updatedAt: event.occurredAt });
      addActivity(state, event, agent.id, `${data.task} (${data.completed}/${data.total})`);
      break;
    }
    case 'activity.logged': {
      requireSource(event, ['scanner', 'codex-1', 'codex-2', 'codex-3']); keys(data, ['message']); text(data.message, 'message', 300);
      addActivity(state, event, event.source === 'scanner' ? 'jev' : event.source, data.message);
      break;
    }
    case 'portfolio.configured': {
      requireSource(event, ['operator']); keys(data, ['budgetUsd']); number(data.budgetUsd, 'budgetUsd', Number.MIN_VALUE);
      state.budgetUsd = data.budgetUsd;
      break;
    }
    case 'market.tick': {
      requireSource(event, ['market']); keys(data, ['tokenId', 'symbol', 'priceUsd', 'volumeUsd']);
      number(data.priceUsd, 'priceUsd', Number.MIN_VALUE); number(data.volumeUsd, 'volumeUsd');
      const market = token(state, data.tokenId, data.symbol);
      if (market.updatedAt && event.occurredAt < market.updatedAt) fail('Out-of-order price tick', 409);
      market.firstPriceUsd ??= data.priceUsd;
      market.priceUsd = data.priceUsd; market.updatedAt = event.occurredAt;
      const at = Math.floor(Date.parse(event.occurredAt) / 60000) * 60000;
      const last = market.candles.at(-1);
      if (last?.at === at) {
        last.close = data.priceUsd; last.high = Math.max(last.high, data.priceUsd); last.low = Math.min(last.low, data.priceUsd); last.volumeUsd += data.volumeUsd;
      } else market.candles.push({ at, open: data.priceUsd, high: data.priceUsd, low: data.priceUsd, close: data.priceUsd, volumeUsd: data.volumeUsd });
      if (market.candles.length > 2880) market.candles.shift();
      state.activeToken ??= data.tokenId;
      break;
    }
    case 'trade.filled': {
      requireSource(event, ['paper-ledger']); keys(data, ['fillId', 'positionId', 'mode', 'tokenId', 'symbol', 'side', 'quantity', 'priceUsd', 'feeUsd']);
      identity(data.fillId, 'fillId'); identity(data.positionId, 'positionId');
      if (data.mode !== 'paper') fail('Real-money fills and order execution are disabled', 403);
      if (!['BUY', 'SELL'].includes(data.side)) fail('Invalid trade side');
      number(data.quantity, 'quantity', Number.MIN_VALUE); number(data.priceUsd, 'priceUsd', Number.MIN_VALUE); number(data.feeUsd, 'feeUsd');
      if (quantity(data.quantity) !== data.quantity || usd(data.quantity * data.priceUsd) <= 0 || data.quantity * data.priceUsd > 1e9) fail('Fill exceeds supported paper-ledger precision/range');
      if (state.fills.some(fill => fill.fillId === data.fillId)) fail('fillId already recorded', 409);
      token(state, data.tokenId, data.symbol);
      let position = state.positions[data.positionId];
      if (position && (position.tokenId !== data.tokenId || position.closedAt)) fail('Position identity is closed or conflicts', 409);
      if (position && event.occurredAt < position.updatedAt) fail('Out-of-order position fill', 409);
      if (!position) {
        if (data.side !== 'BUY') fail('SELL requires an existing position', 409);
        position = state.positions[data.positionId] = { positionId: data.positionId, tokenId: data.tokenId, symbol: data.symbol, quantity: 0, costUsd: 0, investedUsd: 0, boughtQuantity: 0, soldQuantity: 0, proceedsUsd: 0, realizedPnlUsd: 0, openedAt: event.occurredAt, closedAt: null };
      }
      let realizedPnlUsd = 0;
      if (data.side === 'BUY') {
        const cost = usd(data.quantity * data.priceUsd + data.feeUsd);
        position.quantity = quantity(position.quantity + data.quantity); position.costUsd = usd(position.costUsd + cost); position.investedUsd = usd(position.investedUsd + cost); position.boughtQuantity = quantity(position.boughtQuantity + data.quantity);
      } else {
        if (data.quantity > position.quantity) fail('SELL quantity exceeds open position', 409);
        const fullyClosed = data.quantity === position.quantity;
        const cost = fullyClosed ? position.costUsd : usd(position.costUsd * data.quantity / position.quantity);
        const proceeds = usd(data.quantity * data.priceUsd - data.feeUsd);
        realizedPnlUsd = usd(proceeds - cost);
        position.quantity = fullyClosed ? 0 : quantity(position.quantity - data.quantity);
        position.costUsd = fullyClosed ? 0 : usd(position.costUsd - cost);
        position.soldQuantity = quantity(position.soldQuantity + data.quantity); position.proceedsUsd = usd(position.proceedsUsd + proceeds); position.realizedPnlUsd = usd(position.realizedPnlUsd + realizedPnlUsd);
        if (fullyClosed) position.closedAt = event.occurredAt;
      }
      Object.assign(position, { side: data.side, updatedAt: event.occurredAt, lastVersion: state.version + 1 });
      state.fills.push({ ...data, occurredAt: event.occurredAt, realizedPnlUsd });
      state.activeToken = data.tokenId;
      // Ledger events belong to the ledger, never impersonate the forensic analyst.
      addActivity(state, event, null, `${data.side} ${data.symbol} • ${data.quantity} @ $${data.priceUsd} (paper)`);
      break;
    }
    default: fail(`Unknown event type: ${event.type}`);
  }
  // Reject arithmetic overflow rather than serializing NaN/Infinity into a snapshot.
  JSON.stringify(state, (_key, value) => { if (typeof value === 'number' && !Number.isFinite(value)) fail('Numeric overflow'); return value; });
  state.version++; state.updatedAt = event.occurredAt;
  return state;
}

function project(state, now = new Date()) {
  const snapshot = structuredClone(state), today = day(now);
  for (const agent of snapshot.agents) {
    agent.total = null;
    if (agent.id !== 'jev' || snapshot.scan?.status !== 'running') agent.progress = null;
    if (agent.id === 'jev' && snapshot.scan) agent.metric = { done: snapshot.scan.completed, total: null, label: 'Token đã quét' };
  }
  const fillsToday = state.fills.filter(fill => day(fill.occurredAt) === today);
  const positions = Object.values(state.positions);
  const closedToday = positions.filter(p => p.closedAt && day(p.closedAt) === today);
  snapshot.summary = {
    day: today, realizedPnlUsd: usd(fillsToday.reduce((n, f) => n + f.realizedPnlUsd, 0)),
    totalTrades: fillsToday.length, openPositions: positions.filter(p => p.quantity > 0).length,
    winRate: closedToday.length ? 100 * closedToday.filter(p => p.realizedPnlUsd > 0).length / closedToday.length : null,
    capitalUsedUsd: usd(positions.reduce((n, p) => n + p.costUsd, 0)), budgetUsd: state.budgetUsd
  };
  snapshot.trades = positions.sort((a, b) => b.lastVersion - a.lastVersion).map(p => {
    const market = state.markets[p.tokenId];
    const unrealized = p.quantity === 0 ? 0 : market?.priceUsd != null ? usd(p.quantity * market.priceUsd - p.costUsd) : null;
    const pnlUsd = unrealized === null ? null : usd(p.realizedPnlUsd + unrealized);
    return { ...p, status: p.quantity === 0 ? 'closed' : 'open', entryPriceUsd: p.investedUsd / p.boughtQuantity,
      exitPriceUsd: p.soldQuantity ? p.proceedsUsd / p.soldQuantity : null, pnlUsd, pnlPct: pnlUsd === null ? null : 100 * pnlUsd / p.investedUsd };
  });
  // Internal counters and the full fill ledger stay on the server.
  delete snapshot.fills; delete snapshot.positions; delete snapshot.scanRuns;
  if (snapshot.scan) { delete snapshot.scan.items; delete snapshot.scan.tokens; }
  snapshot.asOf = new Date(now).toISOString();
  return snapshot;
}

function createStore({ journalPath, now = () => new Date() } = {}) {
  let state = initialState(), descriptor = null;
  const seen = new Map(), subscribers = new Set();
  function normalize(input) {
    keys(input, ['id', 'type', 'source', 'occurredAt', 'data']);
    identity(input.id, 'event id'); text(input.type, 'type'); identity(input.source, 'source');
    const event = structuredClone(input); event.occurredAt = timestamp(input.occurredAt);
    if (Date.parse(event.occurredAt) > new Date(now()).getTime() + 60000) fail('Event timestamp is in the future');
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) fail('Invalid event data');
    return event;
  }
  if (journalPath) {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    if (fs.existsSync(journalPath)) {
      const journal = fs.readFileSync(journalPath, 'utf8');
      if (journal && !journal.endsWith('\n')) throw new Error('Incomplete event journal; refusing silent data loss');
      for (const line of journal.split('\n').filter(Boolean)) {
        const record = JSON.parse(line), event = normalize(record.event);
        if (record.version !== state.version + 1 || seen.has(event.id)) throw new Error('Invalid journal sequence');
        state = reduce(state, event); seen.set(event.id, { body: stable(event), version: state.version });
      }
    }
    descriptor = fs.openSync(journalPath, 'a');
  }
  let closed = false;
  return {
    snapshot: () => project(state, now()),
    publish(input) {
      if (closed) fail('Store is closed', 503);
      const event = normalize(input), body = stable(event), duplicate = seen.get(event.id);
      if (duplicate) {
        if (duplicate.body !== body) fail('Event id reused with different payload', 409);
        return { duplicate: true, version: duplicate.version, snapshot: project(state, now()) };
      }
      const next = reduce(state, event);
      if (descriptor !== null) {
        try { fs.writeFileSync(descriptor, JSON.stringify({ version: next.version, event }) + '\n'); fs.fsyncSync(descriptor); }
        catch (error) { closed = true; throw Object.assign(new Error(`Journal write failed: ${error.code || error.message}`), { status: 503 }); }
      }
      state = next; seen.set(event.id, { body, version: state.version });
      const snapshot = project(state, now());
      for (const subscriber of subscribers) { try { subscriber(snapshot); } catch { subscribers.delete(subscriber); } }
      return { duplicate: false, version: state.version, snapshot };
    },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    close() { closed = true; subscribers.clear(); if (descriptor !== null) { fs.closeSync(descriptor); descriptor = null; } }
  };
}
module.exports = { createStore, AGENTS };
