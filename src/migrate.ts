import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './util/system/runtimeConfig.js';
import { createDatabase } from './service/system/dbService.js';
import { errorCode } from './util/system/error.js';

loadEnv({ quiet: true });
const database = createDatabase(loadConfig().mysqlUrl);
try {
  const sql = await readFile(new URL('../src/sql/createTable.sql', import.meta.url), 'utf8');
  await database.query(sql);
  console.info('levelia_game_rooms migration applied');
} catch (error) {
  console.error('Migration failed', { code: errorCode(error) });
  process.exitCode = 1;
} finally {
  await database.end();
}
