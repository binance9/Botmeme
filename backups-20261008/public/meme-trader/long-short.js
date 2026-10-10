/* UI-MERGE — LONG/SHORT view inside Meme Trader (component integration, no iframe).
   Reuses the GA Trade Chart modules served same-origin from /ga-assets/ (backed by
   the GA gateway /api/bot/* proxied on this origin). The Meme Trader shell stays
   untouched: this module only owns #long-short-view, the trades mode bar, and the
   sidebar BOTS widget. Event namespaces stay separate:
     MEME:*       -> /api/events  (meme runtime, app.js)
     LONG_SHORT:* -> /api/bot/*   (GA gateway, this module) */
'use strict';
import { ChartCore } from '/ga-assets/js/chart/chart-core.mjs';
import * as LightweightCharts from '/ga-assets/vendor/lightweight-charts.bundle.mjs';
import { ChartCoordinator } from '/ga-assets/js/chart/dieu-phoi-khong-gian-bieu-do.js';
import { eventBus, SMC_EVENT } from '/ga-assets/js/core/event-bus.mjs';
import { getState, setState } from '/ga-assets/js/core/state.mjs';
import { createProvider } from '/ga-assets/js/market/provider-registry.mjs';
import { TIMEFRAMES } from '/ga-assets/js/market/provider-interface.mjs';
import { mountTopbar } from '/ga-assets/js/ui/topbar.mjs';
import { mountLeftToolbar } from '/ga-assets/js/ui/left-toolbar.mjs';
import { mountWatchlist } from '/ga-assets/js/ui/watchlist.mjs';
import { mountSettingsPanel } from '/ga-assets/js/ui/settings-panel.mjs';
import { mountBotPanel } from '/ga-assets/js/ui/bot-panel.mjs';
import { mountBotActivity } from '/ga-assets/js/ui/bot-activity.mjs';
import { mountBottomBar } from '/ga-assets/js/ui/bottom-bar.mjs';
import { startQuotes } from '/ga-assets/js/bot/quotes.mjs';
import { createBotStore } from '/ga-assets/js/bot/bot-store.mjs';
import { startBotClient } from '/ga-assets/js/bot/bot-client.mjs';
import { eventsToMarkers } from '/ga-assets/js/bot/marker-mapper.mjs';
import { BotMarkerPrimitive } from '/ga-assets/js/bot/marker-primitive.mjs';
import { applySmcMode } from '/ga-assets/js/smc/presets.mjs';
import { mountGaSignal } from './ga-signal.js';

const $ = document.querySelector.bind(document);
const LS = '#long-short-view';
const MODE_KEY = 'meme-trader.tradesMode';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- tab controller (section 2/15) ---------------- */
const TradesMode = {
  saved: () => localStorage.getItem(MODE_KEY) === 'long-short' ? 'long-short' : 'meme',
  current: 'meme',
  fromHash() { return location.hash === '#long-short' ? 'long-short' : location.hash === '#meme-trades' ? 'meme' : null; },
  apply(mode, { save = true, updateHash = true } = {}) {
    if (mode) this.current = mode;
    const view = $(LS), grid = $('.content-grid');
    const entering = this.current === 'long-short';
    if (entering && !view.dataset.mounted) mountLongShortView();
    if (entering && !view.hidden) return finish();
    if (entering) TradesMode.scrollRestore = window.scrollY;
    view.hidden = !entering;
    grid.style.display = entering ? 'none' : '';
    document.body.classList.toggle('mode-long-short', entering);
    if (!entering && TradesMode.scrollRestore != null) window.scrollTo({ top: TradesMode.scrollRestore });
    if (entering) { window.scrollTo({ top: 0 }); setTimeout(() => { window.dispatchEvent(new Event('resize')); window.LongShortHub?.resizeChart(); }, 80); setTimeout(() => window.LongShortHub?.resizeChart(), 350); }
    finish();
    function finish() {
      document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.mode === TradesMode.current)));
      if (save) localStorage.setItem(MODE_KEY, TradesMode.current);
      if (updateHash) {
        const hash = TradesMode.current === 'long-short' ? '#long-short' : '#meme-trades';
        if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
      }
    }
  },
  // Sidebar navigation: Trades re-opens the remembered tab, everything else shows the meme page.
  onNav(hash) {
    if (hash === '#trades') this.apply(this.saved());
    else if (['#home', '#agents', '#overview'].includes(hash)) this.apply('meme', { save: false, updateHash: false });
  },
};

