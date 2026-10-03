import { correctionForTarget, RTP_CALIBRATION_ID } from './highLowCalibration.mjs';
import { createHighLowLeaderboard } from './highLowLeaderboard.mjs';
import { createCasinoStatsReader } from './casinoStats.mjs';
import { createPool } from 'mysql2/promise';
import { ApiError } from './http.mjs';
import { errorMetadata } from './safeLog.mjs';
import {
  advancePayoutState, createPayoutState, displayMultiplier, parsePayoutState,
  progressiveOffers, progressivePayout, validateCorrectionPpm,
} from './highLowPayout.mjs';
import {
  drawActionableCard,
  HIGH_LOW_MAX_STREAK,
  HIGH_LOW_RULES_VERSION,
  HIGH_LOW_WAGERS,
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
  payout_state, rules_version, version, settlement_amount, settlement_reason,
  TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', last_heartbeat_at) DIV 1000 AS last_heartbeat_ms,
  TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', expires_at) DIV 1000 AS expires_ms`;

function parseJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function deadlineIso(row) {
  const heartbeatDeadline = Number(row.last_heartbeat_ms) + DISCONNECT_GRACE_MS;
  const absoluteDeadline = Number(row.expires_ms);
  return new Date(Math.min(heartbeatDeadline, absoluteDeadline)).toISOString();
}

function toPublicHand(row) {
  const streak = Number(row.streak);
  const wager = Number(row.wager);
  if (Number(row.rules_version) !== HIGH_LOW_RULES_VERSION) throw new Error('Unsupported high-low rules version');
  const offers = progressiveOffers({ wager, streak, currentCardId: row.current_card,
    state: parsePayoutState(row.payout_state) });
  for (const offer of Object.values(offers)) {
    if (offer.payout > MAX_INTEGER_WALLET) offer.available = false;
  }
  return {
    id: String(row.id),
    wager: Number(row.wager),
    streak,
    potentialPayout: Number(row.potential_payout),
    multiplier: displayMultiplier(Number(row.potential_payout), wager),
    nextWinOffers: offers,
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
  walletMode = 'real',
  poolFactory = options => createPool(options),
  randomIndex,
  workerIntervalMs = 15_000,
} = {}) {
  if (!['real', 'virtual'].includes(walletMode)) throw new Error('Invalid high-low wallet mode');
  const virtual = walletMode === 'virtual';
  const tables = Object.fromEntries(['hands', 'commands', 'ledger', 'settings', 'setting_changes']
    .map(name => [name, `levelia_game_high_low_${virtual ? 'virtual_' : ''}${name}`]));
  const walletTable = virtual ? 'levelia_game_high_low_virtual_wallets' : 'accounts';
  let pool = null;
  let worker = null;
  let expirationCursor = '0';
  let expirationRun = null;

  function getPool() {
    if (!mysqlUrl) {
      throw new ApiError(503, 'database_not_configured', 'Game database is not configured');
    }
    pool ??= poolFactory({
      uri: mysqlUrl,
      connectionLimit: 20,
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
      `SELECT user_id, action, response_json FROM ${tables.commands}
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
      `INSERT INTO ${tables.commands}
       (request_id, user_id, hand_id, action, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [requestId, userId, handId, action, JSON.stringify(response)],
    );
  }

  async function lockAccount(connection, userId) {
    if (virtual) {
      const [[wallet]] = await connection.execute(
        `SELECT wallet FROM ${walletTable} WHERE user_id = ? FOR UPDATE`, [userId]);
      const [[account]] = await connection.execute(
        'SELECT is_frozen FROM accounts WHERE user_id = ?', [userId]);
      if (!wallet || !account) throw new ApiError(409, 'account_not_found', 'テスト用の仮想残高が見つかりません');
      return { wallet: Number(wallet.wallet), isFrozen: Boolean(account.is_frozen) };
    }
    const [rows] = await connection.execute(
      'SELECT wallet, is_frozen FROM accounts WHERE user_id = ? FOR UPDATE', [userId]);
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
    if (virtual) return 0;
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
    if (virtual) return;
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
      `SELECT ${handColumns} FROM ${tables.hands}
       WHERE id = ? AND user_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [handId, userId],
    );
    return rows[0] ?? null;
  }

  async function creditPayout(connection, hand, { requestId = null, automatic = false, reason }) {
    const payout = Number(hand.potential_payout);
    if (Number(hand.streak) <= 0 || !Number.isSafeInteger(payout) || payout < 0) {
      throw new ApiError(409, 'cashout_not_available', 'まだ精算できる配当がありません');
    }
    const account = await lockAccount(connection, String(hand.user_id));
    const walletAfter = account.wallet + payout;
    assertWalletRange(walletAfter);
    const gameWallet = await readGameAccountWallet(connection);
    await connection.execute(`UPDATE ${walletTable} SET wallet = ? WHERE user_id = ?`, [walletAfter, hand.user_id]);
    await connection.execute(
      `INSERT INTO ${tables.ledger}
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
      `UPDATE ${tables.hands}
       SET status = ?, settlement_amount = ?, settlement_reason = ?, settled_at = UTC_TIMESTAMP(3),
           updated_at = UTC_TIMESTAMP(3), version = version + 1
       WHERE id = ?`,
      [automatic ? 'auto_cashed_out' : 'cashed_out', payout, reason, hand.id],
    );
    return { payout, wallet: String(walletAfter) };
  }

  async function readWallet(userId) {
    const [rows] = await getPool().execute(`SELECT wallet FROM ${walletTable} WHERE user_id = ? LIMIT 1`, [userId]);
    const wallet = rows[0]?.wallet;
    return wallet === undefined ? null : String(wallet);
  }

  async function readPayoutConfig(connection = getPool()) {
    const [rows] = await connection.execute(
      `SELECT correction_ppm, version, updated_by, target_rtp_ppm, calibration_id FROM ${tables.settings} WHERE id = 1`,
    );
    if (!rows[0]) throw new ApiError(503, 'payout_settings_missing', '配当設定がありません。マイグレーションを確認してください');
    return { correctionPpm: validateCorrectionPpm(Number(rows[0].correction_ppm)),
      version: Number(rows[0].version), updatedBy: rows[0].updated_by,
      targetRtpPpm: rows[0].target_rtp_ppm === null ? null : Number(rows[0].target_rtp_ppm), calibrationId: rows[0].calibration_id };
  }

  async function setPayoutCorrection({ correctionPpm, actorId, requestId, targetRtpPpm = null, calibrationId = null }) {
    validateCorrectionPpm(correctionPpm);
    if (!/^[1-9]\d{16,19}$/.test(actorId) || !/^[1-9]\d{16,19}$/.test(requestId)) {
      throw new ApiError(400, 'invalid_setting_request', '管理者IDまたは操作IDが不正です');
    }
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      const [settings] = await connection.execute(
        `SELECT correction_ppm, version FROM ${tables.settings} WHERE id = 1 FOR UPDATE`,
      );
      if (!settings[0]) throw new ApiError(503, 'payout_settings_missing', '配当設定がありません');
      const [replayed] = await connection.execute(
        `SELECT actor_id, previous_ppm, correction_ppm, version, target_rtp_ppm, calibration_id FROM ${tables.setting_changes} WHERE request_id = ?`, [requestId],
      );
      if (replayed[0]) {
        const previous = replayed[0];
        if (previous.actor_id !== actorId || Number(previous.correction_ppm) !== correctionPpm
          || (previous.target_rtp_ppm === null ? null : Number(previous.target_rtp_ppm)) !== targetRtpPpm
          || previous.calibration_id !== calibrationId) {
          throw new ApiError(409, 'request_id_reused', '同じ操作IDを別の設定には使用できません');
        }
        await connection.commit();
        return { previousPpm: Number(previous.previous_ppm), correctionPpm, version: Number(previous.version), targetRtpPpm, calibrationId };
      }
      const previousPpm = Number(settings[0].correction_ppm);
      const version = Number(settings[0].version) + 1;
      await connection.execute(
        `UPDATE ${tables.settings} SET correction_ppm = ?, version = ?, updated_by = ?, target_rtp_ppm = ?, calibration_id = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = 1`,
        [correctionPpm, version, actorId, targetRtpPpm, calibrationId],
      );
      await connection.execute(
        `INSERT INTO ${tables.setting_changes} (request_id, actor_id, previous_ppm, correction_ppm, version, target_rtp_ppm, calibration_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`, [requestId, actorId, previousPpm, correctionPpm, version, targetRtpPpm, calibrationId],
      );
      await connection.commit();
      return { previousPpm, correctionPpm, version, targetRtpPpm, calibrationId };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async function setTargetRtp({ targetRtpPpm, actorId, requestId }) {
    return setPayoutCorrection({ correctionPpm: correctionForTarget(targetRtpPpm),
      targetRtpPpm, calibrationId: RTP_CALIBRATION_ID, actorId, requestId });
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
        `SELECT id FROM ${tables.hands}
         WHERE user_id = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
        [userId],
      );
      if (activeRows.length > 0) {
        throw new ApiError(409, 'active_hand_exists', '進行中のゲームがあります');
      }
      if (account.wallet < wager) throw new ApiError(409, 'insufficient_balance', 'LIA残高が不足しています');

      const opening = drawActionableCard(randomIndex);
      const payoutState = createPayoutState(await readPayoutConfig(connection));
      const walletAfter = account.wallet - wager;
      const [insert] = await connection.execute(
        `INSERT INTO ${tables.hands}
         (user_id, status, wager, streak, potential_payout, current_card, payout_state,
          rules_version, version, last_heartbeat_at, expires_at, created_at, updated_at)
         VALUES (?, 'active', ?, 0, 0, ?, ?, ?, 1, UTC_TIMESTAMP(3),
                 DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${HAND_LIFETIME_MINUTES} MINUTE), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
        [userId, wager, opening.cardId, JSON.stringify(payoutState), HIGH_LOW_RULES_VERSION],
      );
      const handId = insert.insertId;
      await connection.execute(`UPDATE ${walletTable} SET wallet = ? WHERE user_id = ?`, [walletAfter, userId]);
      await connection.execute(
        `INSERT INTO ${tables.ledger}
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
         FROM ${tables.hands} WHERE user_id = ?
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
      if (Number(hand.rules_version) !== HIGH_LOW_RULES_VERSION) throw new Error('Unsupported high-low rules version');
      const oldPayoutState = parsePayoutState(hand.payout_state);
      const winningState = advancePayoutState(oldPayoutState, previousCardId, playerGuess);
      if (!winningState) throw new ApiError(409, 'guess_unavailable', 'その方向を選択できません');
      const winningPayout = progressivePayout(Number(hand.wager), Number(hand.streak) + 1, winningState);
      // Reject an unpayable offer before drawing; never cap or silently reduce a promised payout.
      const account = await lockAccount(connection, userId);
      assertWalletRange(account.wallet + winningPayout);
      const resolution = resolveServerGuess({
        currentCardId: previousCardId,
        guess: playerGuess,
        randomIndex,
      });
      const nextStreak = resolution.result === 'win' ? Number(hand.streak) + 1 : Number(hand.streak);
      const potentialPayout = resolution.result === 'win' ? winningPayout : Number(hand.potential_payout);
      const nextPayoutState = resolution.result === 'win' ? winningState : oldPayoutState;
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
          `UPDATE ${tables.hands}
           SET status = 'lost', current_card = ?, settlement_reason = 'loss',
               settled_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3), version = version + 1
           WHERE id = ?`,
          [resolution.finalCardId, hand.id],
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
        `UPDATE ${tables.hands}
         SET streak = ?, potential_payout = ?, current_card = ?, payout_state = ?,
             last_heartbeat_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3), version = version + 1
         WHERE id = ?`,
        [nextStreak, potentialPayout, resolution.currentAfterCardId,
          JSON.stringify(nextPayoutState), hand.id],
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
        `SELECT ${handColumns} FROM ${tables.hands}
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
          `UPDATE ${tables.hands}
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

  async function runExpirationBatch() {
    const [rows] = await getPool().execute(
      `SELECT id FROM ${tables.hands}
       WHERE status = 'active' AND id > ?
         AND (last_heartbeat_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)
              OR expires_at <= UTC_TIMESTAMP(3))
       ORDER BY id LIMIT 50`,
      [expirationCursor],
    );
    for (const row of rows) {
      try {
        await settleExpiredHand(row.id);
      } catch (error) {
        // The transaction rolled back; leave this hand for a later pass.
        console.error('High-low hand expiration failed', { handId: String(row.id), ...errorMetadata(error) });
      }
    }
    // Advance past failures too, otherwise 50 unpayable hands starve all others.
    expirationCursor = rows.length === 50 ? String(rows.at(-1).id) : '0';
    return rows.length;
  }

  function expireInactiveHands() {
    // A slow batch must not overlap the next interval in the same process.
    expirationRun ??= runExpirationBatch().finally(() => { expirationRun = null; });
    return expirationRun;
  }

  async function readSession(userId) {
    ensureWorker();
    const [accounts] = await getPool().execute(
      `SELECT wallet FROM ${walletTable} WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    const account = accounts[0];
    if (!account) return { accountFound: false, wallet: null, hand: null, bestStreak: 0 };
    const [rows] = await getPool().execute(
      `SELECT ${handColumns} FROM ${tables.hands}
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
      `UPDATE ${tables.hands}
       SET last_heartbeat_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND user_id = ? AND status = 'active' AND expires_at > UTC_TIMESTAMP(3)
         AND last_heartbeat_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)`,
      [handId, userId],
    );
    if (result.affectedRows !== 1) throw new ApiError(409, 'hand_not_active', '進行中のゲームが見つかりません');
    return { ok: true };
  }

  const readLeaderboard = createHighLowLeaderboard({ getPool, tables });
  const readCasinoStats = createCasinoStatsReader({ getPool });

  if (mysqlUrl) ensureWorker();

  return {
    readPayoutConfig,
    setPayoutCorrection,
    setTargetRtp,
    readWallet,
    readBestStreak,
    readLeaderboard,
    readCasinoStats,
    readSession,
    start,
    guess,
    cashout,
    heartbeat,
    expireInactiveHands,
    async close() {
      if (worker) clearInterval(worker);
      worker = null;
      if (expirationRun) await expirationRun.catch(() => {});
      if (pool) await pool.end();
      pool = null;
    },
  };
}
