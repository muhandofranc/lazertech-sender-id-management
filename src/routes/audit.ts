import { Router } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { pool } from '../db';
import { requireApiAuth, requireSuperAdmin } from '../auth';

export const auditRouter = Router();
// The audit trail is visible to super admins only.
auditRouter.use(requireApiAuth, requireSuperAdmin);

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

auditRouter.get('/', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid pagination parameters' });
      return;
    }
    const { limit, offset } = parsed.data;

    const [countRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM sender_audit_log',
    );
    const total = Number(countRows[0]?.n ?? 0);

    // LIMIT/OFFSET are interpolated rather than bound because MySQL will
    // not accept placeholders there in a prepared statement. Both values
    // are already coerced to bounded integers by the schema above.
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, actor_username, action, sender_row_id, sender_id,
              before_json, after_json, ip, created_at
         FROM sender_audit_log
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}`,
    );
    res.json({ entries: rows, total, limit, offset });
  } catch (err) {
    next(err);
  }
});
