import assert from 'node:assert/strict';
import test from 'node:test';
import { canGuess } from '../src/games/high-low/game.js';
import type { PlayingCard } from '../src/games/high-low/game.js';

test('rejects guesses that cannot win from the minimum or maximum rank', () => {
  const card = (rank: PlayingCard['rank'], value: number): PlayingCard => ({
    id: `spades-${rank}`, rank, suit: 'spades', value,
  });
  const ace = card('A', 14);
  const two = card('2', 2);
  const seven = card('7', 7);

  assert.equal(canGuess(ace, 'higher'), false);
  assert.equal(canGuess(ace, 'lower'), true);
  assert.equal(canGuess(two, 'lower'), false);
  assert.equal(canGuess(two, 'higher'), true);
  assert.equal(canGuess(seven, 'higher'), true);
  assert.equal(canGuess(seven, 'lower'), true);
});
