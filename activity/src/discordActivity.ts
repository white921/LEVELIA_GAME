import { DiscordSDK } from '@discord/embedded-app-sdk';

export interface DiscordActivityUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface DiscordActivitySession {
  accessToken: string;
  user: DiscordActivityUser;
}

export interface BalanceResult {
  accountFound: boolean;
  wallet: string | null;
}

interface PublicActivityConfig {
  discordAuthEnabled: boolean;
  discordClientId: string | null;
}

function activityApiPath(path: string): string {
  return `/.proxy/api/${path.replace(/^\/+/, '')}`;
}

export function isDiscordActivityContext(search = window.location.search): boolean {
  const params = new URLSearchParams(search);
  return params.has('frame_id') && params.has('instance_id');
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { message?: unknown } | null;
  if (!response.ok) {
    const message = typeof body?.message === 'string' ? body.message : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export async function connectDiscordActivity(): Promise<DiscordActivitySession> {
  const configResponse = await fetch(activityApiPath('config'), { cache: 'no-store' });
  const config = await readJsonResponse<PublicActivityConfig>(configResponse);
  if (!config.discordAuthEnabled || !config.discordClientId) {
    throw new Error('DISCORD_AUTH_NOT_CONFIGURED');
  }

  const discordSdk = new DiscordSDK(config.discordClientId);
  await discordSdk.ready();
  const { code } = await discordSdk.commands.authorize({
    client_id: config.discordClientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });

  const tokenResponse = await fetch(activityApiPath('token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { access_token: accessToken } = await readJsonResponse<{ access_token: string }>(tokenResponse);
  const auth = await discordSdk.commands.authenticate({ access_token: accessToken });
  if (!auth) throw new Error('Discord authentication failed');

  const displayName = auth.user.global_name?.trim() || auth.user.username;
  const avatarUrl = auth.user.avatar
    ? `https://cdn.discordapp.com/avatars/${auth.user.id}/${auth.user.avatar}.webp?size=80`
    : null;
  return {
    accessToken,
    user: {
      id: auth.user.id,
      username: auth.user.username,
      displayName,
      avatarUrl,
    },
  };
}

export async function fetchBalance(accessToken: string): Promise<BalanceResult> {
  const response = await fetch(activityApiPath('balance'), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  return readJsonResponse<BalanceResult>(response);
}
