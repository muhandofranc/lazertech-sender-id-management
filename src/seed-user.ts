/**
 * Creates or updates a dashboard user from the command line. This is the
 * bootstrap path (there has to be a first super admin before anyone can log
 * in and use the Users screen); day to day, users are managed in the UI.
 *
 *   npm run seed-user -- <username> <password> [super_admin|user]
 *
 * Re-running with an existing username resets that user's password and role.
 */
import bcrypt from 'bcryptjs';
import { pool } from './db';

async function main(): Promise<void> {
  const [username, password, roleArg = 'super_admin'] = process.argv.slice(2);
  if (!username || !password) {
    console.error('usage: npm run seed-user -- <username> <password> [super_admin|user]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  if (roleArg !== 'super_admin' && roleArg !== 'user') {
    console.error(`Role must be "super_admin" or "user", got: ${roleArg}`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  await pool.execute(
    `INSERT INTO dashboard_users (username, password_hash, role)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       role = VALUES(role),
       is_active = 1`,
    [username, hash, roleArg],
  );
  console.log(`User "${username}" is ready (${roleArg}).`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
