import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

test('ranking refreshes at shared five-minute expiry, pauses when hidden/closed, and clears another account', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    SVGElement: dom.window.SVGElement, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let now = Date.parse('2026-10-03T03:00:00Z');
  t.mock.method(Date, 'now', () => now);
  let callback: (() => void) | null = null;
  let delay = 0;
  t.mock.method(window, 'setTimeout', (next: () => void, ms: number) => { callback = next; delay = ms; return 1; });
  t.mock.method(window, 'clearTimeout', () => { callback = null; });
  let reads = 0;
  let fail = false;
  let resetAt: string | null = null;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    reads++;
    if (fail) throw new Error('offline');
    const name = String((options.headers as Record<string, string>).Authorization).endsWith('one') ? 'Player One' : 'Player Two';
    const me = { rank: 1, userId: name, displayName: name, value: 12 };
    return Response.json({ weekStart: '2026-09-27T15:00:00Z', weekEnd: '2026-10-04T15:00:00Z',
      updatedAt: new Date(now).toISOString(), nextUpdateAt: new Date(Math.min(now + 300000, resetAt && Date.parse(resetAt) > now ? Date.parse(resetAt) : Infinity)).toISOString(), resetAt, walletMode: 'real',
      streak: { entries: [me], me, participants: 1 }, multiplier: { entries: [me], me, participants: 1 } });
  });
  const { WeeklyLeaderboard } = await import('../src/games/high-low/WeeklyLeaderboard.js');
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  async function render(open: boolean, token: string | null = 'one') {
    await act(async () => root.render(createElement(WeeklyLeaderboard, { open, accessToken: token, onClose() {} })));
  }
  try {
    await render(false);
    assert.equal(reads, 0);
    await render(true);
    assert.equal(reads, 1);
    assert.equal(delay, 300000);
    assert.match(container.textContent!, /Player One/);
    assert.equal(container.querySelectorAll('.weekly-paper').length, 2);
    assert.equal(container.querySelectorAll('.weekly-record').length, 6);
    assert.match(container.textContent!, /週間最高精算倍率/);
    assert.equal(reads, 1, 'both metrics are fetched together');
    now += 300000;
    await act(async () => callback?.());
    assert.equal(reads, 2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    now += 300000;
    await act(async () => callback?.());
    assert.equal(reads, 2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange')));
    assert.equal(reads, 3);
    await render(false);
    assert.equal(callback, null);
    await render(true);
    assert.equal(reads, 3, 'reopening uses still-fresh snapshot');
    fail = true;
    now += 300000;
    await act(async () => callback?.());
    assert.match(container.textContent!, /前回の記録/);
    assert.match(container.textContent!, /Player One/);
    fail = false;
    await render(true, 'two');
    assert.doesNotMatch(container.textContent!, /Player One/);
    assert.match(container.textContent!, /Player Two/);
    await render(true, null);
    assert.doesNotMatch(container.textContent!, /Player Two/);
    assert.match(container.textContent!, /Discordで接続/);
    resetAt = '2026-10-03T15:00:00Z';
    now = Date.parse(resetAt) - 1000;
    await render(true, 'one');
    assert.match(container.textContent!, /Player One/);
    assert.equal(delay, 1000, 'poll at the scheduled reset, not five minutes later');
    fail = true;
    now += 1000;
    await act(async () => callback?.());
    assert.doesNotMatch(container.textContent!, /Player One/, 'a failed refresh must not retain pre-reset rankings');
    assert.match(container.textContent!, /ランキングを取得できませんでした/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
