'use strict';
// Identity allowlist is independent of model prose or evidence decisions.
function trustedIdentity(provider, model, { deep = false } = {}) {
  return provider === 'ssh-llamacpp' && model === 'qwen3-32b' ||
    provider === 'ollama-local' && (model === 'qwen3:14b' || !deep && model === 'qwen3:8b');
}
function attributionIdentity(value) {
  // Historical Ollama receipts predate the explicit provider field.
  const provider = Object.hasOwn(value ?? {}, 'provider') ? value.provider : value?.model === 'qwen3:14b' ? 'ollama-local' : null;
  return trustedIdentity(provider, value?.model, { deep: true }) ? { provider, model: value.model } : null;
}
module.exports = { trustedIdentity, attributionIdentity };
