const CDN = 'https://cdn.discordapp.com';
const snowflake = value => typeof value === 'string' && /^[1-9]\d{16,19}$/.test(value);
const hash = value => typeof value === 'string' && /^(a_)?[a-f0-9]{32}$/.test(value);

export function defaultAvatar(userId, discriminator = '0') {
  const index = /^\d{4}$/.test(discriminator) && discriminator !== '0000'
    ? Number(discriminator) % 5 : Number((BigInt(userId) >> 22n) % 6n);
  return `${CDN}/embed/avatars/${index}.png`;
}

export function memberProfile(userId, guildId, member) {
  const user = member?.user;
  if (user?.id !== userId) return null;
  const avatarUrl = hash(member.avatar)
    ? `${CDN}/guilds/${guildId}/users/${userId}/avatars/${member.avatar}.webp?size=128`
    : hash(user.avatar) ? `${CDN}/avatars/${userId}/${user.avatar}.webp?size=128`
      : defaultAvatar(userId, user.discriminator);
  return { avatarUrl, displayName: member.nick?.trim() || user.global_name?.trim() || user.username };
}

// At most six visible players, reused by both boards and every viewer. No guild-wide scans.
export function createLeaderboardProfiles({ env, fetchImpl = fetch, now = Date.now }) {
  const guildId = env.GUILD_ID?.trim();
  const token = env.DISCORD_BOT_TOKEN?.trim();
  const cache = new Map();
  const pending = new Map();
  let retryAfter = 0;

  async function lookup(userId) {
    const saved = cache.get(userId);
    if (saved && now() < saved.expiresAt) return saved.profile;
    if (!token || !snowflake(guildId) || now() < retryAfter) return saved?.profile ?? null;
    if (pending.has(userId)) return pending.get(userId);
    const job = (async () => {
      let profile = saved?.profile ?? null;
      let ttl = 60_000;
      try {
        const response = await fetchImpl(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
          headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(4_000),
        });
        if (response.ok) {
          profile = memberProfile(userId, guildId, await response.json());
          ttl = 300_000;
        } else if (response.status === 429) {
          const seconds = Number(response.headers.get('retry-after')) || 60;
          retryAfter = now() + Math.min(300_000, Math.max(5_000, seconds * 1_000));
        }
      } catch { /* Ranking results remain available when Discord is temporarily unavailable. */ }
      cache.delete(userId);
      cache.set(userId, { profile, expiresAt: now() + ttl });
      while (cache.size > 64) cache.delete(cache.keys().next().value);
      return profile;
    })().finally(() => pending.delete(userId));
    pending.set(userId, job);
    return job;
  }

  return async function addProfiles(board) {
    const users = [...new Set(['streak', 'multiplier'].flatMap(metric =>
      (board[metric]?.entries ?? []).slice(0, 3).map(entry => entry.userId)))].filter(snowflake);
    const profiles = new Map(await Promise.all(users.map(async id => [id, await lookup(id)])));
    return { ...board, ...Object.fromEntries(['streak', 'multiplier'].filter(metric => board[metric]).map(metric =>
      [metric, { ...board[metric], entries: board[metric].entries.slice(0, 3).map(entry => {
        const profile = profiles.get(entry.userId);
        return { ...entry, displayName: profile?.displayName || entry.displayName,
          avatarUrl: profile?.avatarUrl ?? (snowflake(entry.userId) ? defaultAvatar(entry.userId) : null) };
      }) }])) };
  };
}
