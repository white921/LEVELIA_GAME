import { randomInt } from 'node:crypto';

export const HIGH_LOW_WAGERS = Object.freeze([100, 1_000, 10_000]);
export const HIGH_LOW_MAX_STREAK = 5;
export const HIGH_LOW_FATE_SHIFT_DENOMINATOR = 1_000;
export const HIGH_LOW_RULES_VERSION = 3;

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

const allCardIds = Object.freeze([...cardsById.keys()]);

function choose(items, randomIndex) {
  const index = randomIndex(items.length);
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new RangeError('randomIndex returned an invalid card index');
  }
  return items[index];
}

// Every draw samples the complete 52 cards independently, including repeats.
export function drawRandomCard(randomIndex = upperBound => randomInt(upperBound)) {
  return choose(allCardIds, randomIndex);
}

export function isActionableCard(cardId) {
  const value = cardFromId(cardId).value;
  return value > 2 && value < 14;
}

export function drawActionableCard(randomIndex) {
  const autoDrawnCards = [];
  for (;;) {
    const cardId = drawRandomCard(randomIndex);
    if (isActionableCard(cardId)) return { cardId, autoDrawnCards };
    autoDrawnCards.push(cardId);
  }
}

export function compareCardIds(currentCardId, nextCardId) {
  const current = cardFromId(currentCardId);
  const next = cardFromId(nextCardId);
  if (next.value === current.value) return 'tie';
  return next.value > current.value ? 'higher' : 'lower';
}

export function resolveServerGuess({
  currentCardId,
  guess,
  randomIndex = upperBound => randomInt(upperBound),
}) {
  if (guess !== 'higher' && guess !== 'lower') throw new RangeError('guess must be higher or lower');
  if (!isActionableCard(currentCardId)) throw new Error('Current card must be actionable');
  const revealedCardId = drawRandomCard(randomIndex);

  let finalCardId = revealedCardId;
  let relation = compareCardIds(currentCardId, revealedCardId);
  let fateShifted = false;
  if (relation !== 'tie' && relation !== guess && randomIndex(HIGH_LOW_FATE_SHIFT_DENOMINATOR) === 0) {
    const candidates = allCardIds.filter(cardId => compareCardIds(currentCardId, cardId) === guess);
    finalCardId = choose(candidates, randomIndex);
    relation = guess;
    fateShifted = true;
  }

  const result = relation === 'tie' ? 'tie' : relation === guess ? 'win' : 'loss';
  const autoDrawnCardIds = [];
  let currentAfterCardId = finalCardId;
  if (result !== 'loss' && !isActionableCard(finalCardId)) {
    const drawn = drawActionableCard(randomIndex);
    currentAfterCardId = drawn.cardId;
    autoDrawnCardIds.push(...drawn.autoDrawnCards, drawn.cardId);
  }

  return {
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
