CREATE TABLE IF NOT EXISTS levelia_game_high_low_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  correction_ppm INTEGER UNSIGNED NOT NULL,
  version INTEGER UNSIGNED NOT NULL DEFAULT 1,
  updated_by VARCHAR(20) DEFAULT NULL,
  updated_at DATETIME(3) NOT NULL,
  CHECK (id = 1),
  CHECK (correction_ppm BETWEEN 1 AND 10000000)
);

INSERT IGNORE INTO levelia_game_high_low_settings (id, correction_ppm, version, updated_at)
VALUES (1, 1000000, 1, UTC_TIMESTAMP(3));

CREATE TABLE IF NOT EXISTS levelia_game_high_low_setting_changes (
  request_id VARCHAR(64) NOT NULL PRIMARY KEY,
  actor_id VARCHAR(20) NOT NULL,
  previous_ppm INTEGER UNSIGNED NOT NULL,
  correction_ppm INTEGER UNSIGNED NOT NULL,
  version INTEGER UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_high_low_setting_version (version)
);
