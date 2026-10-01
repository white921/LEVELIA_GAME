import {
  connectDiscordActivity,
  DiscordActivityConnectionError,
  fetchBalance,
  isDiscordActivityContext,
} from './discordActivity.js';
import type { DiscordActivitySession, DiscordConnectionStage } from './discordActivity.js';

interface AccountElements {
  panel: HTMLElement;
  avatar: HTMLElement;
  avatarImage: HTMLImageElement;
  avatarFallback: HTMLElement;
  name: HTMLElement;
  status: HTMLElement;
  balance: HTMLElement;
  refresh: HTMLButtonElement;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function elements(): AccountElements {
  return {
    panel: requiredElement('account-panel'),
    avatar: requiredElement('account-avatar'),
    avatarImage: requiredElement('account-avatar-image'),
    avatarFallback: requiredElement('account-avatar-fallback'),
    name: requiredElement('account-name'),
    status: requiredElement('account-status'),
    balance: requiredElement('account-balance'),
    refresh: requiredElement('balance-refresh'),
  };
}

function formatWallet(wallet: string): string {
  try {
    return `${BigInt(wallet).toLocaleString('ja-JP')} LIA`;
  } catch {
    return '取得失敗';
  }
}

function renderUser(ui: AccountElements, session: DiscordActivitySession): void {
  ui.name.textContent = session.user.displayName;
  ui.status.textContent = `@${session.user.username} と連携済み`;
  ui.avatarFallback.textContent = session.user.displayName.slice(0, 1).toUpperCase();
  if (session.user.avatarUrl) {
    ui.avatarImage.src = session.user.avatarUrl;
    ui.avatarImage.alt = `${session.user.displayName}のアバター`;
    ui.avatar.classList.add('has-image');
  }
}

const stageMessages: Record<DiscordConnectionStage, string> = {
  config: '1/5 サーバー設定を確認中',
  ready: '2/5 Discordアプリへ接続中',
  authorize: '3/5 アカウントの利用許可を確認中',
  token: '4/5 認証コードを安全に交換中',
  authenticate: '5/5 Discordアカウントを確定中',
};

const stageNames: Record<DiscordConnectionStage, string> = {
  config: 'サーバー設定',
  ready: 'SDK接続',
  authorize: '利用許可',
  token: 'コード交換',
  authenticate: 'アカウント確定',
};

async function updateBalance(ui: AccountElements, session: DiscordActivitySession): Promise<void> {
  ui.refresh.disabled = true;
  ui.balance.textContent = '確認中…';
  try {
    const result = await fetchBalance(session.accessToken);
    ui.balance.textContent = result.accountFound && result.wallet !== null
      ? formatWallet(result.wallet)
      : '口座なし';
    ui.status.textContent = result.accountFound
      ? `@${session.user.username} と連携済み`
      : 'LEVELIAの口座が見つかりません';
  } catch (error) {
    console.error('Balance lookup failed', error);
    ui.balance.textContent = '取得失敗';
    ui.status.textContent = '残高を取得できませんでした';
  } finally {
    ui.refresh.disabled = false;
  }
}

export function initAccountPanel(): void {
  const ui = elements();
  const inDiscord = isDiscordActivityContext();
  document.documentElement.classList.toggle('is-discord-activity', inDiscord);

  if (!inDiscord) {
    ui.panel.classList.add('is-standalone');
    ui.name.textContent = 'ブラウザプレビュー';
    ui.status.textContent = 'Discord Activityから起動すると残高を表示します';
    ui.balance.textContent = '— LIA';
    ui.refresh.hidden = true;
    return;
  }

  let session: DiscordActivitySession | null = null;
  const connect = async (): Promise<void> => {
    ui.panel.classList.remove('is-connected', 'is-error');
    ui.refresh.disabled = true;
    ui.refresh.textContent = '更新';
    ui.name.textContent = 'Discordに接続中…';
    ui.status.textContent = 'アカウントを確認しています';
    ui.balance.textContent = '— LIA';
    try {
      session = await connectDiscordActivity(stage => {
        ui.status.textContent = stageMessages[stage];
      });
      ui.panel.classList.add('is-connected');
      renderUser(ui, session);
      await updateBalance(ui, session);
    } catch (error) {
      console.error('Discord Activity connection failed', error);
      ui.panel.classList.add('is-error');
      const connectionError = error instanceof DiscordActivityConnectionError ? error : null;
      const configurationPending = connectionError?.message === 'DISCORD_AUTH_NOT_CONFIGURED';
      ui.name.textContent = configurationPending
        ? '残高連携の設定待ち'
        : `Discord認証：${connectionError ? stageNames[connectionError.stage] : '不明'}で停止`;
      ui.status.textContent = configurationPending
        ? 'ゲームはそのまま遊べます'
        : '再試行しても続く場合は、この表示を管理者へ伝えてください';
      ui.balance.textContent = '— LIA';
      ui.refresh.textContent = '再試行';
      ui.refresh.disabled = false;
    }
  };

  ui.refresh.addEventListener('click', () => {
    if (session) void updateBalance(ui, session);
    else void connect();
  });
  void connect();
}
