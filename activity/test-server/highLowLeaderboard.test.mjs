import assert from 'node:assert/strict';
import test from 'node:test';
import { createHighLowLeaderboard, leaderboardWeek } from '../server/highLowLeaderboard.mjs';

const tables = { commands: 'levelia_game_high_low_commands', hands: 'levelia_game_high_low_hands' };

test('weekly boundary is Monday 00:00 JST, including year rollover', () => {
  for (const [now, expected] of [
    ['2026-10-04T14:59:59.999Z', '2026-09-27T15:00:00.000Z'],
    ['2026-10-04T15:00:00.000Z', '2026-10-04T15:00:00.000Z'],
    ['2027-01-01T00:00:00.000Z', '2026-12-27T15:00:00.000Z'],
  ]) {
    const week = leaderboardWeek(Date.parse(now));
    assert.equal(new Date(week.start).toISOString(), expected);
    assert.equal(week.end - week.start, 7 * 86_400_000);
  }
});

test('concurrent viewers share one five-minute snapshot with individual rank and exact ties', async () => {
  let time = Date.parse('2026-10-03T03:00:00Z');
  let calls = 0;
  const rows = Array.from({ length: 12 }, (_, i) => ({ user_id: String(i + 100), user_name: `Player ${i}`, metric: 'streak', score: i < 2 ? 30 : 30 - i }));
  rows.push({ user_id: '100', user_name: 'Player 0', metric: 'multiplier', score: '123456' });
  const read = createHighLowLeaderboard({ tables, now: () => time, getPool: () => ({ async execute() { calls++; return [rows]; } }) });
  const [first, last, unknown] = await Promise.all([read('100'), read('111'), read('999')]);
  assert.equal(calls, 1);
  assert.equal(first.streak.entries.length, 3);
  assert.deepEqual(first.streak.entries.slice(0, 3).map(e => e.rank), [1, 1, 3]);
  assert.equal(last.streak.me.rank, 12);
  assert.equal(unknown.streak.me, null);
  assert.equal(first.multiplier.me.value, 12.3456);
  assert.equal(first.streak.participants, 12);
  time += 299_999;
  await read('100');
  assert.equal(calls, 1);
  time++;
  await read('100');
  assert.equal(calls, 2);
});

test('Monday invalidates last week even before the five-minute TTL', async () => {
  let time = Date.parse('2026-10-04T14:59:59Z');
  let calls = 0;
  const read = createHighLowLeaderboard({ tables, now: () => time, getPool: () => ({ async execute() { calls++; return [[]]; } }) });
  const before = await read('100');
  assert.equal(before.nextUpdateAt, '2026-10-04T15:00:00.000Z');
  time += 1000;
  const after = await read('100');
  assert.equal(calls, 2);
  assert.notEqual(after.weekStart, before.weekStart);
});

test('failed refresh can recover and never returns an empty success or stale previous-week data', async () => {
  let calls = 0;
  const read = createHighLowLeaderboard({ tables, getPool: () => ({ async execute() { if (++calls === 1) throw new Error('unavailable'); return [[]]; } }) });
  await assert.rejects(read('100'), /unavailable/);
  assert.equal((await read('100')).streak.participants, 0);
  assert.equal(calls, 2);
});

test('scheduled reset preserves the old board until Sunday, expires its cache, then returns to Monday weeks', async () => {
  const resetAt = '2026-10-04T00:00:00+09:00';
  let time = Date.parse(resetAt) - 1000;
  const queries = [];
  const read = createHighLowLeaderboard({ tables, resetAt, now: () => time,
    getPool: () => ({ async execute(_sql, values) { queries.push(values.map(d => d.toISOString())); return [[]]; } }) });
  const before = await read('100');
  assert.equal(before.weekStart, '2026-09-27T15:00:00.000Z');
  assert.equal(before.nextUpdateAt, '2026-10-03T15:00:00.000Z');
  assert.equal(queries[0][4], '1970-01-01T00:00:00.000Z');
  time += 1000;
  const after = await read('100');
  assert.equal(queries.length, 2);
  assert.equal(after.weekStart, '2026-10-03T15:00:00.000Z');
  assert.equal(after.weekEnd, '2026-10-04T15:00:00.000Z');
  assert.equal(after.resetAt, after.weekStart);
  assert.equal(queries[1][0], after.weekStart);
  assert.equal(queries[1][2], after.weekStart);
  assert.equal(queries[1][4], after.weekStart);
  time = Date.parse('2026-10-04T15:00:00Z');
  const monday = await read('100');
  assert.equal(monday.weekStart, '2026-10-04T15:00:00.000Z');
  assert.equal(monday.weekEnd, '2026-10-11T15:00:00.000Z');
  assert.equal(queries[2][4], after.weekStart, 'only the one-time reset excludes older hands, not every Monday');
});

test('reset configuration requires an explicit timezone and valid timestamp', () => {
  for (const resetAt of ['bad', '2026-10-04T00:00:00', '2026-10-04', '2026-99-99T00:00:00Z']) {
    assert.throws(() => createHighLowLeaderboard({ tables, getPool() {}, resetAt }), /ISO timestamp/);
  }
});
