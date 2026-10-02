import { ApiError } from './http.mjs';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

async function readDiscordResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function exchangeDiscordCode({ code, discordClientId, discordClientSecret, fetchImpl = fetch }) {
  const response = await fetchImpl(`${DISCORD_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: discordClientId,
      client_secret: discordClientSecret,
      grant_type: 'authorization_code',
      code,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readDiscordResponse(response);
  if (!response.ok || typeof body?.access_token !== 'string') {
    console.warn('Discord token exchange rejected', {
      status: response.status,
    });
    throw new ApiError(502, 'discord_token_exchange_failed', 'Discord authorization failed');
  }
  console.info('Discord token exchange succeeded');
  return body.access_token;
}

export async function fetchCurrentDiscordUser(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readDiscordResponse(response);
  if (response.status === 401 || response.status === 403) {
    console.warn('Discord user verification rejected', {
      status: response.status,
    });
    throw new ApiError(401, 'discord_access_token_rejected', 'Discord access token was rejected');
  }
  if (!response.ok || typeof body?.id !== 'string' || !/^\d{17,20}$/.test(body.id)) {
    console.warn('Discord user verification failed', {
      status: response.status,
    });
    throw new ApiError(502, 'discord_user_lookup_failed', 'Could not verify the Discord user');
  }
  return { id: body.id };
}
