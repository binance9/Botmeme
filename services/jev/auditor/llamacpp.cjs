'use strict';
const { OllamaReviewer, readBounded } = require('./ollama.cjs');
const { assertNoSecrets } = require('./secrets.cjs');
const MODEL = 'qwen3-32b';
class LlamaCppReviewer extends OllamaReviewer {
  constructor({ model = MODEL, endpoint = 'http://127.0.0.1:18002/v1/chat/completions', timeoutMs = 300000, maxTokens = 4096, fetcher = fetch } = {}) {
    let url; try { url = new URL(endpoint); } catch { throw Error('INVALID_REVIEW_ENDPOINT'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/v1/chat/completions' || url.search || url.hash) throw Error('INVALID_REVIEW_ENDPOINT');
    if (model !== MODEL || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000 || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192 || typeof fetcher !== 'function') throw Error('INVALID_REVIEW_PROVIDER_CONFIG');
    super({ model, timeoutMs, fetcher }); this.endpoint = url.href; this.maxTokens = maxTokens; this.provider = 'ssh-llamacpp';
  }
  async complete(format, system, content, timeoutMs = this.timeoutMs) {
    if (typeof content !== 'string' || typeof system !== 'string' || Buffer.byteLength(content) > 64000) throw Error('REVIEW_SCOPE_TOO_LARGE');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.timeoutMs) throw Error('INVALID_REVIEW_TIMEOUT');
    const body = JSON.stringify({ model: this.model, stream: false, temperature: 0, max_tokens: this.maxTokens, response_format: { type: 'json_schema', json_schema: { name: 'jev_evidence_review', strict: true, schema: format } }, messages: [{ role: 'system', content: system }, { role: 'user', content }] });
    if (Buffer.byteLength(body) > 192000) throw Error('REVIEW_REQUEST_TOO_LARGE');
    const signal = AbortSignal.timeout(timeoutMs), started = process.hrtime.bigint(); let value;
    try {
      const response = await this.fetcher(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal, body });
      if (!response.ok) throw Error('REVIEW_PROVIDER_HTTP_' + response.status);
      value = await readBounded(response, 256 * 1024);
    } catch (error) { if (signal.aborted) throw Error('REVIEW_PROVIDER_TIMEOUT'); throw error; }
    const choice = value?.choices?.[0], message = choice?.message;
    if (value?.model !== MODEL || !Array.isArray(value.choices) || value.choices.length !== 1 || choice.index !== 0 || choice.finish_reason !== 'stop' || message?.role !== 'assistant' || typeof message.content !== 'string' || message.tool_calls?.length || message.function_call || message.refusal) throw Error('REVIEW_PROVIDER_INCOMPLETE');
    let raw; try { raw = JSON.parse(message.content); } catch { throw Error('INVALID_REVIEW_JSON'); }
    assertNoSecrets(raw);
    const count = key => value.usage?.[key] == null ? null : Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0 ? value.usage[key] : (() => { throw Error('INVALID_REVIEW_PROVIDER_USAGE'); })();
    return { raw, metrics: { model: MODEL, promptTokens: count('prompt_tokens'), outputTokens: count('completion_tokens'), durationNs: Number(process.hrtime.bigint() - started) } };
  }
  async review(packet, options) {
    const result = await super.review(packet, options);
    return { ...result, provenance: { ...result.provenance, provider: this.provider } };
  }
}
module.exports = { LlamaCppReviewer, MODEL };
