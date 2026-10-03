import assert from 'node:assert/strict';
import test from 'node:test';
import { startHighLow, HighLowApiError } from '../src/games/high-low/api.js';

test('retries an uncertain wager with the same request ID and body', async t => {
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    bodies.push(String(options.body));
    assert.ok(options.signal, 'requests must have a deadline');
    if (bodies.length === 1) throw new TypeError('response lost after commit');
    return Response.json({ wallet: '900', hand: { id: '1' } });
  });
  const result = await startHighLow('test-token', 100);
  assert.equal(result.wallet, '900');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.ok(JSON.parse(bodies[0]!).requestId);
});

test('retries server errors once, but does not retry rejected wagers', async t => {
  for (const status of [503, 409, 403]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return Response.json({ error: 'test_error', message: 'rejected' }, { status });
    });
    await assert.rejects(startHighLow('test-token', 100), HighLowApiError);
    assert.equal(calls, status === 503 ? 2 : 1);
    mock.mock.restore();
  }
});

test('successful wagers are sent only once', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ wallet: '900', hand: { id: '1' } });
  });
  await startHighLow('test-token', 100);
  assert.equal(calls, 1);
});
