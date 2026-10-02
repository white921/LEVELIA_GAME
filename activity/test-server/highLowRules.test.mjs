import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculatePayout,
  createSecureDeck,
  drawActionableCard,
  nextWinOffer,
  resolveServerGuess,
} from '../server/highLowRules.mjs';

test('creates a unique 52-card deck with an injected unbiased index source', () => {
  const deck = createSecureDeck(() => 0);
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
});

test('skips ace and two until the player receives an actionable card', () => {
  const deck = ['clubs-9', 'hearts-2', 'spades-A'];
  assert.deepEqual(drawActionableCard(deck), {
    cardId: 'clubs-9',
    autoDrawnCards: ['spades-A', 'hearts-2'],
  });
  assert.deepEqual(deck, []);
});

test('resolves a guess and auto-draws after a revealed ace', () => {
  const result = resolveServerGuess({
    currentCardId: 'clubs-7',
    deck: ['clubs-5', 'clubs-2', 'spades-A'],
    guess: 'higher',
    randomIndex: () => 999,
  });
  assert.equal(result.result, 'win');
  assert.equal(result.revealedCardId, 'spades-A');
  assert.deepEqual(result.autoDrawnCardIds, ['clubs-2', 'clubs-5']);
  assert.equal(result.currentAfterCardId, 'clubs-5');
});

test('fate shift is server-side and swaps the losing card back into the deck', () => {
  const samples = [0, 0];
  const result = resolveServerGuess({
    currentCardId: 'clubs-7',
    deck: ['spades-Q', 'hearts-3'],
    guess: 'higher',
    randomIndex: () => samples.shift() ?? 0,
  });
  assert.equal(result.fateShifted, true);
  assert.equal(result.result, 'win');
  assert.equal(result.revealedCardId, 'hearts-3');
  assert.equal(result.finalCardId, 'spades-Q');
  assert.deepEqual(result.deck, ['hearts-3']);
});

test('uses the agreed payout table without floating point settlement', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(streak => calculatePayout(10_000, streak)), [
    15_000, 20_000, 30_000, 40_000, 60_000,
  ]);
});

test('returns the next win payout after the player has something to cash out', () => {
  assert.deepEqual(nextWinOffer(1_000, 1), { payout: 2_000, multiplier: '2.0' });
  assert.deepEqual(nextWinOffer(10_000, 4), { payout: 60_000, multiplier: '6.0' });
});
