import { MessageFlags } from 'discord.js';
import type { Interaction } from 'discord.js';
import { CPU_ID } from '../../constant/yubisuma/yubisuma.js';
import { activeGame, chooseOpponent, createGame, forfeit, GameError, participantGame, submitMove } from '../../service/yubisuma/yubisumaRules.js';
import { modePanel, opponentPanel, privateGamePanel, quitPanel, rulesPanel } from '../../panel/yubisuma/yubisumaPanelService.js';
import { balanceMessage } from '../../service/currency/balanceService.js';
import { errorCode } from '../../util/system/error.js';
import type { YubisumaDependencies } from '../../type/yubisuma/interaction.js';
import type { Game } from '../../type/yubisuma/yubisuma.js';

export async function handleYubisumaInteraction(interaction: Interaction, deps: YubisumaDependencies): Promise<void> {
  if (!(interaction.isButton() || interaction.isUserSelectMenu() || interaction.isStringSelectMenu()) || !interaction.customId.startsWith('ys:')) return;
  try {
    // Acknowledge before all DB, Discord member fetches, and message publishing.
    if (interaction.message?.flags.has(MessageFlags.Ephemeral)) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.guildId !== deps.scope.guildId || interaction.channelId !== deps.scope.channelId) throw new GameError('このパネルは指定の指スマスレッドで使用してください。');
    const userId = interaction.user.id;
    const [, action, gameId, roundValue] = interaction.customId.split(':');
    let changed: Game | undefined;
    switch (action) {
      case 'start':
        await interaction.editReply(modePanel());
        break;
      case 'rules':
        await interaction.editReply(rulesPanel());
        break;
      case 'balance':
        await interaction.editReply({ content: await balanceMessage(deps.database, userId, deps.balanceMode), components: [] });
        break;
      case 'pair':
        await interaction.editReply(opponentPanel());
        break;
      case 'cpu': {
        changed = await deps.store.transact(deps.scope, (room, now) => activeGame(room, userId) ?? createGame(room, userId, CPU_ID, now));
        const seat = changed.players[0] === userId ? 0 : 1;
        await interaction.editReply(privateGamePanel(changed, seat));
        break;
      }
      case 'opponent': {
        if (!interaction.isUserSelectMenu() || interaction.values.length !== 1) throw new GameError('対戦相手を1人選んでください。');
        const opponentId = interaction.values[0]!;
        const member = await interaction.guild?.members.fetch(opponentId).catch(() => null);
        if (!member || member.user.bot || opponentId === userId) throw new GameError('同じサーバーにいる、自分以外のプレイヤーを選んでください。');
        const game = await deps.store.transact(deps.scope, (room, now) => chooseOpponent(room, userId, opponentId, now));
        if (game) {
          changed = game;
          await interaction.editReply(privateGamePanel(game, game.players[0] === userId ? 0 : 1));
        } else await interaction.editReply({
          content: `<@${opponentId}> との対戦を希望しました（5分間有効）。\n相手も「プレイ開始 → 2人プレイ」であなたを選ぶと成立します。「対戦に戻る」で確認できます。`,
          components: modePanel().components.slice(1), allowedMentions: { parse: [] },
        });
        break;
      }
      case 'cancel-invite': {
        const cancelled = await deps.store.transact(deps.scope, room => {
          const exists = room.invitations.some(invite => invite.userId === userId);
          room.invitations = room.invitations.filter(invite => invite.userId !== userId);
          return exists;
        });
        await interaction.editReply({ content: cancelled ? '対戦希望を取り消しました。' : '待機中の対戦希望はありません。成立済みの対戦は「対戦に戻る」から確認してください。', components: [] });
        break;
      }
      case 'resume': {
        const found = await deps.store.transact(deps.scope, room => ({ game: activeGame(room, userId), invite: room.invitations.find(invite => invite.userId === userId) }));
        if (found.game) {
          changed = found.game;
          await interaction.editReply(privateGamePanel(found.game, found.game.players[0] === userId ? 0 : 1));
        } else await interaction.editReply({ content: found.invite ? '相手からの選択を待っています。成立するとスレッドに対戦画面が表示されます。' : '進行中の対戦はありません。「プレイ開始」から始めてください。', components: modePanel().components });
        break;
      }
      case 'open':
      case 'quit-check': {
        const found = await deps.store.transact(deps.scope, room => participantGame(room, gameId ?? '', userId));
        changed = found.game;
        await interaction.editReply(action === 'quit-check' && found.game.status === 'active' ? quitPanel(found.game.id) : privateGamePanel(found.game, found.seat));
        break;
      }
      case 'move': {
        if (!interaction.isStringSelectMenu() || interaction.values.length !== 1 || !/^\d+$/.test(roundValue ?? '')) throw new GameError('入力画面を開き直してください。');
        const value = interaction.values[0]!;
        if (!/^\d,([0-4]|-)$/.test(value)) throw new GameError('選択内容が正しくありません。');
        const [fingers, guess] = value.split(',');
        changed = await deps.store.transact(deps.scope, (room, now) => submitMove(room, gameId ?? '', userId, Number(roundValue), { fingers: Number(fingers), guess: guess === '-' ? null : Number(guess) }, now));
        await interaction.editReply(privateGamePanel(changed, changed.players[0] === userId ? 0 : 1));
        break;
      }
      case 'quit': {
        changed = await deps.store.transact(deps.scope, (room, now) => forfeit(room, gameId ?? '', userId, now));
        await interaction.editReply(privateGamePanel(changed, changed.players[0] === userId ? 0 : 1));
        break;
      }
      default:
        throw new GameError('この操作は利用できません。パネルから開き直してください。');
    }
    if (changed) {
      // The game has committed. A failed public message must not repeat the action.
      try { await deps.messages.sync(changed.id); }
      catch (error) { console.error('Game board sync failed', { gameId: changed.id, code: errorCode(error) }); }
    }
  } catch (error) {
    if (!(error instanceof GameError)) console.error('Yubisuma interaction failed', { interactionId: interaction.id, code: errorCode(error) });
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: error instanceof GameError ? error.message : '処理を確認できませんでした。「プレイ開始 → 対戦に戻る」で現在の状態を確認してください。', components: [], embeds: [] })
        .catch(replyError => console.error('Interaction reply failed', { code: errorCode(replyError) }));
    }
  }
}
