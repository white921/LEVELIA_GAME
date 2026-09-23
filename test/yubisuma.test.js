import assert from 'node:assert/strict';
import test from 'node:test';
import { activeGame, chooseOpponent, createGame, emptyRoom, expireRoom, forfeit, participantGame, submitMove } from '../dist/service/yubisuma/yubisumaRules.js';
import { CPU_ID, INVITE_TIMEOUT_MS, TURN_TIMEOUT_MS } from '../dist/constant/yubisuma/yubisuma.js';
import { entryPanel, gameBoard, privateGamePanel } from '../dist/panel/yubisuma/yubisumaPanelService.js';
import { loadConfig } from '../dist/util/system/runtimeConfig.js';
const A = '111111111111111111', B = '222222222222222222', C = '333333333333333333';
const first = () => 0;

test('panel has exactly the requested initial controls', () => {
  assert.deepEqual(entryPanel().components[0].toJSON().components.map(button => button.label), ['プレイ開始', 'ルール説明', '残高確認']);
});
test('matching requires reciprocal selections and disallows active users', () => {
  const room = emptyRoom();
  assert.equal(chooseOpponent(room, A, B, 0), null);
  assert.equal(chooseOpponent(room, C, A, 1), null);
  const game = chooseOpponent(room, B, A, 2, first);
  assert.deepEqual(game.players, [A, B]);
  assert.equal(room.invitations.length, 0);
  assert.throws(() => createGame(room, A, CPU_ID, 3), /すでに対戦中/);
  assert.throws(() => chooseOpponent(room, C, B, 3), /すでに対戦中/);
});
test('expired invitations cannot match; changing selection replaces previous choice', () => {
  const room = emptyRoom();
  chooseOpponent(room, A, B, 0);
  expireRoom(room, INVITE_TIMEOUT_MS);
  assert.equal(chooseOpponent(room, B, A, INVITE_TIMEOUT_MS, first), null);
  chooseOpponent(room, B, C, INVITE_TIMEOUT_MS + 1);
  assert.equal(room.invitations.filter(invite => invite.userId === B).length, 1);
  assert.equal(room.invitations[0].opponentId, C);
});
test('secret inputs resolve only after both submit, correct guess removes a hand, winner reaches zero', () => {
  const room = emptyRoom();
  const game = createGame(room, A, B, 0, first);
  submitMove(room, game.id, A, 1, { fingers: 1, guess: 2 }, 1);
  assert.equal(game.round, 1);
  assert.equal(game.lastResult, null);
  assert.equal(JSON.stringify(gameBoard(game)).includes('宣言2本'), false);
  submitMove(room, game.id, B, 1, { fingers: 1, guess: null }, 2);
  assert.deepEqual(game.hands, [1, 2]);
  assert.equal(game.caller, 1);
  submitMove(room, game.id, B, 2, { fingers: 0, guess: 3 }, 3);
  submitMove(room, game.id, A, 2, { fingers: 0, guess: null }, 4);
  assert.deepEqual(game.hands, [1, 2]);
  assert.equal(game.caller, 0);
  submitMove(room, game.id, B, 3, { fingers: 0, guess: null }, 5);
  submitMove(room, game.id, A, 3, { fingers: 0, guess: 0 }, 6);
  assert.equal(game.status, 'won');
  assert.equal(game.winner, 0);
  assert.deepEqual(game.hands, [0, 2]);
  assert.equal(activeGame(room, A), undefined);
});
test('CPU commits before human input and cannot adapt after seeing the guess', () => {
  const room = emptyRoom();
  const game = createGame(room, A, CPU_ID, 0, max => max - 1);
  assert.deepEqual(game.moves[1], { fingers: 2, guess: 4 });
  assert.equal(game.caller, 1);
  submitMove(room, game.id, A, 1, { fingers: 2, guess: null }, 1, first);
  assert.equal(game.lastResult.guess, 4);
  assert.equal(game.lastResult.hit, true);
  assert.deepEqual(game.hands, [2, 1]);
});
test('rejects outsiders, invalid input, duplicate and stale submissions', () => {
  const room = emptyRoom();
  const game = createGame(room, A, B, 0, first);
  assert.throws(() => participantGame(room, game.id, C), /参加者/);
  assert.throws(() => submitMove(room, game.id, A, 1, { fingers: 3, guess: 1 }, 1));
  assert.throws(() => submitMove(room, game.id, A, 1, { fingers: 1, guess: 5 }, 1));
  assert.throws(() => submitMove(room, game.id, B, 1, { fingers: 1, guess: 2 }, 1));
  assert.throws(() => submitMove(room, game.id, A, 1, { fingers: NaN, guess: 1 }, 1));
  submitMove(room, game.id, A, 1, { fingers: 1, guess: 1 }, 1);
  assert.throws(() => submitMove(room, game.id, A, 1, { fingers: 0, guess: 0 }, 2), /すでに確定/);
  submitMove(room, game.id, B, 1, { fingers: 0, guess: null }, 3);
  assert.throws(() => submitMove(room, game.id, A, 1, { fingers: 0, guess: null }, 4), /前のラウンド/);
});
test('timeout clears private inputs, forfeit is participant-bound, finished games reject inputs', () => {
  const room = emptyRoom();
  const game = createGame(room, A, B, 0, first);
  submitMove(room, game.id, A, 1, { fingers: 1, guess: 2 }, 1);
  assert.throws(() => submitMove(room, game.id, B, 1, { fingers: 0, guess: null }, TURN_TIMEOUT_MS));
  expireRoom(room, TURN_TIMEOUT_MS);
  assert.equal(game.status, 'expired');
  assert.deepEqual(game.moves, [null, null]);
  assert.equal(game.winner, null);
  const next = createGame(room, A, B, TURN_TIMEOUT_MS + 1, first);
  assert.throws(() => forfeit(room, next.id, C, TURN_TIMEOUT_MS + 2), /参加者/);
  forfeit(room, next.id, A, TURN_TIMEOUT_MS + 2);
  assert.equal(next.winner, 1);
  assert.equal(next.status, 'forfeited');
  assert.throws(() => submitMove(room, next.id, B, 1, { fingers: 0, guess: null }, TURN_TIMEOUT_MS + 3));
});
test('opponent view and public board do not expose committed current-round choices', () => {
  const room = emptyRoom();
  const game = createGame(room, A, B, 0, first);
  const before = JSON.stringify(privateGamePanel(game, 1));
  const publicBefore = JSON.stringify(gameBoard(game));
  submitMove(room, game.id, A, 1, { fingers: 2, guess: 4 }, 1);
  assert.equal(JSON.stringify(privateGamePanel(game, 1)), before);
  assert.equal(JSON.stringify(gameBoard(game)), publicBefore);
  assert.match(JSON.stringify(privateGamePanel(game, 0)), /入力確定/);
});
test('input options fit Discord limit and respect remaining hands', () => {
  const room = emptyRoom();
  const game = createGame(room, A, B, 0, first);
  assert.equal(privateGamePanel(game, 0).components[0].toJSON().components[0].options.length, 15);
  game.hands = [1, 1];
  assert.equal(privateGamePanel(game, 0).components[0].toJSON().components[0].options.length, 6);
});
test('Railway split MySQL variables preserve special characters and require GUILD_ID', () => {
  const env = { DISCORD_TOKEN: 'test', GUILD_ID: A, MYSQLHOST: 'localhost', MYSQLPORT: '3306', MYSQLUSER: 'a@b', MYSQLPASSWORD: 'x:/?#', MYSQL_DATABASE: 'game' };
  const config = loadConfig(env);
  const url = new URL(config.mysqlUrl);
  assert.equal(decodeURIComponent(url.username), env.MYSQLUSER);
  assert.equal(decodeURIComponent(url.password), env.MYSQLPASSWORD);
  assert.equal(config.guildId, A);
  assert.equal(config.balanceMode, 'unavailable');
  assert.throws(() => loadConfig({ ...env, GUILD_ID: '' }), /GUILD_ID/);
  assert.throws(() => loadConfig({ ...env, MYSQLPORT: 'NaN' }), /MYSQLPORT/);
});