/* ---------------- GA chart stack (mounted once, kept alive) ---------------- */
let chart, coordinator, provider, generation = 0, fallbackTimer, usingFallback = false, disposed = false;
let botStore, botMarkers, pendingFocus = null;
const disposers = [];
const showChartStatus = (text, kind = '') => { const el = $('#ls-connection-status'); el.textContent = text; el.dataset.kind = kind; };

function refreshMarkers() {
  if (!botMarkers) return;
  const state = getState();
  botMarkers.rows = chart.rows; botMarkers.step = TIMEFRAMES[state.interval];
  botMarkers.setData(eventsToMarkers(botStore.state.activity, { symbol: state.symbol, timeframe: state.interval.toUpperCase() }));
}
function focusPending() {
  const position = pendingFocus;
  if (!position || disposed || !chart.rows.length) return;
  if (getState().symbol !== position.symbol) return;
  const entry = botStore.state.activity.find(event => event.event_id === `ft-${position.trade_id}-entry`);
  const ftPosition = botStore.state.ft?.positions?.find(item => item.trade_id === position.trade_id);
  chart.focusPosition({
    time: entry?.candle_time ?? chart.rows.at(-1)?.time,
    entry: ftPosition?.entry ?? entry?.price,
    sl: ftPosition?.sl ?? entry?.details?.sl, tp: ftPosition?.tp ?? null,
  });
  botMarkers.setFocused(`ft-${position.trade_id}-entry`);
  pendingFocus = null;
}

async function loadMarket(forceSynthetic = false) {
  window.__smc.loadMarketCalls++;
  const id = ++generation, state = getState();
  provider?.close(); clearTimeout(fallbackTimer);
  usingFallback = forceSynthetic && state.provider === 'binance';
  coordinator.reset(state, createProvider(forceSynthetic ? 'synthetic' : state.provider));
  chart.setData([]);
  $('#ls-chart-symbol').textContent = `${state.symbol} · ${state.interval.toUpperCase()}`;
  // Feed trace: the provider registry serves api.binance.com SPOT endpoints (verified by JEV audit) —
  // the label must not claim FUTURES while the data is spot.
  $('#ls-chart-source').textContent = forceSynthetic || state.provider === 'synthetic' ? 'SYNTHETIC / DEMO' : 'BINANCE / SPOT';
  $('#ls-loading').hidden = false; showChartStatus('Loading market data…');
  const active = provider = createProvider(forceSynthetic ? 'synthetic' : state.provider, {
    onStatus(connection) {
      if (id !== generation) return;
      eventBus.emit('feed:status', connection === 'live' ? 'live' : 'down');
      showChartStatus(connection === 'live' ? 'Live · Binance' : connection === 'connecting' ? 'Connecting stream…' : 'Reconnecting stream…', connection === 'live' ? 'live' : 'warning');
      if (connection === 'live') { clearTimeout(fallbackTimer); fallbackTimer = null; }
      else if (!fallbackTimer) fallbackTimer = setTimeout(() => { if (id === generation) void loadMarket(true); }, 45000);
    },
  });
  try {
    const rows = await active.getCandles(state.symbol, state.interval, 1000);
    if (id !== generation || disposed) return;
    chart.setData(rows); $('#ls-loading').hidden = true; eventBus.emit('chart:loaded');
    if (forceSynthetic || state.provider === 'synthetic') showChartStatus(usingFallback ? 'Offline · Synthetic demo · retrying Binance' : 'Synthetic demo data', 'warning');
    active.subscribeKline((row, metadata) => { if (id === generation && !disposed) chart.update(row, metadata); });
  } catch (error) {
    if (id !== generation || disposed) return;
    if (!forceSynthetic && state.provider === 'binance') { await loadMarket(true); return; }
    $('#ls-loading').hidden = true; showChartStatus(`Data unavailable: ${error.message}`, 'warning');
  }
}
let probing = false;
async function recover() {
  if (!usingFallback || probing || disposed || getState().provider !== 'binance') return;
  probing = true;
  const id = generation, state = getState(), probe = createProvider('binance');
  try { await probe.getCandles(state.symbol, state.interval, 1); if (id === generation && !disposed) await loadMarket(); }
  catch { /* keep the offline chart running */ }
  finally { probe.close(); probing = false; }
}

