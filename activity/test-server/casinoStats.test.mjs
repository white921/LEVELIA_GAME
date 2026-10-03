import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CASINO_STATS_COMMAND,
  CasinoStatsInputError,
  createCasinoStatsReader,
  formatCasinoStats,
  parseCasinoStatsAction,
  parseCasinoStatsPeriod,
} from '../server/casinoStats.mjs';

test('casino statistics command requires a start date and has an optional end date', () => {
  assert.equal(CASINO_STATS_COMMAND.name, 'カジノ統計');
  assert.deepEqual(CASINO_STATS_COMMAND.options.map(option => [option.name, option.required]), [
    ['開始日', true],
    ['終了日', false],
  ]);
});

test('casino statistics dates cover complete JST days and include the end date', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const oneDay = parseCasinoStatsPeriod({ startDate: '2026-10-04' }, now);
  assert.equal(oneDay.start.toISOString(), '2026-10-03T15:00:00.000Z');
  assert.equal(oneDay.end.toISOString(), '2026-10-04T15:00:00.000Z');
  assert.equal(oneDay.effectiveEnd.toISOString(), oneDay.end.toISOString());

  const range = parseCasinoStatsPeriod({ startDate: '2026-10-01', endDate: '2026-10-04' }, now);
  assert.equal(range.start.toISOString(), '2026-09-30T15:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-10-04T15:00:00.000Z');
});

test('casino statistics rejects invalid, reversed, and future start dates', () => {
  const now = Date.parse('2026-10-04T03:00:00Z');
  for (const input of [
    { startDate: '2026/10/04' },
    { startDate: '2026-02-29' },
    { startDate: '1999-12-31' },
    { startDate: '2026-10-04', endDate: '2026-10-03' },
    { startDate: '2026-10-05' },
  ]) assert.throws(() => parseCasinoStatsPeriod(input, now), CasinoStatsInputError);
});

test('casino statistics action accepts options in either order but rejects malformed options', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const interaction = {
    type: 2,
    data: { name: 'カジノ統計', type: 1, options: [
      { type: 3, name: '終了日', value: '2026-10-04' },
      { type: 3, name: '開始日', value: '2026-10-01' },
    ] },
  };
  assert.equal(parseCasinoStatsAction(interaction, now).startDate, '2026-10-01');
  assert.throws(() => parseCasinoStatsAction({ ...interaction,
    data: { ...interaction.data, options: [{ type: 3, name: '終了日', value: '2026-10-04' }] } }, now), CasinoStatsInputError);
});

test('casino statistics reads only the real ledger and aggregates exact integer totals', async () => {
  const calls = [];
  const read = createCasinoStatsReader({ getPool: () => ({ async execute(sql, values) {
    calls.push({ sql, values });
    return [[
      { user_id: '100', wagers: '1000', payouts: '2500', net: '1500' },
      { user_id: '200', wagers: '10000', payouts: '0', net: '-10000' },
    ]];
  } }) });
  const start = new Date('2026-10-03T15:00:00Z');
  const end = new Date('2026-10-04T15:00:00Z');
  const stats = await read(start, end);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM levelia_game_high_low_ledger/);
  assert.doesNotMatch(calls[0].sql, /virtual/);
  assert.deepEqual(calls[0].values, [start, end]);
  assert.deepEqual({ wagers: stats.wagers, payouts: stats.payouts, net: stats.net },
    { wagers: 11000n, payouts: 2500n, net: -8500n });
});

test('casino statistics formats extrema, player total, RTP, and an in-progress cutoff', () => {
  const period = parseCasinoStatsPeriod({ startDate: '2026-10-04', endDate: '2026-10-05' }, Date.parse('2026-10-04T03:34:00Z'));
  const output = formatCasinoStats(period, {
    players: [
      { userId: '100', wagers: 1000n, payouts: 2500n, net: 1500n },
      { userId: '101', wagers: 1000n, payouts: 2500n, net: 1500n },
      { userId: '200', wagers: 10000n, payouts: 0n, net: -10000n },
    ],
    wagers: 12000n,
    payouts: 5000n,
    net: -7000n,
  });
  assert.match(output, /最高利益：<@100>（\+1,500 LIA）、<@101>（\+1,500 LIA）/);
  assert.match(output, /最大損失：<@200>（-10,000 LIA）/);
  assert.match(output, /サーバー全体損益（プレイヤー合計）：-7,000 LIA/);
  assert.match(output, /還元率：41\.6667%/);
  assert.match(output, /集計時点：2026-10-04 12:34 JST（途中）/);
});

test('casino statistics handles periods without wagers', () => {
  const period = parseCasinoStatsPeriod({ startDate: '2026-10-03' }, Date.parse('2026-10-05T00:00:00Z'));
  const output = formatCasinoStats(period, { players: [], wagers: 0n, payouts: 0n, net: 0n });
  assert.match(output, /最高利益：該当なし/);
  assert.match(output, /最大損失：該当なし/);
  assert.match(output, /還元率：算出不可（賭け金なし）/);
});
