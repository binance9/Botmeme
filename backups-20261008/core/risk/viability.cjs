'use strict';
// Round trip uses the fee and slippage already charged by paper replay, the
// measured pool impact, and observed gas. The stop distance is the existing
// room; no separate dollar floor is introduced.
function economicViability({ plannedOrderUsd, actualOrderUsd, feeBps, slippageBps, priceImpactBps, gasUsd, stopDistance }) {
  const planned = Number(plannedOrderUsd), actual = Number(actualOrderUsd);
  const fee = Number(feeBps) / 10000, slip = Number(slippageBps) / 10000;
  const impact = Number.isFinite(priceImpactBps) && priceImpactBps >= 0 ? priceImpactBps / 10000 : 0;
  const gas = Number.isFinite(gasUsd) && gasUsd >= 0 ? gasUsd : 0;
  const blank = { plannedOrderUsd: Number.isFinite(planned) ? planned : 0, actualOrderUsd: 0, feeUsd: 0, gasUsd: 0, impactUsd: 0, slippageUsd: 0, totalUsd: 0, state: 'WAIT' };
  if (!(planned > 0) || !(actual > 0) || !(stopDistance > 0) || !Number.isFinite(fee) || fee < 0 || !Number.isFinite(slip) || slip < 0) {
    return { ...blank, reason: 'Planned size does not leave a positive order after costs.' };
  }
  const feeUsd = actual * fee * 2, slippageUsd = actual * slip, impactUsd = actual * impact, gasRoundTripUsd = gas * 2;
  const totalUsd = feeUsd + slippageUsd + impactUsd + gasRoundTripUsd;
  const roomUsd = actual * stopDistance;
  const figures = { plannedOrderUsd: planned, actualOrderUsd: actual, feeUsd, gasUsd: gasRoundTripUsd, impactUsd, slippageUsd, totalUsd };
  const text = `planned ${planned} USD, actual ${actual} USD, fee ${feeUsd} USD, gas ${gasRoundTripUsd} USD, impact ${impactUsd} USD, slippage ${slippageUsd} USD`;
  if (!(totalUsd < roomUsd)) return { ...figures, state: 'WAIT', reason: `${text}; costs consume the stop room.` };
  return { ...figures, state: 'ELIGIBLE', reason: `${text}; order stays inside ${slippageBps} bps.` };
}
module.exports = { economicViability };
