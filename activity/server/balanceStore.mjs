import { createPool } from 'mysql2/promise';
import { ApiError } from './http.mjs';

export function createBalanceStore(mysqlUrl) {
  let pool = null;

  function getPool() {
    if (!mysqlUrl) {
      throw new ApiError(503, 'database_not_configured', 'Balance database is not configured');
    }
    pool ??= createPool({
      uri: mysqlUrl,
      connectionLimit: 4,
      connectTimeout: 10_000,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    return pool;
  }

  return {
    async read(userId) {
      const [rows] = await getPool().execute('SELECT wallet FROM accounts WHERE user_id = ? LIMIT 1', [userId]);
      const wallet = rows[0]?.wallet;
      return wallet === undefined ? null : String(wallet);
    },
    async close() {
      if (pool) await pool.end();
    },
  };
}
