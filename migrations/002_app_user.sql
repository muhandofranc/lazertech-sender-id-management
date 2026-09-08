-- Dedicated least-privilege account for the dashboard, so it stops
-- connecting to MySQL as root.
--
-- Three host scopes are granted:
--   localhost / 127.0.0.1  -- app run directly on the host, or with
--                             docker `network_mode: host`
--   172.%                  -- app run on the default docker bridge network,
--                             where the connection arrives from the bridge subnet
--
-- MySQL 8.4 removed the mysql_native_password plugin, so caching_sha2_password
-- is the only option here. mysql2 (the node driver) speaks it.
--
-- DML only: the dashboard never issues DDL. Migrations are applied as root.

CREATE USER IF NOT EXISTS 'intranet'@'localhost'
  IDENTIFIED WITH caching_sha2_password BY 'bEjIpriSwojotE';
CREATE USER IF NOT EXISTS 'intranet'@'127.0.0.1'
  IDENTIFIED WITH caching_sha2_password BY 'bEjIpriSwojotE';
CREATE USER IF NOT EXISTS 'intranet'@'172.%'
  IDENTIFIED WITH caching_sha2_password BY 'bEjIpriSwojotE';

GRANT SELECT, INSERT, UPDATE, DELETE ON `grantiliff`.* TO 'intranet'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `grantiliff`.* TO 'intranet'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `grantiliff`.* TO 'intranet'@'172.%';

FLUSH PRIVILEGES;
