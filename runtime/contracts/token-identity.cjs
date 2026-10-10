'use strict';
function tokenIdentity(value) {
  const result = {};
  for (const [key, max] of [['tokenSymbol', 32], ['tokenName', 80]]) {
    if (typeof value?.[key] !== 'string') continue;
    const text = value[key].replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
    if (text) result[key] = text;
  }
  const image = value?.imageUrl;
  if (typeof image === 'string' && image.length <= 400 && /^https:\/\//i.test(image) && !/[\s\u0000-\u001f\u007f]/.test(image)) {
    try { const url = new URL(image); if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) result.imageUrl = image; } catch {}
  }
  return result;
}
module.exports = { tokenIdentity };
