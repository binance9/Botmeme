'use strict';
// A 429 waits for Retry-After. A missing or zero header uses a growing backoff.
// The wait is capped at one scan so a multi-hour header cannot freeze the process.
function createRateLimit({ now = Date.now } = {}) {
  let until = 0, failures = 0;
  const ceiling = 60000, floor = 15000;
  return {
    remaining() { return Math.max(0, until - now()); },
    limited(retryAfter) {
      const clock = now();
      failures = Math.min(failures + 1, 3);
      let requested = 0;
      if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)) {
        const seconds = Number(retryAfter);
        if (Number.isSafeInteger(seconds) && seconds <= (Number.MAX_SAFE_INTEGER - clock) / 1000) requested = seconds * 1000;
      } else if (typeof retryAfter === 'string') {
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) requested = Math.max(0, date - clock);
      }
      const backoff = Math.min(ceiling, floor * 2 ** (failures - 1));
      const wait = requested > 0 ? Math.min(ceiling, requested) : backoff;
      until = Math.max(until, clock + wait);
      return this.remaining();
    },
    recovered() { if (now() >= until) { failures = 0; until = 0; } }
  };
}
module.exports = { createRateLimit };
