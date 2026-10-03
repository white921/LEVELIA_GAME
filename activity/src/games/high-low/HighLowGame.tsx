import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import {
  cashoutHighLow,
  fetchHighLowSession,
  guessHighLow,
  heartbeatHighLow,
  HighLowApiError,
  isUncertainHighLowError,
  startHighLow,
} from './api.js';
import type {
  HighLowGuessEvent,
  HighLowGuessResult,
  HighLowHand,
  HighLowSettlement,
} from './api.js';
import {
  canGuess,
} from './game.js';
import type { Guess, PlayingCard as Card } from './game.js';
import { PlayingCard } from './PlayingCard.js';

type CardEffect = 'idle' | 'awakening' | 'erasing' | 'restoring';
type FatePhase = 'idle' | 'active' | 'rewriting' | 'revealed' | 'resolved';
type ViewPhase = 'loading' | 'setup' | 'playing' | 'recovery';

interface Banner {
  kicker: string;
  message: string;
  tone: 'default' | 'positive' | 'negative' | 'neutral' | 'fate' | 'fate-complete';
  hidden?: boolean;
}

interface FinishSummary {
  title: string;
  message: string;
  tone: 'positive' | 'negative' | 'neutral';
}

interface HighLowGameProps {
  best: number | null;
  onBestChange: (best: number) => void;
  accessToken: string | null;
  inDiscord: boolean;
  onWalletChanged: () => void;
  onOpenRanking?: () => void;
}

const WAGERS = [100, 1_000, 10_000] as const;
const guessRevealTiming = { beforeDeal: 100, cardTravel: 440, suspense: 650, cardFlip: 520 } as const;
const fateShiftTiming = { falseResult: 850, awakening: 1_300, erase: 520, restore: 900, resolution: 700 } as const;

function wait(duration: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, duration));
}

function describeResult(result: HighLowGuessEvent['result'], guess: Guess): Banner {
  if (result === 'tie') return { kicker: 'DRAW', message: '同じ数字', tone: 'neutral' };
  if (result === 'win') return {
    kicker: 'CORRECT', message: guess === 'higher' ? 'HIGH 正解' : 'LOW 正解', tone: 'positive',
  };
  return { kicker: 'MISS', message: guess === 'higher' ? 'HIGH 不正解' : 'LOW 不正解', tone: 'negative' };
}

function promptFor(card: Card): string {
  if (card.value === 14 || card.value === 2) return '次のカードへ自動で進みます';
  return '次のカードを予想してください';
}

function formatLia(value: number | string): string {
  try {
    return `${BigInt(value).toLocaleString('ja-JP')} LIA`;
  } catch {
    return `${value} LIA`;
  }
}

