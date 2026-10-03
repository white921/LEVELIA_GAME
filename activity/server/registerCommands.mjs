import { HIGH_LOW_ADMIN_COMMAND, MANAGEMENT_ROLE_IDS } from './highLowAdmin.mjs';
import { CASINO_STATS_COMMAND } from './casinoStats.mjs';

const commandSpecs = [
  { command: HIGH_LOW_ADMIN_COMMAND, aliases: ['ハイロー補正'] },
  { command: CASINO_STATS_COMMAND, aliases: [] },
];

// Default is a local preview. --apply upserts only these commands, never bulk-overwrites Activity entry points.
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ commands: commandSpecs.map(spec => spec.command), allowedRoleIds: MANAGEMENT_ROLE_IDS }, null, 2));
  console.log('登録する場合: npm run commands:register -- --apply');
} else {
  const applicationId = process.env.DISCORD_CLIENT_ID?.trim();
  const guildId = process.env.GUILD_ID?.trim();
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!/^[1-9]\d{16,19}$/.test(applicationId) || !/^[1-9]\d{16,19}$/.test(guildId) || !token) {
    throw new Error('DISCORD_CLIENT_ID, GUILD_ID, DISCORD_BOT_TOKEN are required');
  }
  const url = `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`;
  const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
  const existing = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!existing.ok) throw new Error(`Command lookup failed (HTTP ${existing.status})`);
  const commands = await existing.json();
  for (const spec of commandSpecs) {
    const current = commands.find(command => command.type === 1 && command.name === spec.command.name)
      ?? commands.find(command => command.type === 1 && spec.aliases.includes(command.name));
    const result = await fetch(current ? `${url}/${current.id}` : url, {
      method: current ? 'PATCH' : 'POST', headers,
      body: JSON.stringify(spec.command), signal: AbortSignal.timeout(15_000),
    });
    if (!result.ok) throw new Error(`Command registration failed for /${spec.command.name} (HTTP ${result.status})`);
    const command = await result.json();
    console.log(`Registered /${command.name} (${command.id}) in guild ${guildId}`);
  }
}
