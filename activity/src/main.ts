import './styles.css';
import { initAccountPanel } from './accountPanel.js';
import { createDeck, resolveGuess, shuffleDeck } from './game.js';
import type { Guess, GuessResult, PlayingCard, Suit } from './game.js';

const suitSymbols: Record<Suit, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

const stage = requiredElement<HTMLDivElement>('card-stage');
const highButton = requiredElement<HTMLButtonElement>('guess-high');
const lowButton = requiredElement<HTMLButtonElement>('guess-low');
const newGameButton = requiredElement<HTMLButtonElement>('new-game');
const rulesButton = requiredElement<HTMLButtonElement>('rules-button');
const rulesDialog = requiredElement<HTMLDialogElement>('rules-dialog');
const resultBanner = requiredElement<HTMLDivElement>('result-banner');
const resultMessage = requiredElement<HTMLElement>('result-message');
const decisionPrompt = requiredElement<HTMLElement>('decision-prompt');
const correctCount = requiredElement<HTMLElement>('correct-count');
const streakCount = requiredElement<HTMLElement>('streak-count');
const bestCount = requiredElement<HTMLElement>('best-count');
const deckCount = requiredElement<HTMLElement>('deck-count');

let deck: PlayingCard[] = [];
let current: PlayingCard | undefined;
let currentElement: HTMLDivElement;
let correct = 0;
let streak = 0;
let best = readBest();
let locked = true;

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
        <div class="corner corner-top"><b>${card.rank}</b><span>${symbol}</span></div>
        <div class="card-center"><span>${symbol}</span><b>${card.rank}</b></div>
        <div class="corner corner-bottom"><b>${card.rank}</b><span>${symbol}</span></div>
      </div>
    </div>`;
  return cardElement;
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

async function dealInitialCard(card: PlayingCard): Promise<void> {
  currentElement = createCardElement(card, false);
  currentElement.classList.add('from-deck');
  stage.replaceChildren(currentElement);
  await wait(50);
  currentElement.classList.add('is-dealt');
  await wait(360);
  currentElement.classList.add('is-face-up');
  await wait(540);
  currentElement.classList.remove('from-deck', 'is-dealt');
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
  const previous = current;
  setControlsEnabled(false);
  decisionPrompt.textContent = 'カードを確認中…';
  resultBanner.className = 'result-banner is-hidden';

  const next = deck.pop();
  if (!next) return;
  const result = resolveGuess(previous, next, guess);
  const incoming = createCardElement(next, false);
  incoming.classList.add('from-deck');
  stage.append(incoming);

  await wait(40);
  currentElement.classList.add('to-discard');
  incoming.classList.add('is-dealt');
  await wait(390);
  incoming.classList.add('is-face-up');
  await wait(520);

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
    }
  } else if (result.correct === false) {
    streak = 0;
  }

  const presentation = describeResult(result, guess);
  resultBanner.className = `result-banner is-${presentation.tone}`;
  resultBanner.querySelector('.result-kicker')!.textContent = presentation.kicker;
  resultMessage.textContent = presentation.message;
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
  setControlsEnabled(false);
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
  await dealInitialCard(first);
  decisionPrompt.textContent = current.value === 14
    ? 'Aより低いか、同じ数字が出ます'
    : current.value === 2
      ? '2より高いか、同じ数字が出ます'
      : '次のカードを予想してください';
  setControlsEnabled(true);
}

highButton.addEventListener('click', () => void makeGuess('higher'));
lowButton.addEventListener('click', () => void makeGuess('lower'));
newGameButton.addEventListener('click', () => void startGame());
rulesButton.addEventListener('click', () => rulesDialog.showModal());

window.addEventListener('keydown', event => {
  if (event.repeat || rulesDialog.open) return;
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    void makeGuess('higher');
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    void makeGuess('lower');
  }
});

bestCount.textContent = String(best);
initAccountPanel();
void startGame();
