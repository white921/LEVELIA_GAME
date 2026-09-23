import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { handleYubisumaInteraction } from '../dist/handler/interaction/yubisumaHandler.js';
import { emptyRoom } from '../dist/service/yubisuma/yubisumaRules.js';
const scope = { guildId: '111111111111111111', channelId: '222222222222222222' };
function fixture(id, type = 'button') {
  const events = [];
  const room = emptyRoom();
  const interaction = {
    id: 'interaction', customId: id, ...scope, user: { id: '333333333333333333' },
    isButton: () => type === 'button', isUserSelectMenu: () => type === 'user', isStringSelectMenu: () => type === 'string',
    deferred: false, replied: false,
    async deferReply(options) { events.push('defer'); assert.equal(options.flags, MessageFlags.Ephemeral); this.deferred = true; },
    async editReply(message) { events.push('reply'); this.lastReply = message; },
  };
  const deps = {
    scope, balanceMode: 'unavailable', database: {},
    store: { async transact(_scope, fn) { events.push('db'); assert.equal(events[0], 'defer'); return fn(room, Date.now()); } },
    messages: { async sync() { events.push('publish'); assert.equal(events[0], 'defer'); } },
  };
  return { interaction, deps, events, room };
}
test('every initial button acknowledges privately and CPU commits before publishing', async () => {
  for (const id of ['ys:start', 'ys:rules', 'ys:balance', 'ys:pair', 'ys:cpu', 'ys:resume', 'ys:cancel-invite']) {
    const f = fixture(id);
    await handleYubisumaInteraction(f.interaction, f.deps);
    assert.equal(f.events[0], 'defer');
    assert.ok(f.events.includes('reply'));
    if (id === 'ys:cpu') assert.deepEqual(f.events, ['defer', 'db', 'reply', 'publish']);
  }
});
test('wrong guild or channel is rejected before DB access', async () => {
  for (const key of ['guildId', 'channelId']) {
    const f = fixture('ys:cpu');
    f.interaction[key] = 'elsewhere';
    await handleYubisumaInteraction(f.interaction, f.deps);
    assert.deepEqual(f.events, ['defer', 'reply']);
    assert.equal(f.room.games.length, 0);
  }
});
test('private menu actions update the same ephemeral message without creating another reply', async () => {
  const f = fixture('ys:cpu');
  f.interaction.message = { flags: { has: flag => flag === MessageFlags.Ephemeral } };
  f.interaction.deferUpdate = async () => { f.events.push('defer'); f.interaction.deferred = true; };
  f.interaction.deferReply = async () => { assert.fail('must update the private message'); };
  await handleYubisumaInteraction(f.interaction, f.deps);
  assert.deepEqual(f.events, ['defer', 'db', 'reply', 'publish']);
  assert.equal(f.room.games.length, 1);
});
test('user select acknowledges before Discord member lookup', async () => {
  const f = fixture('ys:opponent', 'user');
  f.interaction.values = ['444444444444444444'];
  f.interaction.guild = { members: { async fetch() { f.events.push('member'); assert.equal(f.events[0], 'defer'); return { user: { bot: false } }; } } };
  await handleYubisumaInteraction(f.interaction, f.deps);
  assert.deepEqual(f.events, ['defer', 'member', 'db', 'reply']);
});
test('failed acknowledgement never creates a game', async () => {
  const f = fixture('ys:cpu');
  f.interaction.deferReply = async () => { throw Object.assign(new Error('expired'), { code: 10062 }); };
  await handleYubisumaInteraction(f.interaction, f.deps);
  assert.equal(f.room.games.length, 0);
});
