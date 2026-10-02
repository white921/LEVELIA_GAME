import { motion } from 'motion/react';
import type { PlayingCard as Card, Suit } from './game.js';

const suitSymbols: Record<Suit, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

interface PlayingCardProps {
  card: Card;
  faceUp: boolean;
  effect: 'idle' | 'awakening' | 'erasing' | 'restoring';
  reducedMotion: boolean;
}

export function PlayingCard({ card, faceUp, effect, reducedMotion }: PlayingCardProps) {
  const symbol = suitSymbols[card.suit];
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  const effectClass = effect === 'idle' ? '' : ` is-fate-${effect}`;

  return (
    <motion.div
      className={`playing-card${faceUp ? ' is-face-up' : ''}${red ? ' is-red' : ''}${effectClass}`}
      aria-label={`${card.rank}${symbol}`}
      initial={reducedMotion ? false : { x: '125%', y: -7, rotate: 8, scale: 0.93, opacity: 0.3 }}
      animate={{ x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { x: '-125%', y: 10, rotate: -9, scale: 0.88, opacity: 0 }}
      transition={{ duration: reducedMotion ? 0.001 : 0.44, ease: [0.2, 0.78, 0.22, 1] }}
    >
      <div className="card-inner">
        <div className="card-face card-back" aria-hidden="true">
          <div className="back-pattern"><span>L</span></div>
        </div>
        <div className="card-face card-front">
          <div className="corner corner-top"><b>{card.rank}</b><span>{symbol}</span></div>
          <div className="card-center"><span>{symbol}</span><b>{card.rank}</b></div>
          <div className="corner corner-bottom"><b>{card.rank}</b><span>{symbol}</span></div>
        </div>
      </div>
    </motion.div>
  );
}
