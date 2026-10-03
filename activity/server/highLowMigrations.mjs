import { readFile } from 'node:fs/promises';
import { migrateVirtualHighLow } from './highLowVirtual.mjs';

export async function migrateHighLow(connection) {
  const [[lock]] = await connection.query("SELECT GET_LOCK('levelia_game_high_low_migrate', 30) AS acquired");
  if (Number(lock.acquired) !== 1) throw new Error('Could not acquire migration lock');
  try {
    for (const file of ['20261002_create_high_low.sql', '20261003_high_low_payout_settings.sql']) {
      await connection.query(await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'));
    }
    const [columns] = await connection.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'levelia_game_high_low_hands' AND COLUMN_NAME = 'payout_state'",
    );
    if (!columns.length) {
      // Historical hands retain their recorded amounts; no balance/history rewrite.
      await connection.query(`ALTER TABLE levelia_game_high_low_hands
        ADD COLUMN payout_state JSON DEFAULT NULL,
        MODIFY COLUMN potential_payout BIGINT NOT NULL DEFAULT 0`);
    }
    for (const table of ['levelia_game_high_low_settings', 'levelia_game_high_low_setting_changes']) {
      const [targetColumns] = await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'target_rtp_ppm'", [table]);
      if (!targetColumns.length) {
        await connection.query(`ALTER TABLE ${table} ADD COLUMN target_rtp_ppm INTEGER UNSIGNED DEFAULT NULL, ADD COLUMN calibration_id VARCHAR(80) DEFAULT NULL`);
      }
    }
    // Stop storing deck state for new hands; retain historical records unchanged.
    const [[deckColumn]] = await connection.query("SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'levelia_game_high_low_hands' AND COLUMN_NAME = 'remaining_deck'");
    if (deckColumn?.IS_NULLABLE === 'NO') {
      await connection.query('ALTER TABLE levelia_game_high_low_hands MODIFY COLUMN remaining_deck JSON DEFAULT NULL');
    }
    const [[active]] = await connection.query("SELECT COUNT(*) AS count FROM levelia_game_high_low_hands WHERE status = 'active' AND rules_version <> 3");
    if (Number(active.count) !== 0) throw new Error('Finish active games before upgrading high-low rules');
    await migrateVirtualHighLow(connection);
    // Period-limited leaderboard reads should not scan the entire command/history tables.
    for (const prefix of ['levelia_game_high_low_', 'levelia_game_high_low_virtual_']) {
      for (const [suffix, name, columns] of [
        ['commands', 'idx_high_low_weekly_events', 'action, created_at'],
        ['hands', 'idx_high_low_weekly_settlements', 'settled_at'],
      ]) {
        const table = `${prefix}${suffix}`;
        const [indexes] = await connection.execute(
          'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
          [table, name],
        );
        if (!indexes.length) await connection.query(`ALTER TABLE ${table} ADD INDEX ${name} (${columns})`);
      }
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK('levelia_game_high_low_migrate')");
  }
}
