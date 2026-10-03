import { correctionPercentToPpm, validateCorrectionPpm } from './highLowPayout.mjs';

// Independent draws, existing fate shift, progressive curve, integer payouts.
// Hypothetical engaged population, weighted by actual wager volume; not fitted to people.
// Reproduce: output/iid-target-rtp-20261003/simulate.mjs (correction=1).
export const RTP_CALIBRATION_ID = 'iid-behavior-engaged-20261003-v1';
export const BASELINE_RTP_PERCENT = 102.58118179645447;

export function targetPercentToPpm(value) {
  try { return correctionPercentToPpm(value); }
  catch { throw new RangeError('目標平均還元率は0.0001〜1000%、小数点以下4桁以内で指定してください'); }
}

export function correctionForTarget(targetRtpPpm) {
  validateCorrectionPpm(targetRtpPpm);
  // Rounding is limited to the persisted coefficient (one part per million).
  return validateCorrectionPpm(Math.max(1, Math.round(targetRtpPpm * 100 / BASELINE_RTP_PERCENT)));
}

export function estimatedRtpPercent(correctionPpm) {
  return BASELINE_RTP_PERCENT * validateCorrectionPpm(correctionPpm) / 1_000_000;
}