function mountLongShortView() {
  const view = $(LS);
  view.dataset.mounted = 'true';
  setState({ smc: applySmcMode(getState().smcMode, getState().smc) }); // PRO is the honest default
  chart = new ChartCore($('#ls-chart-container'), LightweightCharts, 'dark');
  coordinator = new ChartCoordinator(chart, getState());
  chart.coordinator = coordinator; // ChartCore delegates SMC computation through this handle
  botStore = createBotStore();
  botMarkers = new BotMarkerPrimitive();
  chart.candles.attachPrimitive(botMarkers);
  disposers.push(
    mountTopbar($('#ls-topbar'), { brand: false }),
    mountLeftToolbar($('#ls-left-toolbar')),
    mountGaSignal({ host: $('#ls-topbar'), chart, eventBus, getState, setState, TIMEFRAMES }),
    mountWatchlist($('#ls-watchlist')),
    mountBotPanel($('#ls-bot-status'), botStore, {
      onFocusPosition(position) { pendingFocus = position; setState({ symbol: position.symbol }); focusPending(); },
    }),
    mountBotActivity($('#ls-bot-activity'), botStore),
    mountBottomBar($('#ls-bottom-bar'), botStore),
    mountSettingsPanel($('#ls-settings-dialog')),
    startQuotes({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'PAXGUSDT'], bus: eventBus }),
    startBotClient({
      onSnapshot: snapshot => botStore.applySnapshot(snapshot),
      onEvent: event => botStore.applyEvent(event),
      onConnection: connection => botStore.setConnection(connection),
    }),
    botStore.on(({ kind }) => { refreshMarkers(); renderHubStatus(); }),
    eventBus.on('chart:type', type => { setState({ chartType: type }); chart.setChartType(type); refreshMarkers(); }),
    eventBus.on('state:change', ({ state }) => { botMarkers.step = TIMEFRAMES[state.interval]; refreshMarkers(); }),
  );
  // Fresh confirmed SMC events feed the bridge; stale/provisional never leave the page.
  window.__smc = { seen: 0, sent: 0, last: null, loadMarketCalls: 0, setDataCalls: 0 };

