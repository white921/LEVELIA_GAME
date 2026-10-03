import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { fetchHighLowLeaderboard } from './api.js';
import type { LeaderboardEntry, WeeklyLeaderboard as LeaderboardData } from './api.js';

type Metric = 'streak' | 'multiplier';
const FIVE_MINUTES = 300_000;
const dateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
const scoreFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 4 });

function Crown() {
  return <svg viewBox="0 0 32 24" aria-hidden="true"><path d="m3 6 7 5 6-9 6 9 7-5-3 15H6L3 6Z" fill="currentColor" /><path d="M7 23h18" stroke="currentColor" strokeWidth="2" /></svg>;
}

function Portrait({ entry }: { entry: LeaderboardEntry }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="weekly-portrait" aria-hidden="true">
    {entry.avatarUrl && entry.avatarUrl !== failedUrl
      ? <img src={entry.avatarUrl} alt="" width="80" height="80" decoding="async" onError={() => setFailedUrl(entry.avatarUrl!)} />
      : <span>{Array.from(entry.displayName)[0] ?? '?'}</span>}
  </span>;
}

function Paper({ metric, board, loading, reducedMotion }: {
  metric: Metric;
  board: LeaderboardData[Metric] | undefined;
  loading: boolean;
  reducedMotion: boolean;
}) {
  const title = metric === 'streak' ? '週間最高連勝' : '週間最高精算倍率';
  const delay = metric === 'streak' ? 0.06 : 0.18;
  const tilt = metric === 'streak' ? -2.5 : 2.5;
  return <motion.section className="weekly-paper" aria-labelledby={`weekly-${metric}-title`}
    initial={reducedMotion ? false : { opacity: 0, y: -16, rotate: tilt, scale: 1.025 }}
    animate={{ opacity: 1, y: 0, rotate: reducedMotion ? 0 : [tilt, -tilt * 0.2, 0], scale: 1 }}
    transition={{ duration: reducedMotion ? 0 : 0.46, delay: reducedMotion ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
    style={{ transformOrigin: '50% 5%' }}>
    <motion.span className="weekly-pin" aria-hidden="true"
      initial={reducedMotion ? false : { opacity: 0, scale: 1.5 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.15, delay: reducedMotion ? 0 : delay + 0.2 }} />
    <div className="weekly-paper-heading"><h3 id={`weekly-${metric}-title`}>{title}</h3><p><span />HIGH / LOW<span /></p></div>
    <ol className="weekly-records" aria-label={title}>
      {Array.from({ length: 3 }, (_, index) => {
        const entry = board?.entries[index];
        const value = entry ? scoreFormat.format(entry.value) : '—';
        return <li key={entry?.userId ?? `empty-${index}`} className={`weekly-record weekly-medal-${entry?.rank ?? index + 1}${entry ? '' : ' is-empty'}`}>
          <span className="weekly-rank">{entry?.rank === 1 ? <Crown /> : null}<span>{entry?.rank ?? index + 1}</span><span className="sr-only">位</span></span>
          {entry ? <Portrait entry={entry} /> : <span className="weekly-portrait weekly-portrait-empty" aria-hidden="true">◇</span>}
          <span className="weekly-player-name" title={entry?.displayName}>{entry?.displayName ?? (loading ? '読み込み中…' : '挑戦者募集中')}</span>
          <span className="weekly-score" data-long={value.length > 8} title={entry ? `${value}${metric === 'streak' ? '連勝' : '倍'}` : undefined}>
            <strong>{value}</strong>{entry ? <small>{metric === 'streak' ? '連勝' : '倍'}</small> : null}
          </span>
        </li>;
      })}
    </ol>
  </motion.section>;
}

export function WeeklyLeaderboard({ open, onClose, accessToken }: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const [record, setRecord] = useState<{ token: string; data: LeaderboardData } | null>(null);
  const recordRef = useRef(record);
  recordRef.current = record;
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const resetTime = record?.data.resetAt ? Date.parse(record.data.resetAt) : 0;
  const beforeReset = resetTime > 0 && Date.now() >= resetTime && Date.parse(record!.data.updatedAt) < resetTime;
  const data = accessToken && record?.token === accessToken && Date.parse(record.data.weekEnd) > Date.now() && !beforeReset ? record.data : null;

  useEffect(() => {
    if (open && !dialogRef.current?.open) dialogRef.current?.showModal();
    if (!open && dialogRef.current?.open) dialogRef.current.close();
  }, [open]);

  useEffect(() => {
    if (!open || !accessToken) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let busy = false;
    let dueAt = 0;
    const cached = recordRef.current;
    if (cached?.token === accessToken) dueAt = Date.parse(cached.data.nextUpdateAt);
    setError(false);

    function schedule() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), Math.max(1000, dueAt - Date.now()));
    }
    async function refresh() {
      if (controller.signal.aborted || busy) return;
      if (document.visibilityState === 'hidden') return;
      if (Date.now() < dueAt) { schedule(); return; }
      busy = true;
      try {
        const result = await fetchHighLowLeaderboard(accessToken!, controller.signal);
        if (controller.signal.aborted) return;
        setRecord({ token: accessToken!, data: result });
        setError(false);
        // Follow the shared server snapshot's expiry, avoiding two stacked five-minute caches.
        dueAt = Math.max(Date.now() + 1000, Math.min(Date.parse(result.nextUpdateAt), Date.now() + FIVE_MINUTES));
      } catch {
        if (controller.signal.aborted) return;
        setError(true);
        dueAt = Date.now() + FIVE_MINUTES;
      } finally {
        busy = false;
        if (!controller.signal.aborted) schedule();
      }
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [accessToken, open, retry]);

  return (
    <dialog ref={dialogRef} className="weekly-dialog" aria-labelledby="weekly-title" onClose={onClose}>
      <motion.div className="weekly-screen" initial={false} animate={{ opacity: open ? 1 : 0 }} transition={{ duration: reducedMotion ? 0 : 0.18 }}>
        <header className="weekly-masthead">
          <div className="brand"><img className="brand-mark" src="./images/levelia-game-icon.png" alt="" width="42" height="42" /><span className="brand-copy"><span className="brand-name">LEVELIA</span><span className="brand-subtitle">ADVENTURERS' GUILD</span></span></div>
          <button className="weekly-close" type="button" aria-label="ランキングを閉じてゲームに戻る" onClick={onClose} autoFocus>×</button>
        </header>
        <div className="weekly-heading">
          <h2 id="weekly-title"><span>HIGH</span><i>&amp;</i><span className="weekly-low">LOW</span><span className="weekly-title-jp">ランキング</span></h2>
          <p className="weekly-period">{data ? `${dateFormat.format(new Date(data.weekStart))} — ${dateFormat.format(new Date(Date.parse(data.weekEnd) - 1))}` : '今週のランキング'}</p>
        </div>
        {data?.walletMode === 'virtual' ? <p className="weekly-test-label">仮想残高テストのランキング</p> : null}
        {!accessToken ? <p className="weekly-message">Discordで接続するとランキングを表示します。</p> : null}
        {error ? <p className="weekly-error" role="status">{data ? '更新できませんでした。前回の記録を表示しています。' : 'ランキングを取得できませんでした。'}<button type="button" onClick={() => setRetry(value => value + 1)}>再試行</button></p> : null}
        <div className="weekly-papers" aria-busy={Boolean(accessToken && !data && !error)}>
          {open ? <>
            <Paper metric="streak" board={data?.streak} loading={Boolean(accessToken && !data && !error)} reducedMotion={reducedMotion} />
            <Paper metric="multiplier" board={data?.multiplier} loading={Boolean(accessToken && !data && !error)} reducedMotion={reducedMotion} />
          </> : null}
        </div>
        <footer className="weekly-footer">
          <p>{data ? `${timeFormat.format(new Date(data.updatedAt))} 時点 · ` : ''}5分ごとに記録更新</p>
          <details><summary>集計について</summary><p>毎週月曜0:00に切り替え（日本時間）。表示期間内の正解を数え、精算・引き分けでは連勝が途切れず、不正解でリセットされます。倍率は期間内に精算した受取額÷賭け金。自動精算も対象です。ランキングの集計開始をリセットした場合、それ以前に開始したゲームの倍率は対象外です。同じ記録は同順位で、各部門3人まで表示します。</p></details>
        </footer>
      </motion.div>
    </dialog>
  );
}
