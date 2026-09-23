CREATE TABLE IF NOT EXISTS levelia_game_rooms (
  guild_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  channel_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id, channel_id)
) ENGINE=InnoDB COMMENT='LEVELIA_GAME transactional room state';
