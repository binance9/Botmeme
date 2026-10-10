'use strict';

/** Producer adapter only. Progress advances AFTER a supplied scanner finishes an item.
 * No token list, fake result, price request or autonomous timer is supplied here.
 * scanOne(item) must resolve null (no discovery) or {tokenId,symbol,candidate}.
 * A rejected scan is counted as a failed processed item and remains visible.
 */
async function runScan({ runId, items, scanOne, publish, signal }) {
  if (typeof runId !== 'string' || !/^[\w:./-]{1,80}$/.test(runId)) throw new Error('A unique runId is required');
  if (!Array.isArray(items) || typeof scanOne !== 'function' || typeof publish !== 'function') throw new Error('items, scanOne and publish are required');
  const ids = items.map(item => item.id);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[\w:./-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id))) throw new Error('Scan items require unique valid ids');
  const emit = (type, suffix, data) => publish({ id: `${runId}:${suffix}`, type, source: 'scanner', occurredAt: new Date().toISOString(), data: { runId, ...data } });
  await emit('scan.started', 'start', { total: items.length });
  try {
    for (const [index, item] of items.entries()) {
      if (signal?.aborted) throw new Error('Scan cancelled');
      let result, failure;
      try {
        result = await scanOne(item, { signal });
        if (result !== null && (!result || typeof result !== 'object' || typeof result.tokenId !== 'string' || typeof result.symbol !== 'string' || typeof result.candidate !== 'boolean')) throw new Error('Scanner returned invalid result');
      } catch (error) { failure = String(error.message || error).slice(0, 160); }
      await emit('scan.item', `item:${index}`, failure ? { itemId: item.id, error: failure } : { itemId: item.id, ...(result && { tokenId: result.tokenId, symbol: result.symbol, candidate: result.candidate }) });
    }
    await emit('scan.finished', 'finish', {});
  } catch (error) {
    await emit('scan.failed', 'failed', { error: String(error.message || error).slice(0, 160) });
    throw error;
  }
  return runId;
}
module.exports = { runScan };
