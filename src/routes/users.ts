import { Router } from 'express';
import bcrypt from 'bcryptjs';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { pool } from '../db';
import { recordAudit } from '../audit';
import { requireApiAuth, requireSuperAdmin } from '../auth';

export const usersRouter = Router();

// Every route here is super-admin only.
usersRouter.use(requireApiAuth, requireSuperAdmin);

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  role: 'super_admin' | 'user';
  is_active: number;
  created_at: Date;
  last_login_at: Date | null;
}

const createSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(64, 'Username cannot exceed 64 characters')
    .regex(/^[A-Za-z0-9._-]+$/, 'Username may only contain letters, digits, . _ -'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  role: z.enum(['super_admin', 'user']),
});

const updateSchema = z.object({
  role: z.enum(['super_admin', 'user']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200).optional(),
});

const idParam = z.coerce.number().int().positive();

/**
 * Number of accounts that can still administer the instance. Used to refuse
 * any change that would remove the last one and lock everybody out.
 * Runs inside the caller's transaction so the count cannot race.
 */
async function activeSuperAdmins(conn: PoolConnection, excludingId: number): Promise<number> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM dashboard_users
      WHERE role = 'super_admin' AND is_active = 1 AND id <> ?
      FOR UPDATE`,
    [excludingId],
  );
  return Number(rows[0]?.n ?? 0);
}

function isDuplicate(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { errno?: number }).errno === 1062;
}

usersRouter.get('/', async (_req, res, next) => {
  try {
    const [rows] = await pool.query<UserRow[]>(
      `SELECT id, username, role, is_active, created_at, last_login_at
         FROM dashboard_users ORDER BY username ASC`,
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

usersRouter.post('/', async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const { username, password, role } = parsed.data;
  const actor = req.user!;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const hash = await bcrypt.hash(password, 12);
    const [result] = await conn.execute<ResultSetHeader>(
      'INSERT INTO dashboard_users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hash, role],
    );
    await recordAudit(
      {
        actorUserId: actor.id,
        actorUsername: actor.username,
        action: 'user_create',
        // Password hashes are deliberately never written to the audit trail.
        after: { username, role, is_active: 1 },
        ip: req.ip ?? null,
      },
      conn,
    );
    await conn.commit();
    res.status(201).json({ user: { id: result.insertId, username, role, is_active: 1 } });
  } catch (err) {
    await conn.rollback();
    if (isDuplicate(err)) {
      res.status(409).json({ error: `User "${username}" already exists` });
      return;
    }
    next(err);
  } finally {
    conn.release();
  }
});

usersRouter.put('/:id', async (req, res, next) => {
  const idResult = idParam.safeParse(req.params.id);
  if (!idResult.success) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const id = idResult.data;
  const { role, isActive, password } = parsed.data;
  if (role === undefined && isActive === undefined && password === undefined) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }
  const actor = req.user!;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.execute<UserRow[]>(
      'SELECT id, username, role, is_active FROM dashboard_users WHERE id = ? FOR UPDATE',
      [id],
    );
    const before = existing[0];
    if (!before) {
      await conn.rollback();
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const nextRole = role ?? before.role;
    const nextActive = isActive === undefined ? before.is_active === 1 : isActive;

    // Refuse any edit that would leave no active super admin at all.
    const losesAdmin = before.role === 'super_admin' && before.is_active === 1;
    const keepsAdmin = nextRole === 'super_admin' && nextActive;
    if (losesAdmin && !keepsAdmin && (await activeSuperAdmins(conn, id)) === 0) {
      await conn.rollback();
      res.status(409).json({
        error: 'This is the last active super admin. Promote another account first.',
      });
      return;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (role !== undefined) {
      sets.push('role = ?');
      params.push(role);
    }
    if (isActive !== undefined) {
      sets.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }
    if (password !== undefined) {
      sets.push('password_hash = ?');
      params.push(await bcrypt.hash(password, 12));
    }
    params.push(id);
    await conn.execute(`UPDATE dashboard_users SET ${sets.join(', ')} WHERE id = ?`, params);

    await recordAudit(
      {
        actorUserId: actor.id,
        actorUsername: actor.username,
        action: 'user_update',
        before: {
          username: before.username,
          role: before.role,
          is_active: before.is_active === 1,
        },
        after: {
          username: before.username,
          role: nextRole,
          is_active: nextActive,
          // Records that a reset happened without recording the secret.
          password_changed: password !== undefined,
        },
        ip: req.ip ?? null,
      },
      conn,
    );
    await conn.commit();
    res.json({
      user: { id, username: before.username, role: nextRole, is_active: nextActive ? 1 : 0 },
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

usersRouter.delete('/:id', async (req, res, next) => {
  const idResult = idParam.safeParse(req.params.id);
  if (!idResult.success) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const id = idResult.data;
  const actor = req.user!;

  if (id === actor.id) {
    res.status(409).json({ error: 'You cannot delete your own account' });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.execute<UserRow[]>(
      'SELECT id, username, role, is_active FROM dashboard_users WHERE id = ? FOR UPDATE',
      [id],
    );
    const before = existing[0];
    if (!before) {
      await conn.rollback();
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (
      before.role === 'super_admin' &&
      before.is_active === 1 &&
      (await activeSuperAdmins(conn, id)) === 0
    ) {
      await conn.rollback();
      res.status(409).json({
        error: 'This is the last active super admin. Promote another account first.',
      });
      return;
    }

    await conn.execute('DELETE FROM dashboard_users WHERE id = ?', [id]);
    await recordAudit(
      {
        actorUserId: actor.id,
        actorUsername: actor.username,
        action: 'user_delete',
        before: {
          username: before.username,
          role: before.role,
          is_active: before.is_active === 1,
        },
        ip: req.ip ?? null,
      },
      conn,
    );
    await conn.commit();
    res.json({ deleted: { id, username: before.username } });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});
