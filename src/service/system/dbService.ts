import { createPool } from 'mysql2/promise';
import {
  DEFAULT_MYSQL_CONNECTION_LIMIT,
  DEFAULT_MYSQL_CONNECT_TIMEOUT_MS,
} from '../../constant/system/database.js';

export function createDatabase(mysqlUrl: string) {
  return createPool({
    uri: mysqlUrl,
    connectionLimit: DEFAULT_MYSQL_CONNECTION_LIMIT,
    connectTimeout: DEFAULT_MYSQL_CONNECT_TIMEOUT_MS,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}
