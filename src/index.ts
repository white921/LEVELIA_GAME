import { config as loadEnv } from 'dotenv';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { SHUTDOWN_TIMEOUT_MS } from './constant/system/runtime.js';
import { createDatabase } from './service/system/dbService.js';
import { errorCode } from './util/system/error.js';
import { loadConfig } from './util/system/runtimeConfig.js';
import { YUBISUMA_THREAD_ID } from './constant/shared/id.js';
import { YubisumaStore } from './service/yubisuma/yubisumaStore.js';
import { YubisumaMessageService } from './service/yubisuma/yubisumaMessageService.js';
import { handleYubisumaInteraction } from './handler/interaction/yubisumaHandler.js';
import { startYubisumaMaintenance } from './handler/system/yubisumaMaintenance.js';

loadEnv({ quiet: true });

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid configuration');
  process.exit(1);
}

const database = createDatabase(config.mysqlUrl);
const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { timeout: 10_000, retries: 1 } });
const scope = { guildId: config.guildId, channelId: YUBISUMA_THREAD_ID };
const store = new YubisumaStore(database);
const messages = new YubisumaMessageService(client, store, scope);
const dependencies = { store, messages, scope, database, balanceMode: config.balanceMode };
let stopMaintenance: (() => void) | undefined;
let stopping = false;

async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  stopMaintenance?.();
  process.exitCode = exitCode;
  const timeout = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
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
  stopMaintenance = startYubisumaMaintenance(dependencies);
});
client.on(Events.InteractionCreate, interaction => { void handleYubisumaInteraction(interaction, dependencies); });

try {
  await database.query('SELECT 1');
  await database.query('SELECT guild_id FROM levelia_game_rooms LIMIT 0');
  console.info('MySQL connection verified');
  if (!stopping) await client.login(config.discordToken);
} catch (error) {
  console.error('Startup failed', { code: errorCode(error) });
  await shutdown(1);
}
