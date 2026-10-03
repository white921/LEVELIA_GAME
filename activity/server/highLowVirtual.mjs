// Virtual play has its own wallet, hands, commands, ledger and payout settings.
// Real accounts are only read to take the initial snapshot and check eligibility.
export async function migrateVirtualHighLow(connection) {
  await connection.query(`CREATE TABLE IF NOT EXISTS levelia_game_high_low_virtual_wallets (
    user_id BIGINT NOT NULL PRIMARY KEY,
    initial_wallet INTEGER NOT NULL,
    wallet INTEGER NOT NULL,
    created_at DATETIME(3) NOT NULL,
    CHECK (initial_wallet >= 0), CHECK (wallet >= 0)
  )`);
  for (const name of ['hands', 'commands', 'ledger', 'settings', 'setting_changes']) {
    await connection.query(`CREATE TABLE IF NOT EXISTS levelia_game_high_low_virtual_${name}
      LIKE levelia_game_high_low_${name}`);
  }
  for (const name of ['settings', 'setting_changes']) {
    const table = `levelia_game_high_low_virtual_${name}`;
    const [columns] = await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'target_rtp_ppm'", [table]);
    if (!columns.length) await connection.query(`ALTER TABLE ${table}
      ADD COLUMN target_rtp_ppm INTEGER UNSIGNED DEFAULT NULL,
      ADD COLUMN calibration_id VARCHAR(80) DEFAULT NULL`);
  }
  const [[deck]] = await connection.query("SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'levelia_game_high_low_virtual_hands' AND COLUMN_NAME = 'remaining_deck'");
  if (deck?.IS_NULLABLE === 'NO') await connection.query('ALTER TABLE levelia_game_high_low_virtual_hands MODIFY COLUMN remaining_deck JSON DEFAULT NULL');
  const [[active]] = await connection.query("SELECT COUNT(*) AS count FROM levelia_game_high_low_virtual_hands WHERE status = 'active' AND rules_version <> 3");
  if (Number(active.count)) throw new Error('Finish virtual games before upgrading high-low rules');
  await connection.query(`INSERT IGNORE INTO levelia_game_high_low_virtual_settings
    (id, correction_ppm, version, updated_by, updated_at, target_rtp_ppm, calibration_id)
    SELECT id, correction_ppm, version, updated_by, updated_at, target_rtp_ppm, calibration_id
    FROM levelia_game_high_low_settings`);
}

export async function initializeVirtualWallets(connection, userIds) {
  const ids = [...new Set(userIds)];
  if (!ids.length || ids.some(id => !/^[1-9]\d{16,19}$/.test(id))) {
    throw new Error('Virtual wallet initialization requires valid participant IDs');
  }
  const [[active]] = await connection.query("SELECT COUNT(*) AS count FROM levelia_game_high_low_hands WHERE status = 'active'");
  if (Number(active.count)) throw new Error('Finish real-money hands before enabling virtual play');
  await connection.beginTransaction();
  try {
    for (const id of ids) {
      await connection.execute(`INSERT IGNORE INTO levelia_game_high_low_virtual_wallets
        (user_id, initial_wallet, wallet, created_at)
        SELECT user_id, wallet, wallet, UTC_TIMESTAMP(3) FROM accounts WHERE user_id = ?`, [id]);
      const [[wallet]] = await connection.execute(
        'SELECT user_id FROM levelia_game_high_low_virtual_wallets WHERE user_id = ?', [id]);
      if (!wallet) throw new Error(`Participant account not found: ${id}`);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}
