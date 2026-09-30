import { createBalanceStore } from './balanceStore.mjs';
import { exchangeDiscordCode, fetchCurrentDiscordUser } from './discordClient.mjs';
import {
  ApiError,
  readBearerToken,
  readJson,
  sendJson,
  sendMethodNotAllowed,
} from './http.mjs';
import {
  readMysqlUrl,
  readPublicActivityConfig,
  requireDiscordOAuthConfig,
} from './runtimeConfig.mjs';

function normalizeApiPath(pathname) {
  return pathname.startsWith('/.proxy/') ? pathname.slice('/.proxy'.length) : pathname;
}

function validateAuthorizationCode(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2_048) {
    throw new ApiError(400, 'invalid_authorization_code', 'Discord authorization code is invalid');
  }
  return value;
}

export function createActivityApi({
  env = process.env,
  fetchImpl = fetch,
  balanceStore = createBalanceStore(readMysqlUrl(env)),
} = {}) {
  return {
    async handle(request, response, url) {
      const pathname = normalizeApiPath(url.pathname);
      if (!pathname.startsWith('/api/')) return false;

      try {
        if (pathname === '/api/config') {
          if (request.method !== 'GET') {
            sendMethodNotAllowed(response, ['GET']);
            return true;
          }
          sendJson(response, 200, readPublicActivityConfig(env));
          return true;
        }

        if (pathname === '/api/token') {
          if (request.method !== 'POST') {
            sendMethodNotAllowed(response, ['POST']);
            return true;
          }
          const { discordClientId, discordClientSecret } = requireDiscordOAuthConfig(env);
          const body = await readJson(request);
          const code = validateAuthorizationCode(body?.code);
          const accessToken = await exchangeDiscordCode({
            code,
            discordClientId,
            discordClientSecret,
            fetchImpl,
          });
          sendJson(response, 200, { access_token: accessToken });
          return true;
        }

        if (pathname === '/api/balance') {
          if (request.method !== 'GET') {
            sendMethodNotAllowed(response, ['GET']);
            return true;
          }
          const accessToken = readBearerToken(request);
          const user = await fetchCurrentDiscordUser(accessToken, fetchImpl);
          const wallet = await balanceStore.read(user.id);
          sendJson(response, 200, {
            accountFound: wallet !== null,
            wallet,
          });
          return true;
        }

        sendJson(response, 404, { error: 'not_found', message: 'Not Found' });
        return true;
      } catch (error) {
        if (error instanceof ApiError) {
          sendJson(response, error.statusCode, { error: error.code, message: error.message });
          return true;
        }
        console.error('Activity API request failed', error);
        sendJson(response, 500, { error: 'internal_error', message: 'Internal Server Error' });
        return true;
      }
    },
    async close() {
      await balanceStore.close();
    },
  };
}
