export const LEADERBOARD_REFRESH_MS = 5 * 60 * 1_000;
const DAY_MS = 86_400_000;
const JST_MS = 9 * 60 * 60 * 1_000;

export function leaderboardWeek(now) {
  const local = new Date(now + JST_MS);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - JST_MS;
  const start = midnight - ((local.getUTCDay() + 6) % 7) * DAY_MS;
  return { start, end: start + 7 * DAY_MS };
}

// One cached snapshot per store (and therefore per wallet mode), never per viewer.
// Concurrent requests share the same promise; errors are not cached as empty rankings.
export function createHighLowLeaderboard({ getPool, tables, now = Date.now, resetAt = process.env.HIGH_LOW_LEADERBOARD_RESET_AT }) {
  const resetTime = resetAt ? Date.parse(resetAt) : 0;
  if (resetAt && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(resetAt) || !Number.isFinite(resetTime) || resetTime <= 0)) {
    throw new Error('HIGH_LOW_LEADERBOARD_RESET_AT must be an ISO timestamp with a timezone');
  }
  let snapshot = null;
  let pending = null;

  async function buildSnapshot(at) {
    const week = leaderboardWeek(at);
    // Preserve existing rankings until the scheduled cutover. No historical rows are changed.
    const activeReset = resetTime <= at ? resetTime : 0;
    const start = Math.max(week.start, activeReset);
    const [rows] = await getPool().execute(
      `WITH weekly_events AS (
         SELECT user_id, hand_id, request_id, created_at,
           JSON_UNQUOTE(JSON_EXTRACT(response_json, '$.event.result')) AS result,
           COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(response_json, '$.hand.version')) AS UNSIGNED), 2147483647) AS version
         FROM ${tables.commands}
         WHERE action = 'guess' AND created_at >= ? AND created_at < ?
       ), grouped_events AS (
         SELECT user_id, result,
           SUM(result = 'loss') OVER (PARTITION BY user_id
             ORDER BY created_at, hand_id, version, request_id ROWS UNBOUNDED PRECEDING) AS loss_group
         FROM weekly_events WHERE result IN ('win', 'loss')
       ), winning_runs AS (
         SELECT user_id, SUM(result = 'win') AS score
         FROM grouped_events GROUP BY user_id, loss_group
       ), scores AS (
         SELECT user_id, 'streak' AS metric, MAX(score) AS score
         FROM winning_runs GROUP BY user_id HAVING MAX(score) > 0
         UNION ALL
         SELECT user_id, 'multiplier' AS metric,
           MAX(settlement_amount * (10000 DIV wager)) AS score
         FROM ${tables.hands}
         WHERE settled_at >= ? AND settled_at < ?
           AND created_at >= ?
           AND status IN ('cashed_out', 'auto_cashed_out') AND settlement_amount > 0
         GROUP BY user_id
       )
       SELECT CAST(s.user_id AS CHAR) AS user_id, a.user_name, s.metric, s.score
       FROM scores s JOIN accounts a ON a.user_id = s.user_id`,
      [new Date(start), new Date(at), new Date(start), new Date(at), new Date(activeReset)],
    );
    const boards = {};
    for (const metric of ['streak', 'multiplier']) {
      const sorted = rows.filter(row => row.metric === metric)
        .map(row => ({ userId: String(row.user_id), displayName: row.user_name || 'プレイヤー', score: Number(row.score) }))
        .sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));
      let rank = 0;
      const entries = sorted.map((entry, index) => {
        if (index === 0 || entry.score !== sorted[index - 1].score) rank = index + 1;
        return { userId: entry.userId, displayName: entry.displayName, rank,
          value: metric === 'multiplier' ? entry.score / 10000 : entry.score };
      });
      boards[metric] = { top: entries.slice(0, 3), byUser: new Map(entries.map(entry => [entry.userId, entry])), total: entries.length };
    }
    return {
      weekStart: new Date(start).toISOString(), weekEnd: new Date(week.end).toISOString(),
      resetAt: resetTime ? new Date(resetTime).toISOString() : null,
      updatedAt: new Date(at).toISOString(),
      nextUpdateAt: new Date(Math.min(at + LEADERBOARD_REFRESH_MS, week.end, resetTime > at ? resetTime : Infinity)).toISOString(),
      boards,
    };
  }

  return async function readLeaderboard(userId) {
    // Recheck after waiting: a slow query must not leak last week's snapshot across Monday.
    for (;;) {
      const at = now();
      if (snapshot && at < Date.parse(snapshot.nextUpdateAt)) {
        const { boards, ...metadata } = snapshot;
        return { ...metadata, ...Object.fromEntries(Object.entries(boards).map(([metric, board]) =>
          [metric, { entries: board.top, me: board.byUser.get(userId) ?? null, participants: board.total }])) };
      }
      if (!pending) {
        pending = buildSnapshot(at).then(value => { snapshot = value; }).finally(() => { pending = null; });
      }
      await pending;
    }
  };
}
