import { exchangeDiscordCode, fetchCurrentDiscordUser } from './discordClient.mjs';
import { createHighLowStore } from './highLowStore.mjs';
import { errorMetadata } from './safeLog.mjs';
import { createAccessPolicy } from './accessPolicy.mjs';
import { createDiscordInteractions } from './discordInteractions.mjs';
import { createLeaderboardProfiles } from './leaderboardProfiles.mjs';
import {
  ApiError,
  readBearerToken,
  readJson,
  sendJson,
  sendMethodNotAllowed,
} from './http.mjs';
import {
  readMysqlUrl,
  readWalletMode,
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

function validateRequestId(value) {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, 'invalid_request_id', 'requestId must be a UUID');
  }
  return value.toLowerCase();
}

function validateHandId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) {
    throw new ApiError(400, 'invalid_hand_id', 'Game id is invalid');
  }
  return value;
}

function validateExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ApiError(400, 'invalid_hand_version', 'Game version is invalid');
  }
  return value;
}

async function verifiedUser(request, fetchImpl) {
  const accessToken = readBearerToken(request);
  return fetchCurrentDiscordUser(accessToken, fetchImpl);
}

export function createActivityApi({
  env = process.env,
  fetchImpl = fetch,
  highLowStore = createHighLowStore(readMysqlUrl(env), { walletMode: readWalletMode(env) }),
} = {}) {
  const accessPolicy = createAccessPolicy(env);
  const walletMode = readWalletMode(env);
  const interactions = createDiscordInteractions({ env, store: highLowStore, fetchImpl });
  const addLeaderboardProfiles = createLeaderboardProfiles({ env, fetchImpl });
  return {
    async handle(request, response, url) {
      const pathname = normalizeApiPath(url.pathname);
      if (!pathname.startsWith('/api/')) return false;

      try {
        if (pathname === '/api/discord/interactions') {
          await interactions.handle(request, response);
          return true;
        }
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
          if (accessPolicy.mode === 'private') {
            const user = await fetchCurrentDiscordUser(accessToken, fetchImpl);
            accessPolicy.assertAllowed(user.id);
          }
          sendJson(response, 200, { access_token: accessToken });
          return true;
        }

        // Enforce access on every protected API, including existing tokens and
        // future routes. Never trust a user ID supplied by the browser.
        const user = await verifiedUser(request, fetchImpl);
        accessPolicy.assertAllowed(user.id);
        if (request.method === 'POST' && pathname.startsWith('/api/high-low/')
          && (request.headers['x-high-low-wallet-mode'] ?? 'real') !== walletMode) {
          throw new ApiError(409, 'wallet_mode_changed', '残高モードが切り替わりました。画面を再読み込みしてください');
        }

        if (pathname === '/api/balance') {
          if (request.method !== 'GET') {
            sendMethodNotAllowed(response, ['GET']);
            return true;
          }
          const wallet = await highLowStore.readWallet(user.id);
          sendJson(response, 200, {
            accountFound: wallet !== null,
            wallet,
            walletMode,
          });
          return true;
        }

        if (pathname === '/api/high-low/leaderboard') {
          if (request.method !== 'GET') {
            sendMethodNotAllowed(response, ['GET']);
            return true;
          }
          sendJson(response, 200, { ...await addLeaderboardProfiles(await highLowStore.readLeaderboard(user.id)), walletMode });
          return true;
        }

        if (pathname === '/api/high-low/stats') {
          if (request.method !== 'GET') {
            sendMethodNotAllowed(response, ['GET']);
            return true;
          }
          sendJson(response, 200, { bestStreak: await highLowStore.readBestStreak(user.id) });
          return true;
        }

        if (pathname === '/api/high-low/session') {
          if (request.method !== 'GET') {
            sendMethodNotAllowed(response, ['GET']);
            return true;
          }
          sendJson(response, 200, { ...await highLowStore.readSession(user.id), walletMode });
          return true;
        }

        if (pathname === '/api/high-low/start') {
          if (request.method !== 'POST') {
            sendMethodNotAllowed(response, ['POST']);
            return true;
          }
          const body = await readJson(request);
          const wager = body?.wager;
          if (!Number.isInteger(wager)) throw new ApiError(400, 'invalid_wager', 'Wager must be an integer');
          const result = await highLowStore.start({
            userId: user.id,
            wager,
            requestId: validateRequestId(body?.requestId),
          });
          sendJson(response, 201, result);
          return true;
        }

        const highLowAction = /^\/api\/high-low\/([^/]+)\/(guess|cashout|heartbeat)$/.exec(pathname);
        if (highLowAction) {
          if (request.method !== 'POST') {
            sendMethodNotAllowed(response, ['POST']);
            return true;
          }
          const handId = validateHandId(highLowAction[1]);
          const action = highLowAction[2];
          if (action === 'heartbeat') {
            sendJson(response, 200, await highLowStore.heartbeat({ userId: user.id, handId }));
            return true;
          }
          const body = await readJson(request);
          const common = {
            userId: user.id,
            handId,
            requestId: validateRequestId(body?.requestId),
            expectedVersion: validateExpectedVersion(body?.expectedVersion),
          };
          if (action === 'guess') {
            if (body?.guess !== 'higher' && body?.guess !== 'lower') {
              throw new ApiError(400, 'invalid_guess', 'Guess must be higher or lower');
            }
            sendJson(response, 200, await highLowStore.guess({ ...common, guess: body.guess }));
            return true;
          }
          sendJson(response, 200, await highLowStore.cashout(common));
          return true;
        }

        sendJson(response, 404, { error: 'not_found', message: 'Not Found' });
        return true;
      } catch (error) {
        if (error instanceof ApiError) {
          sendJson(response, error.statusCode, { error: error.code, message: error.message });
          return true;
        }
        console.error('Activity API request failed', errorMetadata(error));
        sendJson(response, 500, { error: 'internal_error', message: 'Internal Server Error' });
        return true;
      }
    },
    async close() {
      await interactions.close();
      await highLowStore.close();
    },
  };
}
