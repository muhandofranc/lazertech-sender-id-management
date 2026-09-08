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
  if (missing.length === 0) return;

  const db = config.db.database;
  const target = `-h ${config.db.host} -P ${config.db.port} -u <admin-user> -p ${db}`;

  // `senderiddetails` belongs to the SMS pipeline, not to this dashboard, so
  // it is never created here -- if it is missing, the connection is pointed at
  // the wrong database.
  if (missing.includes('senderiddetails')) {
    throw new Error(
      `Table \`senderiddetails\` was not found in \`${db}\`.\n` +
        'That table belongs to the SMS pipeline and is not created by these ' +
        'migrations, so this usually means DB_NAME names the wrong database.\n',
    );
  }

  throw new Error(
    `Missing dashboard table(s) in \`${db}\`: ${missing.join(', ')}.\n\n` +
      'Apply the schema migrations, in order, with an account that can create ' +
      'tables:\n\n' +
      `  mysql ${target} < migrations/001_dashboard_tables.sql\n` +
      `  mysql ${target} < migrations/003_roles.sql\n` +
      `  mysql ${target} < migrations/004_default_super_admin.sql\n\n` +
      '004 creates the default super admin (admin / ChangeMe@123), so no seed ' +
      'step is needed. Skip 002 unless this deployment also needs the ' +
      '`intranet` MySQL account created.\n',
  );
}
