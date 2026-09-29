export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'] as const;
export const RANKS = [
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
  { label: '9', value: 9 },
  { label: '10', value: 10 },
  { label: 'J', value: 11 },
  { label: 'Q', value: 12 },
  { label: 'K', value: 13 },
  { label: 'A', value: 14 },
] as const;

export type Suit = (typeof SUITS)[number];
export type Guess = 'higher' | 'lower';
export type Relation = Guess | 'same';

export interface PlayingCard {
  readonly suit: Suit;
  readonly rank: string;
  readonly value: number;
  readonly id: string;
}

export interface GuessResult {
  readonly relation: Relation;
  readonly correct: boolean | null;
}

export function createDeck(): PlayingCard[] {
  return SUITS.flatMap(suit => RANKS.map(({ label, value }) => ({
    suit,
    rank: label,
    value,
    id: `${suit}-${label}`,
  })));
}

export function shuffleDeck(cards: readonly PlayingCard[], random: () => number = Math.random): PlayingCard[] {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError('random must return a value from 0 up to, but not including, 1');
    const target = Math.floor(sample * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled;
}

export function compareCards(current: PlayingCard, next: PlayingCard): Relation {
  if (next.value === current.value) return 'same';
  return next.value > current.value ? 'higher' : 'lower';
}

export function resolveGuess(current: PlayingCard, next: PlayingCard, guess: Guess): GuessResult {
  const relation = compareCards(current, next);
  return { relation, correct: relation === 'same' ? null : relation === guess };
}
