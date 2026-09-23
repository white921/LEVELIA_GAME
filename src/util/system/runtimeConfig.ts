import type { Config } from '../../type/system/runtimeConfig.js';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Required environment variable is missing: ${name}`);
    return value;
  };

  const discordToken = required('DISCORD_TOKEN');
  let mysqlUrl = env.MYSQL_URL?.trim();
  if (!mysqlUrl) {
    const host = required('MYSQLHOST');
    const port = required('MYSQLPORT');
    const user = required('MYSQLUSER');
    const password = required('MYSQLPASSWORD');
    const database = required('MYSQL_DATABASE');
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('MYSQLPORT must be a valid TCP port');
    mysqlUrl = `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(mysqlUrl);
  } catch {
    throw new Error('MYSQL_URL must be a valid mysql:// URL');
  }
  if (parsed.protocol !== 'mysql:' || !parsed.hostname || parsed.pathname.length <= 1) {
    throw new Error('MYSQL_URL must use mysql:// and include a host and database name');
  }

  const guildId = required('GUILD_ID');
  if (!/^[1-9]\d{16,19}$/.test(guildId)) {
    throw new Error('GUILD_ID must be a Discord server ID (17-20 digits)');
  }

  const balanceMode = env.BALANCE_MODE?.trim() || 'unavailable';
  if (balanceMode !== 'lia' && balanceMode !== 'unavailable') throw new Error('BALANCE_MODE must be lia or unavailable');
  return { discordToken, mysqlUrl, guildId, balanceMode };
}
