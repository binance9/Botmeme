'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrains } = require('../services/brains/client.cjs');
test('missing provider keys do not call the network', async () => {
  let called = 0;
  const brains = createBrains({ env: {}, fetcher: async () => { called++; return { ok: true, json: async () => ({}) }; } });
  const grok = await brains.commander('candidate');
  const claude = await brains.forensic('proposal');
  assert.equal(called, 0);
  assert.equal(grok.connected, false);
  assert.match(grok.note, /XAI_API_KEY/);
  assert.match(claude.note, /ANTHROPIC_API_KEY/);
});
test('configured brains call their own providers and can withhold', async () => {
  const seen = [];
  const brains = createBrains({
    env: { XAI_API_KEY: 'grok-secret', ANTHROPIC_API_KEY: 'claude-secret' },
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
