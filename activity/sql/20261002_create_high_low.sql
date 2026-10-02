-- actionsの外部キーで参照する履歴表示専用口座。
-- 既存残高は保持し、ゲームの賭け金・配当でもこの口座残高は更新しない。
INSERT INTO accounts (user_id, user_name, wallet)
VALUES (1552246348756025344, 'LEVELIA Game', 0)
ON DUPLICATE KEY UPDATE
  user_name = VALUES(user_name);

CREATE TABLE IF NOT EXISTS levelia_game_high_low_hands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL,
  wager INTEGER NOT NULL,
  streak TINYINT UNSIGNED NOT NULL DEFAULT 0,
  potential_payout INTEGER NOT NULL DEFAULT 0,
  current_card VARCHAR(16) NOT NULL,
  remaining_deck JSON NOT NULL,
  rules_version SMALLINT UNSIGNED NOT NULL,
  version INTEGER UNSIGNED NOT NULL DEFAULT 1,
  last_heartbeat_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  settlement_amount INTEGER NOT NULL DEFAULT 0,
  settlement_reason VARCHAR(32) DEFAULT NULL,
  settled_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  active_user_id BIGINT GENERATED ALWAYS AS (
    CASE WHEN status = 'active' THEN user_id ELSE NULL END
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_high_low_active_user (active_user_id),
  KEY idx_high_low_expiration (status, last_heartbeat_at, expires_at),
  KEY idx_high_low_user_created (user_id, created_at),
  CONSTRAINT fk_high_low_hand_user FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_high_low_status CHECK (status IN ('active', 'lost', 'cashed_out', 'auto_cashed_out', 'expired')),
  CONSTRAINT chk_high_low_wager CHECK (wager IN (100, 1000, 10000)),
  CONSTRAINT chk_high_low_streak CHECK (streak BETWEEN 0 AND 5)
) COMMENT='LEVELIA Game ハイアンドローの進行状態';

CREATE TABLE IF NOT EXISTS levelia_game_high_low_commands (
  request_id CHAR(36) NOT NULL,
  user_id BIGINT NOT NULL,
  hand_id BIGINT UNSIGNED DEFAULT NULL,
  action VARCHAR(16) NOT NULL,
  response_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (request_id),
  KEY idx_high_low_commands_user_created (user_id, created_at),
  CONSTRAINT fk_high_low_command_user FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_high_low_command_hand FOREIGN KEY (hand_id) REFERENCES levelia_game_high_low_hands(id) ON DELETE RESTRICT
) COMMENT='ハイアンドローAPIの冪等性記録';

CREATE TABLE IF NOT EXISTS levelia_game_high_low_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  hand_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT NOT NULL,
  kind VARCHAR(24) NOT NULL,
  amount INTEGER NOT NULL,
  wallet_before INTEGER NOT NULL,
  wallet_after INTEGER NOT NULL,
  supply_delta INTEGER NOT NULL,
  request_id CHAR(36) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_high_low_ledger_request (request_id),
  KEY idx_high_low_ledger_user_created (user_id, created_at),
  CONSTRAINT fk_high_low_ledger_hand FOREIGN KEY (hand_id) REFERENCES levelia_game_high_low_hands(id) ON DELETE RESTRICT,
  CONSTRAINT fk_high_low_ledger_user FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_high_low_ledger_kind CHECK (kind IN ('wager_debit', 'payout_credit', 'auto_payout_credit'))
) COMMENT='ハイアンドローによるLIA増減の監査台帳';
