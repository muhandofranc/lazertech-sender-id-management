-- Roles for dashboard accounts.
--
--   super_admin -- everything: sender IDs, user management, audit log
--   user        -- sender IDs only
--
-- Existing rows default to 'user'; the founding account is then promoted so
-- the instance is never left without a super admin.

ALTER TABLE `dashboard_users`
  ADD COLUMN `role` ENUM('super_admin','user') NOT NULL DEFAULT 'user' AFTER `password_hash`;

-- Promote the lowest-id account (the one created at setup time). The derived
-- table is required because MySQL will not read the target table directly in
-- an UPDATE subquery.
UPDATE `dashboard_users`
   SET `role` = 'super_admin'
 WHERE `id` = (SELECT `min_id` FROM (SELECT MIN(`id`) AS `min_id` FROM `dashboard_users`) AS t);

-- User-management events share the audit trail with sender changes.
ALTER TABLE `sender_audit_log`
  MODIFY COLUMN `action`
    ENUM('create','update','delete','login','login_failed',
         'user_create','user_update','user_delete') NOT NULL;
