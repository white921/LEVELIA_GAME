import { ApiError } from './http.mjs';

export function createAccessPolicy(env = process.env) {
  // Missing configuration must never open the game to everyone.
  const mode = env.ACTIVITY_ACCESS_MODE?.trim() || 'private';
  if (mode !== 'private' && mode !== 'public') {
    throw new Error('ACTIVITY_ACCESS_MODE must be private or public');
  }
  const values = (env.ACTIVITY_ALLOWED_USER_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (values.some(value => !/^[1-9]\d{16,19}$/.test(value))) {
    throw new Error('ACTIVITY_ALLOWED_USER_IDS must contain Discord user IDs');
  }
  const allowed = new Set(values);
  return {
    mode,
    assertAllowed(userId) {
      if (mode !== 'public' && !allowed.has(userId)) {
        throw new ApiError(403, 'activity_access_denied', '現在は許可されたテスト参加者のみプレイできます');
      }
    },
  };
}
