import assert from 'node:assert/strict';
import test from 'node:test';
import { createHighLowStore } from '../server/highLowStore.mjs';

test('one unpayable hand cannot block later expiry batches, and is retried on the next pass', async t => {
  const pending = Array.from({ length: 51 }, (_, index) => String(index + 1));
  const visited = [];
  let rollbacks = 0;
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const pool = {
    async execute(sql, args = []) {
      assert.match(sql, /SELECT id/);
      const cursor = BigInt(args[0] ?? 0);
      return [pending.filter(id => BigInt(id) > cursor).slice(0, 50).map(id => ({ id }))];
    },
    async getConnection() {
      let handId;
      return {
        async beginTransaction() {}, async commit() {},
        async rollback() { rollbacks++; }, release() {},
        async execute(sql, args) {
          if (sql.includes('FROM levelia_game_high_low_hands')) {
            handId = args[0];
            visited.push(handId);
            return [[{ id: handId, user_id: '123456789012345678', status: 'active',
              streak: handId === '51' ? 0 : 1, potential_payout: 150,
              last_heartbeat_ms: 0, expires_ms: 0 }]];
          }
          if (sql.includes('FROM accounts')) return [[{ wallet: 2147483647, is_frozen: 0 }]];
          assert.match(sql, /UPDATE levelia_game_high_low_hands/);
          pending.splice(pending.indexOf(handId), 1);
          return [{ affectedRows: 1 }];
        },
      };
    },
    async end() {},
  };
  const store = createHighLowStore('mock-only', { poolFactory: () => pool, workerIntervalMs: 600_000 });
  try {
    await store.expireInactiveHands();
    assert.equal(visited.length, 50);
    assert.equal(rollbacks, 50);
    await store.expireInactiveHands();
    assert.equal(visited.at(-1), '51');
    assert.ok(!pending.includes('51'));
    await store.expireInactiveHands();
    assert.equal(visited.filter(id => id === '1').length, 2);
    assert.equal(logs.length, 100);
  } finally {
    await store.close();
  }
});

test('overlapping expiration calls share one batch and shutdown waits for it', async () => {
  let releaseQuery;
  let queries = 0;
  let ended = false;
  const pool = {
    execute() {
      queries++;
      return new Promise(resolve => { releaseQuery = resolve; });
    },
    async end() { ended = true; },
  };
  const store = createHighLowStore('mock-only', { poolFactory: () => pool, workerIntervalMs: 600_000 });
  const first = store.expireInactiveHands();
  const second = store.expireInactiveHands();
  assert.equal(first, second);
  assert.equal(queries, 1);
  const closing = store.close();
  assert.equal(ended, false);
  releaseQuery([[]]);
  assert.equal(await first, 0);
  await closing;
  assert.equal(ended, true);
});
