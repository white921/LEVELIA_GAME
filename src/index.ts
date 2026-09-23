import { config as loadEnv } from 'dotenv';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { createDatabase } from './lib/database.js';

loadEnv({ quiet: true });

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid configuration');
  process.exit(1);
}

const database = createDatabase(config.mysqlUrl);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let stopping = false;

// Avoid logging raw SDK errors: request details can contain credentials.
function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    if (/^[A-Za-z0-9_]+$/.test(code)) return code;
  }
  return 'UNKNOWN_ERROR';
}

async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  try {
    await client.destroy();
    await database.end();
    console.info('LEVELIA_GAME stopped');
  } catch (error) {
    console.error('Shutdown failed', { code: errorCode(error) });
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
client.on(Events.Error, error => {
  console.error('Discord client error', { code: errorCode(error) });
});
client.once(Events.ClientReady, readyClient => {
  console.info('LEVELIA_GAME ready', { botId: readyClient.user.id });
});

try {
  await database.query('SELECT 1');
  console.info('MySQL connection verified');
  if (!stopping) await client.login(config.discordToken);
} catch (error) {
  console.error('Startup failed', { code: errorCode(error) });
  await shutdown(1);
}
