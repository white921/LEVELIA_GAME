import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePayoutState, correctionPercentToPpm, createPayoutState, decisiveWinFraction,
  displayMultiplier, progressiveOffers, progressivePayout } from '../server/highLowPayout.mjs';

test('independent odds depend only on rank and direction, including fate shift and excluding ties', () => {
  assert.deepEqual(decisiveWinFraction('spades-3', 'lower'), { numerator: 1011n, denominator: 12000n });
  assert.deepEqual(decisiveWinFraction('hearts-3', 'lower'), decisiveWinFraction('spades-3', 'lower'));
  const state = advancePayoutState(createPayoutState(), 'spades-3', 'lower');
  assert.equal(progressivePayout(10000, 1, state), Number(9950n * 12000n / 1011n));
});

test('curve and correction apply once, preserving exact fair fractions across five wins', () => {
  let state = createPayoutState({ correctionPpm: correctionPercentToPpm(98), version: 3 });
  for (let streak = 1; streak <= 5; streak++) {
    state = advancePayoutState(state, 'spades-8', 'higher');
    const curve = [0,9950,10050,10150,10250,10350][streak];
    const expected = 10000n * 2000n ** BigInt(streak) * BigInt(curve) * 980000n
      / (1001n ** BigInt(streak) * 10000n * 1000000n);
    assert.equal(progressivePayout(10000, streak, state), Number(expected));
    assert.equal(state.correctionPpm, 980000);
    assert.equal(state.configVersion, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  }
});

test('both directions always remain available for actionable cards; five wins finish the hand', () => {
  const state = createPayoutState();
  const offers = progressiveOffers({ wager: 1000, streak: 1, currentCardId: 'spades-7', state });
  assert.ok(offers.lower.available && offers.higher.available);
  assert.ok(offers.lower.payout > offers.higher.payout);
  const finished = progressiveOffers({ wager: 1000, streak: 5, currentCardId: 'spades-7', state });
  assert.deepEqual(finished.lower, { available: false, payout: null, multiplier: null });
  assert.equal(displayMultiplier(1000, 100), '10');
  assert.equal(displayMultiplier(0, 100), '0');
});

test('one-win expected return matches the first-stage curve for every opening rank and both guesses', () => {
  for (const rank of ['3','4','5','6','7','8','9','10','J','Q','K']) for (const guess of ['higher','lower']) {
    const current = `spades-${rank}`;
    const q = decisiveWinFraction(current, guess);
    const paid = progressivePayout(10000, 1, advancePayoutState(createPayoutState(), current, guess));
    const expected = paid * Number(q.numerator) / Number(q.denominator);
    assert.ok(expected <= 9950 + 1e-8 && expected > 9949);
  }
});

test('correction rejects invalid values and excess precision instead of coercing or rounding', () => {
  assert.equal(correctionPercentToPpm(98.4569), 984569);
  for (const invalid of [0,-1,1000.1,NaN,Infinity,'98',98.12345]) assert.throws(() => correctionPercentToPpm(invalid));
});
