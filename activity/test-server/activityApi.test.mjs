import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createActivityApi } from '../server/activityApi.mjs';

function request(method, headers = {}, body = '') {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.method = method;
  stream.headers = headers;
  return stream;
}

function response() {
  return {
    headers: {},
    statusCode: null,
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
    },
    end(body = '') {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

const closedHighLowStore = {
  async readWallet() {
    throw new Error('not expected');
  },
  async close() {},
};

const ownerId = '649438093996195851';
const visitorId = '123456789012345678';
const protectedRoutes = [
  ['GET', '/api/balance', 'readWallet'],
  ['GET', '/api/high-low/stats', 'readBestStreak'],
  ['GET', '/api/high-low/session', 'readSession'],
  ['POST', '/api/high-low/start', 'start'],
  ['POST', '/api/high-low/1/guess', 'guess'],
  ['POST', '/api/high-low/1/cashout', 'cashout'],
  ['POST', '/api/high-low/1/heartbeat', 'heartbeat'],
];
const validBody = JSON.stringify({
  wager: 100, guess: 'higher', expectedVersion: 1,
  requestId: '123e4567-e89b-42d3-a456-426614174000', userId: ownerId,
});

test('private access rejects existing outsider tokens on all routes before any database operation', async () => {
  const api = createActivityApi({
    env: { ACTIVITY_ACCESS_MODE: 'private', ACTIVITY_ALLOWED_USER_IDS: ownerId },
    fetchImpl: async () => new Response(JSON.stringify({ id: visitorId })),
    highLowStore: new Proxy({}, { get() { throw new Error('database must not be accessed'); } }),
  });
  for (const prefix of ['', '/.proxy']) {
    for (const [method, route] of protectedRoutes) {
      const res = response();
      await api.handle(request(method, {
        authorization: 'Bearer previously-issued-token', 'content-type': 'application/json',
        'x-user-id': ownerId,
      }, validBody), res, new URL(`http://local${prefix}${route}?userId=${ownerId}`));
      assert.equal(res.statusCode, 403, route);
      assert.equal(res.json().error, 'activity_access_denied');
      assert.equal(res.headers['Cache-Control'], 'no-store');
    }
  }
});

test('only verified owner identity reaches every protected operation', async () => {
  for (const [method, route, operation] of protectedRoutes) {
    const calls = [];
    const api = createActivityApi({
      env: { ACTIVITY_ALLOWED_USER_IDS: ownerId },
      fetchImpl: async () => new Response(JSON.stringify({ id: ownerId })),
      highLowStore: { async [operation](input) { calls.push(input); return operation === 'readWallet' ? '1000' : {}; } },
    });
    const res = response();
    await api.handle(request(method, {
      authorization: 'Bearer owner-token', 'content-type': 'application/json',
    }, validBody), res, new URL(`http://local${route}`));
    assert.ok(res.statusCode === 200 || res.statusCode === 201, route);
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0] === 'object' ? calls[0].userId : calls[0], ownerId);
  }
});

test('private token exchange verifies identity and never returns a token to outsiders', async () => {
  for (const userId of [ownerId, visitorId]) {
    const api = createActivityApi({
      env: { DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'secret', ACTIVITY_ALLOWED_USER_IDS: ownerId },
      highLowStore: closedHighLowStore,
      fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/oauth2/token')
        ? { access_token: 'private-token', refresh_token: 'private-refresh' } : { id: userId })),
    });
    const res = response();
    await api.handle(request('POST', { 'content-type': 'application/json' }, JSON.stringify({ code: 'authorization-code' })),
      res, new URL('http://local/api/token'));
    assert.equal(res.statusCode, userId === ownerId ? 200 : 403);
    if (userId !== ownerId) assert.ok(!res.body.includes('private-token'));
  }
});

test('missing access configuration fails closed and invalid configuration fails at startup', async () => {
  const api = createActivityApi({
    env: {}, highLowStore: closedHighLowStore,
    fetchImpl: async () => new Response(JSON.stringify({ id: ownerId })),
  });
  const res = response();
  await api.handle(request('GET', { authorization: 'Bearer owner-token' }), res, new URL('http://local/api/balance'));
  assert.equal(res.statusCode, 403);
  for (const env of [{ ACTIVITY_ACCESS_MODE: 'publci' }, { ACTIVITY_ALLOWED_USER_IDS: 'sh1r0_0921' }]) {
    assert.throws(() => createActivityApi({ env, highLowStore: closedHighLowStore }));
  }
});

