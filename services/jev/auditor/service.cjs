'use strict';
const { randomUUID } = require('node:crypto');
const { validatePacket, canonical, sha256, KINDS } = require('./contract.cjs');
const { OllamaReviewer } = require('./ollama.cjs');
const { assertNoSecrets } = require('./secrets.cjs');
const { evaluateReview } = require('./evaluation.cjs');
const { decide, blocked } = require('./acceptance.cjs');
const { trustedIdentity } = require('./reviewer-identity.cjs');
class JevAuditor {
  constructor({ reviewer = new OllamaReviewer(), escalationReviewer = new OllamaReviewer() } = {}) { this.reviewer = reviewer; this.escalationReviewer = escalationReviewer; }
  async audit(input, { binding = null, revoked = false } = {}) {
    const receipt_id = randomUUID();
    const base = { id: receipt_id, receipt_id, timestamp: new Date().toISOString(), producer: 'JEV_AUDITOR', correlationId: randomUUID(), packetHash: null, source: { kind: 'internal-review-agent', attempts: [] } };
    let packet;
    try { packet = structuredClone(validatePacket(input)); }
    catch { return blocked(null, base, 'INVALID_AUDIT_INPUT'); }
    base.packetHash = sha256(canonical(packet));
    const missing = KINDS.filter(k => !packet.documents.some(d => d.kind === k && d.content.trim()));
    if (missing.length) return blocked(packet, base, 'MISSING_EVIDENCE_KINDS:' + missing.join(','), binding);
    let previousError = null;
    for (const [index, reviewer] of [this.reviewer, this.escalationReviewer].entries()) {
      if (!reviewer) break;
      let answer;
      try {
        const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
        answer = await reviewer.review(freeze(structuredClone(packet)), { previousError });
        if (!trustedIdentity(answer.provenance?.provider, answer.provenance?.model) || answer.provenance?.protocol !== 'evidence-first/2' || (reviewer.model && answer.provenance.model !== reviewer.model) || (reviewer.provider && answer.provenance.provider !== reviewer.provider)) throw Error('INVALID_REVIEWER_IDENTITY');
        evaluateReview(packet, answer.analysis);
        base.source.attempts.push({ ...answer.provenance, result: 'VALID_STRUCTURED_REVIEW' });
        // Valid negative analysis is final. The model does not supply acceptance.
        return decide(packet, { ...base, analysis: answer.analysis }, binding, { revoked });
      } catch (error) {
        const code = /^[A-Z0-9_:,-]+$/.test(error.message) ? error.message : 'REVIEW_FAILED';
        const attempt = { provider: reviewer.provider ?? (['qwen3:8b', 'qwen3:14b'].includes(reviewer.model) ? 'ollama-local' : 'unverified'), model: reviewer.model ?? 'injected-reviewer', result: code };
        if (code === 'ATTRIBUTION_INTERRUPTED_AFTER_VETO' && error.attributionEvidence) {
          try { assertNoSecrets(error.attributionEvidence); attempt.attribution_evidence = structuredClone(error.attributionEvidence); } catch {}
        }
        try { const rejected = answer?.analysis ?? error.rejectedReview; if (rejected) { assertNoSecrets(rejected); attempt.rejected_review = structuredClone(rejected); } } catch {}
        base.source.attempts.push(attempt); previousError = code;
        if (index > 0 || !/^(INVALID_|INCOMPLETE_|CONTRADICTORY_|PASS_WITHOUT_|FINDING_WITHOUT_|UNCITED_|REVIEW_PROVIDER_INCOMPLETE)/.test(code)) return blocked(packet, base, code, binding);
      }
    }
    return blocked(packet, base, 'REVIEW_SCHEMA_REJECTED_AFTER_BOUNDED_RETRY', binding);
  }
}
module.exports = { JevAuditor };
