import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityApiError, fetchBalance } from '../src/discord/discordActivity.js';

test('preserves the HTTP status when a balance request is rejected', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ message: 'Discord access token was rejected' }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    },
  );

  try {
    await assert.rejects(
      fetchBalance('expired-token'),
      error => error instanceof ActivityApiError && error.statusCode === 401,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
