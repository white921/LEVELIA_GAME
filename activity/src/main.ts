import './styles.css';
import { initAccountPanel } from './accountPanel.js';
import {
  chooseFateShiftReplacement,
  createDeck,
  FATE_SHIFT_CHANCE,
  resolveGuess,
  shuffleDeck,
} from './game.js';
import type { Guess, GuessResult, PlayingCard, Suit } from './game.js';
import { navigateTo, routeFromHash } from './navigation.js';
import type { ActivityRoute } from './navigation.js';

const suitSymbols: Record<Suit, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

const guessRevealTiming = {
  beforeDeal: 100,
  cardTravel: 440,
  suspense: 850,
  cardFlip: 600,
} as const;

const fateShiftTiming = {
  falseResult: 950,
  awakening: 1500,
  erase: 520,
  restore: 1000,
  resolution: 800,
} as const;

const fateDemoRequested = new URLSearchParams(window.location.search).get('fate-demo') === '1';

const stage = requiredElement<HTMLDivElement>('card-stage');
const highButton = requiredElement<HTMLButtonElement>('guess-high');
const lowButton = requiredElement<HTMLButtonElement>('guess-low');
const newGameButton = requiredElement<HTMLButtonElement>('new-game');
const selectHighLowButton = requiredElement<HTMLButtonElement>('select-high-low');
const lobbyButton = requiredElement<HTMLButtonElement>('lobby-button');
const rulesButton = requiredElement<HTMLButtonElement>('rules-button');
const rulesDialog = requiredElement<HTMLDialogElement>('rules-dialog');
const lobbyHeadingView = requiredElement<HTMLElement>('lobby-heading-view');
const lobbyView = requiredElement<HTMLElement>('lobby-view');
const gameView = requiredElement<HTMLElement>('game-view');
const resultBanner = requiredElement<HTMLDivElement>('result-banner');
const resultMessage = requiredElement<HTMLElement>('result-message');
const decisionPrompt = requiredElement<HTMLElement>('decision-prompt');
const correctCount = requiredElement<HTMLElement>('correct-count');
const streakCount = requiredElement<HTMLElement>('streak-count');
const bestCount = requiredElement<HTMLElement>('best-count');
const deckCount = requiredElement<HTMLElement>('deck-count');
const lobbyBestCount = requiredElement<HTMLElement>('lobby-best-count');
const fateOverlay = requiredElement<HTMLDivElement>('fate-overlay');

