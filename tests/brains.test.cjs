'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrains } = require('../services/brains/client.cjs');
test('missing cloud keys skip grok/claude; steward (local, keyless) stays primary with fail-open', async () => {
  // AI_STEWARD_BRIDGE: commander duoc chu dong qua nao steward local (mien phi,
  // khong can key). Cloud keys thieu -> grok/claude KHONG duoc goi; steward that
  // bai (fetch loi/500) van fail-open ALLOW — hop dong moi cua bo nao.
  let cloudCalls = 0;
  const brains = createBrains({ env: {}, fetcher: async (url) => {
    if (!String(url).includes('11442')) cloudCalls++;   // chi steward duoc goi
    return { ok: false, json: async () => ({}) };
  } });
  const commander = await brains.commander('candidate');
  const claude = await brains.forensic('proposal');
  assert.equal(cloudCalls, 0);
  assert.equal(commander.connected, false);            // steward tra 500 -> fail-open
  assert.equal(commander.stance, 'ALLOW');
  assert.match(claude.note, /ANTHROPIC_API_KEY/);
});
test('configured brains: steward primary (commander/quant), cloud fallback preserved, forensic stays claude', async () => {
  const seen = [];
  const brains = createBrains({
    env: { XAI_API_KEY: 'grok-secret', ANTHROPIC_API_KEY: 'claude-secret', AI_STEWARD_ENABLED: '0' },  // Tat steward de kiem tra duong cloud du phong nhu cu
    fetcher: async (url, options) => {
      seen.push({ url, authorization: options.headers.Authorization, apiKey: options.headers['x-api-key'] });
      const grok = url.includes('x.ai');
      return { ok: true, json: async () => grok ? { choices: [{ message: { content: '{"stance":"WITHHOLD","note":"chưa đủ bằng chứng"}' } }] } : { content: [{ type: 'text', text: '{"stance":"ALLOW","note":"đủ trích dẫn"}' }] } };
    }
  });
  const grok = await brains.quant('history');
  const claude = await brains.forensic('proposal');
  assert.equal(grok.stance, 'WITHHOLD');
  assert.equal(claude.stance, 'ALLOW');
  assert.equal(seen[0].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(seen[0].authorization, 'Bearer grok-secret');
  assert.equal(seen[1].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[1].apiKey, 'claude-secret');
  assert.ok(!grok.note.includes('grok-secret'));
});
test('steward brain: WITHHOLD qua bridge + fail-open ALLOW khi bridge hong', async () => {
  const seen = [];
  const brains = createBrains({ env: {}, fetcher: async (url, options) => {
    seen.push(String(url));
    if (String(url).includes('11442')) {
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'qwen3:4b');
      return { ok: true, json: async () => ({ message: { content: '{"stance":"WITHHOLD","note":"chua du bang chung local"}' } }) };
    }
    throw new Error('cloud khong duoc goi khi steward dap ung');
  } });
  const verdict = await brains.commander('lich su candidates');
  assert.equal(verdict.connected, true);
  assert.equal(verdict.stance, 'WITHHOLD');
  assert.equal(verdict.brain, 'steward');
  assert.equal(seen.length, 1);
  // bridge hong -> fail-open, KHONG goi cloud vi thieu key
  const down = createBrains({ env: {}, fetcher: async () => { throw new Error('ECONNREFUSED'); } });
  const open = await down.commander('lich su candidates');
  assert.equal(open.stance, 'ALLOW');
  assert.equal(open.connected, false);
});