const offForward = eventBus.on(SMC_EVENT, event => {
  window.__smc.seen++; window.__smc.last = { type: event.event_type, confirmed: event.confirmed, at: event.created_at };
    if (!event.confirmed || disposed) return;
    if (!Number.isFinite(event.created_at)) return;
    const createdAtMs = event.created_at < 1e11 ? event.created_at * 1000 : event.created_at;
    if (Date.now() - createdAtMs > 600000) return;
  window.__smc.sent++;
    void fetch('/api/bot/smc-event', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { ...event, created_at: createdAtMs } }) }).catch(() => {});
  });
  disposers.push(offForward);
  eventBus.on('chart:loaded', () => { refreshMarkers(); focusPending(); });
  disposers.push(eventBus.on('state:change', ({ state, previous }) => {
    if (state.symbol !== previous.symbol || state.interval !== previous.interval || state.provider !== previous.provider) void loadMarket();
    else if (state.smc !== previous.smc) coordinator.applySettings(state, createProvider(usingFallback ? 'synthetic' : state.provider));
  }));
  disposers.push(eventBus.on('chart:fullscreen', () => { chart.fullscreen().catch(() => showChartStatus('Fullscreen unavailable', 'warning')); }));
  const offline = () => { if (getState().provider === 'binance' && !usingFallback) void loadMarket(true); };
  window.addEventListener('offline', offline); window.addEventListener('online', recover);
  const recoveryTimer = setInterval(recover, 30000);
  window.addEventListener('pagehide', () => {
    if (event.persisted) return;
    disposed = true; generation++; provider?.close(); clearTimeout(fallbackTimer); clearInterval(recoveryTimer);
    window.removeEventListener('offline', offline); window.removeEventListener('online', recover);
    disposers.forEach(dispose => dispose());
    chart.destroy();
  }, { once: true });
  void loadMarket(!navigator.onLine);
}

