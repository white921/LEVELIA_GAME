import { createPool } from 'mysql2/promise';
import { ApiError } from './http.mjs';
import { errorMetadata } from './safeLog.mjs';
import {
  calculatePayout,
  cardFromId,
  createSecureDeck,
  drawActionableCard,
  HIGH_LOW_MAX_STREAK,
  HIGH_LOW_RULES_VERSION,
  HIGH_LOW_WAGERS,
  nextWinOffer,
  payoutMultiplier,
  publicCard,
  resolveServerGuess,
} from './highLowRules.mjs';

export const LEVELIA_GAME_USER_ID = '1552246348756025344';
// Explicit operator-approved exception; normal access and wallet checks still apply.
export const HIGH_LOW_ALLOWED_SUB_ACCOUNT_ID = '1551725849009586270';
const DISCONNECT_GRACE_MS = 5 * 60 * 1_000;
const HAND_LIFETIME_MINUTES = 30;
const MAX_INTEGER_WALLET = 2_147_483_647;

const handColumns = `
  id, user_id, status, wager, streak, potential_payout, current_card,
  remaining_deck, rules_version, version, settlement_amount, settlement_reason,
  TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', last_heartbeat_at) DIV 1000 AS last_heartbeat_ms,
  TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', expires_at) DIV 1000 AS expires_ms`;

function parseJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function parseDeck(value) {
  const deck = parseJson(value);
  if (!Array.isArray(deck) || deck.some(cardId => typeof cardId !== 'string')) {
    throw new Error('Stored high-low deck is invalid');
  }
  const known = new Set();
  for (const cardId of deck) {
    cardFromId(cardId);
    if (known.has(cardId)) throw new Error('Stored high-low deck contains duplicate cards');
    known.add(cardId);
  }
  return deck;
}

function deadlineIso(row) {
  const heartbeatDeadline = Number(row.last_heartbeat_ms) + DISCONNECT_GRACE_MS;
  const absoluteDeadline = Number(row.expires_ms);
  return new Date(Math.min(heartbeatDeadline, absoluteDeadline)).toISOString();
}

function toPublicHand(row) {
  const streak = Number(row.streak);
  const nextWin = nextWinOffer(Number(row.wager), streak);
  return {
    id: String(row.id),
    wager: Number(row.wager),
    streak,
    potentialPayout: Number(row.potential_payout),
    multiplier: payoutMultiplier(streak),
    nextWinPayout: nextWin.payout,
    nextWinMultiplier: nextWin.multiplier,
    currentCard: publicCard(row.current_card),
    version: Number(row.version),
    rulesVersion: Number(row.rules_version),
    disconnectDeadlineAt: deadlineIso(row),
    canCashOut: Number(row.streak) > 0,
  };
}

function assertWalletRange(wallet) {
  if (!Number.isSafeInteger(wallet) || wallet < 0 || wallet > MAX_INTEGER_WALLET) {
    throw new ApiError(409, 'wallet_limit_exceeded', 'LIA残高の上限を超えるため精算できません');
  }
}

