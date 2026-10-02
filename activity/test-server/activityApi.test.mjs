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

test('config reports Discord authentication as disabled without secrets', async () => {
  const api = createActivityApi({ env: {}, highLowStore: closedHighLowStore });
  const res = response();

  assert.equal(await api.handle(request('GET'), res, new URL('http://local/api/config')), true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { discordAuthEnabled: false, discordClientId: null });
});

test('token exchange returns only the Discord access token', async () => {
  const fetchCalls = [];
  const api = createActivityApi({
    env: { DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'secret' },
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
    env: {},
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
  const api = createActivityApi({ env: {}, highLowStore: closedHighLowStore });
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
    env: {},
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
