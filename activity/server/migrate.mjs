import { createConnection } from 'mysql2/promise';
import { createAccessPolicy } from './accessPolicy.mjs';
import { initializeVirtualWallets } from './highLowVirtual.mjs';
import { readMysqlUrl, readWalletMode } from './runtimeConfig.mjs';
import { migrateHighLow } from './highLowMigrations.mjs';

createAccessPolicy(process.env);
const walletMode = readWalletMode(process.env);
const mysqlUrl = readMysqlUrl(process.env);
if (!mysqlUrl) throw new Error('MySQL configuration is required');

const connection = await createConnection({ uri: mysqlUrl, multipleStatements: true });
try {
  await migrateHighLow(connection);
  if (walletMode === 'virtual') {
    await initializeVirtualWallets(connection, process.env.ACTIVITY_ALLOWED_USER_IDS.split(',').map(id => id.trim()).filter(Boolean));
  }
  console.log('High-low database migration completed');
} finally {
  await connection.end();
}