test('stats uses the verified Discord identity, ignores supplied identity and prevents caching', async () => {
  const userIds = [];
  const api = createActivityApi({
    env: { ACTIVITY_ACCESS_MODE: 'public' },
    highLowStore: {
      async readBestStreak(userId) { userIds.push(userId); return 5; },
      async close() {},
    },
    fetchImpl: async () => new Response(JSON.stringify({ id: '123456789012345678' })),
  });
  const res = response();
  await api.handle(request('GET', { authorization: 'Bearer access-token' }), res,
    new URL('http://local/.proxy/api/high-low/stats?userId=999999999999999999&bestStreak=99'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { bestStreak: 5 });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(userIds, ['123456789012345678']);
});

test('stats rejects unauthenticated reads and does not accept score writes', async () => {
  const api = createActivityApi({ env: { ACTIVITY_ACCESS_MODE: 'public' }, highLowStore: closedHighLowStore,
    fetchImpl: async () => new Response(JSON.stringify({ id: '123456789012345678' })),
  });
  const res = response();
  await api.handle(request('GET'), res, new URL('http://local/api/high-low/stats'));
  assert.equal(res.statusCode, 401);
  const write = response();
  await api.handle(request('POST', { authorization: 'Bearer access-token' }), write, new URL('http://local/api/high-low/stats'));
  assert.equal(write.statusCode, 405);
});

test('config reports Discord authentication as disabled without secrets', async () => {
  const api = createActivityApi({ env: { ACTIVITY_ACCESS_MODE: 'public' }, highLowStore: closedHighLowStore });
  const res = response();

  assert.equal(await api.handle(request('GET'), res, new URL('http://local/api/config')), true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { discordAuthEnabled: false, discordClientId: null });
});

test('token exchange returns only the Discord access token', async () => {
  const fetchCalls = [];
  const api = createActivityApi({
    env: { ACTIVITY_ACCESS_MODE: 'public', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'secret' },
    highLowStore: closedHighLowStore,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'do-not-return' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const res = response();
  const req = request('POST', { 'content-type': 'application/json' }, JSON.stringify({ code: 'authorization-code' }));

  await api.handle(req, res, new URL('http://local/.proxy/api/token'));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { access_token: 'access' });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://discord.com/api/v10/oauth2/token');
  assert.match(String(fetchCalls[0].options.body), /client_secret=secret/);
});

test('balance uses the Discord-verified user id for the read-only lookup', async () => {
  const lookedUpUserIds = [];
  const highLowStore = {
    async readWallet(userId) {
      lookedUpUserIds.push(userId);
      return '1234';
    },
    async close() {},
  };
  const api = createActivityApi({
    env: { ACTIVITY_ACCESS_MODE: 'public' },
    highLowStore,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer access-token');
      return new Response(JSON.stringify({ id: '123456789012345678' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const res = response();

  await api.handle(
    request('GET', { authorization: 'Bearer access-token' }),
    res,
    new URL('http://local/api/balance'),
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { accountFound: true, wallet: '1234' });
  assert.deepEqual(lookedUpUserIds, ['123456789012345678']);
});

test('balance rejects requests without a Discord access token', async () => {
  const api = createActivityApi({ env: { ACTIVITY_ACCESS_MODE: 'public' }, highLowStore: closedHighLowStore });
  const res = response();

  await api.handle(request('GET'), res, new URL('http://local/api/balance'));

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'missing_access_token');
});

test('high-low start uses only the Discord-verified user id', async () => {
  const starts = [];
  const highLowStore = {
    async start(input) {
      starts.push(input);
      return { wallet: '900', hand: { id: '1' }, openingAutoDrawnCards: [] };
    },
    async close() {},
  };
  const api = createActivityApi({
    env: { ACTIVITY_ACCESS_MODE: 'public' },
    highLowStore,
    fetchImpl: async () => new Response(JSON.stringify({ id: '123456789012345678' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const res = response();
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  await api.handle(
    request('POST', { authorization: 'Bearer access-token', 'content-type': 'application/json' },
      JSON.stringify({ wager: 100, requestId, userId: '999999999999999999' })),
    res,
    new URL('http://local/api/high-low/start'),
  );
  assert.equal(res.statusCode, 201);
  assert.deepEqual(starts, [{ userId: '123456789012345678', wager: 100, requestId }]);
});
