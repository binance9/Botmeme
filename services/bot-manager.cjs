'use strict';
// BotManager — runtime supervisor for the two independent bots (UI-MERGE section 7).
// It only start/stop/status/health. It never decides BUY/SELL, and the two bots
// share no strategy state: MEME is controlled in-process (this application),
// LONG/SHORT through the GA gateway service (FreqTrade dry-run at :8081 behind it).
const STATES = { ON: 'ON', OFF: 'OFF', STARTING: 'STARTING', ERROR: 'ERROR' };
const gatewayUrl = () => process.env.GA_GATEWAY ?? 'http://127.0.0.1:8932';

function createBotManager({ application, fetch = globalThis.fetch.bind(globalThis), gateway = gatewayUrl, now = () => new Date() } = {}) {
  if (!application) throw new TypeError('application is required');
  const memory = { meme: null, longShort: null }; // transient lastError per bot
  const timeout = signal => AbortSignal.timeout(signal ?? 6000);
  const gatewayBase = typeof gateway === 'function' ? gateway : () => gateway;

  async function callGateway(pathname, options) {
    const response = await fetch(`${gatewayBase()}${pathname}`, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(body.error || `GATEWAY_HTTP_${response.status}`), { status: response.status });
    return body;
  }

  async function memeState() {
    try {
      const control = application.control();
      // A stale scan error must not mask the real runtime state: OFF means stopped,
      // with the last scan error carried in detail for the operator.
      if (control.running) return { state: STATES.ON, detail: `${control.mode} · ${control.network}` };
      return { state: STATES.OFF, detail: control.lastError ? `stopped · ${control.lastError}` : 'stopped' };
    } catch (error) { return { state: STATES.ERROR, detail: error.message }; }
  }

  async function longShortState() {
    try {
      const state = await callGateway('/api/bot/state', { signal: timeout(4000) });
      const ft = state.ft ?? {};
      if (!ft.connected) return { state: STATES.ERROR, detail: 'Gateway lost FreqTrade' };
      if (state.power?.enabled === false) return { state: STATES.OFF, detail: `FreqTrade ${ft.state}` };
      if (ft.state === 'running') return { state: STATES.ON, detail: `dry-run · ${ft.strategy || 'strategy'}` };
      if (state.power?.ftError) return { state: STATES.ERROR, detail: state.power.ftError };
      return { state: STATES.OFF, detail: `FreqTrade ${ft.state}` };
    } catch (error) {
      return { state: STATES.ERROR, detail: error.message === 'GATEWAY_HTTP_404' ? 'Gateway legacy' : `Gateway offline · ${error.message}` };
    }
  }

  return {
    async status() {
      const [meme, longShort] = await Promise.all([memeState(), longShortState()]);
      return {
        at: now().toISOString(),
        meme: { ...meme, namespace: 'MEME' },
        longShort: { ...longShort, namespace: 'LONG_SHORT' },
        dryRun: true,
      };
    },

    async start(bot) {
      if (bot === 'meme') {
        memory.meme = STATES.STARTING;
        try { await application.start(); memory.meme = null; }
        catch (error) { memory.meme = error.message; throw error; }
        return this.status();
      }
      if (bot === 'long-short') {
        memory.longShort = STATES.STARTING;
        try { await callGateway('/api/bot/power', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }), signal: timeout() }); memory.longShort = null; }
        catch (error) { memory.longShort = error.message; throw error; }
        return this.status();
      }
      throw new TypeError('unknown bot');
    },

    async stop(bot) {
      if (bot === 'meme') {
        try { await application.stop(); memory.meme = null; }
        catch (error) { memory.meme = error.message; throw error; }
        return this.status();
      }
      if (bot === 'long-short') {
        try { await callGateway('/api/bot/power', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }), signal: timeout() }); memory.longShort = null; }
        catch (error) { memory.longShort = error.message; throw error; }
        return this.status();
      }
      throw new TypeError('unknown bot');
    },

    async health() {
      const status = await this.status();
      return {
        ...status,
        web: { state: STATES.ON, detail: 'meme-trader web' },
        isolation: { memeNamespace: 'MEME', longShortNamespace: 'LONG_SHORT', sharedStrategyState: false },
      };
    },
  };
}

module.exports = { createBotManager, STATES, gatewayUrl };
