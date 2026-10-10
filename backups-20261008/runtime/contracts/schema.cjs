'use strict';
const bad = code => { throw Error('INVALID_EVENT_' + code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = (max = 2000) => value => typeof value === 'string' && value.trim().length > 0 && value.length <= max || bad('STRING');
const number = (min = -Infinity, max = Infinity) => value => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max || bad('NUMBER');
const integer = (min = 0) => value => Number.isSafeInteger(value) && value >= min || bad('INTEGER');
const positive = value => { number(0)(value); if (value === 0) bad('POSITIVE'); };
const boolean = value => typeof value === 'boolean' || bad('BOOLEAN');
const oneOf = values => value => values.includes(value) || bad('ENUM');
const nullable = check => value => value === null || check(value);
const array = (check, max = 256, min = 0) => value => {
  if (!Array.isArray(value) || value.length < min || value.length > max) bad('ARRAY');
  for (const item of value) check(item);
};
const object = fields => value => {
  if (!plain(value) || Object.keys(value).length !== Object.keys(fields).length || Object.keys(fields).some(key => !Object.hasOwn(value, key))) bad('KEYS');
  for (const [key, check] of Object.entries(fields)) check(value[key]);
};
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) bad('TIMESTAMP');
};
const id = string(160), fraction = number(0, 1), nonnegative = number(0);
const cleanStrings = new Set(), MAX_EMBEDDED_JSON = 4096;
function noSecrets(value, seen = new WeakSet(), depth = 0) {
  if (depth > 24) bad('DEPTH');
  if (typeof value === 'string') {
    if (cleanStrings.has(value)) return;
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:seed[_ -]?phrase|recovery[_ -]?phrase|private[_ -]?key|signing[_ -]?secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization)\s*["']?\s*[:=]\s*\S|\bbearer\s+[\w.~+\/-]{12,}/i.test(value)) bad('SECRET');
    // Ordinary ids/prose are not JSON. Exceptions on every string dominated
    // portfolio replay CPU. Only containers/quoted strings can hide keys.
    const first = value.trimStart()[0];
    const embedded = ['{', '[', '"'].includes(first);
    if (embedded && value.length > MAX_EMBEDDED_JSON) bad('EMBEDDED_JSON_SIZE');
    if (embedded) {
      let decoded;
      try { decoded = JSON.parse(value); } catch { return; }
      if (decoded !== value) noSecrets(decoded, seen, depth + 1);
    }
    if (!embedded && value.length <= MAX_EMBEDDED_JSON) {
      if (cleanStrings.size >= 4096) cleanStrings.clear();
      cleanStrings.add(value);
    }
  } else if (value && typeof value === 'object') {
    if (seen.has(value)) bad('CYCLE');
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:seed[_ -]?phrase|recovery[_ -]?phrase|private[_ -]?key|signing[_ -]?secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization)$/i.test(key)) bad('SECRET');
      noSecrets(child, seen, depth + 1);
    }
    seen.delete(value);
  }
}
module.exports = { bad, string, number, integer, positive, boolean, oneOf, nullable, array, object, timestamp, id, fraction, nonnegative, noSecrets };
