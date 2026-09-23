import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { YubisumaStore } from '../dist/service/yubisuma/yubisumaStore.js';
import { activeGame, chooseOpponent, createGame, submitMove } from '../dist/service/yubisuma/yubisumaRules.js';
import { CPU_ID } from '../dist/constant/yubisuma/yubisuma.js';

test('real MySQL: concurrent matching/input, rollback, persistence, room isolation and expiry', {
  skip: !process.env.TEST_MYSQL_SOCKET && !process.env.TEST_MYSQL_PORT,
}, async () => {
  const options = process.env.TEST_MYSQL_SOCKET
    ? { socketPath: process.env.TEST_MYSQL_SOCKET, user: 'root' }
    : { host: '127.0.0.1', port: Number(process.env.TEST_MYSQL_PORT), user: 'root', password: process.env.TEST_MYSQL_PASSWORD };
  const dbName = `levelia_game_test_${process.pid}`;
  const admin = await mysql.createConnection(options);
  let database;
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
    database = mysql.createPool({ ...options, database: dbName, connectionLimit: 10 });
    const sql = await readFile(new URL('../src/sql/createTable.sql', import.meta.url), 'utf8');
    await database.query(sql);
    await database.query(sql); // rerunnable migration
    const store = new YubisumaStore(database);
    const scope = { guildId: '111111111111111111', channelId: '222222222222222222' };
    const A = '333333333333333333', B = '444444444444444444';
    const results = await Promise.all([
      store.transact(scope, (room, now) => chooseOpponent(room, A, B, now, () => 0)),
      store.transact(scope, (room, now) => chooseOpponent(room, B, A, now, () => 0)),
    ]);
    const game = results.find(Boolean);
    assert.ok(game);
    assert.equal((await store.transact(scope, room => room.games)).length, 1);
    const player0 = game.players[0], player1 = game.players[1];
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => store.transact(scope, (room, now) => submitMove(room, game.id, player0, 1, { fingers: 1, guess: 2 }, now))));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    await store.transact(scope, (room, now) => submitMove(room, game.id, player1, 1, { fingers: 1, guess: null }, now));
    const restarted = new YubisumaStore(database);
    const persisted = await restarted.transact(scope, room => room.games[0]);
    assert.equal(persisted.round, 2);
    assert.deepEqual(persisted.hands, [1, 2]);
    await assert.rejects(store.transact(scope, room => { room.games[0].hands = [0, 0]; throw new Error('rollback'); }));
    assert.deepEqual((await store.transact(scope, room => room.games[0])).hands, [1, 2]);
    const other = { ...scope, channelId: '555555555555555555' };
    assert.equal((await store.transact(other, room => room.games)).length, 0);
    const cpuStarts = await Promise.all(Array.from({ length: 8 }, () => store.transact(other, (room, now) => activeGame(room, A) ?? createGame(room, A, CPU_ID, now))));
    assert.equal(new Set(cpuStarts.map(item => item.id)).size, 1);
    await store.transact(scope, room => { room.games[0].expiresAt = Date.now() - 1; });
    const expired = await store.transact(scope, room => room.games[0]);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.winner, null);
    assert.deepEqual(expired.moves, [null, null]);
  } finally {
    await database?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
});
