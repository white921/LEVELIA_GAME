import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { AccountPanel } from './components/AccountPanel.js';
import { isDiscordActivityContext } from './discord/discordActivity.js';
import type { DiscordActivitySession } from './discord/discordActivity.js';
import { fetchHighLowStats } from './games/high-low/api.js';
import { navigateTo, routeFromHash } from './navigation.js';
import type { ActivityRoute } from './navigation.js';

const HighLowGame = lazy(async () => {
  const module = await import('./games/high-low/HighLowGame.js');
  return { default: module.HighLowGame };
});

function Header({ route, onOpenRules }: { route: ActivityRoute; onOpenRules: () => void }) {
  const playing = route === 'high-low';
  return (
    <header className="site-header">
      <a className="brand" href="#lobby" aria-label="LEVELIA GAMES ロビー">
        <img className="brand-mark" src="./images/levelia-game-icon.png" alt="" width="42" height="42" />
        <span className="brand-copy">
          <span className="brand-name">LEVELIA</span>
          <span className="brand-subtitle">ADVENTURERS' GUILD</span>
        </span>
      </a>
      <div className="header-actions">
        {playing ? <button className="quiet-button lobby-button" type="button" onClick={() => navigateTo('lobby')}>ロビー</button> : null}
        {playing ? <button className="quiet-button" type="button" aria-haspopup="dialog" onClick={onOpenRules}>遊び方</button> : null}
      </div>
    </header>
  );
}

function LobbyHeading() {
  return (
    <section className="view lobby-heading-view" aria-labelledby="lobby-title">
      <div className="lobby-hero">
        <div className="lobby-heading">
          <p className="eyebrow">LEVELIA ADVENTURERS' GUILD</p>
          <h1 className="lobby-title" id="lobby-title"><span>GUILD</span><strong>LEVELIA GAMES</strong></h1>
          <p>冒険の合間に、運と読みを試す遊戯場。</p>
        </div>
      </div>
    </section>
  );
}

function LobbyGameList({ best, reducedMotion }: { best: number | null; reducedMotion: boolean }) {
  return (
    <motion.section
      key="lobby"
      className="view lobby-view"
      aria-labelledby="lobby-title"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0.001 : 0.2 }}
    >
        <div className="lobby-section-heading">
          <div><p className="eyebrow">CHOOSE YOUR GAME</p><h2>ゲームを選ぶ</h2></div>
          <p>現在は一人用ゲームを公開中</p>
        </div>

        <div className="game-grid">
          <button className="game-tile game-tile-featured" type="button" onClick={() => navigateTo('high-low')}>
            <span className="game-tile-topline">
              <span className="game-status is-open">PLAYABLE</span>
              <span className="game-mode">SOLO · CARD</span>
            </span>
            <span className="game-tile-copy">
              <small>GUILD CARD QUEST</small>
              <strong>HIGH <i>/</i> LOW</strong>
              <span>次の一枚を見抜け。</span>
            </span>
            <span className="game-tile-footer">
              <span>最高連勝 <b>{best ?? '—'}</b></span>
              <span className="game-enter">遊ぶ <b aria-hidden="true">→</b></span>
            </span>
          </button>

          {[1, 2].map(slot => (
            <article key={slot} className="game-tile game-tile-locked" aria-label="近日公開のゲーム">
              <span className="game-tile-topline"><span className="game-status">COMING SOON</span></span>
              <span className="game-tile-copy"><strong>未公開</strong><span>詳細は後日公開</span></span>
            </article>
          ))}
        </div>
        <p className="lobby-note">新しい遊戯は、このギルドホールに追加されます。</p>
    </motion.section>
  );
}

function RulesDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  return (
    <dialog ref={dialogRef} className="rules-dialog" aria-labelledby="rules-title">
      <form method="dialog">
        <div className="dialog-heading">
          <div><p className="eyebrow">HOW TO PLAY</p><h2 id="rules-title">遊び方</h2></div>
          <button className="dialog-close" value="close" aria-label="遊び方を閉じる">×</button>
        </div>
        <ol>
          <li>100・1,000・10,000 LIAから賭け金を選びます。</li>
          <li>中央のカードを確認し、次が高ければHIGH、低ければLOWを選びます。</li>
          <li>正解後は現在倍率で精算するか、そのまま次を予想できます。</li>
          <li>同じ数字は引き分けで連勝を維持し、5連勝すると6倍で強制精算します。</li>
          <li>最高連勝の記録はゲームをまたいで続きます。精算や引き分けでは途切れず、負けたときだけ連勝が途切れます。</li>
          <li>カードは山札へ戻りません。残り札は表示しないため、自分で覚えてください。</li>
        </ol>
        <p>ジョーカーは使いません。Aが最大、2が最小です。切断後は5分間復帰でき、それを過ぎると1勝以上は自動精算、0勝は払い戻しなしで終了します。</p>
        <button className="dialog-action" value="close">ゲームに戻る</button>
      </form>
    </dialog>
  );
}

