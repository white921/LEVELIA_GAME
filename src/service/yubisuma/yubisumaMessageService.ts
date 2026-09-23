import type { Client } from 'discord.js';
import type { Scope } from '../../type/yubisuma/yubisuma.js';
import { gameBoard } from '../../panel/yubisuma/yubisumaPanelService.js';
import { YubisumaStore } from './yubisumaStore.js';

export class YubisumaMessageService {
  constructor(private readonly client: Client, private readonly store: YubisumaStore, private readonly scope: Scope) {}

  // The room lock serializes publishing with updates, including overlapping deploys.
  async sync(gameId: string): Promise<void> {
    await this.store.transact(this.scope, async room => {
      const game = room.games.find(item => item.id === gameId);
      if (!game) return;
      const payload = gameBoard(game);
      const version = JSON.stringify(payload);
      if (game.messageId && game.publishedVersion === version) return;
      const channel = await this.client.channels.fetch(this.scope.channelId);
      if (!channel?.isThread() || channel.guildId !== this.scope.guildId || !channel.isSendable()) throw new Error('Invalid game thread');
      if (game.messageId) {
        try {
          await channel.messages.edit(game.messageId, payload);
          game.publishedVersion = version;
          return;
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 10008)) throw error;
          game.messageId = null;
        }
      }
      const recent = await channel.messages.fetch({ limit: 100 });
      const recovered = recent.find(message => message.author.id === this.client.user?.id && (
        message.components.some(row => 'components' in row && row.components.some(component => 'customId' in component && component.customId === `ys:open:${game.id}`))
        || message.embeds.some(embed => embed.footer?.text === `ys-game:${game.id}`)
      ));
      if (recovered) {
        game.messageId = recovered.id;
        await recovered.edit(payload);
      } else {
        const message = await channel.send({ ...payload, nonce: game.id.replaceAll('-', '').slice(0, 24), enforceNonce: true });
        game.messageId = message.id;
      }
      game.publishedVersion = version;
    });
  }
}
