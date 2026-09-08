import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { RowDataPacket } from 'mysql2/promise';
import { config } from './config';
import { pool } from './db';

const COOKIE_NAME = 'gsid';
const secretKey = new TextEncoder().encode(config.sessionSecret);

export type Role = 'super_admin' | 'user';

export interface SessionUser {
  id: number;
  username: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  is_active: number;
}

/**
 * Returns the user on success, or null on bad username/password/disabled.
 * Deliberately does not distinguish between those cases to the caller's
 * response, so the login form cannot be used to enumerate usernames.
 */
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<SessionUser | null> {
  const [rows] = await pool.execute<UserRow[]>(
    'SELECT id, username, password_hash, role, is_active FROM dashboard_users WHERE username = ? LIMIT 1',
    [username],
  );
  const row = rows[0];

  if (!row) {
    // Spend roughly the same time as a real bcrypt compare so response
    // timing does not reveal whether the username exists.
    await bcrypt.compare(password, '$2a$12$' + 'x'.repeat(53));
    return null;
  }
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok || row.is_active !== 1) return null;

  return { id: row.id, username: row.username, role: row.role };
}

export async function issueSession(res: Response, user: SessionUser): Promise<void> {
  // Only the user id is authoritative here. Role is re-read from the database
  // on every request (see readSession) so a demotion or deactivation takes
  // effect immediately instead of lingering until the cookie expires.
  const token = await new SignJWT({ uid: user.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${config.sessionTtlHours}h`)
    .sign(secretKey);

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionTtlHours * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

async function readSession(req: Request): Promise<SessionUser | null> {
  const token = req.cookies?.[COOKIE_NAME];
  if (typeof token !== 'string' || token === '') return null;

  let uid: number;
  try {
    const { payload } = await jwtVerify(token, secretKey);
    if (typeof payload.uid !== 'number') return null;
    uid = payload.uid;
  } catch {
    return null;
  }

  const [rows] = await pool.execute<UserRow[]>(
    'SELECT id, username, password_hash, role, is_active FROM dashboard_users WHERE id = ? LIMIT 1',
    [uid],
  );
  const row = rows[0];
  // Deleted or deactivated between requests: the session stops working now.
  if (!row || row.is_active !== 1) return null;

  return { id: row.id, username: row.username, role: row.role };
}

/** Guards the JSON API: 401 rather than a redirect, so fetch() can react. */
export async function requireApiAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = await readSession(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  req.user = user;
  next();
}

/**
 * Super-admin-only endpoints (user management, audit log). Must be mounted
 * after requireApiAuth, which populates req.user.
 */
export function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user?.role !== 'super_admin') {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }
  next();
}

/** Guards HTML pages: redirect to the login screen. */
export async function requirePageAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = await readSession(req);
  if (!user) {
    res.redirect('/login');
    return;
  }
  req.user = user;
  next();
}

export async function currentUser(req: Request): Promise<SessionUser | null> {
  return readSession(req);
}
