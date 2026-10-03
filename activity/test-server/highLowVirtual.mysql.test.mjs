import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { migrateHighLow } from '../server/highLowMigrations.mjs';
import { initializeVirtualWallets } from '../server/highLowVirtual.mjs';
import { createHighLowStore } from '../server/highLowStore.mjs';

const mysqlUrl = process.env.TEST_VIRTUAL_MYSQL_URL;
const userId = '123456789012345678';
const otherId = '223456789012345678';

test('virtual play persists separately through retry, loss, cashout, expiry and restart; real money never changes', {
  skip: !mysqlUrl,
}, async () => {
  // Dedicated disposable database only, separate from the real-mode integration suite.
  const c = await createConnection({ uri: mysqlUrl, multipleStatements: true, supportBigNumbers: true, bigNumberStrings: true });
  let store;
  try {
    const [[db]] = await c.query('SELECT DATABASE() AS name');
    assert.match(db.name, /^levelia_.*test$/);
    assert.notEqual(mysqlUrl, process.env.TEST_MYSQL_URL, 'Virtual suite requires its own disposable database');
    const [tables] = await c.query('SHOW TABLES');
    await c.query('SET FOREIGN_KEY_CHECKS=0');
    for (const row of tables) await c.query(`DROP TABLE \`${Object.values(row)[0]}\``);
    await c.query('SET FOREIGN_KEY_CHECKS=1');
    await c.query(`CREATE TABLE accounts (user_id BIGINT PRIMARY KEY, user_name VARCHAR(64), wallet INT NOT NULL, is_frozen BOOLEAN DEFAULT FALSE);
      CREATE TABLE sub_accounts (sub_user_id BIGINT);
      CREATE TABLE actions (id INT PRIMARY KEY, comment VARCHAR(64));
      INSERT INTO accounts VALUES (${userId}, 'player', 20000, 0), (${otherId}, 'other', 12000, 0);
      INSERT INTO actions VALUES (1, 'pre-existing real history');`);
    await migrateHighLow(c);
    await initializeVirtualWallets(c, [userId, otherId]);
    const before = JSON.stringify((await c.query('SELECT * FROM accounts ORDER BY user_id'))[0]);
    const beforeActions = JSON.stringify((await c.query('SELECT * FROM actions'))[0]);
    // Deny real wallet/history writes at the database level for the game connection.
    // Any accidental UPDATE accounts or INSERT actions will make the test fail.
    await c.query("CREATE USER IF NOT EXISTS 'virtual_player'@'127.0.0.1' IDENTIFIED BY 'local-test-only'");
    await c.query(`GRANT SELECT ON \`${db.name}\`.* TO 'virtual_player'@'127.0.0.1'`);
    for (const suffix of ['wallets','hands','commands','ledger','settings','setting_changes']) {
      await c.query(`GRANT INSERT, UPDATE, DELETE ON \`${db.name}\`.levelia_game_high_low_virtual_${suffix} TO 'virtual_player'@'127.0.0.1'`);
    }
    const playerUrl = new URL(mysqlUrl);
    playerUrl.username = 'virtual_player'; playerUrl.password = 'local-test-only';
    store = createHighLowStore(playerUrl.toString(), { walletMode: 'virtual', randomIndex: () => 7, workerIntervalMs: 600000 });
    assert.equal(await store.readWallet(userId), '20000');
    assert.equal(await store.readWallet('999999999999999999'), null);
    const start = { userId, wager: 100, requestId: randomUUID() };
    const started = await store.start(start);
    assert.equal(started.wallet, '19900');
    assert.deepEqual(await store.start(start), started);
    await assert.rejects(store.start({ ...start, requestId: randomUUID() }), { code: 'active_hand_exists' });
    await assert.rejects(store.heartbeat({ userId: otherId, handId: started.hand.id }), { code: 'hand_not_active' });
    await store.heartbeat({ userId, handId: started.hand.id });
    // Obtain a real new-multiplier win using deterministic draws.
    await c.execute("UPDATE levelia_game_high_low_virtual_hands SET current_card='spades-5' WHERE id=?", [started.hand.id]);
    const guess = await store.guess({ userId, handId: started.hand.id, guess: 'higher', expectedVersion: 1, requestId: randomUUID() });
    assert.equal(guess.event.result, 'win');
    const cashout = { userId, handId: started.hand.id, expectedVersion: guess.hand.version, requestId: randomUUID() };
    // Force a ledger failure after the wallet update: the whole payout must roll back.
    await c.query("CREATE TRIGGER reject_virtual_payout BEFORE INSERT ON levelia_game_high_low_virtual_ledger FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test rollback'");
    await assert.rejects(store.cashout(cashout));
    assert.equal(await store.readWallet(userId), '19900');
    await c.query('DROP TRIGGER reject_virtual_payout');
    const paid = await store.cashout(cashout);
    assert.deepEqual(await store.cashout(cashout), paid);
    assert.equal(Number(paid.settlement.wallet), 19900 + paid.settlement.payout);
    // Expiry must use the same isolated payout transaction.
    const expired = await store.start({ ...start, requestId: randomUUID() });
    await c.execute("UPDATE levelia_game_high_low_virtual_hands SET streak=1,potential_payout=150,last_heartbeat_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 6 MINUTE) WHERE id=?", [expired.hand.id]);
    await store.expireInactiveHands();
    await store.expireInactiveHands();
    const losing = await store.start({ ...start, requestId: randomUUID() });
    await c.execute("UPDATE levelia_game_high_low_virtual_hands SET current_card='spades-5' WHERE id=?", [losing.hand.id]);
    const lost = await store.guess({ userId, handId: losing.hand.id, guess: 'lower', expectedVersion: 1, requestId: randomUUID() });
    assert.equal(lost.event.result, 'loss');
    // Five wins also auto-settle in the virtual ledger.
    const auto = await store.start({ ...start, requestId: randomUUID() });
    await c.execute("UPDATE levelia_game_high_low_virtual_hands SET streak=4,current_card='spades-5' WHERE id=?", [auto.hand.id]);
    const won = await store.guess({ userId, handId: auto.hand.id, guess: 'higher', expectedVersion: 1, requestId: randomUUID() });
    assert.equal(won.settlement.reason, 'max_streak');
    const wallet = await store.readWallet(userId);
    await store.close();
    await initializeVirtualWallets(c, [userId, otherId]); // Never resets an existing test balance.
    await migrateHighLow(c); // Restart migration preserves balances and history.
    store = createHighLowStore(playerUrl.toString(), { walletMode: 'virtual', workerIntervalMs: 600000 });
    assert.equal((await store.readSession(userId)).wallet, wallet);
    const [[ledger]] = await c.query('SELECT SUM(supply_delta) AS net, SUM(wallet_after-wallet_before <> supply_delta) AS bad FROM levelia_game_high_low_virtual_ledger');
    assert.equal(Number(wallet) - 20000, Number(ledger.net));
    assert.equal(Number(ledger.bad), 0);
    assert.equal(JSON.stringify((await c.query('SELECT * FROM accounts ORDER BY user_id'))[0]), before);
    assert.equal(JSON.stringify((await c.query('SELECT * FROM actions'))[0]), beforeActions);
    for (const suffix of ['hands','commands','ledger']) {
      const [[row]] = await c.query(`SELECT COUNT(*) AS count FROM levelia_game_high_low_${suffix}`);
      assert.equal(Number(row.count), 0);
    }
  } finally { await store?.close(); await c.end(); }
});
