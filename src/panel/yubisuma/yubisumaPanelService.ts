import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder,
} from 'discord.js';
import { CPU_ID, RULES } from '../../constant/yubisuma/yubisuma.js';
import type { Game, Seat } from '../../type/yubisuma/yubisuma.js';

const button = (id: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const label = (userId: string) => userId === CPU_ID ? 'CPU' : `<@${userId}>`;
const noMentions = { parse: [] as ('users' | 'roles' | 'everyone')[] };

export function entryPanel() {
  return {
    embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle('指スマ').setDescription('CPUと1人プレイ、またはお互いを選んで2人プレイ。\n「プレイ開始」から遊べます。\n賭け金・報酬はありません。')],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('ys:start', 'プレイ開始', ButtonStyle.Primary), button('ys:rules', 'ルール説明'), button('ys:balance', '残高確認'),
    )],
    allowedMentions: noMentions,
  };
}

export function modePanel() {
  return { content: 'プレイ人数を選択してください。対戦中の場合は「対戦に戻る」で再開できます。', embeds: [], components: [
    new ActionRowBuilder<ButtonBuilder>().addComponents(button('ys:cpu', '1人プレイ', ButtonStyle.Primary), button('ys:pair', '2人プレイ', ButtonStyle.Primary)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(button('ys:resume', '対戦に戻る'), button('ys:cancel-invite', '対戦希望を取り消す')),
  ] };
}

export function opponentPanel() {
  return { content: '対戦相手を選んでください。相手も「プレイ開始 → 2人プレイ」であなたを選ぶと成立します。', embeds: [], components: [
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId('ys:opponent').setPlaceholder('対戦相手を1人選択').setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(button('ys:resume', '対戦に戻る'), button('ys:cancel-invite', '対戦希望を取り消す')),
  ] };
}

export function rulesPanel() {
  return { embeds: [new EmbedBuilder().setTitle('指スマのルール').setDescription(RULES).setColor(0x9b59b6)], components: [] };
}

function resultText(game: Game): string {
  const result = game.lastResult;
  if (!result) return '';
  return `\n\n前の結果（ラウンド${result.round}）\n${label(game.players[0])}: ${result.fingers[0]}本 ／ ${label(game.players[1])}: ${result.fingers[1]}本\n合計${result.fingers[0] + result.fingers[1]}本・宣言${result.guess}本 → ${result.hit ? '的中！ 手を1本抜きました。' : 'はずれ'}`;
}

export function gameBoard(game: Game) {
  let description = `${label(game.players[0])} 対 ${label(game.players[1])}\n残りの手：${game.hands[0]}本 ／ ${game.hands[1]}本`;
  if (game.status === 'active') {
    description += `\nラウンド${game.round} ／ 宣言役：${label(game.players[game.caller])}\n「入力・進行を確認」から自分の入力画面を開いてください。\n入力期限：<t:${Math.floor(game.expiresAt / 1000)}:R>`;
  } else if (game.status === 'expired') description += '\n入力期限を過ぎたため終了しました（勝敗なし）。';
  else description += `\n${label(game.players[game.winner!])}の勝ち！${game.status === 'forfeited' ? '（相手が降参）' : ''}`;
  description += resultText(game);
  return {
    embeds: [new EmbedBuilder().setTitle('指スマ対戦').setDescription(description).setColor(game.status === 'active' ? 0x9b59b6 : 0x2ecc71)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button(`ys:open:${game.id}`, game.status === 'active' ? '入力・進行を確認' : '対戦結果を確認', game.status === 'active' ? ButtonStyle.Primary : ButtonStyle.Secondary))],
    allowedMentions: noMentions,
  };
}

export function privateGamePanel(game: Game, seat: Seat) {
  const board = gameBoard(game);
  if (game.status !== 'active') return { ...board, components: [], content: 'この対戦は終了しました。「プレイ開始」から次の対戦ができます。' };
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`ys:open:${game.id}`, '対戦に戻る'), button(`ys:quit-check:${game.id}`, '降参する', ButtonStyle.Danger),
  );
  const move = game.moves[seat];
  if (move) return {
    ...board,
    content: `入力確定：上げる本数 ${move.fingers}本${move.guess !== null ? ` ／ 宣言 ${move.guess}本` : ''}\n相手の入力を待っています。「対戦に戻る」で更新できます。`,
    components: [controls],
  };
  const select = new StringSelectMenuBuilder().setCustomId(`ys:move:${game.id}:${game.round}`).setMinValues(1).setMaxValues(1).setPlaceholder('選択すると入力が確定します');
  for (let fingers = 0; fingers <= game.hands[seat]; fingers++) {
    if (game.caller === seat) {
      for (let guess = 0; guess <= game.hands[0] + game.hands[1]; guess++) {
        select.addOptions({ label: `上げる ${fingers}本 ／ 宣言 ${guess}本`, value: `${fingers},${guess}` });
      }
    } else select.addOptions({ label: `上げる ${fingers}本`, value: `${fingers},-` });
  }
  return {
    ...board,
    content: game.caller === seat ? 'あなたが宣言役です。上げる本数と、両者の合計本数の予想を選んでください。選択後は変更できません。' : '上げる親指の本数を選んでください。選択後は変更できません。',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), controls],
  };
}

export function quitPanel(gameId: string) {
  return { content: '降参すると相手の勝ちになります。終了しますか？', embeds: [], components: [
    new ActionRowBuilder<ButtonBuilder>().addComponents(button(`ys:quit:${gameId}`, '降参して終了', ButtonStyle.Danger), button(`ys:open:${gameId}`, '戻る')),
  ] };
}
