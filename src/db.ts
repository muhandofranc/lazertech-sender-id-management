import mysql from 'mysql2/promise';
import { config } from './config';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4_general_ci',
});

/**
 * Fail loudly at boot if the dashboard's own tables are missing, rather
 * than surfacing a raw SQL error on the first login attempt.
 */
export async function assertSchema(): Promise<void> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN ('senderiddetails', 'dashboard_users', 'sender_audit_log')`,
    [config.db.database],
  );
  const present = new Set(rows.map((r) => String(r.TABLE_NAME).toLowerCase()));

  const missing = ['senderiddetails', 'dashboard_users', 'sender_audit_log'].filter(
    (t) => !present.has(t),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing table(s) in \`${config.db.database}\`: ${missing.join(', ')}.\n` +
        'Apply the migration, then seed a user:\n\n' +
        '  mysql -h 127.0.0.1 -u root -p grantiliff < migrations/001_dashboard_tables.sql\n' +
        '  npm run seed-user -- <username> <password>\n',
    );
  }
}
