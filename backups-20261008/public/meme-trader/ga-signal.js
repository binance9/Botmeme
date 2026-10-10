// GA Signal golden contract v2. Display only; scanner and SMC remain server/engine owned.
const UP_INK = '#0ecb81', DOWN_INK = '#f6465d', REFERENCE_INK = '#c5cedb';
const FONT = '600 11px Inter, -apple-system, "Segoe UI", sans-serif';
const TERMINAL = new Set(['SL_HIT', 'EXPIRED', 'TP3_HIT']);
const STORAGE_KEY = 'meme-trader.gaSignal';
const TECHNICALS_KEY = 'meme-trader.gatechnicals';
const REPLAY_KEY = 'meme-trader.gaReplay';

function formatPrice(value) {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// The snapshot contains the latest journal event per setup, with event.side authoritative.
function selectSetups(setups, events) {
  const terminalIds = new Set(events.filter(e => (TERMINAL.has(e.type) || e.details?.completed)).map(e => e.setup_id));
  const unique = new Map(setups.map(s => [s.setup_id, s]));
  const sorted = [...unique.values()].sort((a, b) =>
    (b.details?.setup?.signal_time ?? 0) - (a.details?.setup?.signal_time ?? 0));
  const active = sorted.find(s => !TERMINAL.has(s.type) && !terminalIds.has(s.setup_id)) ?? null;
  return { setups: sorted, active };
}

export class GaSignalLayer {
  constructor() {
    this.rows = []; this.step = 900; this.setups = []; this.events = [];
    this.active = null; this.enabled = true;
    this.views = [this.view('bottom', true), this.view('top', false)];
  }
  view(order, background) {
    return { zOrder: () => order, renderer: () => ({ draw: target =>
      target.useMediaCoordinateSpace(scope => this.draw(scope, background)) }) };
  }
  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.chart = this.series = this.requestUpdate = null; }
  paneViews() { return this.views; }
  updateAllViews() {}
  autoscaleInfo() {
    if (!this.enabled || !this.active?.replay) return null;
    const receipt = this.active.details;
    const prices = [receipt.reference?.bottom, receipt.reference?.top, receipt.sl?.price,
      ...(receipt.targets ?? []).map(t => t.price)].filter(Number.isFinite);
    return prices.length ? { priceRange: { minValue: Math.min(...prices), maxValue: Math.max(...prices) } } : null;
  }
  setData({ rows, step, setups, events, active }) {
    this.rows = rows ?? []; this.step = step ?? this.step;
    this.setups = setups ?? []; this.events = events ?? []; this.active = active ?? null;
    this.requestUpdate?.();
  }
  x(time) {
    const rows = this.rows, scale = this.chart.timeScale();
    if (!rows.length || !Number.isFinite(time)) return null;
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].time < time) lo = mid + 1; else hi = mid; }
    if (lo === rows.length) return scale.logicalToCoordinate(rows.length - 1 + (time - rows.at(-1).time) / this.step);
    if (lo === 0) return scale.logicalToCoordinate((time - rows[0].time) / this.step);
    const left = rows[lo - 1];
    return scale.logicalToCoordinate(lo - 1 + (time - left.time) / (rows[lo].time - left.time));
  }
  draw({ context: ctx, mediaSize: size }, background = false) {
    // Section B's literal empty-state rule: no GA drawings without an active setup.
    if (!this.enabled || !this.chart || !this.rows.length || !this.active) return;
    const w = size.width, h = size.height;
    const y = price => Number.isFinite(price) ? this.series.priceToCoordinate(price) : null;
    const receipt = this.active.details ?? {};
    const valid = level => level?.reason && level?.anchor_id && Number.isFinite(level.price);
    const s = receipt.setup;
    const signalX = this.x(s?.signal_time);
    const hasZone = valid(receipt.reference) && Number.isFinite(receipt.reference.top) && Number.isFinite(receipt.reference.bottom);
    const reference = hasZone ? receipt.reference.price : null;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    ctx.font = FONT; ctx.lineWidth = .75; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const left = Math.max(0, signalX ?? w);
    if (background) {
      const band = (a, b, ink, alpha) => {
        const ya = y(a), yb = y(b);
        if (![signalX, ya, yb].every(Number.isFinite) || left >= w) return;
        ctx.fillStyle = ink; ctx.globalAlpha = alpha;
        ctx.fillRect(left, Math.min(ya, yb), w - left, Math.abs(yb - ya));
      };
      if (valid(receipt.targets?.at(-1))) band(reference, receipt.targets.at(-1).price, UP_INK, .07);
      if (valid(receipt.sl)) band(reference, receipt.sl.price, DOWN_INK, .07);
      if (hasZone) band(receipt.reference.bottom, receipt.reference.top, REFERENCE_INK, .035);
      ctx.restore(); return;
    }

    // Place level labels first, then direction tags, then TP event labels. Only our own
    // rectangles participate: SMC's BOS/CHoCH/Strong-Weak rendering is never modified.
    const labels = [];
    const queue = (text, xx, yy, ink, priority, pill = false, right = false) => {
      if (![xx, yy].every(Number.isFinite) || yy < 0 || yy > h || xx < 0 || xx > w) return;
      const width = ctx.measureText(text).width + (pill ? 12 : 4);
      labels.push({ text, x: Math.max(2, Math.min(w - width - 2, right ? w - width - 4 : xx - width / 2)),
        y: yy, width, ink, priority, pill, height: pill ? 15 : 12 });
    };
    const level = (price, text, ink, dashed, pill) => {
      const yy = y(price);
      if (![signalX, yy].every(Number.isFinite) || left >= w || yy < 0 || yy > h) return;
      // Target pills sit on their price; Reference and SL alone have horizontal lines.
      if (!pill) {
        ctx.strokeStyle = ink; ctx.setLineDash(dashed ? [4, 4] : []);
        ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(w, yy); ctx.stroke();
      }
      queue(text, w, yy, ink, 0, pill, true);
    };
    if (Number.isFinite(reference)) level(reference, `Reference Zone ${formatPrice(reference)} · ${receipt.reference.reason}`, REFERENCE_INK, false, false);
    if (valid(receipt.sl)) level(receipt.sl.price, `× SL ${formatPrice(receipt.sl.price)} · ${receipt.sl.reason}`, DOWN_INK, true, false);
    const hits = new Set(this.events.filter(e => e.setup_id === this.active.setup_id).map(e => e.type));
    for (let n = 1; n <= 3; n++) {
      const target = receipt.targets?.find(t => t.level === n), price = target?.price;
      if (valid(target)) level(price,
        `Target Point ${n} ${hits.has(`TP${n}_HIT`) ? '✓ ' : ''}${formatPrice(price)} · ${target.reason}`, UP_INK, false, true);
    }
    ctx.setLineDash([]);
    for (const setup of this.setups) {
      const detail = setup.details?.setup, xx = this.x(detail?.signal_time);
      const yy = y(detail?.entry_ref);
      if ((setup.side === 'LONG' || setup.side === 'SHORT') && Number.isFinite(yy)) {
        queue(setup.side === 'LONG' ? 'UP' : 'DOWN', xx,
          Math.max(8, Math.min(h - 8, yy + (setup.side === 'LONG' ? 20 : -20))),
          setup.side === 'LONG' ? UP_INK : DOWN_INK, 1, true);
      }
    }
    // Historical setups have only their direction tag and the actual TP-hit candles.
    const historicalIds = new Set(this.setups.filter(e => e.setup_id !== this.active.setup_id).map(e => e.setup_id));
    const seen = new Set();
    for (const event of this.events) {
      if (!historicalIds.has(event.setup_id) || !/^TP[123]_HIT$/.test(event.type)) continue;
      const time = event.candle_time ?? event.time;
      const key = `${event.setup_id}:${event.type}:${time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = event.details?.targets?.find(t => t.level === Number(event.type[2]));
      if (!valid(target)) continue;
      const xx = this.x(time), yy = y(target.price);
      if (![xx, yy].every(Number.isFinite) || xx < 0 || xx > w || yy < 0 || yy > h) continue;
      ctx.strokeStyle = UP_INK; ctx.beginPath();
      ctx.moveTo(xx, yy - 3); ctx.lineTo(xx + 3, yy); ctx.lineTo(xx, yy + 3);
      ctx.lineTo(xx - 3, yy); ctx.closePath(); ctx.stroke();
      queue(`◇ ${event.type.slice(0, 3)}`, xx, Math.max(8, Math.min(h - 8, yy - 12)), UP_INK, 2);
    }
    const placed = [];
    labels.sort((a, b) => a.priority - b.priority || a.y - b.y);
    for (const label of labels) {
      const pad = label.height / 2 + 1;
      const desired = Math.max(pad, Math.min(h - pad, label.y));
      let chosen = null;
      // Nearest free vertical slot, constrained to this pane; >=13px center separation.
      for (let distance = 0; distance <= h; distance += 1) {
        for (const yy of distance ? [desired + distance, desired - distance] : [desired]) {
          if (yy < pad || yy > h - pad) continue;
          if (placed.some(p => label.x < p.x + p.width + 3 && label.x + label.width + 3 > p.x &&
            Math.abs(yy - p.y) < Math.max(13, (label.height + p.height) / 2 + 2))) continue;
          chosen = yy; break;
        }
        if (chosen !== null) break;
      }
      if (chosen === null) continue; // Impossible cramped panes lose lowest-priority labels first.
      placed.push({ ...label, y: chosen });
      if (label.pill) {
        ctx.fillStyle = label.ink; ctx.beginPath();
        ctx.roundRect(label.x, chosen - label.height / 2, label.width, label.height, 4); ctx.fill();
      }
      ctx.fillStyle = label.pill ? '#08111d' : label.ink;
      ctx.fillText(label.text, label.x + (label.pill ? 6 : 2), chosen);
    }
    ctx.restore();
  }
}

// SMA-seeded EMA and Wilder smoothing: no premature warm-up values are displayed.
function ema(values, period) {
  const out = Array(values.length).fill(null);
  let value = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) { value = 0; count = 0; continue; }
    if (count < period) {
      value += values[i]; count++;
      if (count === period) { value /= period; out[i] = value; }
    } else { value += 2 / (period + 1) * (values[i] - value); out[i] = value; }
  }
  return out;
}
function technicalMetrics(rows) {
  const metrics = [], closes = rows.map(r => r.close), n = rows.length;
  const fast = ema(closes, 50).at(-1), slow = ema(closes, 200).at(-1);
  if (Number.isFinite(fast) && Number.isFinite(slow)) metrics.push(['Trend', fast > slow ? 'UP' : fast < slow ? 'DOWN' : 'RANGE']);
  let gain = 0, loss = 0, tr = 0, plus = 0, minus = 0, count = 0, dxCount = 0, adx = 0;
  let rsi = null, strength = null, directionalStrength = 0;
  const validCloses = closes.every(Number.isFinite);
  const validOHLC = rows.every(r => [r.high, r.low, r.close].every(Number.isFinite));
  if (validCloses) for (let i = 1; i < n; i++) {
    const delta = closes[i] - closes[i - 1], g = Math.max(0, delta), l = Math.max(0, -delta);
    if (i <= 14) { gain += g / 14; loss += l / 14; }
    else { gain = (gain * 13 + g) / 14; loss = (loss * 13 + l) / 14; }
    if (i >= 14) rsi = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  if (validOHLC) for (let i = 1; i < n; i++) {
    const a = rows[i - 1], b = rows[i];
    const up = b.high - a.high, down = a.low - b.low;
    const range = Math.max(b.high - b.low, Math.abs(b.high - a.close), Math.abs(b.low - a.close));
    const p = up > down && up > 0 ? up : 0, m = down > up && down > 0 ? down : 0;
    count++;
    if (count <= 14) { tr += range; plus += p; minus += m; }
    else { tr = tr - tr / 14 + range; plus = plus - plus / 14 + p; minus = minus - minus / 14 + m; }
    if (count < 14) continue;
    const pdi = tr === 0 ? 0 : 100 * plus / tr, mdi = tr === 0 ? 0 : 100 * minus / tr;
    const dx = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
    dxCount++;
    if (dxCount <= 14) adx += dx / 14;
    else adx = (adx * 13 + dx) / 14;
    if (dxCount >= 14) { strength = adx; directionalStrength = Math.sign(pdi - mdi); }
  }
  if (strength !== null) metrics.push(['ADX(14)', `${strength.toFixed(1)} ${strength >= 20 ? 'TRENDING' : 'RANGE'}`, strength >= 20 ? directionalStrength : 0]);
  if (rsi !== null) metrics.push(['RSI(14)', rsi.toFixed(1)]);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd = e12.map((v, i) => Number.isFinite(v) && Number.isFinite(e26[i]) ? v - e26[i] : null);
  const signal = ema(macd, 9).at(-1);
  if (Number.isFinite(signal) && Number.isFinite(macd.at(-1))) metrics.push(['MACD', macd.at(-1) - signal >= 0 ? 'Bull' : 'Bear']);
  const volumes = rows.slice(-20).map(r => r.volume);
  if (volumes.length === 20 && volumes.every(Number.isFinite)) {
    const average = volumes.reduce((sum, v) => sum + v, 0) / 20;
    metrics.push(['Volume', volumes.at(-1) > average ? 'Above' : 'Below', Math.sign(rows.at(-1).close - rows.at(-1).open)]);
  }
  return metrics;
}

export function mountGaSignal({ host, chart, eventBus, getState, setState, TIMEFRAMES }) {
  const controls = host.querySelector('.controls');
  const modeSeg = controls?.querySelector('.mode-seg');
  if (!modeSeg || modeSeg.parentElement !== controls) throw new Error('GA Signal requires the mounted topbar .controls > .mode-seg');
  const makeSwitch = (name, className) => {
    const el = document.createElement('button'); el.type = 'button'; el.className = `switch ${className}`;
    el.innerHTML = `<span class="track"><span class="knob"></span></span><span class="label">${name}</span>`;
    return el;
  };
  const button = makeSwitch('GA Signal', 'ga-switch');
  button.title = 'GA Signal: current risk/targets and historical signal markers';
  modeSeg.insertAdjacentElement('afterend', button);
  const status = document.createElement('span'); status.className = 'ga-status';
  status.title = 'GA Signal runtime (scanner server-side)'; status.setAttribute('role', 'status');
  button.insertAdjacentElement('afterend', status);
  const technicalsButton = makeSwitch('Technicals', 'ga-technicals-switch');
  status.insertAdjacentElement('afterend', technicalsButton);
  const panel = document.createElement('div'); panel.className = 'ga-technicals';
  panel.style.cssText = 'position:absolute;top:10px;width:190px;box-sizing:border-box;padding:8px;background:rgba(11,17,30,.92);border:1px solid #26354b;border-radius:5px;color:#c5cedb;font:10px Inter,sans-serif;z-index:3;overflow:auto;pointer-events:auto';
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font:inherit;table-layout:auto';
  const caption = document.createElement('caption'); caption.textContent = 'TECHNICALS';
  caption.style.cssText = 'text-align:left;font-weight:700;font-size:10px;padding-bottom:5px;letter-spacing:.6px';
  const tbody = document.createElement('tbody'); table.append(caption, tbody); panel.append(table);
  const replayControls = document.createElement('div'); replayControls.className = 'ga-replay';
  replayControls.style.cssText = 'font-size:9px;color:#f0b90b;margin-bottom:6px';
  const replayTag = document.createElement('span'); replayTag.setAttribute('role', 'status');
  const prev = document.createElement('button'), next = document.createElement('button');
  for (const [el, label] of [[prev, 'Prev'], [next, 'Next']]) {
    el.type = 'button'; el.textContent = label; el.title = `${label} replay receipt`;
    el.style.cssText = 'font:inherit;margin:4px 4px 0 0;padding:2px 5px;cursor:pointer';
  }
  replayControls.append(replayTag, document.createElement('br'), prev, next);
  panel.prepend(replayControls);
  chart.container.append(panel);

  const layer = new GaSignalLayer(); chart.candles.attachPrimitive(layer);
  let enabled = false, technicalsEnabled = true, generation = 0, inFlight = false;
  let pollTimer = null, disposed = false, controller = null, statusKind = 'SCANNING';
  try {
    enabled = localStorage.getItem(STORAGE_KEY) === '1';
    technicalsEnabled = localStorage.getItem(TECHNICALS_KEY) !== '0';
    if (localStorage.getItem(TECHNICALS_KEY) === null) localStorage.setItem(TECHNICALS_KEY, '1');
  } catch { /* Memory-only fallback. */ }
  let replayValue = new URLSearchParams(location.search).get('ga-replay');
  if (replayValue === null) try { replayValue = localStorage.getItem(REPLAY_KEY); } catch { /* Memory-only fallback. */ }
  const replayMode = replayValue !== null && replayValue !== '';
  let replayNumber = Number(replayValue), replayReceipts = null;
  if (!Number.isSafeInteger(replayNumber) || replayNumber < 1) replayNumber = 1;
  replayControls.hidden = !replayMode;
  replayTag.textContent = `REPLAY #${replayNumber} — structural receipt — loading`;
  prev.disabled = next.disabled = true;
  let { symbol, interval } = getState();
  let lastSelected = [], active = null, metrics = [], candleSignature = null, awaitingCandles = false;
  const previousDebug = window.__gaSignal;
  const debug = { enabled: () => enabled, lastRefreshAt: null, lastEventCount: 0, layer };
  window.__gaSignal = debug;

  function renderStatus(kind = statusKind) {
    statusKind = kind; status.hidden = !enabled;
    const inks = { SCANNING: '#f0b90b', ACTIVE_UP: UP_INK, ACTIVE_DOWN: DOWN_INK, NO_SIGNAL: '#8ea0bd', ERROR: DOWN_INK };
    status.style.cssText = `font:600 10px Inter,sans-serif;color:${inks[kind]}`;
    status.textContent = enabled ? (replayMode ? `REPLAY #${replayNumber} — structural receipt${kind === 'ERROR' ? ' — unavailable' : ''}` : `${kind === 'NO_SIGNAL' ? '○' : '●'} ${kind.replace('_', ' ')}`) : '';
  }
  function layoutPanel() {
    const right = chart.chart.priceScale('right').width() + 8;
    const left = chart.chart.priceScale('left').width();
    const available = chart.container.clientWidth - right - left - 8;
    const paneHeight = chart.chart.panes()[0]?.getHeight() ?? chart.container.clientHeight;
    panel.style.right = `${right}px`; panel.style.width = `${Math.max(0, Math.min(190, available))}px`;
    panel.style.maxHeight = `${Math.max(0, paneHeight - 20)}px`;
    panel.hidden = !enabled || (!technicalsEnabled && !replayMode);
    table.hidden = !technicalsEnabled;
  }
  function renderTechnicals() {
    tbody.replaceChildren();
    const values = [...metrics];
    if (active) values.push(['Signal Bias', active.side === 'LONG' ? 'UP' : 'DOWN']);
    for (const [name, value, semantic] of values) {
      const tr = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
      th.scope = 'row'; th.textContent = name; td.textContent = value;
      th.style.cssText = 'text-align:left;font-weight:400;padding:3px 3px 3px 0;color:#8ea0bd';
      td.style.cssText = 'text-align:right;padding:3px 0;font-variant-numeric:tabular-nums';
      const bullish = semantic > 0 || ['UP', 'Bull'].includes(value) || (name === 'RSI(14)' && Number(value) > 50);
      const bearish = semantic < 0 || ['DOWN', 'Bear'].includes(value) || (name === 'RSI(14)' && Number(value) < 50);
      td.style.color = bullish ? UP_INK : bearish ? DOWN_INK : '#c5cedb';
      tr.append(th, td); tbody.append(tr);
    }
    layoutPanel();
  }
  function renderControls() {
    for (const [el, on] of [[button, enabled], [technicalsButton, technicalsEnabled]]) {
      el.classList.toggle('on', on); el.setAttribute('aria-pressed', String(on));
    }
    layer.enabled = enabled; layer.requestUpdate?.(); renderStatus(); layoutPanel();
  }
  function clearLayer() {
    lastSelected = []; active = null;
    layer.setData({ rows: [], step: TIMEFRAMES[getState().interval], setups: [], events: [], active: null });
    renderTechnicals();
  }
  function renderReplay() {
    const receipt = replayReceipts?.find(r => r.n === replayNumber);
    if (receipt && (getState().symbol !== receipt.symbol || getState().interval !== receipt.timeframe)) {
      setState({ symbol: receipt.symbol, interval: receipt.timeframe });
    }
    const index = replayReceipts?.indexOf(receipt) ?? -1;
    replayTag.textContent = `REPLAY #${replayNumber} — structural receipt${receipt ? '' : ' — unavailable'}`;
    prev.disabled = index <= 0; next.disabled = index < 0 || index >= replayReceipts.length - 1;
    active = receipt ? { ...receipt, replay: true, type: 'SETUP_CREATED',
      details: { reference: receipt.reference, sl: receipt.sl, targets: receipt.targets,
        setup: { signal_time: receipt.signal_time, entry_ref: receipt.entry_ref } } } : null;
    lastSelected = active ? [active] : [];
    layer.setData({ rows: awaitingCandles ? [] : chart.rows, step: TIMEFRAMES[getState().interval],
      setups: lastSelected, events: [], active });
    renderStatus(receipt ? (receipt.side === 'LONG' ? 'ACTIVE_UP' : 'ACTIVE_DOWN') : 'ERROR');
    renderTechnicals();
  }
  function stepReplay(delta) {
    const index = replayReceipts?.findIndex(r => r.n === replayNumber) ?? -1;
    const receipt = replayReceipts?.[index + delta];
    if (!receipt || index < 0) return;
    replayNumber = receipt.n;
    try { localStorage.setItem(REPLAY_KEY, String(replayNumber)); } catch { /* Memory-only fallback. */ }
    const url = new URL(location.href); url.searchParams.set('ga-replay', String(replayNumber));
    history.replaceState(history.state, '', url);
    renderReplay();
  }
  const previousReplay = () => stepReplay(-1), nextReplay = () => stepReplay(1);
  prev.addEventListener('click', previousReplay); next.addEventListener('click', nextReplay);
  async function refresh() {
    if (disposed || inFlight) return;
    const { symbol: reqSymbol, interval: reqTimeframe } = getState();
    const reqGeneration = ++generation;
    inFlight = true; controller = new AbortController();
    renderStatus('SCANNING');
    const isCurrent = () => {
      const current = getState();
      return !disposed && reqGeneration === generation && current.symbol === reqSymbol && current.interval === reqTimeframe;
    };
    try {
      if (replayMode) {
        if (!replayReceipts) {
          const res = await fetch('/api/ga-signal/replay', { signal: controller.signal });
          if (!isCurrent()) return;
          if (!res.ok) { renderReplay(); return; }
          const body = await res.json();
          if (!isCurrent()) return;
          if (!Array.isArray(body.receipts)) throw new Error('Invalid replay receipts');
          replayReceipts = body.receipts;
        }
        renderReplay(); return;
      }
      const res = await fetch(`/api/ga-signal/snapshot?symbol=${encodeURIComponent(reqSymbol)}&timeframe=${encodeURIComponent(reqTimeframe)}`, { signal: controller.signal });
      if (!isCurrent() || !res.ok) { if (isCurrent()) renderStatus('ERROR'); return; }
      const body = await res.json();
      if (!isCurrent()) return;
      const belongs = e => e.symbol === reqSymbol && e.timeframe === reqTimeframe;
      const events = (body.events ?? []).filter(belongs);
      const selected = selectSetups((body.setups ?? []).filter(belongs), events);
      lastSelected = selected.setups; active = selected.active;
      const ids = new Set(lastSelected.map(s => s.setup_id));
      layer.setData({ rows: awaitingCandles ? [] : chart.rows, step: TIMEFRAMES[reqTimeframe],
        setups: lastSelected, events: events.filter(e => ids.has(e.setup_id)), active });
      debug.lastRefreshAt = Date.now(); debug.lastEventCount = events.length; debug.lastSeq = body.lastSeq;
      renderStatus(!active ? 'NO_SIGNAL' : active.side === 'LONG' ? 'ACTIVE_UP' : 'ACTIVE_DOWN');
      renderTechnicals();
    } catch { if (isCurrent()) renderStatus('ERROR'); }
    finally { if (reqGeneration === generation) { inFlight = false; controller = null; } }
  }
  function toggle() {
    if (disposed) return;
    enabled = !enabled;
    try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch { /* Memory-only fallback. */ }
    renderControls(); if (enabled) void refresh();
  }
  function toggleTechnicals() {
    if (disposed) return;
    technicalsEnabled = !technicalsEnabled;
    try { localStorage.setItem(TECHNICALS_KEY, technicalsEnabled ? '1' : '0'); } catch { /* Memory-only fallback. */ }
    renderControls();
  }
  button.addEventListener('click', toggle); technicalsButton.addEventListener('click', toggleTechnicals);
  const offChange = eventBus.on('state:change', () => {
    if (disposed) return;
    const current = getState();
    if (current.symbol === symbol && current.interval === interval) return;
    symbol = current.symbol; interval = current.interval;
    generation++; controller?.abort(); controller = null; inFlight = false;
    awaitingCandles = true; metrics = []; candleSignature = null;
    clearLayer(); void refresh();
  });
  const offLoaded = eventBus.on('chart:loaded', () => {
    if (disposed) return;
    awaitingCandles = false;
    candleTick();
    layer.setData({ rows: chart.rows, step: TIMEFRAMES[getState().interval], setups: lastSelected, events: layer.events, active });
    void refresh();
  });
  // ChartCore mutates chart.rows on live updates without emitting chart:loaded. Observe
  // its normalized values once per second; no chart/engine methods need patching.
  function candleTick() {
    if (disposed || awaitingCandles) return;
    const signature = JSON.stringify(chart.rows.map(r => [r.time, r.high, r.low, r.close, r.volume]));
    if (signature !== candleSignature) {
      candleSignature = signature; metrics = technicalMetrics(chart.rows);
      layer.setData({ rows: chart.rows, step: TIMEFRAMES[getState().interval], setups: lastSelected, events: layer.events, active });
      renderTechnicals();
    } else layoutPanel();
  }
  // OFF affects presentation only; it never stops the scanner.
  function pollLoop() {
    if (disposed) return;
    pollTimer = setTimeout(async () => { await refresh(); pollLoop(); }, 10000);
  }
  const observer = new ResizeObserver(layoutPanel); observer.observe(chart.container);
  renderControls(); candleTick();
  const technicalsTimer = setInterval(candleTick, 1000);
  void refresh(); pollLoop();
  return function dispose() {
    if (disposed) return;
    disposed = true; generation++; controller?.abort();
    clearTimeout(pollTimer); clearInterval(technicalsTimer); observer.disconnect();
    offChange(); offLoaded();
    button.removeEventListener('click', toggle); technicalsButton.removeEventListener('click', toggleTechnicals);
    prev.removeEventListener('click', previousReplay); next.removeEventListener('click', nextReplay);
    button.remove(); status.remove(); technicalsButton.remove(); panel.remove();
    chart.candles.detachPrimitive(layer);
    if (window.__gaSignal === debug) {
      if (previousDebug === undefined) delete window.__gaSignal; else window.__gaSignal = previousDebug;
    }
  };
}