function LegalDocuments() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [document, setDocument] = useState<'terms' | 'privacy'>('terms');
  const title = document === 'terms' ? '利用規約' : 'プライバシーポリシー';

  function openDocument(next: 'terms' | 'privacy') {
    setDocument(next);
    dialogRef.current?.showModal();
  }

  return (
    <footer className="legal-footer">
      <button type="button" aria-haspopup="dialog" onClick={() => openDocument('terms')}>利用規約</button>
      <button type="button" aria-haspopup="dialog" onClick={() => openDocument('privacy')}>プライバシーポリシー</button>
      <dialog ref={dialogRef} className="legal-dialog" aria-labelledby="legal-title">
        <form method="dialog" className="legal-dialog-heading">
          <h2 id="legal-title">{title}</h2>
          <button type="submit" autoFocus aria-label="規約を閉じる">閉じる</button>
        </form>
        <iframe key={document} src={`./${document}.html`} title={title} sandbox="" />
      </dialog>
    </footer>
  );
}

export function App() {
  const reducedMotion = useReducedMotion() ?? false;
  const [route, setRoute] = useState<ActivityRoute>(() => routeFromHash(window.location.hash));
  const [bestRecord, setBestRecord] = useState<{ accessToken: string; value: number } | null>(null);
  const [activitySession, setActivitySession] = useState<DiscordActivitySession | null>(null);
  const accessToken = activitySession?.accessToken ?? null;
  const best = accessToken && bestRecord?.accessToken === accessToken ? bestRecord.value : null;
  const updateBest = useCallback((value: number) => {
    if (!accessToken) return;
    setBestRecord(previous => ({
      accessToken,
      value: previous?.accessToken === accessToken ? Math.max(previous.value, value) : value,
    }));
  }, [accessToken]);
  const [balanceRefreshKey, setBalanceRefreshKey] = useState(0);
  const rulesDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!accessToken) {
      setBestRecord(null);
      return;
    }
    let cancelled = false;
    void fetchHighLowStats(accessToken).then(stats => {
      if (!cancelled) updateBest(stats.bestStreak);
    }).catch(() => {
      if (!cancelled) console.error('High-low stats lookup failed');
    });
    return () => { cancelled = true; };
  }, [accessToken, route, updateBest]);

  useEffect(() => {
    const renderRoute = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener('hashchange', renderRoute);
    return () => window.removeEventListener('hashchange', renderRoute);
  }, []);

  useEffect(() => {
    document.title = route === 'high-low' ? 'High & Low | LEVELIA GAMES' : 'LEVELIA GAMES';
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [reducedMotion, route]);

  return (
    <>
      <div id="app-shell">
        <Header route={route} onOpenRules={() => rulesDialogRef.current?.showModal()} />
        {route === 'lobby' ? <LobbyHeading /> : null}
        <AccountPanel onSessionChange={setActivitySession} balanceRefreshKey={balanceRefreshKey} />
        <main>
          <AnimatePresence mode="wait" initial={false}>
            {route === 'lobby' ? <LobbyGameList best={best} reducedMotion={reducedMotion} /> : (
              <motion.section
                key="high-low"
                className="view game-view"
                initial={reducedMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: reducedMotion ? 0.001 : 0.22 }}
              >
                <Suspense fallback={<p className="activity-loading">ゲームを準備しています…</p>}>
                  <HighLowGame
                    best={best}
                    onBestChange={updateBest}
                    accessToken={activitySession?.accessToken ?? null}
                    inDiscord={isDiscordActivityContext()}
                    onWalletChanged={() => setBalanceRefreshKey(key => key + 1)}
                  />
                </Suspense>
              </motion.section>
            )}
          </AnimatePresence>
        </main>
        <LegalDocuments />
        <RulesDialog dialogRef={rulesDialogRef} />
      </div>
    </>
  );
}
