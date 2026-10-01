import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseFateShiftReplacement,
  compareCards,
  createDeck,
  resolveGuess,
  shuffleDeck,
} from '../src/game.js';

test('creates a unique 52-card deck with ace high', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(card => card.id)).size, 52);
  assert.equal(deck.find(card => card.id === 'spades-A')?.value, 14);
  assert.equal(deck.find(card => card.id === 'clubs-2')?.value, 2);
});

test('shuffles without mutating the source deck', () => {
  const deck = createDeck();
  const ids = deck.map(card => card.id);
  const shuffled = shuffleDeck(deck, () => 0);
  assert.deepEqual(deck.map(card => card.id), ids);
  assert.notDeepEqual(shuffled.map(card => card.id), ids);
  assert.deepEqual(new Set(shuffled.map(card => card.id)), new Set(ids));
});

test('compares ranks independently of suit', () => {
  const deck = createDeck();
  const five = deck.find(card => card.id === 'hearts-5')!;
  const king = deck.find(card => card.id === 'clubs-K')!;
  const otherFive = deck.find(card => card.id === 'spades-5')!;
  assert.equal(compareCards(five, king), 'higher');
  assert.equal(compareCards(king, five), 'lower');
  assert.equal(compareCards(five, otherFive), 'same');
});

test('treats equal ranks as a draw for either guess', () => {
  const deck = createDeck();
  const first = deck.find(card => card.id === 'hearts-10')!;
  const second = deck.find(card => card.id === 'diamonds-10')!;
  assert.deepEqual(resolveGuess(first, second, 'higher'), { relation: 'same', correct: null });
  assert.deepEqual(resolveGuess(first, second, 'lower'), { relation: 'same', correct: null });
});

test('fate shift replaces only a missed guess with a card that makes it correct', () => {
  const deck = createDeck();
  const seven = deck.find(card => card.id === 'clubs-7')!;
  const three = deck.find(card => card.id === 'hearts-3')!;
  const candidates = [
    deck.find(card => card.id === 'diamonds-4')!,
    deck.find(card => card.id === 'spades-Q')!,
  ];

  const replacement = chooseFateShiftReplacement(seven, three, candidates, 'higher', () => .99);
  assert.deepEqual(replacement, { card: candidates[1], index: 1 });
  assert.equal(resolveGuess(seven, replacement!.card, 'higher').correct, true);
});

test('fate shift does not activate for a correct or drawn result', () => {
  const deck = createDeck();
  const seven = deck.find(card => card.id === 'clubs-7')!;
  const nine = deck.find(card => card.id === 'hearts-9')!;
  const otherSeven = deck.find(card => card.id === 'diamonds-7')!;
  const candidates = [deck.find(card => card.id === 'spades-Q')!];

  assert.equal(chooseFateShiftReplacement(seven, nine, candidates, 'higher'), null);
  assert.equal(chooseFateShiftReplacement(seven, otherSeven, candidates, 'higher'), null);
});
