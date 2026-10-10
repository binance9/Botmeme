'use strict';
const { createHash } = require('node:crypto');
function derived(source, { producer, type, payload, status = 'OBSERVED', evidence = [source.id], missing_evidence = source.missing_evidence, confidence = source.confidence, uncertainty = source.uncertainty, variant = '', timestamp = source.timestamp }) {
  const suffix = createHash('sha256').update(JSON.stringify([producer, type, source.network, source.epoch, source.id, variant])).digest('hex');
  return { id: producer + ':' + type + ':' + suffix, type, timestamp, producer, source: producer.toLowerCase() + '.service', evidence, status,
    correlationId: source.correlationId, network: source.network, epoch: source.epoch, confidence, evidence_quality: source.evidence_quality,
    missing_evidence: [...missing_evidence], uncertainty, payload };
}
module.exports = { derived };
