import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Room, Scope } from '../../type/yubisuma/yubisuma.js';
import { emptyRoom, expireRoom } from './yubisumaRules.js';

export class YubisumaStore {
  constructor(private readonly database: Pool) {}

  async transact<T>(scope: Scope, operation: (room: Room, now: number) => T | Promise<T>): Promise<T> {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        'INSERT INTO levelia_game_rooms (guild_id, channel_id, state) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = channel_id',
        [scope.guildId, scope.channelId, JSON.stringify(emptyRoom())],
      );
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT state FROM levelia_game_rooms WHERE guild_id = ? AND channel_id = ? FOR UPDATE',
        [scope.guildId, scope.channelId],
      );
      const raw = rows[0]?.state;
      const room: Room = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!room || room.version !== 1 || !Array.isArray(room.games) || !Array.isArray(room.invitations)) throw new Error('Invalid room state');
      const now = Date.now();
      expireRoom(room, now);
      const result = await operation(room, now);
      await connection.execute('UPDATE levelia_game_rooms SET state = ? WHERE guild_id = ? AND channel_id = ?',
        [JSON.stringify(room), scope.guildId, scope.channelId]);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
