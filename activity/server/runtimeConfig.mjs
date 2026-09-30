import { ApiError } from './http.mjs';

function optional(env, name) {
  return env[name]?.trim() || null;
}

export function readPublicActivityConfig(env = process.env) {
  const discordClientId = optional(env, 'DISCORD_CLIENT_ID');
  const discordClientSecret = optional(env, 'DISCORD_CLIENT_SECRET');
  return {
    discordAuthEnabled: Boolean(discordClientId && discordClientSecret),
    discordClientId,
  };
}

export function requireDiscordOAuthConfig(env = process.env) {
  const { discordAuthEnabled, discordClientId } = readPublicActivityConfig(env);
  const discordClientSecret = optional(env, 'DISCORD_CLIENT_SECRET');
  if (!discordAuthEnabled || !discordClientId || !discordClientSecret) {
    throw new ApiError(503, 'discord_auth_not_configured', 'Discord authentication is not configured');
  }
  return { discordClientId, discordClientSecret };
}

export function readMysqlUrl(env = process.env) {
  const mysqlUrl = optional(env, 'MYSQL_URL');
  if (mysqlUrl) return mysqlUrl;

  const host = optional(env, 'MYSQLHOST');
  const port = optional(env, 'MYSQLPORT');
  const user = optional(env, 'MYSQLUSER');
  const password = optional(env, 'MYSQLPASSWORD');
  const database = optional(env, 'MYSQL_DATABASE');
  if (!host || !port || !user || !password || !database) return null;

  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}
