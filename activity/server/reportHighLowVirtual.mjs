import { createConnection } from 'mysql2/promise';
import { readMysqlUrl } from './runtimeConfig.mjs';

const c = await createConnection({ uri: readMysqlUrl(), supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
try {
  await c.query('SET TRANSACTION READ ONLY');
  await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  const [[time]] = await c.query('SELECT UTC_TIMESTAMP(3) AS checked_utc');
  const [players] = await c.query(`SELECT CAST(v.user_id AS CHAR) AS user_id, a.user_name,
    v.created_at AS started_utc, v.initial_wallet, v.wallet AS virtual_wallet,
    COALESCE(t.test_credits,0) AS test_credits,
    v.wallet-v.initial_wallet-COALESCE(t.test_credits,0) AS net_lia,
    COALESCE(l.wagers,0) AS wagers, COALESCE(l.payouts,0) AS payouts,
    COALESCE(l.games,0) AS games, COALESCE(h.active_hands,0) AS active_hands,
    COALESCE(l.net,0) = v.wallet-v.initial_wallet-COALESCE(t.test_credits,0) AS ledger_matches
    FROM levelia_game_high_low_virtual_wallets v
    LEFT JOIN accounts a ON a.user_id=v.user_id
    LEFT JOIN (SELECT user_id,
      SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(response_json, '$.amount')) AS SIGNED)) AS test_credits
      FROM levelia_game_high_low_virtual_commands WHERE action='test_credit'
      GROUP BY user_id) t ON t.user_id=v.user_id
    LEFT JOIN (SELECT user_id, SUM(supply_delta) AS net,
      SUM(CASE WHEN kind='wager_debit' THEN amount ELSE 0 END) AS wagers,
      SUM(CASE WHEN kind<>'wager_debit' THEN amount ELSE 0 END) AS payouts,
      SUM(kind='wager_debit') AS games FROM levelia_game_high_low_virtual_ledger GROUP BY user_id) l ON l.user_id=v.user_id
    LEFT JOIN (SELECT user_id, COUNT(*) AS active_hands FROM levelia_game_high_low_virtual_hands
      WHERE status='active' GROUP BY user_id) h ON h.user_id=v.user_id
    ORDER BY net_lia DESC, v.user_id`);
  const [settings] = await c.query('SELECT * FROM levelia_game_high_low_virtual_settings');
  console.log(JSON.stringify({ ...time, walletMode: 'virtual', settings, players,
    totalNetLia: players.reduce((sum, p) => sum + Number(p.net_lia), 0),
    totalTestCredits: players.reduce((sum, p) => sum + Number(p.test_credits), 0),
    note: 'Net excludes test credits and includes wagers on active hands; unsettled potential payouts are excluded.' }, null, 2));
  await c.rollback();
} finally { await c.end(); }
