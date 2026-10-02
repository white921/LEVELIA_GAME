import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
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
    } finally {
      await store.close();
    }
  } finally {
    await connection.end();
  }
});
