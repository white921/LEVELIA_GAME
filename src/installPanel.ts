import { once } from 'node:events';
import { config as loadEnv } from 'dotenv';
import { Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { YUBISUMA_THREAD_ID } from './constant/shared/id.js';
import { entryPanel } from './panel/yubisuma/yubisumaPanelService.js';
import { loadConfig } from './util/system/runtimeConfig.js';
import { errorCode } from './util/system/error.js';

loadEnv({ quiet: true });
const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { timeout: 10_000, retries: 1 } });
try {
  const ready = once(client, Events.ClientReady, { signal: AbortSignal.timeout(30_000) });
  await client.login(config.discordToken);
  await ready;
  const channel = await client.channels.fetch(YUBISUMA_THREAD_ID);
  if (!channel?.isThread() || channel.guildId !== config.guildId || !channel.isSendable()) throw new Error('Panel target does not match configured guild/thread');
  if (channel.locked) throw new Error('Panel target is locked');
  const me = await channel.guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) throw new Error('Missing thread permissions');
  if (!channel.joined) await channel.join();
  const recent = await channel.messages.fetch({ limit: 100 });
  const existing = recent.find(message => message.author.id === client.user?.id && message.components.some(row =>
    'components' in row && row.components.some(component => 'customId' in component && component.customId === 'ys:start')));
  const message = existing ? await existing.edit(entryPanel()) : await channel.send({ ...entryPanel(), nonce: YUBISUMA_THREAD_ID, enforceNonce: true });
  const verified = await channel.messages.fetch({ message: message.id, force: true });
  const controls = verified.components.flatMap(row => 'components' in row ? row.components.map(component => component.toJSON()) : [])
    .map(component => ({ id: 'custom_id' in component ? component.custom_id : null, label: 'label' in component ? component.label : null }));
  const expected = [{ id: 'ys:start', label: 'プレイ開始' }, { id: 'ys:rules', label: 'ルール説明' }, { id: 'ys:balance', label: '残高確認' }];
  if (verified.author.id !== client.user?.id || JSON.stringify(controls) !== JSON.stringify(expected) || verified.embeds[0]?.description !== entryPanel().embeds[0]?.data.description) throw new Error('Panel readback mismatch');
  console.info(JSON.stringify({ panelUrl: verified.url, messageId: verified.id, threadId: channel.id, botId: verified.author.id, verified: true }));
} catch (error) {
  console.error('Panel installation failed', { code: errorCode(error), name: error instanceof Error ? error.name : 'Error' });
  process.exitCode = 1;
} finally {
  await client.destroy();
}
