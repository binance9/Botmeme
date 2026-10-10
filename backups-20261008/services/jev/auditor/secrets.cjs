'use strict';
// Fail closed on credential-shaped values. Identifiers and references in source
// code remain reviewable; actual credentials must be removed at evidence origin.
function assertNoSecrets(value, depth = 0, seen = new WeakSet()) {
  if (depth > 32) throw Error('SECRET_SCREEN_LIMIT');
  if (typeof value === 'string') {
    const quoted = /(?:private[_-]?key|seed[_-]?phrase|recovery[_-]?phrase|api[_-]?key|authorization|signing[_-]?secret|access[_-]?token|refresh[_-]?token)\s*["']?\s*[:=]\s*(["'])(?:\\[\s\S]|(?!\1)[^\\]){20,}\1/i;
    const bearer = /\bauthorization\s*[:=]\s*["']?\s*bearer\s+[A-Za-z0-9._~+\/-]{12,}/i;
    const unquoted = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|signing[_-]?secret)\s*[:=]\s*([A-Za-z0-9_~+\/-]{16,})(?=[\s,;}"']|$)/i;
    if (quoted.test(value) || bearer.test(value) || unquoted.test(value) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) throw Error('SECRET_LITERAL_DENIED');
    // Decode data, never execute source. Repeated JSON serialization must not
    // hide a credential from the same boundary that screens structured input.
    let decoded, parsed = false;
    if (/^\s*[\[{"]/.test(value)) {
      try { decoded = JSON.parse(value); parsed = true; } catch { /* Source need not be JSON. */ }
    }
    if (parsed) {
      assertNoSecrets(decoded, depth + 1, seen);
    } else {
      // Source/log text may embed an escaped JSON string without itself being
      // JSON. Inspect only valid double-quoted JSON literals containing escapes.
      for (const match of value.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)) {
        if (!match[0].includes('\\')) continue;
        let literal;
        try { literal = JSON.parse(match[0]); } catch { continue; }
        assertNoSecrets(literal, depth + 1, seen);
      }
    }
  } else if (value && typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:private[_-]?key|seed[_-]?phrase|recovery[_-]?phrase|api[_-]?key|authorization|signing[_-]?secret|access[_-]?token|refresh[_-]?token)$/i.test(key) && child !== null && child !== undefined && child !== '') throw Error('SECRET_LITERAL_DENIED');
      assertNoSecrets(key, depth + 1, seen); assertNoSecrets(child, depth + 1, seen);
    }
  }
}
module.exports = { assertNoSecrets };
