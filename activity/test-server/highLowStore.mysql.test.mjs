import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { createHighLowStore, LEVELIA_GAME_USER_ID } from '../server/highLowStore.mjs';

const mysqlUrl = process.env.TEST_MYSQL_URL;
const userId = '123456789012345678';

test('wager and payout are atomic, idempotent, and never move the LEVELIA Game wallet', {
  skip: !mysqlUrl,
}, async () => {
  const connection = await createConnection({ uri: mysqlUrl, multipleStatements: true });
  const migrationPath = fileURLToPath(new URL('../sql/20261002_create_high_low.sql', import.meta.url));
  const migration = await readFile(migrationPath, 'utf8');
  try {
    await connection.query(`
      SET FOREIGN_KEY_CHECKS = 0;
      DROP TABLE IF EXISTS levelia_game_high_low_ledger;
      DROP TABLE IF EXISTS levelia_game_high_low_commands;
      DROP TABLE IF EXISTS levelia_game_high_low_hands;
      DROP TABLE IF EXISTS sub_accounts;
      DROP TABLE IF EXISTS actions;
      DROP TABLE IF EXISTS accounts;
      SET FOREIGN_KEY_CHECKS = 1;
      CREATE TABLE accounts (
        user_id BIGINT NOT NULL PRIMARY KEY,
        user_name VARCHAR(64) NOT NULL,
        wallet INTEGER NOT NULL DEFAULT 0,
        is_frozen BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE sub_accounts (
        id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
        main_user_id BIGINT NOT NULL,
        sub_user_id BIGINT NOT NULL,
        UNIQUE KEY uq_main_sub (main_user_id, sub_user_id),
        FOREIGN KEY (main_user_id) REFERENCES accounts(user_id),
        FOREIGN KEY (sub_user_id) REFERENCES accounts(user_id)
      );
      CREATE TABLE actions (
        id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
        command_name VARCHAR(32) NOT NULL,
        amount INTEGER NOT NULL,
        from_user_id BIGINT NOT NULL,
        to_user_id BIGINT NOT NULL,
        from_after_wallet INTEGER NOT NULL,
        to_after_wallet INTEGER NOT NULL,
        comment VARCHAR(256) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        FOREIGN KEY (from_user_id) REFERENCES accounts(user_id),
        FOREIGN KEY (to_user_id) REFERENCES accounts(user_id)
      );
    `);
    await connection.execute(
      'INSERT INTO accounts (user_id, user_name, wallet) VALUES (?, ?, ?), (?, ?, ?)',
      [userId, 'player', 20_000, LEVELIA_GAME_USER_ID, 'old name', 777_777],
    );
    await connection.query(migration);

    const [seededAccounts] = await connection.execute(
      'SELECT user_name, wallet FROM accounts WHERE user_id = ?',
      [LEVELIA_GAME_USER_ID],
    );
    assert.equal(seededAccounts[0].user_name, 'LEVELIA Game');
    assert.equal(seededAccounts[0].wallet, 777_777);

    const store = createHighLowStore(mysqlUrl, { randomIndex: () => 0, workerIntervalMs: 60_000 });
    try {
      assert.equal(await store.readBestStreak(userId), 0);
      const startRequestId = '123e4567-e89b-42d3-a456-426614174001';
      const started = await store.start({ userId, wager: 100, requestId: startRequestId });
      assert.equal(started.wallet, '19900');
      assert.equal(started.hand.wager, 100);
      assert.deepEqual(await store.start({ userId, wager: 100, requestId: startRequestId }), started);

      let [[player], [game], [betActions], [betLedger]] = await Promise.all([
        connection.execute('SELECT wallet FROM accounts WHERE user_id = ?', [userId]).then(([rows]) => rows),
        connection.execute('SELECT wallet FROM accounts WHERE user_id = ?', [LEVELIA_GAME_USER_ID]).then(([rows]) => rows),
        connection.execute("SELECT COUNT(*) AS count FROM actions WHERE command_name = 'high_low_bet'").then(([rows]) => rows),
        connection.execute("SELECT SUM(supply_delta) AS total FROM levelia_game_high_low_ledger").then(([rows]) => rows),
      ]);
      assert.equal(player.wallet, 19_900);
      assert.equal(game.wallet, 777_777);
      assert.equal(Number(betActions.count), 1);
      assert.equal(Number(betLedger.total), -100);

      await connection.execute(
        'UPDATE levelia_game_high_low_hands SET streak = 1, potential_payout = 150 WHERE id = ?',
        [started.hand.id],
      );
      const cashoutRequestId = '123e4567-e89b-42d3-a456-426614174002';
      const settled = await store.cashout({
        userId,
        handId: started.hand.id,
        requestId: cashoutRequestId,
        expectedVersion: started.hand.version,
      });
      assert.equal(settled.settlement.payout, 150);
      assert.equal(settled.settlement.wallet, '20050');
      assert.equal(await store.readBestStreak(userId), 1);
      assert.deepEqual(await store.cashout({
        userId,
        handId: started.hand.id,
        requestId: cashoutRequestId,
        expectedVersion: started.hand.version,
      }), settled);

      [[player], [game], [betActions], [betLedger]] = await Promise.all([
        connection.execute('SELECT wallet FROM accounts WHERE user_id = ?', [userId]).then(([rows]) => rows),
        connection.execute('SELECT wallet FROM accounts WHERE user_id = ?', [LEVELIA_GAME_USER_ID]).then(([rows]) => rows),
        connection.execute("SELECT COUNT(*) AS count FROM actions WHERE command_name = 'high_low_payout'").then(([rows]) => rows),
        connection.execute("SELECT SUM(supply_delta) AS total FROM levelia_game_high_low_ledger").then(([rows]) => rows),
      ]);
      assert.equal(player.wallet, 20_050);
      assert.equal(game.wallet, 777_777);
      assert.equal(Number(betActions.count), 1);
      assert.equal(Number(betLedger.total), 50);

      const concurrent = await Promise.allSettled([
        store.start({ userId, wager: 100, requestId: '123e4567-e89b-42d3-a456-426614174003' }),
        store.start({ userId, wager: 1_000, requestId: '123e4567-e89b-42d3-a456-426614174004' }),
      ]);
      assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
      const successful = concurrent.find(result => result.status === 'fulfilled').value;
      const [walletRows] = await connection.execute('SELECT wallet FROM accounts WHERE user_id = ?', [userId]);
      assert.equal(walletRows[0].wallet, 20_050 - successful.hand.wager);
      const [gameRows] = await connection.execute('SELECT wallet FROM accounts WHERE user_id = ?', [LEVELIA_GAME_USER_ID]);
      assert.equal(gameRows[0].wallet, 777_777);

      // Existing DB history and active hands count, without any browser score import.
      await connection.execute(
        `UPDATE levelia_game_high_low_hands
         SET streak = 4, current_card = 'spades-5', remaining_deck = ? WHERE id = ?`,
        [JSON.stringify(['hearts-9']), successful.hand.id],
      );
      assert.equal(await store.readBestStreak(userId), 5);
      const finalGuess = {
        userId, handId: successful.hand.id, guess: 'higher',
        requestId: '123e4567-e89b-42d3-a456-426614174005', expectedVersion: successful.hand.version,
      };
      const won = await store.guess(finalGuess);
      assert.equal(won.hand, null);
      assert.equal(won.settlement.reason, 'max_streak');
      assert.equal(won.bestStreak, 6);
      assert.deepEqual(await store.guess(finalGuess), won);
      // Responses persisted by an older release also receive the DB score on replay.
      await connection.execute(
        "UPDATE levelia_game_high_low_commands SET response_json = JSON_REMOVE(response_json, '$.bestStreak') WHERE request_id = ?",
        [finalGuess.requestId],
      );
      assert.deepEqual(await store.guess(finalGuess), won);

      const freshStore = createHighLowStore(mysqlUrl, { workerIntervalMs: 60_000 });
      try {
        assert.equal(await freshStore.readBestStreak(userId), 6);
        assert.equal((await freshStore.readSession(userId)).bestStreak, 6);
        assert.equal(await freshStore.readBestStreak(LEVELIA_GAME_USER_ID), 0);
        assert.equal((await freshStore.readSession('999999999999999999')).bestStreak, 0);
      } finally {
        await freshStore.close();
      }

      const next = await store.start({ userId, wager: 100, requestId: '123e4567-e89b-42d3-a456-426614174006' });
      await connection.execute(
        `UPDATE levelia_game_high_low_hands
         SET streak = 2, current_card = 'spades-5', remaining_deck = ? WHERE id = ?`,
        [JSON.stringify(['hearts-3']), next.hand.id],
      );
      const lost = await store.guess({
        userId, handId: next.hand.id, guess: 'higher',
        requestId: '123e4567-e89b-42d3-a456-426614174007', expectedVersion: next.hand.version,
      });
      assert.equal(lost.event.result, 'loss');
      assert.equal(lost.bestStreak, 8);
      assert.equal(await store.readBestStreak(userId), 8);
      // A player's completed loss still contains the streak reached before losing.
      await connection.execute('UPDATE levelia_game_high_low_hands SET streak = 0 WHERE id <> ?', [next.hand.id]);
      assert.equal(await store.readBestStreak(userId), 2);

      // An expired hand cannot be revived before the cleanup worker runs.
      for (const expiry of ['disconnect', 'maximum_duration']) {
        const expiring = await store.start({ userId, wager: 100, requestId: randomUUID() });
        await store.heartbeat({ userId, handId: expiring.hand.id });
        const timestampUpdate = expiry === 'disconnect'
          ? 'last_heartbeat_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 6 MINUTE)'
          : 'expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)';
        await connection.execute(
          `UPDATE levelia_game_high_low_hands SET streak = 1, potential_payout = 150, ${timestampUpdate} WHERE id = ?`,
          [expiring.hand.id],
        );
        const request = { userId, handId: expiring.hand.id, expectedVersion: expiring.hand.version };
        await assert.rejects(store.guess({ ...request, guess: 'higher', requestId: randomUUID() }), { code: 'hand_expired' });
        await assert.rejects(store.cashout({ ...request, requestId: randomUUID() }), { code: 'hand_expired' });
        await assert.rejects(store.heartbeat(request), { code: 'hand_not_active' });
        const settledSession = await store.readSession(userId);
        assert.equal(settledSession.hand, null);
        assert.equal(Number(settledSession.wallet), Number(expiring.wallet) + 150);
        await store.expireInactiveHands();
        assert.equal((await store.readSession(userId)).wallet, settledSession.wallet);
      }

      await verifyCrossGameStreaks(connection, store);
    } finally {
      await store.close();
    }
  } finally {
    await connection.end();
  }
});

