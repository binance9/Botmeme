'use strict';
// Jev decision adapter — fast structured verdicts for Botmeme candidates.
// Wraps the machine-wide JEV client (C:\JEV\jev-api.cjs, TypeSafe System One).
//
// Contract (owner's master plan, docs/MASTER-PLAN-CODEX6-JEV.md step [4]):
//  - ONE batched systemone call per candidate: noul(s) + score + choice.
//  - Every answer passes guardrail validation; violations => verdict REJECTED.
//  - Degrade: no key / API error / timeout => { ok:false, reason, fallback:'rule-quant' }
//    — callers MUST fall back to rule-quant and never hang on this module.
//  - This module NEVER issues acceptance (TypeSafe /v1/systemone is not an
//    acceptance provider per docs/JEV-AUDITOR.md). It only produces decision
//    advisory payloads consumed by the Commander/risk layers.

const JEVC = require('C:/JEV/jev-api.cjs');

const CONFIDENCE_FLOOR = 0.55;      // below => TRADE downgrades to WATCH
const REJECT_CONFIDENCE_FLOOR = 0.7; // below => REJECT downgrades to WATCH: rejecting on low confidence is guessing

function buildQuestions(candidate) {
  const state = {
    token: candidate.token || null,
    network: candidate.network || null,
    liquidityUsd: candidate.liquidityUsd ?? null,
    volume24hUsd: candidate.volume24hUsd ?? null,
    priceUsd: candidate.priceUsd ?? null,
    ageMinutes: candidate.ageMinutes ?? null,
    top10HolderShare: candidate.top10HolderShare ?? null,
    observedAt: candidate.observedAt || null
  };
  return {
    state,
    questions: {
      tradable: JEVC.builders.noul(
        'Token này có đáng đưa vào watchlist giao dịch paper ngay bây giờ không?',
        { true: 'dữ liệu đủ và không có tín hiệu nguy hiểm', false: 'có tín hiệu rõ ràng nguy hiểm (honeypot, rug, thanh khoản rút)' }
      ),
      momentum: JEVC.builders.score(
        'Chấm động lượng hiện tại của token này.',
        ['suy yếu', 'đi ngang', 'hơi tăng', 'đang bùng nổ', 'bong bóng cực nóng']
      ),
      action: JEVC.builders.choice('Quyết định hành động cho candidate này. Chú ý: dữ liệu thiếu (thanh khoản/volume bằng 0 hoặc null) KHÔNG phải lý do REJECT — khi thiếu dữ liệu hãy chọn WATCH.', {
        TRADE: 'mở vị paper ngay: dữ liệu đủ, không có tín hiệu nguy hiểm',
        WATCH: 'theo dõi thêm: dữ liệu chưa đủ hoặc tín hiệu chưa rõ',
        REJECT: 'chỉ dùng khi có tín hiệu rõ ràng nguy hiểm (honeypot, rug pull, scam)'
      })
    }
  };
}

// candidate: {token, network, liquidityUsd, volume24hUsd, priceUsd, ageMinutes, ...}
// returns verdict: { ok, action, confidence, probabilities, tradableProbability,
//                    momentum, model, latencyMs, guardrail, usage, routing }
// or             : { ok:false, reason, fallback:'rule-quant' }
async function evaluateCandidate(candidate, model) {
  let req;
  try { req = buildQuestions(candidate); } catch (e) { return { ok: false, reason: 'bad-candidate', error: e.message, fallback: 'rule-quant' }; }
  const r = await JEVC.systemOne(req.state, req.questions, model);
  if (!r.ok) return { ok: false, reason: r.reason || 'api-unavailable', status: r.status, error: r.error, fallback: 'rule-quant', routing: r.routing };
  const a = r.answers || {};
  const g = r.guardrail || { violations: ['no-guardrail'] };
  if (g.violations && g.violations.length) {
    return { ok: false, reason: 'guardrail-violations', violations: g.violations, model: r.model, fallback: 'rule-quant', latencyMs: r.latencyMs };
  }
  const action = a.action && a.action.choice;
  const confidence = a.action && typeof a.action.confidence === 'number' ? a.action.confidence : null;
  const momentum = a.momentum ? a.momentum.score : null;
  const tradable = a.tradable ? a.tradable.noul : null;
  // Guardrail-of-last-resort: low confidence or low tradable probability downgrade to WATCH
  let final = action;
  if (final === 'TRADE' && (typeof confidence === 'number' && confidence < CONFIDENCE_FLOOR || typeof tradable === 'number' && tradable < CONFIDENCE_FLOOR)) {
    final = 'WATCH';
  }
  // A REJECT made on low confidence is a guess, not a verdict — downgrade to WATCH.
  if (final === 'REJECT' && (typeof confidence !== 'number' || confidence < REJECT_CONFIDENCE_FLOOR)) {
    final = 'WATCH';
  }
  return {
    ok: true, action: final, rawAction: action, confidence, probabilities: a.action ? a.action.probabilities : null,
    tradableProbability: tradable, momentum,
    model: r.model, latencyMs: r.latencyMs, usage: r.usage, requestId: r.requestId,
    guardrail: { checked: g.checked, violations: g.violations }
  };
}

module.exports = { evaluateCandidate, buildQuestions, CONFIDENCE_FLOOR, REJECT_CONFIDENCE_FLOOR, hasKey: JEVC.hasKey };
