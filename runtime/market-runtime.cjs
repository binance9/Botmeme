'use strict';
const { createRuntime } = require('./events/bus.cjs');
const { createHunter } = require('../services/jev/hunter.cjs');
const { createMarketData } = require('../core/market-data/service.cjs');

// Composition boundary for the research stage, not an execution/autopilot API.
function createMarketRuntime({ providers, hunterPolicy, ...options } = {}) {
  const runtime = createRuntime(options);
  let hunter, market;
  try {
    hunter = createHunter({ runtime, now: options.now, policy: hunterPolicy });
    market = createMarketData({ runtime, providers: providers ?? {}, now: options.now });
    hunter.start();
  } catch (error) { void runtime.close(); throw error; }
  return {
    runtime, market,
    selectNetwork(network) { market.stop(); return runtime.selectNetwork(network); },
    async close() { market.stop(); hunter.stop(); await runtime.close(); }
  };
}
module.exports = { createMarketRuntime };
