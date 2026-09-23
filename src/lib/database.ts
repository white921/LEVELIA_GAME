import { createPool } from 'mysql2/promise';

export function createDatabase(mysqlUrl: string) {
  return createPool({
    uri: mysqlUrl,
    connectionLimit: 5,
    connectTimeout: 10_000,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}
