import type { Guess, PlayingCard } from './game.js';

export interface HighLowHand {
  id: string;
  wager: number;
  streak: number;
  potentialPayout: number;
  multiplier: string;
  nextWinOffers: Record<Guess, { available: boolean; payout: number | null; multiplier: string | null }>;
  currentCard: PlayingCard;
  version: number;
  rulesVersion: number;
  disconnectDeadlineAt: string;
  canCashOut: boolean;
}

let walletMode: 'real' | 'virtual' = 'real';

export interface HighLowSessionResult {
  walletMode: 'real' | 'virtual';
  bestStreak: number;
  accountFound: boolean;
  wallet: string | null;
  hand: HighLowHand | null;
}

export interface HighLowStartResult {
  wallet: string;
  hand: HighLowHand;
  openingAutoDrawnCards: PlayingCard[];
}

export interface HighLowGuessEvent {
  guess: Guess;
  result: 'win' | 'loss' | 'tie';
  previousCard: PlayingCard;
  revealedCard: PlayingCard;
  finalCard: PlayingCard;
  autoDrawnCards: PlayingCard[];
  fateShifted: boolean;
}

export interface HighLowSettlement {
  reason: 'loss' | 'cashout' | 'max_streak';
  payout: number;
  wallet: string | null;
}

export interface HighLowGuessResult {
  bestStreak: number;
  hand: HighLowHand | null;
  event: HighLowGuessEvent;
  settlement: HighLowSettlement | null;
}

export interface HighLowCashoutResult {
  hand: null;
  settlement: HighLowSettlement;
}

export class HighLowApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'HighLowApiError';
  }
}

export function isUncertainHighLowError(error: unknown): boolean {
  return !(error instanceof HighLowApiError) || error.statusCode >= 500;
}

function apiPath(path: string): string {
  return `/.proxy/api/high-low/${path.replace(/^\/+/, '')}`;
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
  if (!response.ok) {
    throw new HighLowApiError(
      response.status,
      typeof body?.error === 'string' ? body.error : 'request_failed',
      typeof body?.message === 'string' ? body.message : `Request failed (${response.status})`,
    );
  }
  if (body === null) throw new Error('Game response was incomplete');
  return body as T;
}

function authorization(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

async function postJson<T>(accessToken: string, path: string, body?: object): Promise<T> {
  // Only commands with a server-persisted idempotency key may be retried.
  // Serialize once so a lost response never turns into a new wager or guess.
  const serialized = body ? JSON.stringify(body) : undefined;
  const canRetry = body !== undefined && 'requestId' in body;
  const requestWalletMode = walletMode;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(apiPath(path), {
        method: 'POST',
        headers: { ...authorization(accessToken), 'X-High-Low-Wallet-Mode': requestWalletMode, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(serialized ? { body: serialized } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      return await readResponse<T>(response);
    } catch (error) {
      if (!canRetry || attempt >= 1 || !isUncertainHighLowError(error)) throw error;
    }
  }
}

export async function fetchHighLowStats(accessToken: string): Promise<{ bestStreak: number }> {
  const response = await fetch(apiPath('stats'), {
    headers: authorization(accessToken),
    cache: 'no-store',
  });
  return readResponse<{ bestStreak: number }>(response);
}

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  rank: number;
  value: number;
}

export interface WeeklyLeaderboard {
  resetAt?: string | null;
  walletMode: 'real' | 'virtual';
  weekStart: string;
  weekEnd: string;
  updatedAt: string;
  nextUpdateAt: string;
  streak: { entries: LeaderboardEntry[]; me: LeaderboardEntry | null; participants: number };
  multiplier: { entries: LeaderboardEntry[]; me: LeaderboardEntry | null; participants: number };
}

export async function fetchHighLowLeaderboard(accessToken: string, signal: AbortSignal): Promise<WeeklyLeaderboard> {
  const response = await fetch(apiPath('leaderboard'), {
    headers: authorization(accessToken), cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  return readResponse<WeeklyLeaderboard>(response);
}

export async function fetchHighLowSession(accessToken: string): Promise<HighLowSessionResult> {
  const response = await fetch(apiPath('session'), {
    headers: authorization(accessToken),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  const result = await readResponse<HighLowSessionResult>(response);
  walletMode = result.walletMode ?? 'real';
  return result;
}

export function startHighLow(accessToken: string, wager: number): Promise<HighLowStartResult> {
  return postJson(accessToken, 'start', { wager, requestId: crypto.randomUUID() });
}

export function guessHighLow(accessToken: string, hand: HighLowHand, guess: Guess): Promise<HighLowGuessResult> {
  return postJson(accessToken, `${hand.id}/guess`, {
    guess,
    expectedVersion: hand.version,
    requestId: crypto.randomUUID(),
  });
}

export function cashoutHighLow(accessToken: string, hand: HighLowHand): Promise<HighLowCashoutResult> {
  return postJson(accessToken, `${hand.id}/cashout`, {
    expectedVersion: hand.version,
    requestId: crypto.randomUUID(),
  });
}

export function heartbeatHighLow(accessToken: string, handId: string): Promise<{ ok: true }> {
  return postJson(accessToken, `${handId}/heartbeat`);
}
