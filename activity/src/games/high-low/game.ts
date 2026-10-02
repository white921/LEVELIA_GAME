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
export type Rank = (typeof RANKS)[number]['label'];
export type Guess = 'higher' | 'lower';

export interface PlayingCard {
  readonly suit: Suit;
  readonly rank: Rank;
  readonly value: number;
  readonly id: string;
}

export function canGuess(current: PlayingCard, guess: Guess): boolean {
  if (guess === 'higher') return current.value < 14;
  return current.value > 2;
}
