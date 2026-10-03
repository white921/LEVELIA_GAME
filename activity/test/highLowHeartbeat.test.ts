import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

test('heartbeat conflicts preserve the result of a paid game', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, SVGElement: dom.window.SVGElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  const { HighLowGame } = await import('../src/games/high-low/HighLowGame.js');
  const card = { id: 'clubs-8', rank: '8', value: 8, suit: 'clubs' };
  const next = { id: 'diamonds-10', rank: '10', value: 10, suit: 'diamonds' };
  const hand = {
    id: '508', wager: 1000, streak: 0, potentialPayout: 0, multiplier: '0',
    nextWinOffers: { higher: { available: true, payout: 1500, multiplier: '1.5' }, lower: { available: true, payout: 2200, multiplier: '2.2' } }, currentCard: card, version: 1,
    rulesVersion: 2, disconnectDeadlineAt: new Date(Date.now() + 300_000).toISOString(), canCashOut: false,
  };
  const loss = () => Response.json({
    bestStreak: 0, hand: null, settlement: { reason: 'loss', payout: 0, wallet: null },
    event: { guess: 'lower', result: 'loss', previousCard: card, revealedCard: next,
      finalCard: next, autoDrawnCards: [], fateShifted: false },
  });
  const conflict = () => Response.json({ error: 'hand_not_active', message: 'finished' }, { status: 409 });
  const container = document.getElementById('root')!;
  try {
    for (const timing of ['during-request', 'during-reveal', 'after-result', 'idle'] as const) {
      await t.test(timing, async sub => {
        let heartbeat!: () => void;
        const animationSteps: Array<() => void> = [];
        sub.mock.method(window, 'setInterval', (callback: () => void) => { heartbeat = callback; return 1; });
        sub.mock.method(window, 'clearInterval', () => {});
        sub.mock.method(window, 'setTimeout', (callback: () => void) => { animationSteps.push(callback); return 1; });
        let reads = 0;
        let guesses = 0;
        let finishGuess!: (response: Response) => void;
        let finishHeartbeat!: (response: Response) => void;
        sub.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
          const path = String(url);
          if (path.endsWith('/session')) {
            reads++;
            return Response.json({ accountFound: true, wallet: '9000', bestStreak: 0, hand: reads === 1 ? hand : null });
          }
          if (path.endsWith('/heartbeat')) {
            if (timing === 'after-result') return new Promise<Response>(resolve => { finishHeartbeat = resolve; });
            return conflict();
          }
          assert.ok(path.endsWith('/guess'), 'no extra wager or unexpected command');
          guesses++;
          if (timing === 'during-request') return new Promise<Response>(resolve => { finishGuess = resolve; });
          return loss();
        });
        const root = createRoot(container);
        try {
          await act(async () => root.render(createElement(HighLowGame, {
            best: 0, onBestChange() {}, accessToken: 'test', inDiscord: true, onWalletChanged() {},
          })));
          if (timing === 'idle') {
            await act(async () => heartbeat());
            assert.equal(reads, 2, 'an idle expired game must still reconcile');
            assert.ok(container.querySelector('.wager-options'));
            return;
          }
          if (timing === 'after-result') await act(async () => heartbeat());
          await act(async () => container.querySelector<HTMLButtonElement>('.guess-low')!.click());
          if (timing !== 'after-result') await act(async () => heartbeat());
          assert.equal(reads, 1, 'heartbeat must not reload during a guess or its reveal');
          assert.equal(container.querySelector('.wager-options'), null);
          if (timing === 'during-request') await act(async () => finishGuess(loss()));
          for (let step = 0; animationSteps.length && step < 20; step++) {
            await act(async () => animationSteps.shift()!());
          }
          assert.match(container.querySelector('.settlement-summary')?.textContent ?? '', /賭け金は払い戻されません/);
          if (timing === 'after-result') await act(async () => finishHeartbeat(conflict()));
          assert.equal(reads, 1, 'a late heartbeat must not clear the completed result');
          assert.match(container.querySelector('.settlement-summary')?.textContent ?? '', /賭け金は払い戻されません/);
          assert.equal(guesses, 1);
          assert.equal(container.querySelector<HTMLButtonElement>('.wager-options button')?.disabled, false);
        } finally {
          await act(async () => root.unmount());
        }
      });
    }
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