/* ---------------- Bot ON/OFF + status widgets (sections 8/10/11) ---------------- */
let botsCache = null, botsAt = 0, botBusy = { meme: false, 'long-short': false };
async function fetchBots() {
  try {
    const response = await fetch('/api/bots/status', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const body = await response.json();
    // BotManager speaks camelCase (longShort); the UI indexes kebab ('long-short').
    botsCache = { at: body.at, dryRun: body.dryRun, meme: body.meme, 'long-short': body.longShort }; botsAt = Date.now();
  } catch (error) { botsCache = null; window.__botsFetchError = String(error && error.stack || error).slice(0, 400); }
  renderBotsWidget(); renderHubStatus();
}
const stateClass = state => ({ ON: 'on', OFF: 'off', ERROR: 'error', STARTING: 'starting' }[state] ?? 'off');
function renderBotsWidget() {
  for (const bot of ['long-short', 'meme']) {
    const el = $(`#bot-state-${bot}`);
    if (!el) continue;
    const busy = botBusy[bot];
    const info = botsCache?.[bot] ?? { state: 'OFF', detail: botsCache ? 'unknown' : 'status unavailable' };
    const state = busy ? 'STARTING' : info.state;
    el.className = `bot-state ${stateClass(state)}`;
    el.innerHTML = `<i></i>${busy ? 'STARTING…' : esc(state)}`;
    el.title = `${bot} · ${esc(info.detail ?? '')} · namespace ${esc(info.namespace ?? '')}`;
  }
}
function renderHubStatus() {
  // One status block per mode bar instance; contents depend on the active tab's bot.
  const mode = TradesMode.current;
  for (const host of document.querySelectorAll('[data-hub-status]')) {
    const bot = mode === 'long-short' ? 'long-short' : 'meme';
    const info = botsCache?.[bot] ?? { state: 'OFF', detail: '' };
    const busy = botBusy[bot];
    const state = busy ? 'STARTING' : info.state;
    const on = state === 'ON';
    const ft = botStore?.state?.ft;
    const gatewayLive = botStore?.state?.connection === 'live';
    const memeServiceLive = Date.now() - botsAt < 20000;
    const connOk = mode === 'long-short' ? gatewayLive : memeServiceLive;
    host.innerHTML = `
      <button class="hub-bot-toggle ${on ? 'on' : state === 'ERROR' ? 'off' : 'off'}" data-bot-toggle="${bot}"
        title="Bật/tắt runtime bot ${bot} (namespace ${esc(info.namespace ?? '')}) — không phải ẩn UI" ${busy ? 'disabled' : ''}>
        <i></i>Bot ${busy ? 'STARTING…' : state === 'ERROR' ? 'ERROR' : on ? 'ON' : 'OFF'}
      </button>
      ${mode === 'long-short' ? `<span class="hub-badge">${ft?.connected ? (ft.dryRun ? '⊙ Dry Run' : 'LIVE') : '✕ Offline'}</span>` : ''}
      <span class="hub-conn ${connOk ? '' : 'bad'}" title="${mode === 'long-short' ? 'LONG_SHORT gateway' : 'MEME service'} connection"><i></i>${mode === 'long-short' ? 'FreqTrade' : 'Service'} ${connOk ? 'Connected' : 'Disconnected'}</span>`;
  }
}
document.addEventListener('click', async event => {
  const toggle = event.target.closest('[data-bot-toggle]');
  if (!toggle || botBusy[toggle.dataset.botToggle]) return;
  const bot = toggle.dataset.botToggle;
  const turningOn = !(botsCache?.[bot]?.state === 'ON');
  botBusy[bot] = true; renderBotsWidget(); renderHubStatus();
  try {
    const response = await fetch(`/api/bots/${bot}/${turningOn ? 'start' : 'stop'}`, { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP_${response.status}`);
    botsCache = { at: body.at, dryRun: body.dryRun, meme: body.meme, 'long-short': body.longShort }; botsAt = Date.now();
  } catch (error) {
    botsCache = botsCache ?? {}; botsCache[bot] = { ...(botsCache[bot] ?? {}), state: 'ERROR', detail: error.message };
  } finally { botBusy[bot] = false; renderBotsWidget(); renderHubStatus(); }
});
document.addEventListener('click', event => {
  const row = event.target.closest('[data-bot-nav]');
  if (!row) return;
  TradesMode.apply(row.dataset.botNav === 'long-short' ? 'long-short' : 'meme');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.hash === '#trades'));
});

/* ---------------- trades mode bar (section 11) ---------------- */
function mountModeBar(host, { withStatus }) {
  if (!host || host.querySelector('.trades-mode-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'trades-mode-bar';
  bar.innerHTML = `
    <span class="trades-mode-title">Trades</span>
    <div class="trades-mode-seg" role="tablist" aria-label="Chế độ Trades">
      <button role="tab" data-mode="meme">MEME TRADER</button>
      <button role="tab" data-mode="long-short">LONG / SHORT</button>
    </div>
    ${withStatus ? '<span class="trades-mode-status" data-hub-status></span>' : ''}`;
  host.append(bar);
  bar.addEventListener('click', event => {
    const button = event.target.closest('[data-mode]');
    if (button) TradesMode.apply(button.dataset.mode);
  });
  TradesMode.apply(TradesMode.fromHash() ?? TradesMode.saved(), { save: false });
}

/* ---------------- boot ---------------- */
function init() {
  const view = $(LS);
  if (!view) return;
  // GA chart lib passed through from index.html (same vendored bundle as the standalone).
  mountModeBar($('.trades-heading'), { withStatus: false });
  mountModeBar($('#ls-trades-header'), { withStatus: true });
  renderBotsWidget(); renderHubStatus();
  // Self-rescheduling poll — cannot die silently like a cleared interval.
  (async function pollBots() {
    for (;;) {
      await fetchBots().catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
    }
  })();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
window.__gaBus = eventBus;
window.LongShortHub = {
  TradesMode, renderBotsWidget, renderHubStatus,
  resizeChart: () => chart?.resize(),
  smcState: () => coordinator ? { pivots: coordinator.current.pivots.length, events: coordinator.current.events.length, confirmed: coordinator.current.events.filter(e => e.status === 'CONFIRMED').length, enabled: getState().smc.enabled, step: coordinator.step, coordRows: coordinator.rows.length, chartRows: chart?.rows.length ?? -1, engineLast: coordinator.engine?.last?.time ?? null, higher: !!coordinator.higherProvider } : null,
  debug: () => ({ cache: botsCache, at: botsAt, err: window.__botsFetchError ?? null, busy: botBusy }),
};
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => window.LongShortHub?.resizeChart(), 150); });
