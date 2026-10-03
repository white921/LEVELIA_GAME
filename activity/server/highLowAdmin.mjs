import { targetPercentToPpm, estimatedRtpPercent, BASELINE_RTP_PERCENT } from './highLowCalibration.mjs';
import { PROGRESSIVE_RETURN_BPS } from './highLowPayout.mjs';

// Same three management roles as KARUMA's constant/shared/management.ts.
export const MANAGEMENT_ROLE_IDS = Object.freeze([
  '1534637252620062881', // 英傑
  '1534636370717573150', // 皇帝
  '1534879870532849846', // システム支配人
]);

export const HIGH_LOW_ADMIN_COMMAND = Object.freeze({
  name: 'ハイロー還元率', type: 1,
  description: '管理3ロール専用：ハイローの目標平均還元率を確認・変更します',
  // Role authorization is enforced on every signed interaction, including admins.
  // Discord integration settings can additionally hide the command from other roles.
  default_member_permissions: null,
  options: [
    { type: 1, name: '確認', description: '現在の目標平均還元率と補正係数を確認します' },
    { type: 1, name: '設定', description: '新しいゲームの目標平均還元率を設定します（行動モデルの推定値）', options: [
      { type: 10, name: '目標', description: '目標平均還元率（%）。98なら推定98%になる係数を計算します',
        required: true, min_value: 0.0001, max_value: 1000 },
    ] },
  ],
});

export function canManageHighLow(interaction, guildId) {
  return Boolean(guildId && interaction.guild_id === guildId
    && Array.isArray(interaction.member?.roles)
    && interaction.member.roles.some(role => MANAGEMENT_ROLE_IDS.includes(role)));
}

export function parseAdminAction(interaction) {
  const options = interaction.data?.options;
  if (interaction.type !== 2 || interaction.data?.name !== HIGH_LOW_ADMIN_COMMAND.name
    || interaction.data?.type !== 1 || !Array.isArray(options) || options.length !== 1) {
    throw new RangeError('未対応のコマンドです');
  }
  const sub = options[0];
  if (sub.type !== 1) throw new RangeError('サブコマンドが不正です');
  if (sub.name === '確認' && !sub.options?.length) return { kind: 'show' };
  if (sub.name === '設定' && sub.options?.length === 1 && sub.options[0].name === '目標' && sub.options[0].type === 10) {
    return { kind: 'set', targetRtpPpm: targetPercentToPpm(sub.options[0].value) };
  }
  throw new RangeError('目標平均還元率を指定してください');
}

export async function executeAdminAction(store, action, interaction) {
  const config = action.kind === 'show' ? await store.readPayoutConfig()
    : await store.setTargetRtp({ targetRtpPpm: action.targetRtpPpm,
      actorId: interaction.member.user.id, requestId: interaction.id });
  const prefix = action.kind === 'show' ? '現在の目標平均還元率' : '目標平均還元率を設定しました';
  const target = config.targetRtpPpm == null ? '未指定（基準配当を維持）' : `${config.targetRtpPpm / 10_000}%`;
  const curve = PROGRESSIVE_RETURN_BPS.slice(1).map(bps => `${Number((bps / 100 * config.correctionPpm / 1_000_000).toFixed(4))}%`).join(' → ');
  return `${prefix}：${target}\n`
    + `基準行動モデルでの推定：${estimatedRtpPercent(config.correctionPpm).toFixed(4)}%\n`
    + `補正係数：×${config.correctionPpm / 1_000_000}（基準推定${BASELINE_RTP_PERCENT.toFixed(4)}%から計算）\n`
    + `1〜5勝の還元係数：${curve}\n`
    + `設定バージョン：${config.version}\n新しいゲームから適用します。進行中のゲームは開始時の設定を維持します。\n`
    + '仮定した精算行動・賭け金構成に基づく推定です。配当変更による行動の変化や実際のプレイヤー構成により、実測還元率は目標からずれます。';
}
