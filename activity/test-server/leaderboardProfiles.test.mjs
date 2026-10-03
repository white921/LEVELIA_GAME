import assert from 'node:assert/strict';
import test from 'node:test';
import { createLeaderboardProfiles, defaultAvatar, memberProfile } from '../server/leaderboardProfiles.mjs';

const id = '649438093996195851';
const guild = '1534636292153807039';
const avatar = 'a'.repeat(32);
const globalAvatar = 'b'.repeat(32);
const entry = { userId: id, displayName: 'database name', rank: 1, value: 5 };
const board = { streak: { entries: [entry] }, multiplier: { entries: [entry] } };
const member = { nick: 'Guild name', avatar, user: { id, avatar: globalAvatar, global_name: 'Global', username: 'user', discriminator: '0' } };

test('guild avatar and nickname win; global and default avatars are explicit fallbacks', () => {
  assert.equal(memberProfile(id, guild, member).avatarUrl, `https://cdn.discordapp.com/guilds/${guild}/users/${id}/avatars/${avatar}.webp?size=128`);
  assert.equal(memberProfile(id, guild, member).displayName, 'Guild name');
  assert.match(memberProfile(id, guild, { ...member, avatar: null }).avatarUrl, new RegExp(`/avatars/${id}/${globalAvatar}`));
  assert.equal(memberProfile(id, guild, { ...member, avatar: null, user: { ...member.user, avatar: null } }).avatarUrl, defaultAvatar(id));
  assert.equal(defaultAvatar(id, '1234'), 'https://cdn.discordapp.com/embed/avatars/4.png');
  assert.equal(memberProfile(id, guild, { ...member, user: { id: 'other' } }), null);
});

test('two boards and concurrent viewers share one profile fetch for five minutes', async () => {
  let calls = 0; let now = 1000;
  const add = createLeaderboardProfiles({ env: { GUILD_ID: guild, DISCORD_BOT_TOKEN: 'secret' }, now: () => now,
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, `https://discord.com/api/v10/guilds/${guild}/members/${id}`);
      assert.equal(options.headers.Authorization, 'Bot secret');
      return Response.json(member);
    } });
  const [a, b] = await Promise.all([add(board), add(board)]);
  assert.equal(calls, 1);
  assert.equal(a.multiplier.entries[0].displayName, 'Guild name');
  assert.equal(b.streak.entries[0].avatarUrl, a.multiplier.entries[0].avatarUrl);
  assert.equal(entry.displayName, 'database name', 'cached scores are not mutated');
  assert.ok(!JSON.stringify(a).includes('secret'));
  now += 299999; await add(board); assert.equal(calls, 1);
  now++; await add(board); assert.equal(calls, 2);
});

test('Discord failure and rate limits preserve scores and suppress request storms', async () => {
  let calls = 0; let now = 1000;
  const add = createLeaderboardProfiles({ env: { GUILD_ID: guild, DISCORD_BOT_TOKEN: 'secret' }, now: () => now,
    fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); } });
  const result = await add(board);
  assert.equal(result.streak.entries[0].value, 5);
  assert.equal(result.streak.entries[0].avatarUrl, defaultAvatar(id));
  now += 61000; await add(board); assert.equal(calls, 1);
  now += 60000; await add(board); assert.equal(calls, 2);
  const missing = createLeaderboardProfiles({ env: {}, fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal((await missing(board)).streak.entries[0].displayName, 'database name');
});

test('only the three visible players in each board are resolved', async () => {
  let calls = 0;
  const entries = Array.from({ length: 10 }, (_, i) => ({ ...entry, userId: String(BigInt(id) + BigInt(i)) }));
  const add = createLeaderboardProfiles({ env: { GUILD_ID: guild, DISCORD_BOT_TOKEN: 'secret' }, fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } });
  const result = await add({ streak: { entries }, multiplier: { entries } });
  assert.equal(calls, 3);
  assert.equal(result.streak.entries.length, 3);
});
