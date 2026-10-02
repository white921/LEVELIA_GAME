import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2/promise';
import { readMysqlUrl } from './runtimeConfig.mjs';

const mysqlUrl = readMysqlUrl(process.env);
if (!mysqlUrl) throw new Error('MySQL configuration is required');

const migrationPath = fileURLToPath(new URL('../sql/20261002_create_high_low.sql', import.meta.url));
const sql = await readFile(migrationPath, 'utf8');
const connection = await createConnection({ uri: mysqlUrl, multipleStatements: true });
try {
  await connection.query(sql);
  console.log('High-low database migration completed');
} finally {
  await connection.end();
}
