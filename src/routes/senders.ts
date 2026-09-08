import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { pool } from '../db';
import { recordAudit } from '../audit';
import { requireApiAuth } from '../auth';

export const sendersRouter = Router();
sendersRouter.use(requireApiAuth);

interface SenderRow extends RowDataPacket {
  Id: number;
  senderId: string;
  senderIdType: 'Transactional' | 'Promotional';
  csp: 'grant' | 'lazer' | null;
}

// Mirrors the column definitions exactly: senderId is varchar(12) UNIQUE,
// and both other columns are enums. Validating here turns what would be a
// raw MySQL error into a readable message.
const senderSchema = z.object({
  senderId: z
    .string()
    .trim()
    .min(1, 'Sender ID is required')
    .max(12, 'Sender ID cannot exceed 12 characters'),
  senderIdType: z.enum(['Transactional', 'Promotional']),
  csp: z.enum(['grant', 'lazer']),
});

const idParam = z.coerce.number().int().positive();

function clientIp(req: { ip?: string }): string | null {
  return req.ip ?? null;
}

/** MySQL duplicate-key errno, raised by the `uniques` index on senderId. */
function isDuplicate(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { errno?: number }).errno === 1062;
}

sendersRouter.get('/', async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const csp = typeof req.query.csp === 'string' ? req.query.csp : '';
    const type = typeof req.query.type === 'string' ? req.query.type : '';

    const where: string[] = [];
    const params: unknown[] = [];
    if (search !== '') {
      where.push('senderId LIKE ?');
      params.push(`%${search}%`);
    }
    if (csp === 'grant' || csp === 'lazer') {
      where.push('csp = ?');
      params.push(csp);
    }
    if (type === 'Transactional' || type === 'Promotional') {
      where.push('senderIdType = ?');
      params.push(type);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query<SenderRow[]>(
      `SELECT Id, senderId, senderIdType, csp FROM senderiddetails
       ${clause} ORDER BY senderId ASC`,
      params,
    );
    res.json({ senders: rows });
  } catch (err) {
    next(err);
  }
});

sendersRouter.post('/', async (req, res, next) => {
  const parsed = senderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const { senderId, senderIdType, csp } = parsed.data;
  const user = req.user!;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute<ResultSetHeader>(
      'INSERT INTO senderiddetails (senderId, senderIdType, csp) VALUES (?, ?, ?)',
      [senderId, senderIdType, csp],
    );
    const newId = result.insertId;
    await recordAudit(
      {
        actorUserId: user.id,
        actorUsername: user.username,
        action: 'create',
        senderRowId: newId,
        senderId,
        after: { senderId, senderIdType, csp },
        ip: clientIp(req),
      },
      conn,
    );
    await conn.commit();
    res.status(201).json({ sender: { Id: newId, senderId, senderIdType, csp } });
  } catch (err) {
    await conn.rollback();
    if (isDuplicate(err)) {
      res.status(409).json({ error: `Sender ID "${senderId}" already exists` });
      return;
    }
    next(err);
  } finally {
    conn.release();
  }
});

sendersRouter.put('/:id', async (req, res, next) => {
  const idResult = idParam.safeParse(req.params.id);
  if (!idResult.success) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const parsed = senderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const id = idResult.data;
  const { senderId, senderIdType, csp } = parsed.data;
  const user = req.user!;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock and capture the prior state so the audit row records what
    // actually changed, not what the client claimed was there.
    const [existing] = await conn.execute<SenderRow[]>(
      'SELECT Id, senderId, senderIdType, csp FROM senderiddetails WHERE Id = ? FOR UPDATE',
      [id],
    );
    const before = existing[0];
    if (!before) {
      await conn.rollback();
      res.status(404).json({ error: 'Sender ID not found' });
      return;
    }

    await conn.execute(
      'UPDATE senderiddetails SET senderId = ?, senderIdType = ?, csp = ? WHERE Id = ?',
      [senderId, senderIdType, csp, id],
    );
    await recordAudit(
      {
        actorUserId: user.id,
        actorUsername: user.username,
        action: 'update',
        senderRowId: id,
        senderId,
        before: {
          senderId: before.senderId,
          senderIdType: before.senderIdType,
          csp: before.csp,
        },
        after: { senderId, senderIdType, csp },
        ip: clientIp(req),
      },
      conn,
    );
    await conn.commit();
    res.json({ sender: { Id: id, senderId, senderIdType, csp } });
  } catch (err) {
    await conn.rollback();
    if (isDuplicate(err)) {
      res.status(409).json({ error: `Sender ID "${senderId}" already exists` });
      return;
    }
    next(err);
  } finally {
    conn.release();
  }
});

sendersRouter.delete('/:id', async (req, res, next) => {
  const idResult = idParam.safeParse(req.params.id);
  if (!idResult.success) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const id = idResult.data;
  const user = req.user!;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // The row is about to be gone for good, so snapshot it into the audit
    // trail first -- that log is the only remaining record it existed.
    const [existing] = await conn.execute<SenderRow[]>(
      'SELECT Id, senderId, senderIdType, csp FROM senderiddetails WHERE Id = ? FOR UPDATE',
      [id],
    );
    const before = existing[0];
    if (!before) {
      await conn.rollback();
      res.status(404).json({ error: 'Sender ID not found' });
      return;
    }

    await conn.execute('DELETE FROM senderiddetails WHERE Id = ?', [id]);
    await recordAudit(
      {
        actorUserId: user.id,
        actorUsername: user.username,
        action: 'delete',
        senderRowId: id,
        senderId: before.senderId,
        before: {
          senderId: before.senderId,
          senderIdType: before.senderIdType,
          csp: before.csp,
        },
        ip: clientIp(req),
      },
      conn,
    );
    await conn.commit();
    res.json({ deleted: { Id: id, senderId: before.senderId } });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});
