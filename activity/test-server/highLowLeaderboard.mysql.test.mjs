import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { migrateHighLow } from '../server/highLowMigrations.mjs';
import { createHighLowLeaderboard } from '../server/highLowLeaderboard.mjs';

const mysqlUrl = process.env.TEST_LEADERBOARD_MYSQL_URL;
test('weekly SQL counts ordered guesses across hands, isolates modes, and ranks only settled payouts', { skip: !mysqlUrl }, async () => {
  assert.match(new URL(mysqlUrl).pathname, /^\/levelia_leaderboard_test$/);
  const db = await createConnection({ uri: mysqlUrl, multipleStatements: true, timezone: 'Z' });
  const tables = { hands: 'levelia_game_high_low_hands', commands: 'levelia_game_high_low_commands' };
  const playerA = '111111111111111111';
  const playerB = '222222222222222222';
  let now = Date.parse('2026-10-04T14:59:00Z');
  const start = '2026-09-27 15:00:00.000';
  try {
    const [existing] = await db.query('SHOW TABLES');
    await db.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const row of existing) await db.query(`DROP TABLE \`${Object.values(row)[0]}\``);
    await db.query('SET FOREIGN_KEY_CHECKS = 1');
    await db.query('CREATE TABLE accounts (user_id BIGINT PRIMARY KEY, user_name VARCHAR(64), wallet INT DEFAULT 0)');
    await db.execute('INSERT INTO accounts (user_id, user_name) VALUES (?, ?), (?, ?)', [playerA, 'A', playerB, 'B']);
    await migrateHighLow(db);
    await migrateHighLow(db); // Existing installations and repeated deploys must be safe.

    async function hand(user, status, amount, settledAt, wager = 100, createdAt = start) {
      const [result] = await db.execute(`INSERT INTO ${tables.hands}
        (user_id, status, wager, streak, potential_payout, current_card, rules_version, last_heartbeat_at, expires_at,
         settlement_amount, settled_at, created_at, updated_at)
        VALUES (?, ?, ?, 0, 999999, 'clubs-5', 3, ?, ?, ?, ?, ?, ?)`,
      [user, status, wager, start, '2026-10-05 00:00:00', amount, settledAt, createdAt, start]);
      return result.insertId;
    }
    async function event(user, id, result, timestamp, version = 2) {
      await db.execute(`INSERT INTO ${tables.commands} (request_id, user_id, hand_id, action, response_json, created_at)
        VALUES (?, ?, ?, 'guess', ?, ?)`, [randomUUID(), user, id, JSON.stringify({ event: { result }, hand: version ? { version } : null }), timestamp]);
    }
    const first = await hand(playerA, 'cashed_out', 1234, '2026-10-01 00:00:00');
    const lost = await hand(playerA, 'lost', 0, '2026-10-01 00:00:02');
    const final = await hand(playerA, 'auto_cashed_out', 20000, '2026-10-02 00:00:00', 1000);
    const active = await hand(playerA, 'active', 0, null);
    await event(playerA, first, 'win', '2026-09-27 14:59:59.999'); // Previous week's win is excluded.
    await event(playerA, first, 'win', start);
    await event(playerA, first, 'tie', '2026-09-27 15:00:01');
    await event(playerA, lost, 'win', '2026-10-01 00:00:01', 2);
    await event(playerA, lost, 'win', '2026-10-01 00:00:01', 3);
    await event(playerA, lost, 'loss', '2026-10-01 00:00:01', null); // Same ms: versions put loss last.
    await event(playerA, final, 'win', '2026-10-02 00:00:00', null);
    await event(playerA, active, 'win', '2026-10-03 00:00:00');
    const second = await hand(playerB, 'cashed_out', 200000, '2026-10-02 00:00:00', 10000);
    for (let i = 0; i < 3; i++) await event(playerB, second, 'win', `2026-10-01 00:00:0${i}`);
    await hand(playerB, 'cashed_out', 999999, '2026-09-27 14:59:59.999'); // Old and future payouts excluded.
    await hand(playerB, 'cashed_out', 999999, '2026-10-04 15:00:00');
    await hand(playerB, 'expired', 999999, '2026-10-03 00:00:00');

    const read = createHighLowLeaderboard({ getPool: () => db, tables, now: () => now });
    const board = await read(playerA);
    assert.deepEqual(board.streak.entries.map(e => [e.rank, e.value]), [[1, 3], [1, 3]]);
    assert.deepEqual(board.multiplier.entries.map(e => [e.rank, e.value]), [[1, 20], [1, 20]]);
    assert.equal(board.streak.me.displayName, 'A');
    const virtualRead = createHighLowLeaderboard({ getPool: () => db, now: () => now,
      tables: { hands: 'levelia_game_high_low_virtual_hands', commands: 'levelia_game_high_low_virtual_commands' } });
    assert.equal((await virtualRead(playerA)).streak.participants, 0);
    assert.equal((await virtualRead(playerA)).multiplier.participants, 0);

    now = Date.parse('2026-10-04T15:00:01Z');
    assert.equal((await read(playerA)).streak.entries.length, 0);
    assert.equal((await read(playerA)).multiplier.entries[0].userId, playerB);
    await event(playerA, active, 'win', '2026-10-04 15:00:00.001', 3);
    now += 300000;
    assert.equal((await read(playerA)).streak.me.value, 1, 'ongoing hand carries no previous-week wins');

    const resetAt = '2026-10-04T00:00:00+09:00';
    const resetSql = '2026-10-03 15:00:00.000';
    const fresh = await hand(playerA, 'cashed_out', 250, '2026-10-03 15:00:01', 100, resetSql);
    await hand(playerB, 'cashed_out', 9000, '2026-10-03 15:00:01'); // Started before reset: excluded.
    await event(playerA, active, 'win', '2026-10-03 14:59:59.999', 4); // Excluded from the new streak.
    await event(playerA, fresh, 'win', resetSql, 2); // Boundary is inclusive.
    await event(playerA, fresh, 'win', '2026-10-03 15:00:01', 3);
    const [[countsBefore]] = await db.query(`SELECT (SELECT COUNT(*) FROM ${tables.hands}) AS hands, (SELECT COUNT(*) FROM ${tables.commands}) AS commands`);
    now = Date.parse(resetAt) - 1;
    const resetRead = createHighLowLeaderboard({ getPool: () => db, tables, resetAt, now: () => now });
    assert.equal((await resetRead(playerA)).multiplier.me.value, 20, 'old ranking remains until cutover');
    now += 2001;
    const freshBoard = await resetRead(playerA);
    assert.equal(freshBoard.streak.me.value, 2);
    assert.deepEqual(freshBoard.multiplier.entries.map(e => [e.userId, e.value]), [[playerA, 2.5]]);
    const [[countsAfter]] = await db.query(`SELECT (SELECT COUNT(*) FROM ${tables.hands}) AS hands, (SELECT COUNT(*) FROM ${tables.commands}) AS commands`);
    assert.deepEqual(countsAfter, countsBefore, 'reset never deletes history');
    await hand(playerA, 'auto_cashed_out', 300, '2026-10-04 15:00:00', 100, resetSql);
    now = Date.parse('2026-10-04T15:00:01Z');
    const nextWeek = await resetRead(playerA);
    assert.equal(nextWeek.streak.me.value, 1);
    assert.deepEqual(nextWeek.multiplier.entries.map(e => [e.userId, e.value]), [[playerA, 3]], 'Sunday hands may settle next week, but pre-reset hands stay excluded');
  } finally {
    await db.end();
  }
});