let deck: PlayingCard[] = [];
let current: PlayingCard | undefined;
let currentElement: HTMLDivElement;
let correct = 0;
let streak = 0;
let best = readBest();
let locked = true;
let gameGeneration = 0;
let currentRoute: ActivityRoute = 'lobby';
let fateDemoPending = fateDemoRequested;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function readBest(): number {
  try {
    const value = Number.parseInt(localStorage.getItem('levelia-high-low-best') ?? '0', 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function saveBest(): void {
  try {
    localStorage.setItem('levelia-high-low-best', String(best));
  } catch {
    // The game remains playable when storage is blocked.
  }
}

function updateBestDisplays(): void {
  bestCount.textContent = String(best);
  lobbyBestCount.textContent = String(best);
}

function createCardElement(card: PlayingCard, faceUp: boolean): HTMLDivElement {
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  const symbol = suitSymbols[card.suit];
  const cardElement = document.createElement('div');
  cardElement.className = `playing-card${faceUp ? ' is-face-up' : ''}${red ? ' is-red' : ''}`;
  cardElement.setAttribute('aria-label', `${card.rank}${symbol}`);
  cardElement.innerHTML = `
    <div class="card-inner">
      <div class="card-face card-back" aria-hidden="true">
        <div class="back-pattern"><span>L</span></div>
      </div>
      <div class="card-face card-front">
        <div class="corner corner-top"><b data-card-rank>${card.rank}</b><span data-card-suit>${symbol}</span></div>
        <div class="card-center"><span data-card-suit>${symbol}</span><b data-card-rank>${card.rank}</b></div>
        <div class="corner corner-bottom"><b data-card-rank>${card.rank}</b><span data-card-suit>${symbol}</span></div>
      </div>
    </div>`;
  return cardElement;
}

function updateCardFace(cardElement: HTMLDivElement, card: PlayingCard): void {
  const symbol = suitSymbols[card.suit];
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  cardElement.classList.toggle('is-red', red);
  cardElement.setAttribute('aria-label', `${card.rank}${symbol}`);
  cardElement.querySelectorAll<HTMLElement>('[data-card-rank]').forEach(element => {
    element.textContent = card.rank;
  });
  cardElement.querySelectorAll<HTMLElement>('[data-card-suit]').forEach(element => {
    element.textContent = symbol;
  });
}

function updateScoreboard(): void {
  correctCount.textContent = String(correct);
  streakCount.textContent = String(streak);
  bestCount.textContent = String(best);
  deckCount.textContent = String(deck.length);
}

function setControlsEnabled(enabled: boolean): void {
  locked = !enabled;
  highButton.disabled = !enabled || current?.value === 14;
  lowButton.disabled = !enabled || current?.value === 2;
  highButton.setAttribute('aria-describedby', current?.value === 14 ? 'decision-prompt' : '');
  lowButton.setAttribute('aria-describedby', current?.value === 2 ? 'decision-prompt' : '');
}

function wait(duration: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, duration));
}

function startFateEffects(): void {
  const stageRect = stage.getBoundingClientRect();
  fateOverlay.style.setProperty('--fate-x', `${stageRect.left + stageRect.width / 2}px`);
  fateOverlay.style.setProperty('--fate-y', `${stageRect.top + stageRect.height / 2}px`);
  document.body.classList.add('is-fate-shifting');
  fateOverlay.className = 'fate-overlay is-active';
  stage.classList.add('is-fate-active');
}

function resetFateEffects(): void {
  document.body.classList.remove('is-fate-shifting');
  fateOverlay.className = 'fate-overlay';
  stage.classList.remove('is-fate-active');
}

async function dealInitialCard(card: PlayingCard, generation: number): Promise<boolean> {
  currentElement = createCardElement(card, false);
  currentElement.classList.add('from-deck');
  stage.replaceChildren(currentElement);
  await wait(50);
  if (generation !== gameGeneration) return false;
  currentElement.classList.add('is-dealt');
  await wait(360);
  if (generation !== gameGeneration) return false;
  currentElement.classList.add('is-face-up');
  await wait(540);
  if (generation !== gameGeneration) return false;
  currentElement.classList.remove('from-deck', 'is-dealt');
  return true;
}

function describeResult(result: GuessResult, guess: Guess): { kicker: string; message: string; tone: string } {
  if (result.correct === null) return { kicker: 'DRAW', message: '同じ数字', tone: 'neutral' };
  if (result.correct) return {
    kicker: 'CORRECT',
    message: guess === 'higher' ? 'HIGH 正解' : 'LOW 正解',
    tone: 'positive',
  };
  return {
    kicker: 'MISS',
    message: guess === 'higher' ? 'HIGH 不正解' : 'LOW 不正解',
    tone: 'negative',
  };
}

async function makeGuess(guess: Guess): Promise<void> {
  if (locked || deck.length === 0 || !current) return;
  const generation = gameGeneration;
  const previous = current;
  setControlsEnabled(false);
  decisionPrompt.textContent = '次のカードを引いています…';
  resultBanner.className = 'result-banner is-hidden';

  let next = deck.pop();
  if (!next) return;
  let result = resolveGuess(previous, next, guess);
  let fateShifted = false;
  const fateShiftSelected = result.correct === false
    && (fateDemoPending || Math.random() < FATE_SHIFT_CHANCE);
  const fateReplacement = fateShiftSelected
    ? chooseFateShiftReplacement(previous, next, deck, guess)
    : null;

  if (fateReplacement) {
    deck[fateReplacement.index] = next;
    fateDemoPending = false;
    fateShifted = true;
  }

  const incoming = createCardElement(next, false);
  incoming.classList.add('from-deck');
  stage.append(incoming);

  await wait(guessRevealTiming.beforeDeal);
  if (generation !== gameGeneration) return;
  currentElement.classList.add('to-discard');
  incoming.classList.add('is-dealt');
  await wait(guessRevealTiming.cardTravel);
  if (generation !== gameGeneration) return;
  decisionPrompt.textContent = 'カードをめくります…';
  await wait(guessRevealTiming.suspense);
  if (generation !== gameGeneration) return;
  incoming.classList.add('is-face-up');
  await wait(guessRevealTiming.cardFlip);
  if (generation !== gameGeneration) return;

  if (fateReplacement) {
    const falsePresentation = describeResult(result, guess);
    resultBanner.className = 'result-banner is-negative';
    resultBanner.querySelector('.result-kicker')!.textContent = falsePresentation.kicker;
    resultMessage.textContent = falsePresentation.message;
    decisionPrompt.textContent = '……';
    await wait(fateShiftTiming.falseResult);
    if (generation !== gameGeneration) return;

    startFateEffects();
    incoming.classList.add('is-fate-awakening');
    resultBanner.className = 'result-banner is-fate';
    resultBanner.querySelector('.result-kicker')!.textContent = 'FATE INTERVENES';
    resultMessage.textContent = '運命が揺らいでいる';
    decisionPrompt.textContent = 'カードに何かが起きています…';
    await wait(fateShiftTiming.awakening);
    if (generation !== gameGeneration) return;

    fateOverlay.classList.add('is-rewriting');
    incoming.classList.add('is-fate-erasing');
    await wait(fateShiftTiming.erase);
    if (generation !== gameGeneration) return;
    next = fateReplacement.card;
    updateCardFace(incoming, next);
    result = resolveGuess(previous, next, guess);
    incoming.classList.remove('is-fate-erasing');
    incoming.classList.add('is-fate-restoring');
    fateOverlay.classList.remove('is-rewriting');
    fateOverlay.classList.add('is-revealed');
    await wait(fateShiftTiming.restore);
    if (generation !== gameGeneration) return;
    resultBanner.querySelector('.result-kicker')!.textContent = 'FATE REWRITTEN';
    resultMessage.textContent = '運命が書き換わった';
    decisionPrompt.textContent = '新しい運命を確定しています…';
    fateOverlay.classList.add('is-resolved');
    await wait(fateShiftTiming.resolution);
    if (generation !== gameGeneration) return;
    incoming.classList.remove('is-fate-awakening', 'is-fate-restoring');
    resetFateEffects();
  }

  currentElement.remove();
  incoming.classList.remove('from-deck', 'is-dealt');
  currentElement = incoming;
  current = next;

  if (result.correct === true) {
    correct += 1;
    streak += 1;
    if (streak > best) {
      best = streak;
      saveBest();
      updateBestDisplays();
    }
  } else if (result.correct === false) {
    streak = 0;
  }

  const presentation = describeResult(result, guess);
  resultBanner.className = fateShifted
    ? 'result-banner is-fate-complete'
    : `result-banner is-${presentation.tone}`;
  resultBanner.querySelector('.result-kicker')!.textContent = fateShifted
    ? 'FATE REWRITTEN'
    : presentation.kicker;
  resultMessage.textContent = fateShifted
    ? `運命改変・${presentation.message}`
    : presentation.message;
  updateScoreboard();

  if (deck.length === 0) {
    locked = true;
    highButton.disabled = true;
    lowButton.disabled = true;
    decisionPrompt.textContent = `山札終了。${correct}回正解しました。`;
    newGameButton.classList.add('is-prominent');
  } else {
    decisionPrompt.textContent = current.value === 14
      ? 'Aより低いか、同じ数字が出ます'
      : current.value === 2
        ? '2より高いか、同じ数字が出ます'
        : '次のカードを予想してください';
    setControlsEnabled(true);
  }
}

async function startGame(): Promise<void> {
  const generation = ++gameGeneration;
  setControlsEnabled(false);
  resetFateEffects();
  deck = shuffleDeck(createDeck());
  const first = deck.pop();
  if (!first) throw new Error('The deck is empty');
  current = first;
  correct = 0;
  streak = 0;
  newGameButton.classList.remove('is-prominent');
  resultBanner.className = 'result-banner';
  resultBanner.querySelector('.result-kicker')!.textContent = 'CURRENT CARD';
  resultMessage.textContent = '最初のカード';
  decisionPrompt.textContent = 'カードを配っています…';
  updateScoreboard();
  if (!await dealInitialCard(first, generation)) return;
  decisionPrompt.textContent = current.value === 14
    ? 'Aより低いか、同じ数字が出ます'
    : current.value === 2
      ? '2より高いか、同じ数字が出ます'
      : '次のカードを予想してください';
  setControlsEnabled(true);
}

function renderRoute(route: ActivityRoute): void {
  currentRoute = route;
  const playingHighLow = route === 'high-low';
  lobbyHeadingView.hidden = playingHighLow;
  lobbyView.hidden = playingHighLow;
  gameView.hidden = !playingHighLow;
  lobbyButton.hidden = !playingHighLow;
  rulesButton.hidden = !playingHighLow;

  if (playingHighLow) {
    document.title = 'High & Low | LEVELIA GAMES';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    void startGame();
    return;
  }

  document.title = 'LEVELIA GAMES';
  gameGeneration += 1;
  setControlsEnabled(false);
  resetFateEffects();
  updateBestDisplays();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

highButton.addEventListener('click', () => void makeGuess('higher'));
lowButton.addEventListener('click', () => void makeGuess('lower'));
newGameButton.addEventListener('click', () => void startGame());
selectHighLowButton.addEventListener('click', () => navigateTo('high-low'));
lobbyButton.addEventListener('click', () => navigateTo('lobby'));
rulesButton.addEventListener('click', () => rulesDialog.showModal());
window.addEventListener('hashchange', () => renderRoute(routeFromHash(window.location.hash)));

window.addEventListener('keydown', event => {
  if (currentRoute !== 'high-low' || event.repeat || rulesDialog.open) return;
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    void makeGuess('higher');
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    void makeGuess('lower');
  }
});

updateBestDisplays();
initAccountPanel();
renderRoute(routeFromHash(window.location.hash));
