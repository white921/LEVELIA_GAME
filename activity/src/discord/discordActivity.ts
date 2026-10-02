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

export type DiscordConnectionStage = 'config' | 'ready' | 'authorize' | 'token' | 'authenticate';

export class DiscordActivityConnectionError extends Error {
  constructor(
    public readonly stage: DiscordConnectionStage,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Discord connection failed', { cause });
    this.name = 'DiscordActivityConnectionError';
  }
}

export class ActivityApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ActivityApiError';
  }
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
    throw new ActivityApiError(response.status, message);
  }
  return body as T;
}

export async function connectDiscordActivity(
  onStage: (stage: DiscordConnectionStage) => void = () => undefined,
): Promise<DiscordActivitySession> {
  let stage: DiscordConnectionStage = 'config';
  try {
    onStage(stage);
    const configResponse = await fetch(activityApiPath('config'), { cache: 'no-store' });
    const config = await readJsonResponse<PublicActivityConfig>(configResponse);
    if (!config.discordAuthEnabled || !config.discordClientId) {
      throw new Error('DISCORD_AUTH_NOT_CONFIGURED');
    }

    const { DiscordSDK } = await import('@discord/embedded-app-sdk');
    const discordSdk = new DiscordSDK(config.discordClientId);
    stage = 'ready';
    onStage(stage);
    await discordSdk.ready();

    stage = 'authorize';
    onStage(stage);
    const { code } = await discordSdk.commands.authorize({
      client_id: config.discordClientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });

    stage = 'token';
    onStage(stage);
    const tokenResponse = await fetch(activityApiPath('token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const { access_token: accessToken } = await readJsonResponse<{ access_token: string }>(tokenResponse);

    stage = 'authenticate';
    onStage(stage);
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
  } catch (error) {
    throw new DiscordActivityConnectionError(stage, error);
  }
}

export async function fetchBalance(accessToken: string): Promise<BalanceResult> {
  const response = await fetch(activityApiPath('balance'), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  return readJsonResponse<BalanceResult>(response);
}