export function HighLowGame({ best, onBestChange, accessToken, inDiscord, onWalletChanged, onOpenRanking }: HighLowGameProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const [phase, setPhase] = useState<ViewPhase>('loading');
  const [hand, setHand] = useState<HighLowHand | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [current, setCurrent] = useState<Card | null>(null);
  const [cardVersion, setCardVersion] = useState(0);
  const [faceUp, setFaceUp] = useState(false);
  const [cardEffect, setCardEffect] = useState<CardEffect>('idle');
  const [fatePhase, setFatePhase] = useState<FatePhase>('idle');
  const [fatePosition, setFatePosition] = useState({ x: '50vw', y: '50vh' });
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('ゲームを準備しています…');
  const [banner, setBanner] = useState<Banner>({ kicker: 'CURRENT CARD', message: '最初のカード', tone: 'default' });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<FinishSummary | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const handRef = useRef<HighLowHand | null>(null);

  const pause = useCallback((duration: number) => wait(reducedMotion ? 1 : duration), [reducedMotion]);
  const isCurrentGeneration = (generation: number) => generation === generationRef.current;

  const updateHand = useCallback((next: HighLowHand | null) => {
    handRef.current = next;
    setHand(next);
    if (next) setCurrent(next.currentCard);
  }, []);

  const resetFateEffects = useCallback(() => {
    document.body.classList.remove('is-fate-shifting');
    setFatePhase('idle');
    setCardEffect('idle');
  }, []);

  const showError = useCallback((error: unknown) => {
    console.error('High-low request failed', { statusCode: error instanceof HighLowApiError ? error.statusCode : null });
    const message = error instanceof HighLowApiError
      ? error.message
      : '通信に失敗しました。少し待ってからもう一度お試しください。';
    setErrorMessage(message);
  }, []);

  const loadSession = useCallback(async () => {
    const generation = ++generationRef.current;
    // Loading owns the operation lock after invalidating any old animation.
    busyRef.current = true;
    setBusy(true);
    updateHand(null);
    resetFateEffects();
    setSummary(null);
    if (!accessToken) {
      setWallet(null);
      setPhase('setup');
      busyRef.current = false;
      setBusy(false);
      return;
    }
    setPhase('loading');
    setErrorMessage(null);
    try {
      const session = await fetchHighLowSession(accessToken);
      if (!isCurrentGeneration(generation)) return;
      onBestChange(session.bestStreak);
      setWallet(session.wallet);
      onWalletChanged();
      if (!session.accountFound) {
        updateHand(null);
        setErrorMessage('LEVELIAの口座が見つかりません。');
        setPhase('setup');
        return;
      }
      if (session.hand) {
        updateHand(session.hand);
        setFaceUp(true);
        setPrompt(promptFor(session.hand.currentCard));
        setBanner({ kicker: 'GAME RESUMED', message: '進行中のゲームを再開', tone: 'default' });
        setPhase('playing');
      } else {
        updateHand(null);
        setPhase('setup');
      }
    } catch (error) {
      if (!isCurrentGeneration(generation)) return;
      showError(error);
      // Do not offer a fresh wager while the previous command is unconfirmed.
      setPhase('recovery');
    } finally {
      if (isCurrentGeneration(generation)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [accessToken, onBestChange, onWalletChanged, resetFateEffects, showError, updateHand]);

  useEffect(() => {
    void loadSession();
    return () => {
      generationRef.current += 1;
      document.body.classList.remove('is-fate-shifting');
    };
  }, [loadSession]);

  useEffect(() => {
    if (!accessToken || !hand) return undefined;
    const interval = window.setInterval(() => {
      const generation = generationRef.current;
      void heartbeatHighLow(accessToken, hand.id).catch(error => {
        // A settled hand may return 409 while its result is still being shown.
        // Only reconcile an idle, current hand; never cancel its reveal.
        if (isCurrentGeneration(generation) && handRef.current?.id === hand.id && !busyRef.current
          && error instanceof HighLowApiError && error.statusCode === 409) void loadSession();
      });
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [accessToken, hand, loadSession]);

  const startWageredGame = useCallback(async (wager: number) => {
    if (!accessToken || busyRef.current) return;
    const generation = ++generationRef.current;
    setBusy(true);
    busyRef.current = true;
    setErrorMessage(null);
    setSummary(null);
    try {
      const result = await startHighLow(accessToken, wager);
      if (!isCurrentGeneration(generation)) return;
      setWallet(result.wallet);
      onWalletChanged();
      updateHand(result.hand);
      setCurrent(result.hand.currentCard);
      setCardVersion(version => version + 1);
      setFaceUp(false);
      setBanner({ kicker: 'BET ACCEPTED', message: `${formatLia(wager)}で開始`, tone: 'default' });
      setPrompt('カードを配っています…');
      setPhase('playing');
      await pause(410);
      if (!isCurrentGeneration(generation)) return;
      setFaceUp(true);
      await pause(540);
      if (!isCurrentGeneration(generation)) return;
      setPrompt(promptFor(result.hand.currentCard));
    } catch (error) {
      if (!isCurrentGeneration(generation)) return;
      if (isUncertainHighLowError(error)
        || error instanceof HighLowApiError && error.code === 'active_hand_exists') {
        await loadSession();
      } else {
        showError(error);
      }
    } finally {
      if (isCurrentGeneration(generation)) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }, [accessToken, loadSession, onWalletChanged, pause, showError, updateHand]);

  const finishGame = useCallback((settlement: HighLowSettlement | null) => {
    if (!settlement) return;
    if (settlement.wallet !== null) {
      setWallet(settlement.wallet);
      onWalletChanged();
    }
    if (settlement.reason === 'loss') {
      setSummary({ title: 'ゲーム終了', message: '賭け金は払い戻されません。', tone: 'negative' });
    } else if (settlement.reason === 'max_streak') {
      setSummary({
        title: '5連勝達成',
        message: `${formatLia(settlement.payout)}を自動精算しました。`,
        tone: 'positive',
      });
    } else {
      setSummary({ title: '精算完了', message: `${formatLia(settlement.payout)}を受け取りました。`, tone: 'positive' });
    }
    updateHand(null);
    setPhase('setup');
  }, [onWalletChanged, updateHand]);

  const presentGuess = useCallback(async (result: HighLowGuessResult, generation: number) => {
    const { event } = result;
    await pause(guessRevealTiming.beforeDeal);
    if (!isCurrentGeneration(generation)) return;
    setCurrent(event.revealedCard);
    setCardVersion(version => version + 1);
    setFaceUp(false);
    await pause(guessRevealTiming.cardTravel);
    if (!isCurrentGeneration(generation)) return;
    setPrompt('カードをめくります…');
    await pause(guessRevealTiming.suspense);
    if (!isCurrentGeneration(generation)) return;
    setFaceUp(true);
    await pause(guessRevealTiming.cardFlip);
    if (!isCurrentGeneration(generation)) return;

    if (event.fateShifted) {
      setBanner(describeResult('loss', event.guess));
      setPrompt('……');
      await pause(fateShiftTiming.falseResult);
      if (!isCurrentGeneration(generation)) return;
      const stageRect = stageRef.current?.getBoundingClientRect();
      if (stageRect) setFatePosition({
        x: `${stageRect.left + stageRect.width / 2}px`,
        y: `${stageRect.top + stageRect.height / 2}px`,
      });
      document.body.classList.add('is-fate-shifting');
      setFatePhase('active');
      setCardEffect('awakening');
      setBanner({ kicker: 'FATE INTERVENES', message: '運命が揺らいでいる', tone: 'fate' });
      await pause(fateShiftTiming.awakening);
      if (!isCurrentGeneration(generation)) return;
      setFatePhase('rewriting');
      setCardEffect('erasing');
      await pause(fateShiftTiming.erase);
      if (!isCurrentGeneration(generation)) return;
      setCurrent(event.finalCard);
      setCardEffect('restoring');
      setFatePhase('revealed');
      await pause(fateShiftTiming.restore);
      if (!isCurrentGeneration(generation)) return;
      setFatePhase('resolved');
      setBanner({ kicker: 'FATE REWRITTEN', message: '運命が書き換わった', tone: 'fate' });
      await pause(fateShiftTiming.resolution);
      if (!isCurrentGeneration(generation)) return;
      resetFateEffects();
    }

    const presentation = describeResult(event.result, event.guess);
    setBanner(event.fateShifted
      ? { kicker: 'FATE REWRITTEN', message: `運命改変・${presentation.message}`, tone: 'fate-complete' }
      : presentation);

    for (const autoCard of event.autoDrawnCards) {
      setPrompt('A・2のため次のカードへ進みます…');
      await pause(500);
      if (!isCurrentGeneration(generation)) return;
      setCurrent(autoCard);
      setCardVersion(version => version + 1);
      setFaceUp(true);
    }

    if (result.hand) {
      updateHand(result.hand);
      setPrompt(result.hand.canCashOut
        ? `精算するか、次のカードを予想してください（${result.hand.multiplier}倍）`
        : promptFor(result.hand.currentCard));
    }
    onBestChange(result.bestStreak);
    await pause(result.settlement ? 650 : 0);
    if (!isCurrentGeneration(generation)) return;
    finishGame(result.settlement);
  }, [finishGame, onBestChange, pause, resetFateEffects, updateHand]);

  const makeGuess = useCallback(async (guess: Guess) => {
    const active = handRef.current;
    if (!accessToken || !active || busyRef.current || !canGuess(active.currentCard, guess)
      || !active.nextWinOffers[guess].available) return;
    const generation = generationRef.current;
    setBusy(true);
    busyRef.current = true;
    setErrorMessage(null);
    setPrompt('次のカードを引いています…');
    setBanner(currentBanner => ({ ...currentBanner, hidden: true }));
    try {
      const result = await guessHighLow(accessToken, active, guess);
      if (!isCurrentGeneration(generation)) return;
      await presentGuess(result, generation);
    } catch (error) {
      if (!isCurrentGeneration(generation)) return;
      if (isUncertainHighLowError(error)
        || error instanceof HighLowApiError && ['stale_hand_version', 'hand_finished', 'hand_expired', 'hand_not_found'].includes(error.code)) {
        await loadSession();
      } else {
        showError(error);
      }
    } finally {
      if (isCurrentGeneration(generation)) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }, [accessToken, loadSession, presentGuess, showError]);

  const cashOut = useCallback(async () => {
    const active = handRef.current;
    if (!accessToken || !active || !active.canCashOut || busyRef.current) return;
    const generation = generationRef.current;
    setBusy(true);
    busyRef.current = true;
    setErrorMessage(null);
    try {
      const result = await cashoutHighLow(accessToken, active);
      if (!isCurrentGeneration(generation)) return;
      finishGame(result.settlement);
    } catch (error) {
      if (!isCurrentGeneration(generation)) return;
      if (isUncertainHighLowError(error)
        || error instanceof HighLowApiError && ['stale_hand_version', 'hand_finished', 'hand_expired', 'hand_not_found'].includes(error.code)) {
        await loadSession();
      } else {
        showError(error);
      }
    } finally {
      if (isCurrentGeneration(generation)) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }, [accessToken, finishGame, loadSession, showError]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (phase !== 'playing' || event.repeat || document.querySelector('dialog[open]')) return;
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        void makeGuess('higher');
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        void makeGuess('lower');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [makeGuess, phase]);

  const walletAmount = wallet === null ? null : BigInt(wallet);
  const lowDisabled = busy || !hand || !canGuess(hand.currentCard, 'lower') || !hand.nextWinOffers.lower.available;
  const highDisabled = busy || !hand || !canGuess(hand.currentCard, 'higher') || !hand.nextWinOffers.higher.available;
  const resultClass = `result-banner${banner.hidden ? ' is-hidden' : ''}${banner.tone === 'default' ? '' : ` is-${banner.tone}`}`;
  const isFateRevealed = fatePhase === 'revealed' || fatePhase === 'resolved';
  const fateClass = `fate-overlay${fatePhase === 'idle' ? '' : ' is-active'}${fatePhase === 'rewriting' ? ' is-rewriting' : ''}${isFateRevealed ? ' is-revealed' : ''}${fatePhase === 'resolved' ? ' is-resolved' : ''}`;

  return (
    <>
      <section className="hero" aria-labelledby="game-title">
        <p className="eyebrow">GUILD CARD QUEST · SOLO</p>
        <h1 id="game-title"><span>HIGH</span><i aria-hidden="true">/</i><span>LOW</span></h1>
        <p className="hero-copy">次のカードは、いまより上か下か。</p>
        {onOpenRanking ? <button className="high-low-ranking-button" type="button" aria-haspopup="dialog" onClick={onOpenRanking}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3h10v6a5 5 0 0 1-10 0V3Zm0 2H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4M12 14v5m-5 2h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          週間ランキングを見る<span aria-hidden="true">→</span>
        </button> : null}
      </section>

      {phase !== 'playing' ? (
        <section className="game-shell game-setup" aria-label="ハイアンドローの開始設定">
          <div className="setup-heading">
            <p className="eyebrow">PLACE YOUR BET</p>
            <h2>{summary?.title ?? (phase === 'loading' ? 'ゲームを確認中' : phase === 'recovery' ? 'ゲーム状態を確認できません' : '賭け金を選ぶ')}</h2>
            <p>{phase === 'recovery' ? '通信が戻ったら、進行中のゲームと残高を確認してください。' : summary ? 'もう一度遊ぶ場合は、下からゲームを開始してください。' : (accessToken
              ? '賭け金を確定すると、最初のカードが配られます。'
              : inDiscord ? 'Discordアカウントへ接続しています。' : '実プレイはDiscord Activityから起動してください。')}</p>
          </div>
          {summary ? <div className={`settlement-summary is-${summary.tone}`}>{summary.message}</div> : null}
          {errorMessage ? <p className="game-error" role="alert">{errorMessage}</p> : null}
          {phase === 'loading' ? <p className="activity-loading">サーバーのゲーム状態を確認しています…</p> : null}
          {phase === 'recovery' ? (
            <button className="quiet-button" type="button" data-retry-session disabled={busy} onClick={() => void loadSession()}>
              ゲーム状態を再確認
            </button>
          ) : null}
          {phase === 'setup' && accessToken ? (
            <div className="wager-options" aria-label="賭け金">
              {WAGERS.map(wager => (
                <button key={wager} type="button"
                  disabled={busy || walletAmount === null || walletAmount < BigInt(wager)}
                  onClick={() => void startWageredGame(wager)}>
                  <small>BET</small><strong>{wager.toLocaleString('ja-JP')}</strong><span>LIA</span>
                </button>
              ))}
            </div>
          ) : null}
          {phase === 'setup' && !accessToken && !inDiscord ? (
            <p className="real-play-notice">この画面では結果を生成しません。DiscordでLEVELIA Gameを起動すると、残高とサーバー抽選でプレイできます。</p>
          ) : null}
          <p className="disconnect-note">通信が切れた場合は5分間再接続できます。復帰しなければ、1勝以上は現在倍率で自動精算、0勝は払い戻しなしで終了します。</p>
        </section>
      ) : hand ? (
        <section className="game-shell" aria-label="ハイアンドローゲーム">
          <div className="scoreboard" aria-label="ゲーム状況">
            <div className="score-item"><span className="score-label">賭け金</span><strong>{hand.wager.toLocaleString('ja-JP')}</strong></div>
            <div className="score-item score-item-featured"><span className="score-label">連勝</span><strong>{hand.streak}</strong></div>
            <div className="score-item"><span className="score-label">精算額</span><strong>{hand.potentialPayout.toLocaleString('ja-JP')}</strong></div>
            <div className="score-item"><span className="score-label">最高</span><strong>{best ?? '—'}</strong></div>
          </div>

          <div className="table">
            <div className="table-glow" aria-hidden="true" />
            <div className="deck-zone" aria-hidden="true">
              <div className="deck-stack">
                <div className="deck-card deck-card-shadow" /><div className="deck-card deck-card-middle" /><div className="deck-card deck-card-top" />
              </div>
              <span>次のカード</span>
            </div>
            <div ref={stageRef} className={`card-stage${fatePhase === 'idle' ? '' : ' is-fate-active'}`} aria-label="現在のカード">
              <AnimatePresence initial>
                {current ? <PlayingCard key={cardVersion} card={current} faceUp={faceUp} effect={cardEffect} reducedMotion={reducedMotion} /> : null}
              </AnimatePresence>
            </div>
            <motion.div className={resultClass} aria-live="polite" aria-atomic="true"
              animate={{ opacity: banner.hidden ? 0 : 1 }} transition={{ duration: reducedMotion ? 0.001 : 0.18 }}>
              <span className="result-kicker">{banner.kicker}</span><strong>{banner.message}</strong>
            </motion.div>
          </div>

          <div className="decision" aria-label="次のカードを予想">
            <p className="decision-prompt">{prompt}</p>
            {errorMessage ? <p className="game-error" role="alert">{errorMessage}</p> : null}
            <div className="decision-buttons">
              <button className="guess-button guess-low has-offer" type="button" disabled={lowDisabled} onClick={() => void makeGuess('lower')}>
                <span className="guess-icon" aria-hidden="true">↓</span><span><b>LOW</b><small>低い</small></span><kbd>↓</kbd>
                <span className="guess-offer">{hand.nextWinOffers.lower.available
                  ? <>勝つと<strong>{formatLia(hand.nextWinOffers.lower.payout!)}</strong><small>{hand.nextWinOffers.lower.multiplier}倍</small></> : '選択できません'}</span>
              </button>
              <button className="guess-button guess-high has-offer" type="button" disabled={highDisabled} onClick={() => void makeGuess('higher')}>
                <span className="guess-icon" aria-hidden="true">↑</span><span><b>HIGH</b><small>高い</small></span><kbd>↑</kbd>
                <span className="guess-offer">{hand.nextWinOffers.higher.available
                  ? <>勝つと<strong>{formatLia(hand.nextWinOffers.higher.payout!)}</strong><small>{hand.nextWinOffers.higher.multiplier}倍</small></> : '選択できません'}</span>
              </button>
            </div>
            {hand.canCashOut ? (
              <div className="continuation-offer" aria-label="精算と次の勝利時の配当">
                <div><span>いま精算</span><strong>{formatLia(hand.potentialPayout)}</strong></div>
                <div className="continuation-next"><span>現在の倍率</span><strong>{hand.multiplier}倍</strong></div>
                <button className="cashout-button" type="button" disabled={busy} onClick={() => void cashOut()}>
                  <span className="cashout-icon" aria-hidden="true">✓</span><span>いま精算する<strong className="cashout-amount">{formatLia(hand.potentialPayout)}を受け取る</strong></span>
                </button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <p className="rule-note">Aが最も高く、2が最も低い。同じ数字は引き分けです。</p>
      {createPortal(
        <div className={fateClass} aria-hidden="true" style={{ '--fate-x': fatePosition.x, '--fate-y': fatePosition.y } as CSSProperties}>
          <div className="fate-orbit fate-orbit-outer" /><div className="fate-orbit fate-orbit-inner" /><div className="fate-flare" />
        </div>,
        document.body,
      )}
    </>
  );
}
