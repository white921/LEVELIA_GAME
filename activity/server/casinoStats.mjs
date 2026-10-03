const DAY_MS = 86_400_000;
const JST_MS = 9 * 60 * 60 * 1_000;

export const CASINO_STATS_COMMAND = Object.freeze({
  name: 'カジノ統計',
  type: 1,
  description: '管理3ロール専用：指定した日本時間の日付範囲でカジノ実績を表示します',
  default_member_permissions: null,
  options: [
    {
      type: 3,
      name: '開始日',
      description: 'YYYY-MM-DD（例：2026-10-04）',
      required: true,
      min_length: 10,
      max_length: 10,
    },
    {
      type: 3,
      name: '終了日',
      description: 'YYYY-MM-DD（省略すると開始日の1日分）',
      required: false,
      min_length: 10,
      max_length: 10,
    },
  ],
});

export class CasinoStatsInputError extends Error {}

function jstDayStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CasinoStatsInputError('日付は YYYY-MM-DD 形式で入力してください。');
  }
  const utc = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value
    || Number(value.slice(0, 4)) < 2000) {
    throw new CasinoStatsInputError('実在する日付（2000年以降）を入力してください。');
  }
  return utc - JST_MS;
}

export function parseCasinoStatsPeriod({ startDate, endDate }, now = Date.now()) {
  const startMs = jstDayStart(startDate);
  const lastDayMs = jstDayStart(endDate ?? startDate);
  if (lastDayMs < startMs) throw new CasinoStatsInputError('終了日は開始日以降にしてください。');
  if (startMs >= now) throw new CasinoStatsInputError('開始日は現在より前にしてください。');
  const endMs = lastDayMs + DAY_MS;
  return {
    start: new Date(startMs),
    end: new Date(endMs),
    effectiveEnd: new Date(Math.min(endMs, now)),
    startDate,
    endDate: endDate ?? startDate,
  };
}

export function parseCasinoStatsAction(interaction, now = Date.now()) {
  const options = interaction.data?.options;
  if (interaction.type !== 2 || interaction.data?.name !== CASINO_STATS_COMMAND.name
    || interaction.data?.type !== 1 || !Array.isArray(options)) {
    throw new CasinoStatsInputError('未対応のコマンドです。');
  }
  const allowed = new Set(['開始日', '終了日']);
  if (options.some(option => option.type !== 3 || !allowed.has(option.name))
    || new Set(options.map(option => option.name)).size !== options.length) {
    throw new CasinoStatsInputError('日付の指定が不正です。');
  }
  const startDate = options.find(option => option.name === '開始日')?.value;
  const endDate = options.find(option => option.name === '終了日')?.value;
  if (typeof startDate !== 'string' || (endDate !== undefined && typeof endDate !== 'string')) {
    throw new CasinoStatsInputError('開始日を指定してください。');
  }
  return parseCasinoStatsPeriod({ startDate, endDate }, now);
}

function asBigInt(value) {
  return typeof value === 'bigint' ? value : BigInt(value ?? 0);
}

export function createCasinoStatsReader({ getPool }) {
  return async function readCasinoStats(start, end) {
    const [rows] = await getPool().execute(
      `SELECT CAST(user_id AS CHAR) AS user_id,
         SUM(CASE WHEN kind = 'wager_debit' THEN amount ELSE 0 END) AS wagers,
         SUM(CASE WHEN kind IN ('payout_credit', 'auto_payout_credit') THEN amount ELSE 0 END) AS payouts,
         SUM(supply_delta) AS net
       FROM levelia_game_high_low_ledger
       WHERE created_at >= ? AND created_at < ?
       GROUP BY user_id`,
      [start, end],
    );
    const players = rows.map(row => ({
      userId: String(row.user_id),
      wagers: asBigInt(row.wagers),
      payouts: asBigInt(row.payouts),
      net: asBigInt(row.net),
    }));
    return {
      players,
      wagers: players.reduce((total, player) => total + player.wagers, 0n),
      payouts: players.reduce((total, player) => total + player.payouts, 0n),
      net: players.reduce((total, player) => total + player.net, 0n),
    };
  };
}

function signedLia(value) {
  const amount = asBigInt(value);
  return `${amount > 0n ? '+' : ''}${amount.toLocaleString('ja-JP')} LIA`;
}

function formatRtp(wagers, payouts) {
  const denominator = asBigInt(wagers);
  if (denominator === 0n) return '算出不可（賭け金なし）';
  const scaled = (asBigInt(payouts) * 1_000_000n + denominator / 2n) / denominator;
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}%`;
}

function extrema(players, compare, predicate) {
  const eligible = players.filter(player => predicate(player.net));
  if (!eligible.length) return [];
  const target = eligible.reduce((best, player) => compare(player.net, best) ? player.net : best, eligible[0].net);
  return eligible.filter(player => player.net === target).sort((a, b) => a.userId.localeCompare(b.userId));
}

function formatPlayers(players) {
  if (!players.length) return '該当なし';
  const visible = players.slice(0, 10).map(player => `<@${player.userId}>（${signedLia(player.net)}）`);
  if (players.length > visible.length) visible.push(`ほか${players.length - visible.length}名`);
  return visible.join('、');
}

function formatJstMinute(date) {
  return new Date(date.getTime() + JST_MS).toISOString().slice(0, 16).replace('T', ' ');
}

export function formatCasinoStats(period, stats) {
  const highestProfit = extrema(stats.players, (value, best) => value > best, value => value > 0n);
  const largestLoss = extrema(stats.players, (value, best) => value < best, value => value < 0n);
  const lines = [
    '**カジノ統計**',
    `対象期間：${period.startDate}${period.endDate === period.startDate ? '' : ` ～ ${period.endDate}`}（JST）`,
  ];
  if (period.effectiveEnd < period.end) lines.push(`集計時点：${formatJstMinute(period.effectiveEnd)} JST（途中）`);
  lines.push(
    '',
    `最高利益：${formatPlayers(highestProfit)}`,
    `最大損失：${formatPlayers(largestLoss)}`,
    `サーバー全体損益（プレイヤー合計）：${signedLia(stats.net)}`,
    `還元率：${formatRtp(stats.wagers, stats.payouts)}`,
    '',
    `賭け金合計：${asBigInt(stats.wagers).toLocaleString('ja-JP')} LIA`,
    `配当合計：${asBigInt(stats.payouts).toLocaleString('ja-JP')} LIA`,
    '実残高の台帳に期間内に記録された賭け金・配当だけを集計しています。',
  );
  return lines.join('\n');
}

