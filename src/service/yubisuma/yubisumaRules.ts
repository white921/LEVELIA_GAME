import { randomInt, randomUUID } from 'node:crypto';
import { ACTIVE_GAME_LIMIT, CPU_ID, HISTORY_LIMIT, INVITE_TIMEOUT_MS, TURN_TIMEOUT_MS } from '../../constant/yubisuma/yubisuma.js';
import type { Game, Move, Random, Room, Seat } from '../../type/yubisuma/yubisuma.js';

export class GameError extends Error {}
export const emptyRoom = (): Room => ({ version: 1, invitations: [], games: [] });

export function expireRoom(room: Room, now: number): void {
  room.invitations = room.invitations.filter(invite => invite.expiresAt > now);
  for (const game of room.games) {
    if (game.status === 'active' && game.expiresAt <= now) {
      game.status = 'expired';
      game.moves = [null, null];
      game.updatedAt = now;
    }
  }
  const active = room.games.filter(game => game.status === 'active');
  const finished = room.games.filter(game => game.status !== 'active').sort((a, b) => b.updatedAt - a.updatedAt);
  room.games = [...active, ...finished.slice(0, HISTORY_LIMIT)];
}

export function activeGame(room: Room, userId: string): Game | undefined {
  return room.games.find(game => game.status === 'active' && game.players.includes(userId));
}

function commitCpu(game: Game, random: Random): void {
  const seat = game.players.indexOf(CPU_ID);
  if (seat < 0 || game.status !== 'active') return;
  const cpu = seat as Seat;
  game.moves[cpu] = {
    fingers: random(game.hands[cpu] + 1),
    guess: game.caller === cpu ? random(game.hands[0] + game.hands[1] + 1) : null,
  };
}

export function createGame(room: Room, userId: string, opponentId: string, now: number, random: Random = randomInt): Game {
  if (userId === opponentId || userId === CPU_ID) throw new GameError('自分自身とは対戦できません。');
  if (activeGame(room, userId) || (opponentId !== CPU_ID && activeGame(room, opponentId))) {
    throw new GameError('参加者がすでに対戦中です。「対戦に戻る」から確認してください。');
  }
  if (room.games.filter(game => game.status === 'active').length >= ACTIVE_GAME_LIMIT) throw new GameError('現在混み合っています。少し待ってからお試しください。');
  const game: Game = {
    id: randomUUID(), players: [userId, opponentId], hands: [2, 2], caller: random(2) as Seat,
    round: 1, moves: [null, null], status: 'active', winner: null, lastResult: null,
    expiresAt: now + TURN_TIMEOUT_MS, updatedAt: now, messageId: null, publishedVersion: null,
  };
  commitCpu(game, random);
  room.games.push(game);
  room.invitations = room.invitations.filter(invite => !game.players.includes(invite.userId) && !game.players.includes(invite.opponentId));
  return game;
}

export function chooseOpponent(room: Room, userId: string, opponentId: string, now: number, random: Random = randomInt): Game | null {
  if (userId === opponentId || opponentId === CPU_ID) throw new GameError('別のプレイヤーを選択してください。');
  if (activeGame(room, userId) || activeGame(room, opponentId)) throw new GameError('あなた、または相手がすでに対戦中です。');
  const reciprocal = room.invitations.find(invite => invite.userId === opponentId && invite.opponentId === userId && invite.expiresAt > now);
  if (reciprocal) return createGame(room, opponentId, userId, now, random);
  room.invitations = room.invitations.filter(invite => invite.userId !== userId);
  if (room.invitations.length >= 500) throw new GameError('対戦希望が混み合っています。少し待ってください。');
  room.invitations.push({ userId, opponentId, expiresAt: now + INVITE_TIMEOUT_MS });
  return null;
}

export function participantGame(room: Room, gameId: string, userId: string): { game: Game; seat: Seat } {
  const game = room.games.find(item => item.id === gameId);
  if (!game) throw new GameError('この対戦は見つかりません。プレイ開始から確認してください。');
  const seat = game.players.indexOf(userId);
  if (seat < 0 || userId === CPU_ID) throw new GameError('この対戦の参加者だけが操作できます。');
  return { game, seat: seat as Seat };
}

export function submitMove(room: Room, gameId: string, userId: string, round: number, move: Move, now: number, random: Random = randomInt): Game {
  const { game, seat } = participantGame(room, gameId, userId);
  if (game.status !== 'active' || game.expiresAt <= now) throw new GameError('この対戦は終了しています。');
  if (game.round !== round) throw new GameError('前のラウンドの入力です。「対戦に戻る」から現在の画面を開いてください。');
  if (game.moves[seat]) throw new GameError('入力はすでに確定しています。「対戦に戻る」で進行を確認できます。');
  if (!Number.isInteger(move.fingers) || move.fingers < 0 || move.fingers > game.hands[seat]) throw new GameError('上げる本数が正しくありません。');
  if (game.caller === seat) {
    if (move.guess === null || !Number.isInteger(move.guess) || move.guess < 0 || move.guess > game.hands[0] + game.hands[1]) throw new GameError('宣言する本数が正しくありません。');
  } else if (move.guess !== null) throw new GameError('今回は相手が宣言する番です。');
  game.moves[seat] = { ...move };
  game.updatedAt = now;
  const [a, b] = game.moves;
  if (a && b) {
    const guess = game.moves[game.caller]!.guess!;
    const hit = a.fingers + b.fingers === guess;
    game.lastResult = { round: game.round, caller: game.caller, fingers: [a.fingers, b.fingers], guess, hit };
    if (hit) game.hands[game.caller] -= 1;
    game.moves = [null, null];
    if (game.hands[game.caller] === 0) {
      game.status = 'won';
      game.winner = game.caller;
    } else {
      game.caller = game.caller === 0 ? 1 : 0;
      game.round += 1;
      game.expiresAt = now + TURN_TIMEOUT_MS;
      commitCpu(game, random);
    }
  }
  return game;
}

export function forfeit(room: Room, gameId: string, userId: string, now: number): Game {
  const { game, seat } = participantGame(room, gameId, userId);
  if (game.status !== 'active') throw new GameError('この対戦はすでに終了しています。');
  game.status = 'forfeited';
  game.winner = seat === 0 ? 1 : 0;
  game.moves = [null, null];
  game.updatedAt = now;
  return game;
}
