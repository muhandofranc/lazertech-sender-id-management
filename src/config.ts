import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got: ${v}`);
  return n;
}

export const config = {
  port: int('PORT', 3020),
  // Behind a TLS-terminating proxy set COOKIE_SECURE=true so the session
  // cookie is only ever sent over https.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionTtlHours: int('SESSION_TTL_HOURS', 12),

  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: int('DB_PORT', 3306),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: process.env.DB_NAME ?? 'grantiliff',
  },

  // Signs the session cookie. Changing it invalidates every live session.
  sessionSecret: required('SESSION_SECRET'),
} as const;
