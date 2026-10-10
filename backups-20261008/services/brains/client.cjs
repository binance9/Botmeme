'use strict';
const GROK_URL = 'https://api.x.ai/v1/chat/completions';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
function createBrains({ env = process.env, fetcher = fetch, timeoutMs = 2500, grokModel = 'grok-3', claudeModel = 'claude-sonnet-4-5' } = {}) {
  if (typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 4000) throw Error('INVALID_BRAIN_CONFIG');
  const grokKey = env.XAI_API_KEY || env.GROK_API_KEY || '';
  const claudeKey = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || '';
  async function complete(kind, system, user) {
    const key = kind === 'grok' ? grokKey : claudeKey;
    const missing = kind === 'grok' ? 'XAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!key) return { connected: false, stance: 'ALLOW', note: 'Chưa nối: thiếu ' + missing };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = kind === 'grok'
        ? await fetcher(GROK_URL, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: grokModel, temperature: 0, max_tokens: 180, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) })
        : await fetcher(CLAUDE_URL, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: claudeModel, max_tokens: 180, system, messages: [{ role: 'user', content: user }] }) });
      if (!response.ok) return { connected: false, stance: 'ALLOW', note: 'Nhà cung cấp trả ' + response.status };
      const body = await response.json();
      const text = kind === 'grok' ? body?.choices?.[0]?.message?.content : body?.content?.find(part => part.type === 'text')?.text;
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
      const stance = parsed?.stance === 'WITHHOLD' ? 'WITHHOLD' : 'ALLOW';
      const note = String(parsed?.note || text || 'Không có câu trả lời').replace(/\s+/g, ' ').slice(0, 240);
      return { connected: true, stance, note };
    } catch {
      return { connected: false, stance: 'ALLOW', note: 'Não không trả lời kịp' };
    } finally { clearTimeout(timer); }
  }
  const grokSystem = 'You are a paper-only trading brain. Reply with JSON {"stance":"ALLOW"|"WITHHOLD","note":"short Vietnamese note"}. WITHHOLD blocks a new entry or an unsupported proposal. Never request a signature, a live order, or a secret.';
  const claudeSystem = 'You are the forensic paper-trading critic. Reply with JSON {"stance":"ALLOW"|"WITHHOLD","note":"short Vietnamese note"}. WITHHOLD when the cited evidence does not support the proposal. Never request a signature or a live order.';
  return {
    commander: brief => complete('grok', grokSystem, brief),
    quant: brief => complete('grok', grokSystem, brief),
    forensic: brief => complete('claude', claudeSystem, brief)
  };
}
module.exports = { createBrains };