async function verifyCrossGameStreaks(connection, store) {
  const player = '222222222222222222';
  await connection.execute('INSERT INTO accounts (user_id, user_name, wallet) VALUES (?, ?, ?)',
    [player, 'cross-game-player', 20_000]);
  let hand;
  async function start() {
    const result = await store.start({ userId: player, wager: 100, requestId: randomUUID() });
    hand = result.hand;
    assert.equal(hand.streak, 0);
    assert.equal(hand.nextWinPayout, 150);
  }
  async function guess(result) {
    // Fix only the draw, allowing production code to update wins and payouts.
    const card = { win: 'hearts-9', tie: 'hearts-5', loss: 'hearts-3' }[result];
    await connection.execute(
      "UPDATE levelia_game_high_low_hands SET current_card = 'spades-5', remaining_deck = ? WHERE id = ?",
      [JSON.stringify([card]), hand.id],
    );
    const input = { userId: player, handId: hand.id, guess: 'higher', expectedVersion: hand.version, requestId: randomUUID() };
    const response = await store.guess(input);
    assert.equal(response.event.result, result);
    assert.deepEqual(await store.guess(input), response); // Replay never adds wins.
    hand = response.hand;
    return response;
  }

  await start();
  for (let win = 1; win <= 5; win++) {
    const result = await guess('win');
    assert.equal(result.bestStreak, win);
    if (win === 5) {
      assert.equal(hand, null);
      assert.equal(result.settlement.reason, 'max_streak');
      assert.equal(result.settlement.payout, 600);
    }
  }
  await start();
  assert.equal(await store.readBestStreak(player), 5);
  assert.equal((await guess('win')).bestStreak, 6);
  assert.equal((await guess('tie')).bestStreak, 6);
  assert.equal(hand.streak, 1);
  assert.equal((await guess('win')).bestStreak, 7);
  const cashout = await store.cashout({ userId: player, handId: hand.id, expectedVersion: hand.version, requestId: randomUUID() });
  assert.equal(cashout.settlement.payout, 200); // Uses 2 wins in this game, not 7.
  await start();
  assert.equal((await guess('win')).bestStreak, 8);
  await connection.execute('UPDATE levelia_game_high_low_hands SET last_heartbeat_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 6 MINUTE) WHERE id = ?', [hand.id]);
  assert.equal((await store.readSession(player)).hand, null);
  await start();
  // Even expiry with no wins must not break the ongoing record.
  await connection.execute('UPDATE levelia_game_high_low_hands SET last_heartbeat_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 6 MINUTE) WHERE id = ?', [hand.id]);
  await store.readSession(player);
  await start();
  assert.equal((await guess('win')).bestStreak, 9);
  assert.equal((await guess('loss')).bestStreak, 9);
  await start();
  for (let win = 0; win < 5; win++) assert.equal((await guess('win')).bestStreak, 9);
  await start();
  for (let win = 6; win <= 10; win++) assert.equal((await guess('win')).bestStreak, Math.max(9, win));
  const restarted = createHighLowStore(mysqlUrl, { workerIntervalMs: 60_000 });
  try {
    assert.equal((await restarted.readSession(player)).bestStreak, 10);
    assert.equal(await restarted.readBestStreak(userId), 2); // Other player's records are isolated.
  } finally {
    await restarted.close();
  }
}
