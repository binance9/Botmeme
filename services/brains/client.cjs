'use strict';
const GROK_URL = 'https://api.x.ai/v1/chat/completions';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
// AI_STEWARD_BRIDGE: nao 'steward' chay qua cau noi local (Ollama-shape), mien phi,
// khong khoa API. La PRIMARY cho commander/quant khi bat; grok/claude thanh DU PHONG.
// Timeout rieng (mac dinh 45s (nap lanh ~26s)) vi Steward nap model lanh co the lau hon clamp 4s cua
// nao cloud — van fail-open ALLOW nhu cu khi qua han.
const STEWARD_DEFAULTS = {
  chatUrl: 'http://127.0.0.1:11442/api/chat',
  model: 'qwen3:4b',
  timeoutMs: 45000,  // Steward nap model lanh ~26s; 20s thieu
};
function createBrains({ env = process.env, fetcher = fetch, timeoutMs = 2500, grokModel = 'grok-3', claudeModel = 'claude-sonnet-4-5' } = {}) {
  const STEWARD_CHAT_URL = env.AI_STEWARD_CHAT_URL || STEWARD_DEFAULTS.chatUrl;
  const STEWARD_MODEL = env.AI_STEWARD_MODEL || STEWARD_DEFAULTS.model;
  const STEWARD_TIMEOUT_MS = Number(env.AI_STEWARD_TIMEOUT_MS || STEWARD_DEFAULTS.timeoutMs);
  const STEWARD_DISABLED = env.AI_STEWARD_ENABLED === '0';
  if (typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 4000) throw Error('INVALID_BRAIN_CONFIG');
  const grokKey = env.XAI_API_KEY || env.GROK_API_KEY || '';
  const claudeKey = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || '';
  async function stewardComplete(system, user) {
    // Nao steward: JSON {"stance","note"} qua cau noi Ollama-shape. Moi loi -> fail-open.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STEWARD_TIMEOUT_MS);
    try {
      const response = await fetcher(STEWARD_CHAT_URL, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: STEWARD_MODEL, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], options: { temperature: 0, num_predict: 220 } }) });
      if (!response.ok) return { connected: false, stance: 'ALLOW', note: 'Steward tra ' + response.status };
      const body = await response.json();
      const text = body?.message?.content || '';
      let parsed; try { parsed = JSON.parse(text); } catch { const m = String(text).match(/\{[\s\S]*\}/); try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; } }
      const stance = parsed?.stance === 'WITHHOLD' ? 'WITHHOLD' : 'ALLOW';
      const note = String(parsed?.note || text || 'Khong co cau tra loi').replace(/\s+/g, ' ').slice(0, 240);
      return { connected: true, stance, note, brain: 'steward' };
    } catch {
      return { connected: false, stance: 'ALLOW', note: 'Steward khong tra loi kip' };
    } finally { clearTimeout(timer); }
  }
  async function complete(kind, system, user) {
    if ((kind === 'commander' || kind === 'quant') && !STEWARD_DISABLED) {
      const primary = await stewardComplete(system, user);
      if (primary.connected) return primary;
      // DU PHONG: Steward hong -> grok nhu cu (provider hien tai).
    }
    const cloud = kind === 'claude' ? 'claude' : 'grok';   // commander/quant/forensic -> backend cloud
    const key = cloud === 'grok' ? grokKey : claudeKey;
    const missing = cloud === 'grok' ? 'XAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!key) return { connected: false, stance: 'ALLOW', note: 'Chưa nối: thiếu ' + missing };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = cloud === 'grok'
        ? await fetcher(GROK_URL, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: grokModel, temperature: 0, max_tokens: 180, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) })
        : await fetcher(CLAUDE_URL, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: claudeModel, max_tokens: 180, system, messages: [{ role: 'user', content: user }] }) });
      if (!response.ok) return { connected: false, stance: 'ALLOW', note: 'Nhà cung cấp trả ' + response.status };
      const body = await response.json();
      const text = cloud === 'grok' ? body?.choices?.[0]?.message?.content : body?.content?.find(part => part.type === 'text')?.text;
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
    commander: brief => complete('commander', grokSystem, brief),   // steward truoc, grok du phong
    quant: brief => complete('quant', grokSystem, brief),           // steward truoc, grok du phong
    forensic: brief => complete('claude', claudeSystem, brief),     // giu claude (nha phan bien doc lap)
    stewardStatus: () => ({ url: STEWARD_CHAT_URL, model: STEWARD_MODEL, disabled: STEWARD_DISABLED, timeoutMs: STEWARD_TIMEOUT_MS })
  };
}
module.exports = { createBrains };
