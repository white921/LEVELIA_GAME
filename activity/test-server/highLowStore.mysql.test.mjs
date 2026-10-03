import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { correctionForTarget, RTP_CALIBRATION_ID } from '../server/highLowCalibration.mjs';
import { migrateHighLow } from '../server/highLowMigrations.mjs';
import { createConnection } from 'mysql2/promise';
import { createHighLowStore, LEVELIA_GAME_USER_ID } from '../server/highLowStore.mjs';

const mysqlUrl = process.env.TEST_MYSQL_URL;
const userId = '123456789012345678';
let nextDraw = 7;
const randomIndex = n => n === 52 ? nextDraw : n - 1;

test('wager and payout are atomic, idempotent, and never move the LEVELIA Game wallet', {
  skip: !mysqlUrl,
}, async () => {
  const connection = await createConnection({ uri: mysqlUrl, multipleStatements: true, supportBigNumbers: true, bigNumberStrings: true });
  try {
    await connection.query(`
      SET FOREIGN_KEY_CHECKS = 0;
      DROP TABLE IF EXISTS levelia_game_high_low_setting_changes;
      DROP TABLE IF EXISTS levelia_game_high_low_settings;
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
    await migrateHighLow(connection);

    const [seededAccounts] = await connection.execute(
      'SELECT user_name, wallet FROM accounts WHERE user_id = ?',
      [LEVELIA_GAME_USER_ID],
    );
    assert.equal(seededAccounts[0].user_name, 'old name'); // Migration must not edit account identity.
    assert.equal(seededAccounts[0].wallet, 777_777);

    const store = createHighLowStore(mysqlUrl, { randomIndex, workerIntervalMs: 60_000 });
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
         SET streak = 4, current_card = 'spades-5' WHERE id = ?`,
        [successful.hand.id],
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
         SET streak = 2, current_card = 'spades-5' WHERE id = ?`,
        [next.hand.id],
      );
      nextDraw = 1;
      const lost = await store.guess({
        userId, handId: next.hand.id, guess: 'higher',
        requestId: '123e4567-e89b-42d3-a456-426614174007', expectedVersion: next.hand.version,
      });
      nextDraw = 7;
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
      await verifySubAccountException(connection, store);
      await verifyExpirationIsolation(connection, store);
      await verifyProgressivePayouts(connection);
    } finally {
      await store.close();
    }
  } finally {
    await connection.end();
  }
});

async function verifyExpirationIsolation(connection, store) {
  const blocked = '444444444444444444';
  const payable = '555555555555555555';
  await connection.execute('INSERT INTO accounts (user_id, user_name, wallet) VALUES (?, ?, ?), (?, ?, ?)',
    [blocked, 'blocked-payout', 1000, payable, 'payable', 1000]);
  const blockedHand = await store.start({ userId: blocked, wager: 100, requestId: randomUUID() });
  const payableHand = await store.start({ userId: payable, wager: 100, requestId: randomUUID() });
  await connection.execute('UPDATE accounts SET wallet = 2147483647 WHERE user_id = ?', [blocked]);
  await connection.execute(
    `UPDATE levelia_game_high_low_hands SET streak = 1, potential_payout = 150,
     last_heartbeat_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 6 MINUTE) WHERE id IN (?, ?)`,
    [blockedHand.hand.id, payableHand.hand.id],
  );
  await store.expireInactiveHands();
  assert.equal(await store.readWallet(blocked), '2147483647');
  assert.equal(await store.readWallet(payable), '1050');
  const [hands] = await connection.execute(
    'SELECT status FROM levelia_game_high_low_hands WHERE id IN (?, ?) ORDER BY id',
    [blockedHand.hand.id, payableHand.hand.id],
  );
  assert.deepEqual(hands.map(hand => hand.status), ['active', 'auto_cashed_out']);
  const [credits] = await connection.execute(
    "SELECT user_id, COUNT(*) AS count FROM levelia_game_high_low_ledger WHERE user_id IN (?, ?) AND kind = 'auto_payout_credit' GROUP BY user_id",
    [blocked, payable],
  );
  assert.equal(credits.length, 1);
  assert.equal(String(credits[0].user_id), payable);
  assert.equal(Number(credits[0].count), 1);
  // Once the cause is resolved, the failed hand is settled exactly once.
  await connection.execute('UPDATE accounts SET wallet = 900 WHERE user_id = ?', [blocked]);
  await store.expireInactiveHands();
  await store.expireInactiveHands();
  assert.equal(await store.readWallet(blocked), '1050');
  assert.equal(await store.readWallet(payable), '1050');
  assert.equal(await store.readWallet(LEVELIA_GAME_USER_ID), '777777');
  const [actions] = await connection.execute(
    "SELECT COUNT(*) AS count FROM actions WHERE command_name = 'high_low_payout' AND to_user_id IN (?, ?)",
    [blocked, payable],
  );
  assert.equal(Number(actions[0].count), 2);
}

async function verifySubAccountException(connection, store) {
  const allowedSub = '1551725849009586270';
  const otherSub = '333333333333333333';
  await connection.execute(
    'INSERT INTO accounts (user_id, user_name, wallet) VALUES (?, ?, ?), (?, ?, ?)',
    [allowedSub, 'allowed-sub', 1000, otherSub, 'blocked-sub', 1000],
  );
  await connection.execute('INSERT INTO sub_accounts (main_user_id, sub_user_id) VALUES (?, ?), (?, ?)',
    [userId, allowedSub, userId, otherSub]);
  const mainWalletBefore = await store.readWallet(userId);

  await assert.rejects(store.start({ userId: otherSub, wager: 100, requestId: randomUUID() }), { code: 'sub_account_not_allowed' });
  assert.equal(await store.readWallet(otherSub), '1000');
  const [rejectedHands] = await connection.execute('SELECT id FROM levelia_game_high_low_hands WHERE user_id = ?', [otherSub]);
  assert.equal(rejectedHands.length, 0);

  await connection.execute('UPDATE accounts SET is_frozen = TRUE WHERE user_id = ?', [allowedSub]);
  await assert.rejects(store.start({ userId: allowedSub, wager: 100, requestId: randomUUID() }), { code: 'account_frozen' });
  await connection.execute('UPDATE accounts SET is_frozen = FALSE, wallet = 99 WHERE user_id = ?', [allowedSub]);
  await assert.rejects(store.start({ userId: allowedSub, wager: 100, requestId: randomUUID() }), { code: 'insufficient_balance' });
  await connection.execute('UPDATE accounts SET wallet = 1000 WHERE user_id = ?', [allowedSub]);

  const input = { userId: allowedSub, wager: 100, requestId: randomUUID() };
  const started = await store.start(input);
  assert.equal(started.wallet, '900');
  assert.deepEqual(await store.start(input), started);
  assert.equal(await store.readWallet(allowedSub), '900');
  assert.equal(await store.readWallet(userId), mainWalletBefore);
  await assert.rejects(store.start({ ...input, requestId: randomUUID() }), { code: 'active_hand_exists' });
  await connection.execute(
    "UPDATE levelia_game_high_low_hands SET current_card = 'spades-5' WHERE id = ?",
    [started.hand.id],
  );
  const won = await store.guess({
    userId: allowedSub, handId: started.hand.id, expectedVersion: started.hand.version,
    guess: 'higher', requestId: randomUUID(),
  });
  assert.equal(won.event.result, 'win');
  const settled = await store.cashout({
    userId: allowedSub, handId: won.hand.id, expectedVersion: won.hand.version, requestId: randomUUID(),
  });
  assert.equal(settled.settlement.wallet, String(900 + Math.floor(100 * .995 * 12000 / 9003)));
  assert.equal(await store.readWallet(userId), mainWalletBefore);
  assert.equal(await store.readWallet(LEVELIA_GAME_USER_ID), '777777');
  const [subRows] = await connection.execute('SELECT sub_user_id FROM sub_accounts WHERE main_user_id = ?', [userId]);
  assert.equal(subRows.length, 2); // Registration is preserved; no main-account promotion.
}

async function verifyCrossGameStreaks(connection, store) {
  const player = '222222222222222222';
  await connection.execute('INSERT INTO accounts (user_id, user_name, wallet) VALUES (?, ?, ?)',
    [player, 'cross-game-player', 20_000]);
  let hand;
  async function start() {
    nextDraw = 7;
    const result = await store.start({ userId: player, wager: 100, requestId: randomUUID() });
    hand = result.hand;
    assert.equal(hand.streak, 0);
    assert.equal(hand.rulesVersion, 3);
    assert.ok(hand.nextWinOffers);
  }
  async function guess(result) {
    // Fix only the draw, allowing production code to update wins and payouts.
    nextDraw = { win: 7, tie: 3, loss: 1 }[result];
    await connection.execute(
      "UPDATE levelia_game_high_low_hands SET current_card = 'spades-5' WHERE id = ?",
      [hand.id],
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
      assert.equal(result.settlement.payout, Number(100n * 10350n * 12000n**5n / (10000n * 9003n**5n)));
    }
  }
  await start();
  assert.equal(await store.readBestStreak(player), 5);
  assert.equal((await guess('win')).bestStreak, 6);
  assert.equal((await guess('tie')).bestStreak, 6);
  assert.equal(hand.streak, 1);
  assert.equal((await guess('win')).bestStreak, 7);
  const cashout = await store.cashout({ userId: player, handId: hand.id, expectedVersion: hand.version, requestId: randomUUID() });
  assert.equal(cashout.settlement.payout, Number(100n * 10050n * 12000n**2n / (10000n * 9003n**2n))); // Uses 2 wins in this game, not 7.
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

async function verifyProgressivePayouts(connection) {
  const coefficient98 = correctionForTarget(980000), coefficient101 = correctionForTarget(1010000);
  const player = '888888888888888888', actorId = '649438093996195851';
  await connection.execute('INSERT INTO accounts (user_id, user_name, wallet) VALUES (?, ?, ?)', [player, 'progressive', 1_000_000]);
  const store = createHighLowStore(mysqlUrl, { randomIndex, workerIntervalMs: 600_000 });
  let hand;
  const start = async () => {
    nextDraw = 7;
    hand = (await store.start({ userId: player, wager: 10000, requestId: randomUUID() })).hand;
    return hand;
  };
  const stored = async () => {
    const [[row]] = await connection.execute('SELECT payout_state, potential_payout, remaining_deck, version FROM levelia_game_high_low_hands WHERE id = ?', [hand.id]);
    return { ...row, payout_state: typeof row.payout_state === 'string' ? JSON.parse(row.payout_state) : row.payout_state };
  };
  const setDraw = async rank => {
    nextDraw = rank - 2;
    await connection.execute("UPDATE levelia_game_high_low_hands SET current_card = 'spades-7' WHERE id = ?", [hand.id]);
    hand = (await store.readSession(player)).hand;
  };
  const guess = async () => {
    const input = { userId: player, handId: hand.id, guess: 'higher', expectedVersion: hand.version, requestId: randomUUID() };
    const result = await store.guess(input);
    assert.deepEqual(await store.guess(input), result);
    hand = result.hand;
    return result;
  };
  try {
    const change = { actorId, requestId: '1555555555555555501', targetRtpPpm: 980000 };
    const changed = await store.setTargetRtp(change);
    assert.equal(changed.calibrationId, RTP_CALIBRATION_ID);
    assert.equal((await store.readPayoutConfig()).targetRtpPpm, 980000);
    await start();
    assert.equal((await stored()).payout_state.correctionPpm, coefficient98);
    await setDraw(9);
    assert.equal((await stored()).remaining_deck, null);
    const offered = hand.nextWinOffers.higher.payout;
    assert.equal(offered, Number(10000n * 9950n * BigInt(coefficient98) * 12000n / (10000n * 1000000n * 7005n)));
    await guess(); assert.equal(hand.potentialPayout, offered);
    const fairAfterWin = (await stored()).payout_state;
    await setDraw(7);
    assert.equal((await guess()).event.result, 'tie');
    assert.equal(hand.potentialPayout, offered);
    assert.deepEqual((await stored()).payout_state, fairAfterWin);

    await store.setTargetRtp({ actorId, requestId: '1555555555555555502', targetRtpPpm: 1010000 });
    assert.deepEqual(await store.setTargetRtp(change), changed); // An old delivery cannot revert newer settings.
    assert.equal((await store.readPayoutConfig()).correctionPpm, coefficient101);
    await assert.rejects(store.setTargetRtp({ ...change, targetRtpPpm: 990000 }), { code: 'request_id_reused' });
    await migrateHighLow(connection); // Repeat migrations preserve settings and active fair state.
    assert.equal((await store.readPayoutConfig()).correctionPpm, coefficient101);
    assert.deepEqual((await stored()).payout_state, fairAfterWin);
    await setDraw(9);
    const secondOffer = hand.nextWinOffers.higher.payout;
    await guess(); assert.equal(hand.potentialPayout, secondOffer);
    assert.equal((await stored()).payout_state.correctionPpm, coefficient98);
    const cashInput = { userId: player, handId: hand.id, expectedVersion: hand.version, requestId: randomUUID() };
    const cashed = await store.cashout(cashInput);
    assert.equal(cashed.settlement.payout, secondOffer);
    assert.deepEqual(await store.cashout(cashInput), cashed);
    assert.equal(cashed.settlement.wallet, String(990000 + secondOffer));

    await start(); assert.equal((await stored()).payout_state.correctionPpm, coefficient101);
    for (let n = 1; n <= 5; n++) {
      await setDraw(9);
      const offer = hand.nextWinOffers.higher.payout;
      const result = await guess();
      if (n === 5) { assert.equal(result.settlement.reason, 'max_streak'); assert.equal(result.settlement.payout, offer); }
      else assert.equal(hand.potentialPayout, offer);
    }
    await start();
    await setDraw(3); // Lose without fate shift.
    const loss = await guess(); assert.equal(loss.event.result, 'loss'); assert.equal(loss.settlement.payout, 0);

    await start(); await setDraw(9); await guess();
    const expiryPayout = hand.potentialPayout;
    const walletBeforeExpiry = Number(await store.readWallet(player));
    await connection.execute('UPDATE levelia_game_high_low_hands SET last_heartbeat_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 6 MINUTE) WHERE id = ?', [hand.id]);
    assert.equal((await store.readSession(player)).hand, null);
    assert.equal(Number(await store.readWallet(player)), walletBeforeExpiry + expiryPayout);
    assert.equal((await store.readSession(player)).hand, null);
    assert.equal(Number(await store.readWallet(player)), walletBeforeExpiry + expiryPayout);

    await start(); await setDraw(9);
    const before = await stored();
    await connection.execute('UPDATE accounts SET wallet = 2147483647 WHERE user_id = ?', [player]);
    await assert.rejects(store.guess({ userId: player, handId: hand.id, guess: 'higher', expectedVersion: hand.version, requestId: randomUUID() }), { code: 'wallet_limit_exceeded' });
    assert.deepEqual(await stored(), before); // No card is consumed for an unpayable offer.
    assert.equal(await store.readWallet(LEVELIA_GAME_USER_ID), '777777');
    const [[audit]] = await connection.execute('SELECT COUNT(*) AS n FROM levelia_game_high_low_setting_changes');
    assert.equal(Number(audit.n), 2);
  } finally { await store.close(); }
}
