export type Seat = 0 | 1;
export type Move = { fingers: number; guess: number | null };
export type RoundResult = {
  round: number;
  caller: Seat;
  fingers: [number, number];
  guess: number;
  hit: boolean;
};
export type Game = {
  id: string;
  players: [string, string];
  hands: [number, number];
  caller: Seat;
  round: number;
  moves: [Move | null, Move | null];
  status: 'active' | 'won' | 'forfeited' | 'expired';
  winner: Seat | null;
  lastResult: RoundResult | null;
  expiresAt: number;
  updatedAt: number;
  messageId: string | null;
  publishedVersion: string | null;
};
export type Invitation = { userId: string; opponentId: string; expiresAt: number };
export type Room = { version: 1; invitations: Invitation[]; games: Game[] };
export type Scope = { guildId: string; channelId: string };
export type Random = (maxExclusive: number) => number;
