import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

test('game recovery keeps controls usable without submitting another wager', async t => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals: Record<string, unknown> = {
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
  const hand = {
    id: '1', wager: 100, streak: 1, potentialPayout: 150, multiplier: '1.5',
    nextWinOffers: { higher: { available: true, payout: 200, multiplier: '2' }, lower: { available: true, payout: 300, multiplier: '3' } }, version: 1, rulesVersion: 2,
    currentCard: { id: 'spades-7', rank: '7', value: 7, suit: 'spades' },
    disconnectDeadlineAt: new Date(Date.now() + 300_000).toISOString(), canCashOut: true,
  };
  const session = (active: boolean) => ({ accountFound: true, wallet: '900', bestStreak: 1, hand: active ? hand : null });
  const container = document.getElementById('root')!;
  async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); }
  async function click(button: HTMLButtonElement) { await act(async () => button.click()); await flush(); }
  async function until(predicate: () => boolean) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (predicate()) return;
      await flush();
    }
    assert.ok(predicate(), 'UI did not reach the expected state');
  }
  const button = (selector: string) => {
    const element = container.querySelector<HTMLButtonElement>(selector);
    assert.ok(element, `missing ${selector}`);
    return element;
  };
  try {
    for (const action of ['guess', 'cashout']) {
      await t.test(`${action} version conflict reloads the hand and releases the lock`, async sub => {
        let reads = 0;
        let commands = 0;
        sub.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
          if (String(url).endsWith('/session')) { reads++; return Response.json(session(true)); }
          commands++;
          return Response.json({ error: 'stale_hand_version', message: 'reload' }, { status: 409 });
        });
        const root = createRoot(container);
        try {
          await act(async () => root.render(createElement(HighLowGame, {
            best: 1, onBestChange() {}, accessToken: 'test-token', inDiscord: true, onWalletChanged() {},
          })));
          const selector = action === 'guess' ? '.guess-high' : '.cashout-button';
          await click(button(selector));
          assert.equal(reads, 2);
          assert.equal(button(selector).disabled, false);
          await click(button(selector));
          assert.equal(commands, 2, 'the busy ref must also be released');
        } finally { await act(async () => root.unmount()); }
      });
    }
    await t.test('lost start responses restore the paid hand; failed recovery offers a read-only retry', async sub => {
      let reads = 0;
      let commands = 0;
      let recoveryFails = true;
      sub.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
        if (String(url).endsWith('/session')) {
          reads++;
          if (reads === 1) return Response.json(session(false));
          if (recoveryFails) throw new TypeError('offline');
          return Response.json(session(true));
        }
        commands++;
        throw new TypeError('response lost after debit');
      });
      const root = createRoot(container);
      try {
        await act(async () => root.render(createElement(HighLowGame, {
          best: 1, onBestChange() {}, accessToken: 'test-token', inDiscord: true, onWalletChanged() {},
        })));
        await click(button('.wager-options button'));
        assert.ok(reads >= 2, 'uncertain start must reconcile server state');
        assert.equal(container.querySelector('.wager-options'), null, 'no new wagers until recovery succeeds');
        const submitted = commands;
        recoveryFails = false;
        await click(button('[data-retry-session]'));
        assert.equal(button('.guess-high').disabled, false);
        assert.equal(commands, submitted, 'recovery must not place a second wager');
      } finally { await act(async () => root.unmount()); }
    });
    await t.test('normal start, tie, win and cashout retain their behavior and block double clicks', async sub => {
      const commands: string[] = [];
      let guesses = 0;
      sub.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
        const path = String(url);
        if (path.endsWith('/session')) return Response.json(session(false));
        commands.push(path);
        if (path.endsWith('/start')) return Response.json({ wallet: '900', hand: { ...hand, streak: 0, canCashOut: false }, openingAutoDrawnCards: [] });
        if (path.endsWith('/cashout')) return Response.json({ hand: null, settlement: { reason: 'cashout', payout: 150, wallet: '1050' } });
        guesses++;
        return Response.json({
          bestStreak: 1, hand: { ...hand, streak: guesses === 1 ? 0 : 1, canCashOut: guesses > 1, version: guesses + 1 }, settlement: null,
          event: { guess: 'higher', result: guesses === 1 ? 'tie' : 'win', previousCard: hand.currentCard,
            revealedCard: hand.currentCard, finalCard: hand.currentCard, autoDrawnCards: [], fateShifted: false },
        });
      });
      const root = createRoot(container);
      try {
        await act(async () => root.render(createElement(HighLowGame, {
          best: 1, onBestChange() {}, accessToken: 'test-token', inDiscord: true, onWalletChanged() {},
        })));
        const wager = button('.wager-options button');
        await act(async () => { wager.click(); wager.click(); });
        await until(() => container.querySelector<HTMLButtonElement>('.guess-high')?.disabled === false);
        assert.equal(commands.filter(path => path.endsWith('/start')).length, 1);
        const high = button('.guess-high');
        await act(async () => { high.click(); high.click(); });
        await until(() => button('.guess-high').disabled === false);
        assert.equal(guesses, 1);
        assert.equal(container.querySelector('.cashout-button'), null);
        await click(button('.guess-high'));
        await until(() => button('.guess-high').disabled === false);
        assert.equal(guesses, 2);
        await click(button('.cashout-button'));
        assert.match(container.textContent!, /150 LIAを受け取りました/);
        assert.equal(button('.wager-options button').disabled, false);
        assert.equal(commands.length, 4);
      } finally { await act(async () => root.unmount()); }
    });
    await t.test('a late failure from the previous session cannot reload or lock the new session', async sub => {
      let reads = 0;
      let finishOldRequest!: (response: Response) => void;
      sub.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
        if (String(url).endsWith('/session')) { reads++; return Response.json(session(true)); }
        return new Promise<Response>(resolve => { finishOldRequest = resolve; });
      });
      const root = createRoot(container);
      const callbacks = { best: 1, onBestChange() {}, inDiscord: true, onWalletChanged() {} };
      try {
        await act(async () => root.render(createElement(HighLowGame, { ...callbacks, accessToken: 'old-token' })));
        await act(async () => button('.guess-high').click());
        assert.equal(button('.guess-high').disabled, true);
        await act(async () => root.render(createElement(HighLowGame, { ...callbacks, accessToken: 'new-token' })));
        await act(async () => finishOldRequest(Response.json({ error: 'stale_hand_version', message: 'reload' }, { status: 409 })));
        assert.equal(reads, 2);
        assert.equal(button('.guess-high').disabled, false);
      } finally { await act(async () => root.unmount()); }
    });
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
