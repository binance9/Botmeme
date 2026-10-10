'use strict';
const { DEFAULT_POLICY: quant } = require('../../services/quant/service.cjs');
function projectProgress(agents, events, portfolio, clock) {
  const hour = events.filter(e => Date.parse(e.timestamp) >= clock.getTime() - 3600000 && Date.parse(e.timestamp) <= clock.getTime());
  for (const agent of agents) agent.progress = null;
  const set = (agent, event, done, label) => {
    agent.metric = { done, total: null, label };
    if (event) {
      agent.updatedAt = event.timestamp;
      agent.progressEventId = event.id;
      agent.progressProducer = event.producer;
    }
  };
  const hunter = agents[0], scan = events.findLast(e => e.type === 'ScanProgress' || e.type === 'AIActivityEvent' && e.producer === 'MARKET_DATA' && e.payload.task.startsWith('scan:'));
  hunter.tokensThisHour = new Set(hour.filter(e => e.type === 'TokenCandidate').map(e => e.payload.token)).size;
  if (scan?.type === 'ScanProgress') {
    set(hunter, scan, scan.payload.completed, 'Token đã quét');
    hunter.status = scan.payload.state.toLowerCase();
    if (scan.payload.state === 'RUNNING' && scan.payload.total > 0) hunter.progress = Math.min(100, scan.payload.completed / scan.payload.total * 100);
  } else if (scan?.payload.state === 'RUNNING' && scan.payload.progress != null) {
    hunter.progress = scan.payload.progress * 100;
  }
  const signals = hour.filter(e => e.type === 'SignalObservation');
  const reviewed = new Set(hour.filter(e => e.type === 'SafetyDecision' || e.type === 'StrategyDecision' && e.producer === 'CODEX_1').map(e => e.payload.candidateId));
  // WAIT decisions intentionally are not journaled as StrategyDecision. A
  // single-signal activity receipt still proves that signal was considered.
  const consideredSignals = new Set(hour.filter(e => e.type === 'AIActivityEvent' && e.producer === 'CODEX_1' && /^Compared [1-9]\d* candidates;/.test(e.payload.message)).map(e => e.payload.task));
  const commanderEvent = hour.findLast(e => e.producer === 'CODEX_1' || e.type === 'SafetyDecision');
  set(agents[1], commanderEvent, signals.filter(e => reviewed.has(e.payload.candidateId) || consideredSignals.has(e.id)).length, 'Signal đã xét giờ qua');
  const activity = events.findLast(e => e.type === 'AIActivityEvent' && e.producer === 'CODEX_2');
  const input = activity && events.find(e => e.id === activity.payload.task);
  const samples = input ? events.filter(e => e.type === 'MarketSnapshot' && e.payload.token === input.payload.token && Date.parse(e.timestamp) <= Date.parse(input.timestamp) && e.evidence.length && !e.missing_evidence.length && e.confidence >= quant.minQuality && e.evidence_quality >= quant.minQuality && e.uncertainty <= 1 - quant.minQuality && ['OBSERVED', 'COMPLETED'].includes(e.status)).slice(-quant.maxHistory) : [];
  agents[2].closedTrades = portfolio.trades.filter(t => t.state === 'CLOSED').length;
  if (input) set(agents[2], activity, samples.length, 'Mẫu giá đã phân tích');
  const reports = events.filter(e => e.type === 'RootCauseReport');
  agents[3].reportsProcessed = reports.length;
  if (reports.length) set(agents[3], reports.at(-1), new Set(reports.map(e => e.payload.failureId)).size, 'Vụ đã điều tra');
  for (const agent of agents) agent.lastActivityAgeMs = agent.updatedAt ? Math.max(0, clock.getTime() - Date.parse(agent.updatedAt)) : null;
}
module.exports = { projectProgress };
