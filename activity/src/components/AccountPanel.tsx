import { useCallback, useEffect, useState } from 'react';
import {
  ActivityApiError,
  connectDiscordActivity,
  DiscordActivityConnectionError,
  fetchBalance,
  isDiscordActivityContext,
} from '../discord/discordActivity.js';
import type { DiscordActivitySession, DiscordConnectionStage } from '../discord/discordActivity.js';

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

function formatWallet(wallet: string): string {
  try {
    return `${BigInt(wallet).toLocaleString('ja-JP')} LIA`;
  } catch {
    return '取得失敗';
  }
}

interface AccountPanelProps {
  onSessionChange: (session: DiscordActivitySession | null) => void;
  balanceRefreshKey: number;
}

export function AccountPanel({ onSessionChange, balanceRefreshKey }: AccountPanelProps) {
  const inDiscord = isDiscordActivityContext();
  const [virtual, setVirtual] = useState(false);
  const [session, setSession] = useState<DiscordActivitySession | null>(null);
  const [name, setName] = useState(inDiscord ? 'Discordに接続中…' : 'ブラウザプレビュー');
  const [status, setStatus] = useState(inDiscord
    ? 'アカウントを確認しています'
    : 'Discord Activityから起動すると残高を表示します');
  const [balance, setBalance] = useState('— LIA');
  const [variant, setVariant] = useState<'standalone' | 'connecting' | 'connected' | 'error'>(
    inDiscord ? 'connecting' : 'standalone',
  );
  const [busy, setBusy] = useState(inDiscord);

  const updateBalance = useCallback(async (activeSession: DiscordActivitySession) => {
    setBusy(true);
    setBalance('確認中…');
    try {
      const result = await fetchBalance(activeSession.accessToken);
      setVirtual(result.walletMode === 'virtual');
      setBalance(result.accountFound && result.wallet !== null ? formatWallet(result.wallet) : '口座なし');
      setStatus(result.accountFound
        ? result.walletMode === 'virtual' ? '仮想残高テスト・実際のLIAは増減しません' : `@${activeSession.user.username} と連携済み`
        : 'LEVELIAの口座が見つかりません');
    } catch (error) {
      console.error('Balance lookup failed', { statusCode: error instanceof ActivityApiError ? error.statusCode : null });
      if (error instanceof ActivityApiError && error.statusCode === 401) {
        setSession(null);
        onSessionChange(null);
        setVariant('error');
        setName('Discord認証の有効期限切れ');
        setBalance('— LIA');
        setStatus('再試行するとDiscordへ再接続します');
      } else {
        setBalance('取得失敗');
        setStatus('残高を取得できませんでした');
      }
    } finally {
      setBusy(false);
    }
  }, [onSessionChange]);

  const connect = useCallback(async () => {
    setSession(null);
    setVariant('connecting');
    setBusy(true);
    setName('Discordに接続中…');
    setStatus('アカウントを確認しています');
    setBalance('— LIA');
    try {
      const activeSession = await connectDiscordActivity(stage => setStatus(stageMessages[stage]));
      setSession(activeSession);
      onSessionChange(activeSession);
      setVariant('connected');
      setName(activeSession.user.displayName);
      setStatus(`@${activeSession.user.username} と連携済み`);
      await updateBalance(activeSession);
    } catch (error) {
      console.error('Discord Activity connection failed', { stage: error instanceof DiscordActivityConnectionError ? error.stage : null });
      setVariant('error');
      onSessionChange(null);
      const connectionError = error instanceof DiscordActivityConnectionError ? error : null;
      const configurationPending = connectionError?.message === 'DISCORD_AUTH_NOT_CONFIGURED';
      const accessDenied = connectionError?.message === '現在は許可されたテスト参加者のみプレイできます';
      setName(configurationPending
        ? '残高連携の設定待ち'
        : accessDenied ? '現在はテスト中です'
          : `Discord認証：${connectionError ? stageNames[connectionError.stage] : '不明'}で停止`);
      setStatus(configurationPending
        ? '運営者の設定が完了するとプレイできます'
        : accessDenied ? '現在は許可されたテスト参加者のみプレイできます'
          : '再試行しても続く場合は、この表示を管理者へ伝えてください');
      setBalance('— LIA');
      setBusy(false);
    }
  }, [onSessionChange, updateBalance]);

  useEffect(() => {
    document.documentElement.classList.toggle('is-discord-activity', inDiscord);
    if (inDiscord) void connect();
    return () => document.documentElement.classList.remove('is-discord-activity');
  }, [connect, inDiscord]);

  useEffect(() => {
    if (balanceRefreshKey > 0 && session) void updateBalance(session);
  }, [balanceRefreshKey, session, updateBalance]);

  const avatarFallback = session?.user.displayName.slice(0, 1).toUpperCase() ?? 'L';
  const className = [
    'account-panel',
    virtual ? 'is-virtual' : '',
    variant === 'standalone' ? 'is-standalone' : '',
    variant === 'connected' ? 'is-connected' : '',
    variant === 'error' ? 'is-error' : '',
  ].filter(Boolean).join(' ');

  return (
    <section className={className} aria-label="Discordアカウントと残高">
      <div className="account-identity">
        <span className={`account-avatar${session?.user.avatarUrl ? ' has-image' : ''}`} aria-hidden="true">
          {session?.user.avatarUrl ? <img src={session.user.avatarUrl} alt="" /> : null}
          <span>{avatarFallback}</span>
        </span>
        <span className="account-copy">
          <strong>{name}</strong>
          <small>{status}</small>
        </span>
      </div>
      <div className="balance-display">
        <span>{virtual ? '仮想残高（テスト）' : '所持LIA'}</span>
        <strong aria-live="polite">{balance}</strong>
      </div>
      {inDiscord ? (
        <button
          className="balance-refresh"
          type="button"
          disabled={busy}
          onClick={() => session ? void updateBalance(session) : void connect()}
        >
          {variant === 'error' ? '再試行' : '更新'}
        </button>
      ) : null}
    </section>
  );
}