function isDuplicateEntry(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

export function createHighLowStore(mysqlUrl, {
  poolFactory = options => createPool(options),
  randomIndex,
  workerIntervalMs = 15_000,
} = {}) {
  let pool = null;
  let worker = null;

  function getPool() {
    if (!mysqlUrl) {
      throw new ApiError(503, 'database_not_configured', 'Game database is not configured');
    }
    pool ??= poolFactory({
      uri: mysqlUrl,
      connectionLimit: 6,
      connectTimeout: 10_000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      timezone: 'Z',
    });
    return pool;
  }

  function ensureWorker() {
    if (worker) return;
    worker = setInterval(() => {
      void expireInactiveHands().catch(error => console.error('High-low expiration failed', errorMetadata(error)));
    }, workerIntervalMs);
    worker.unref?.();
  }

  async function readCommand(connection, requestId, userId, action, forUpdate = false) {
    const [rows] = await connection.execute(
      `SELECT user_id, action, response_json FROM levelia_game_high_low_commands
       WHERE request_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [requestId],
    );
    const row = rows[0];
    if (!row) return null;
    if (String(row.user_id) !== userId || row.action !== action) {
      throw new ApiError(409, 'request_id_reused', '同じrequestIdを別の操作には使用できません');
    }
    return parseJson(row.response_json);
  }

  async function saveCommand(connection, { requestId, userId, handId, action, response }) {
    await connection.execute(
      `INSERT INTO levelia_game_high_low_commands
       (request_id, user_id, hand_id, action, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [requestId, userId, handId, action, JSON.stringify(response)],
    );
  }

  async function lockAccount(connection, userId) {
    const [rows] = await connection.execute(
      'SELECT wallet, is_frozen FROM accounts WHERE user_id = ? FOR UPDATE',
      [userId],
    );
    const row = rows[0];
    if (!row) throw new ApiError(409, 'account_not_found', 'LEVELIAの口座が見つかりません');
    return { wallet: Number(row.wallet), isFrozen: Boolean(row.is_frozen) };
  }

  async function assertMainAccount(connection, userId) {
    const [rows] = await connection.execute(
      'SELECT 1 FROM sub_accounts WHERE sub_user_id = ? LIMIT 1',
      [userId],
    );
    if (rows.length > 0 && userId !== HIGH_LOW_ALLOWED_SUB_ACCOUNT_ID) {
      throw new ApiError(403, 'sub_account_not_allowed', 'サブアカウントではゲームに参加できません');
    }
  }

  async function readGameAccountWallet(connection) {
    const [rows] = await connection.execute(
      'SELECT wallet FROM accounts WHERE user_id = ? LIMIT 1',
      [LEVELIA_GAME_USER_ID],
    );
    if (!rows[0]) {
      throw new ApiError(503, 'game_account_not_found', 'LEVELIA Gameの履歴用口座が見つかりません');
    }
    return Number(rows[0].wallet);
  }

  async function insertAction(connection, {
    type,
    amount,
    userId,
    userAfterWallet,
    gameWallet,
    comment,
  }) {
    const payout = type === 'high_low_payout';
    await connection.execute(
      `INSERT INTO actions
       (command_name, amount, from_user_id, to_user_id, from_after_wallet, to_after_wallet, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      payout
        ? [type, amount, LEVELIA_GAME_USER_ID, userId, gameWallet, userAfterWallet, comment]
        : [type, amount, userId, LEVELIA_GAME_USER_ID, userAfterWallet, gameWallet, comment],
    );
  }

  async function selectHand(connection, handId, userId, forUpdate = false) {
    const [rows] = await connection.execute(
      `SELECT ${handColumns} FROM levelia_game_high_low_hands
       WHERE id = ? AND user_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [handId, userId],
    );
    return rows[0] ?? null;
  }

  async function creditPayout(connection, hand, { requestId = null, automatic = false, reason }) {
    const payout = Number(hand.potential_payout);
    if (payout <= 0) throw new ApiError(409, 'cashout_not_available', 'まだ精算できる配当がありません');
    const account = await lockAccount(connection, String(hand.user_id));
    const walletAfter = account.wallet + payout;
    assertWalletRange(walletAfter);
    const gameWallet = await readGameAccountWallet(connection);
    await connection.execute('UPDATE accounts SET wallet = ? WHERE user_id = ?', [walletAfter, hand.user_id]);
    await connection.execute(
      `INSERT INTO levelia_game_high_low_ledger
       (hand_id, user_id, kind, amount, wallet_before, wallet_after, supply_delta, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [hand.id, hand.user_id, automatic ? 'auto_payout_credit' : 'payout_credit', payout,
        account.wallet, walletAfter, payout, requestId],
    );
    await insertAction(connection, {
      type: 'high_low_payout',
      amount: payout,
      userId: String(hand.user_id),
      userAfterWallet: walletAfter,
      gameWallet,
      comment: `ハイ&ロー ${Number(hand.streak)}連勝${automatic ? '・自動精算' : ''}`,
    });
    await connection.execute(
      `UPDATE levelia_game_high_low_hands
       SET status = ?, settlement_amount = ?, settlement_reason = ?, settled_at = UTC_TIMESTAMP(3),
           updated_at = UTC_TIMESTAMP(3), version = version + 1
       WHERE id = ?`,
      [automatic ? 'auto_cashed_out' : 'cashed_out', payout, reason, hand.id],
    );
    return { payout, wallet: String(walletAfter) };
  }

  async function readWallet(userId) {
    const [rows] = await getPool().execute('SELECT wallet FROM accounts WHERE user_id = ? LIMIT 1', [userId]);
    const wallet = rows[0]?.wallet;
    return wallet === undefined ? null : String(wallet);
  }

  async function start({ userId, wager, requestId }) {
    ensureWorker();
    if (!HIGH_LOW_WAGERS.includes(wager)) {
      throw new ApiError(400, 'invalid_wager', '賭け金は100、1,000、10,000 LIAから選んでください');
    }
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      const account = await lockAccount(connection, userId);
      const saved = await readCommand(connection, requestId, userId, 'start', true);
      if (saved) {
        await connection.commit();
        return saved;
      }
      if (account.isFrozen) throw new ApiError(403, 'account_frozen', '凍結中の口座ではゲームを開始できません');
      await assertMainAccount(connection, userId);
      const [activeRows] = await connection.execute(
        `SELECT id FROM levelia_game_high_low_hands
         WHERE user_id = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
        [userId],
      );
      if (activeRows.length > 0) {
        throw new ApiError(409, 'active_hand_exists', '進行中のゲームがあります');
      }
      if (account.wallet < wager) throw new ApiError(409, 'insufficient_balance', 'LIA残高が不足しています');

      const deck = createSecureDeck(randomIndex);
      const opening = drawActionableCard(deck);
      const walletAfter = account.wallet - wager;
      const [insert] = await connection.execute(
        `INSERT INTO levelia_game_high_low_hands
         (user_id, status, wager, streak, potential_payout, current_card, remaining_deck,
          rules_version, version, last_heartbeat_at, expires_at, created_at, updated_at)
         VALUES (?, 'active', ?, 0, 0, ?, ?, ?, 1, UTC_TIMESTAMP(3),
                 DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${HAND_LIFETIME_MINUTES} MINUTE), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
        [userId, wager, opening.cardId, JSON.stringify(deck), HIGH_LOW_RULES_VERSION],
      );
      const handId = insert.insertId;
      await connection.execute('UPDATE accounts SET wallet = ? WHERE user_id = ?', [walletAfter, userId]);
      await connection.execute(
        `INSERT INTO levelia_game_high_low_ledger
         (hand_id, user_id, kind, amount, wallet_before, wallet_after, supply_delta, request_id, created_at)
         VALUES (?, ?, 'wager_debit', ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [handId, userId, wager, account.wallet, walletAfter, -wager, requestId],
      );
      const gameWallet = await readGameAccountWallet(connection);
      await insertAction(connection, {
        type: 'high_low_bet', amount: wager, userId, userAfterWallet: walletAfter, gameWallet,
        comment: 'ハイ&ロー 賭け金',
      });
      const hand = await selectHand(connection, handId, userId);
      const response = {
        wallet: String(walletAfter),
        hand: toPublicHand(hand),
        openingAutoDrawnCards: opening.autoDrawnCards.map(publicCard),
      };
      await saveCommand(connection, { requestId, userId, handId, action: 'start', response });
      await connection.commit();
      return response;
    } catch (error) {
      await connection.rollback();
      if (isDuplicateEntry(error)) {
        throw new ApiError(409, 'active_hand_exists', '進行中のゲームがあります');
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function readBestStreak(userId, connection = getPool()) {
    // A losing hand retains its wins before the loss. Reset the run only
    // AFTER that hand; cashouts, ties and expiry do not break a winning run.
    const [rows] = await connection.execute(
      `WITH grouped_hands AS (
         SELECT streak, COALESCE(SUM(status = 'lost') OVER (
           ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS loss_group
         FROM levelia_game_high_low_hands WHERE user_id = ?
       ), winning_runs AS (
         SELECT SUM(streak) AS wins FROM grouped_hands GROUP BY loss_group
       )
       SELECT COALESCE(MAX(wins), 0) AS best_streak FROM winning_runs`,
      [userId],
    );
    return Number(rows[0].best_streak);
  }

  function assertHandNotExpired(hand) {
    const now = Date.now();
    if (Number(hand.last_heartbeat_ms) + DISCONNECT_GRACE_MS <= now || Number(hand.expires_ms) <= now) {
      throw new ApiError(409, 'hand_expired', 'ゲームの期限が切れました。状態を再読み込みします');
    }
  }

  async function guess({ userId, handId, guess: playerGuess, requestId, expectedVersion }) {
    ensureWorker();
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      let saved = await readCommand(connection, requestId, userId, 'guess');
      if (saved) {
        const response = { ...saved, bestStreak: await readBestStreak(userId, connection) };
        await connection.commit();
        return response;
      }
      const hand = await selectHand(connection, handId, userId, true);
      if (!hand) throw new ApiError(404, 'hand_not_found', 'ゲームが見つかりません');
      saved = await readCommand(connection, requestId, userId, 'guess', true);
      if (saved) {
        const response = { ...saved, bestStreak: await readBestStreak(userId, connection) };
        await connection.commit();
        return response;
      }
      if (hand.status !== 'active') throw new ApiError(409, 'hand_finished', 'このゲームはすでに終了しています');
      assertHandNotExpired(hand);
      if (Number(hand.version) !== expectedVersion) {
        throw new ApiError(409, 'stale_hand_version', 'ゲーム状態が更新されています。画面を再読み込みしてください');
      }

      const previousCardId = hand.current_card;
      const resolution = resolveServerGuess({
        currentCardId: previousCardId,
        deck: parseDeck(hand.remaining_deck),
        guess: playerGuess,
        randomIndex,
      });
      const nextStreak = resolution.result === 'win' ? Number(hand.streak) + 1 : Number(hand.streak);
      const potentialPayout = calculatePayout(Number(hand.wager), nextStreak);
      const event = {
        guess: playerGuess,
        result: resolution.result,
        previousCard: publicCard(previousCardId),
        revealedCard: publicCard(resolution.revealedCardId),
        finalCard: publicCard(resolution.finalCardId),
        autoDrawnCards: resolution.autoDrawnCardIds.map(publicCard),
        fateShifted: resolution.fateShifted,
      };

      if (resolution.result === 'loss') {
        await connection.execute(
          `UPDATE levelia_game_high_low_hands
           SET status = 'lost', current_card = ?, remaining_deck = ?, settlement_reason = 'loss',
               settled_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3), version = version + 1
           WHERE id = ?`,
          [resolution.finalCardId, JSON.stringify(resolution.deck), hand.id],
        );
        const response = {
          hand: null,
          event,
          bestStreak: await readBestStreak(userId, connection),
          settlement: { reason: 'loss', payout: 0, wallet: null },
        };
        await saveCommand(connection, { requestId, userId, handId: hand.id, action: 'guess', response });
        await connection.commit();
        return response;
      }

      await connection.execute(
        `UPDATE levelia_game_high_low_hands
         SET streak = ?, potential_payout = ?, current_card = ?, remaining_deck = ?,
             last_heartbeat_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3), version = version + 1
         WHERE id = ?`,
        [nextStreak, potentialPayout, resolution.currentAfterCardId, JSON.stringify(resolution.deck), hand.id],
      );

      let response;
      if (resolution.result === 'win' && nextStreak === HIGH_LOW_MAX_STREAK) {
        const updatedHand = await selectHand(connection, hand.id, userId, true);
        const settlement = await creditPayout(connection, updatedHand, {
          requestId,
          reason: 'max_streak',
        });
        response = { hand: null, event, settlement: { reason: 'max_streak', ...settlement } };
      } else {
        const updatedHand = await selectHand(connection, hand.id, userId);
        response = { hand: toPublicHand(updatedHand), event, settlement: null };
      }
      response.bestStreak = await readBestStreak(userId, connection);
      await saveCommand(connection, { requestId, userId, handId: hand.id, action: 'guess', response });
      await connection.commit();
      return response;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function cashout({ userId, handId, requestId, expectedVersion }) {
    ensureWorker();
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      let saved = await readCommand(connection, requestId, userId, 'cashout');
      if (saved) {
        await connection.commit();
        return saved;
      }
      const hand = await selectHand(connection, handId, userId, true);
      if (!hand) throw new ApiError(404, 'hand_not_found', 'ゲームが見つかりません');
      saved = await readCommand(connection, requestId, userId, 'cashout', true);
      if (saved) {
        await connection.commit();
        return saved;
      }
      if (hand.status !== 'active') throw new ApiError(409, 'hand_finished', 'このゲームはすでに終了しています');
      assertHandNotExpired(hand);
      if (Number(hand.version) !== expectedVersion) {
        throw new ApiError(409, 'stale_hand_version', 'ゲーム状態が更新されています。画面を再読み込みしてください');
      }
      const settlement = await creditPayout(connection, hand, { requestId, reason: 'cashout' });
      const response = { hand: null, settlement: { reason: 'cashout', ...settlement } };
      await saveCommand(connection, { requestId, userId, handId: hand.id, action: 'cashout', response });
      await connection.commit();
      return response;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function settleExpiredHand(handId) {
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT ${handColumns} FROM levelia_game_high_low_hands
         WHERE id = ? FOR UPDATE`,
        [handId],
      );
      const hand = rows[0];
      if (!hand || hand.status !== 'active') {
        await connection.commit();
        return false;
      }
      const now = Date.now();
      const inactive = Number(hand.last_heartbeat_ms) + DISCONNECT_GRACE_MS <= now;
      const absoluteExpired = Number(hand.expires_ms) <= now;
      if (!inactive && !absoluteExpired) {
        await connection.commit();
        return false;
      }
      if (Number(hand.streak) > 0) {
        await creditPayout(connection, hand, {
          automatic: true,
          reason: absoluteExpired ? 'maximum_duration' : 'disconnected',
        });
      } else {
        await connection.execute(
          `UPDATE levelia_game_high_low_hands
           SET status = 'expired', settlement_reason = ?, settled_at = UTC_TIMESTAMP(3),
               updated_at = UTC_TIMESTAMP(3), version = version + 1
           WHERE id = ?`,
          [absoluteExpired ? 'maximum_duration' : 'disconnected', hand.id],
        );
      }
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function expireInactiveHands() {
    const [rows] = await getPool().execute(
      `SELECT id FROM levelia_game_high_low_hands
       WHERE status = 'active'
         AND (last_heartbeat_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)
              OR expires_at <= UTC_TIMESTAMP(3))
       ORDER BY id LIMIT 50`,
    );
    for (const row of rows) await settleExpiredHand(row.id);
    return rows.length;
  }

  async function readSession(userId) {
    ensureWorker();
    const [accounts] = await getPool().execute(
      'SELECT wallet FROM accounts WHERE user_id = ? LIMIT 1',
      [userId],
    );
    const account = accounts[0];
    if (!account) return { accountFound: false, wallet: null, hand: null, bestStreak: 0 };
    const [rows] = await getPool().execute(
      `SELECT ${handColumns} FROM levelia_game_high_low_hands
       WHERE user_id = ? AND status = 'active' LIMIT 1`,
      [userId],
    );
    const hand = rows[0];
    if (hand && (Number(hand.last_heartbeat_ms) + DISCONNECT_GRACE_MS <= Date.now()
      || Number(hand.expires_ms) <= Date.now())) {
      await settleExpiredHand(hand.id);
      return { accountFound: true, wallet: await readWallet(userId), hand: null, bestStreak: await readBestStreak(userId) };
    }
    return { accountFound: true, wallet: String(account.wallet), hand: hand ? toPublicHand(hand) : null, bestStreak: await readBestStreak(userId) };
  }

  async function heartbeat({ userId, handId }) {
    ensureWorker();
    const [result] = await getPool().execute(
      `UPDATE levelia_game_high_low_hands
       SET last_heartbeat_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND user_id = ? AND status = 'active' AND expires_at > UTC_TIMESTAMP(3)
         AND last_heartbeat_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)`,
      [handId, userId],
    );
    if (result.affectedRows !== 1) throw new ApiError(409, 'hand_not_active', '進行中のゲームが見つかりません');
    return { ok: true };
  }

  if (mysqlUrl) ensureWorker();

  return {
    readWallet,
    readBestStreak,
    readSession,
    start,
    guess,
    cashout,
    heartbeat,
    expireInactiveHands,
    async close() {
      if (worker) clearInterval(worker);
      worker = null;
      if (pool) await pool.end();
      pool = null;
    },
  };
}
