import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { createActivityApi } from '../server/activityApi.mjs';
import { MANAGEMENT_ROLE_IDS } from '../server/highLowAdmin.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const appId = '1552246348756025344', guildId = '1534636292153807039';
const env = { DISCORD_CLIENT_ID: appId, GUILD_ID: guildId,
  DISCORD_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') };
const base = { id: '1555555555555555555', application_id: appId, guild_id: guildId, type: 2,
  token: 'test-only-token', member: { user: { id: '649438093996195851' }, roles: [MANAGEMENT_ROLE_IDS[0]] },
  data: { name: 'ハイロー還元率', type: 1, options: [{ name: '設定', type: 1, options: [{ name: '目標', type: 10, value: 98.46 }] }] } };
function response() { return { writeHead(code) { this.status = code; }, setHeader() {}, end(body) { this.body = JSON.parse(body); } }; }
function request(payload, { old = false, tamper = false } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now()/1000) - (old ? 1000 : 0));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  const req = Readable.from([Buffer.from(tamper ? body + ' ' : body)]);
  req.method = 'POST'; req.headers = { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': signature };
  return req;
}

test('signed Discord requests require the exact guild and one of the three roles, including for administrators', async () => {
  const calls = [], replies = [];
  const api = createActivityApi({ env, highLowStore: {
    async setTargetRtp(input) { calls.push(input); return { correctionPpm: 959826, targetRtpPpm: input.targetRtpPpm, version: 2 }; },
    async close() {},
  }, fetchImpl: async (url, init) => { replies.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); } });
  try {
    for (const role of MANAGEMENT_ROLE_IDS) {
      const res = response();
      await api.handle(request({ ...base, member: { ...base.member, roles: [role] } }), res, new URL('http://local/api/discord/interactions'));
      assert.deepEqual(res.body, { type: 5, data: { flags: 64 } });
    }
    for (const change of [
      { member: { ...base.member, roles: [] } },
      { member: { ...base.member, roles: ['123456789012345678'], permissions: '8' } },
      { member: undefined, user: base.member.user, guild_id: undefined },
      { guild_id: '123456789012345678' }, { application_id: '123456789012345678' },
    ]) {
      const res = response();
      await api.handle(request({ ...base, ...change }), res, new URL('http://local/api/discord/interactions'));
      assert.equal(res.body.type, 4);
      assert.equal(res.body.data.flags, 64);
      assert.match(res.body.data.content, /管理3ロール/);
    }
  } finally { await api.close(); }
  assert.equal(calls.length, 3);
  assert.equal(calls[0].targetRtpPpm, 984600);
  assert.equal(calls[0].actorId, base.member.user.id);
  assert.equal(calls[0].requestId, base.id);
  assert.equal(replies.length, 3);
  assert.match(replies[0].body.content, /新しいゲームから/);
  assert.deepEqual(replies[0].body.allowed_mentions, { parse: [] });
});

test('signature, freshness and signed PING are handled before any database access', async () => {
  const api = createActivityApi({ env, highLowStore: new Proxy({}, { get() { throw new Error('Unexpected store access'); } }) });
  for (const options of [{ old: true }, { tamper: true }]) {
    const res = response();
    await api.handle(request(base, options), res, new URL('http://local/api/discord/interactions'));
    assert.equal(res.status, 401);
  }
  const res = response();
  await api.handle(request({ type: 1 }), res, new URL('http://local/api/discord/interactions'));
  assert.deepEqual(res.body, { type: 1 });
});

test('a signed show command reads only; malformed correction values do not reach the store', async () => {
  let reads = 0, writes = 0;
  const api = createActivityApi({ env, highLowStore: {
    async readPayoutConfig() { reads++; return { correctionPpm: 1000000, version: 1 }; },
    async setTargetRtp() { writes++; }, async close() {},
  }, fetchImpl: async () => new Response('{}') });
  const res = response();
  await api.handle(request({ ...base, data: { ...base.data, options: [{ type: 1, name: '確認' }] } }), res, new URL('http://local/api/discord/interactions'));
  for (const value of [-1,0,1001,'99',99.12345]) {
    const res = response();
    const payload = structuredClone(base); payload.data.options[0].options[0].value = value;
    await api.handle(request(payload), res, new URL('http://local/api/discord/interactions'));
    assert.equal(res.body.type, 4);
  }
  await api.close(); assert.equal(reads, 1); assert.equal(writes, 0);
});
