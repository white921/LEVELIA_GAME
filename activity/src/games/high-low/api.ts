import type { Guess, PlayingCard } from './game.js';

export interface HighLowHand {
  id: string;
  wager: number;
  streak: number;
  potentialPayout: number;
  multiplier: string;
  nextWinPayout: number;
  nextWinMultiplier: string;
  currentCard: PlayingCard;
  version: number;
  rulesVersion: number;
  disconnectDeadlineAt: string;
  canCashOut: boolean;
}

export interface HighLowSessionResult {
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
  return body as T;
}

function authorization(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

function postJson<T>(accessToken: string, path: string, body?: object): Promise<T> {
  return fetch(apiPath(path), {
    method: 'POST',
    headers: { ...authorization(accessToken), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(readResponse<T>);
}

export async function fetchHighLowStats(accessToken: string): Promise<{ bestStreak: number }> {
  const response = await fetch(apiPath('stats'), {
    headers: authorization(accessToken),
    cache: 'no-store',
  });
  return readResponse<{ bestStreak: number }>(response);
}

export async function fetchHighLowSession(accessToken: string): Promise<HighLowSessionResult> {
  const response = await fetch(apiPath('session'), {
    headers: authorization(accessToken),
    cache: 'no-store',
  });
  return readResponse<HighLowSessionResult>(response);
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
