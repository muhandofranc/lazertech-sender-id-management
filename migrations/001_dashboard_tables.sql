-- Tables the dashboard needs. `senderiddetails` itself is deliberately
-- left exactly as it is: no new columns, so every existing consumer
-- (grantliff_mq/bulk_pub.py and friends) keeps working untouched.

-- Dashboard operators. Kept in the DB purely so audit rows can be
-- attributed to a real, stable user id.
CREATE TABLE IF NOT EXISTS `dashboard_users` (
  `id`            BIGINT       NOT NULL AUTO_INCREMENT,
  `username`      VARCHAR(64)  NOT NULL,
  `password_hash` VARCHAR(100) NOT NULL,
  `is_active`     TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_login_at` DATETIME     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dashboard_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only audit trail.
--
-- Deletes are permanent in `senderiddetails`, so this table is the only
-- record that a sender ID ever existed. That is why it does NOT foreign-key
-- to `senderiddetails` (the row it describes is often gone) and why
-- `actor_username` is denormalised alongside `actor_user_id` (so history
-- stays readable even if the user row is later removed).
CREATE TABLE IF NOT EXISTS `sender_audit_log` (
  `id`             BIGINT      NOT NULL AUTO_INCREMENT,
  `actor_user_id`  BIGINT      NULL,
  `actor_username` VARCHAR(64) NOT NULL,
  `action`         ENUM('create','update','delete','login','login_failed') NOT NULL,
  `sender_row_id`  BIGINT      NULL,
  `sender_id`      VARCHAR(12) NULL,
  `before_json`    JSON        NULL,
  `after_json`     JSON        NULL,
  `ip`             VARCHAR(45) NULL,
  `created_at`     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_created_at` (`created_at`),
  KEY `idx_audit_sender_id` (`sender_id`),
  KEY `idx_audit_actor` (`actor_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
