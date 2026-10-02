import { randomInt } from 'node:crypto';

export const HIGH_LOW_WAGERS = Object.freeze([100, 1_000, 10_000]);
export const HIGH_LOW_MAX_STREAK = 5;
export const HIGH_LOW_FATE_SHIFT_DENOMINATOR = 1_000;
export const HIGH_LOW_RULES_VERSION = 1;

const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
const ranks = [
  ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7], ['8', 8],
  ['9', 9], ['10', 10], ['J', 11], ['Q', 12], ['K', 13], ['A', 14],
];

const cardsById = new Map(suits.flatMap(suit => ranks.map(([rank, value]) => {
  const card = Object.freeze({ suit, rank, value, id: `${suit}-${rank}` });
  return [card.id, card];
})));

export function cardFromId(cardId) {
  const card = cardsById.get(cardId);
  if (!card) throw new Error(`Unknown card id: ${cardId}`);
  return card;
}

export function createSecureDeck(randomIndex = upperBound => randomInt(upperBound)) {
  const deck = [...cardsById.keys()];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1);
    if (!Number.isInteger(target) || target < 0 || target > index) {
      throw new RangeError('randomIndex returned an invalid deck index');
    }
    [deck[index], deck[target]] = [deck[target], deck[index]];
  }
  return deck;
}

export function isActionableCard(cardId) {
  const value = cardFromId(cardId).value;
  return value > 2 && value < 14;
}

export function drawActionableCard(deck) {
  const autoDrawnCards = [];
  while (deck.length > 0) {
    const cardId = deck.pop();
    if (isActionableCard(cardId)) return { cardId, autoDrawnCards };
    autoDrawnCards.push(cardId);
  }
  throw new Error('Deck ended before an actionable card was found');
}

export function compareCardIds(currentCardId, nextCardId) {
  const current = cardFromId(currentCardId);
  const next = cardFromId(nextCardId);
  if (next.value === current.value) return 'tie';
  return next.value > current.value ? 'higher' : 'lower';
}

export function calculatePayout(wager, streak) {
  const multipliers = new Map([[1, 15_000], [2, 20_000], [3, 30_000], [4, 40_000], [5, 60_000]]);
  const basisPoints = multipliers.get(streak) ?? 0;
  return Math.floor((wager * basisPoints) / 10_000);
}

export function payoutMultiplier(streak) {
  return ({ 1: '1.5', 2: '2.0', 3: '3.0', 4: '4.0', 5: '6.0' })[streak] ?? '0.0';
}

export function nextWinOffer(wager, streak) {
  const nextStreak = Math.min(streak + 1, HIGH_LOW_MAX_STREAK);
  return {
    payout: calculatePayout(wager, nextStreak),
    multiplier: payoutMultiplier(nextStreak),
  };
}

export function resolveServerGuess({
  currentCardId,
  deck,
  guess,
  randomIndex = upperBound => randomInt(upperBound),
}) {
  if (guess !== 'higher' && guess !== 'lower') throw new RangeError('guess must be higher or lower');
  if (!isActionableCard(currentCardId)) throw new Error('Current card must be actionable');
  const nextDeck = [...deck];
  const revealedCardId = nextDeck.pop();
  if (!revealedCardId) throw new Error('The deck is empty');

  let finalCardId = revealedCardId;
  let relation = compareCardIds(currentCardId, revealedCardId);
  let fateShifted = false;
  if (relation !== 'tie' && relation !== guess && randomIndex(HIGH_LOW_FATE_SHIFT_DENOMINATOR) === 0) {
    const candidateIndexes = nextDeck.flatMap((cardId, index) =>
      compareCardIds(currentCardId, cardId) === guess ? [index] : []);
    if (candidateIndexes.length > 0) {
      const replacementIndex = candidateIndexes[randomIndex(candidateIndexes.length)];
      finalCardId = nextDeck[replacementIndex];
      nextDeck[replacementIndex] = revealedCardId;
      relation = guess;
      fateShifted = true;
    }
  }

  const result = relation === 'tie' ? 'tie' : relation === guess ? 'win' : 'loss';
  const autoDrawnCardIds = [];
  let currentAfterCardId = finalCardId;
  if (result !== 'loss' && !isActionableCard(finalCardId)) {
    const drawn = drawActionableCard(nextDeck);
    currentAfterCardId = drawn.cardId;
    autoDrawnCardIds.push(...drawn.autoDrawnCards, drawn.cardId);
  }

  return {
    deck: nextDeck,
    result,
    relation,
    revealedCardId,
    finalCardId,
    currentAfterCardId,
    autoDrawnCardIds,
    fateShifted,
  };
}

export function publicCard(cardId) {
  return { ...cardFromId(cardId) };
}
