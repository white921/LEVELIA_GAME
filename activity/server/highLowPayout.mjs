import { cardFromId, HIGH_LOW_FATE_SHIFT_DENOMINATOR } from './highLowRules.mjs';

// The behavior-study curve, applied once at settlement, not compounded per win.
export const PROGRESSIVE_RETURN_BPS = Object.freeze([0, 9950, 10050, 10150, 10250, 10350]);
export const DEFAULT_CORRECTION_PPM = 1_000_000;
export const MAX_CORRECTION_PPM = 10_000_000;

export function validateCorrectionPpm(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CORRECTION_PPM) {
    throw new RangeError('補正率は0.0001〜1000%、小数点以下4桁以内で指定してください');
  }
  return value;
}

export function correctionPercentToPpm(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('補正率は数値で指定してください');
  const scaled = value * 10_000;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-7) throw new RangeError('補正率は小数点以下4桁以内で指定してください');
  return validateCorrectionPpm(Math.round(scaled));
}

export function createPayoutState({ correctionPpm = DEFAULT_CORRECTION_PPM, version = 1 } = {}) {
  return { numerator: '1', denominator: '1', correctionPpm: validateCorrectionPpm(correctionPpm), configVersion: version };
}

export function parsePayoutState(value) {
  const state = typeof value === 'string' ? JSON.parse(value) : value;
  if (!state || !/^[1-9]\d*$/.test(state.numerator) || !/^[1-9]\d*$/.test(state.denominator)
    || !Number.isSafeInteger(state.configVersion) || state.configVersion < 1) {
    throw new Error('Stored high-low payout state is invalid');
  }
  validateCorrectionPpm(state.correctionPpm);
  return state;
}

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

export function decisiveWinFraction(currentCardId, guess) {
  if (guess !== 'higher' && guess !== 'lower') throw new RangeError('Invalid guess');
  const rank = cardFromId(currentCardId).value;
  const wins = guess === 'higher' ? 14 - rank : rank - 2;
  const losses = 12 - wins;
  if (!wins) return null;
  // A losing draw can be replaced by a uniformly selected winning card.
  return { numerator: BigInt(wins * HIGH_LOW_FATE_SHIFT_DENOMINATOR + losses),
    denominator: BigInt((wins + losses) * HIGH_LOW_FATE_SHIFT_DENOMINATOR) };
}

export function advancePayoutState(stateValue, currentCardId, guess) {
  const state = parsePayoutState(stateValue);
  const q = decisiveWinFraction(currentCardId, guess);
  if (!q) return null;
  const numerator = BigInt(state.numerator) * q.denominator;
  const denominator = BigInt(state.denominator) * q.numerator;
  const divisor = gcd(numerator, denominator);
  return { ...state, numerator: String(numerator / divisor), denominator: String(denominator / divisor) };
}

export function progressivePayout(wager, streak, stateValue) {
  if (!Number.isSafeInteger(wager) || wager < 0 || !Number.isInteger(streak) || streak < 0 || streak > 5) {
    throw new RangeError('Invalid wager or streak');
  }
  const state = parsePayoutState(stateValue);
  const payout = BigInt(wager) * BigInt(state.numerator) * BigInt(PROGRESSIVE_RETURN_BPS[streak])
    * BigInt(state.correctionPpm) / (BigInt(state.denominator) * 10_000n * 1_000_000n);
  if (payout > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Payout exceeds safe integer range');
  return Number(payout);
}

export function displayMultiplier(payout, wager) {
  return (payout / wager).toFixed(4).replace(/\.?0+$/, '') || '0';
}

export function progressiveOffers({ wager, streak, currentCardId, state }) {
  return Object.fromEntries(['higher', 'lower'].map(guess => {
    const next = streak < 5 ? advancePayoutState(state, currentCardId, guess) : null;
    const payout = next ? progressivePayout(wager, streak + 1, next) : null;
    return [guess, { available: next !== null, payout, multiplier: payout === null ? null : displayMultiplier(payout, wager) }];
  }));
}
