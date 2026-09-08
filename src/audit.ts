import type { PoolConnection } from 'mysql2/promise';
import { pool } from './db';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'login'
  | 'login_failed'
  | 'user_create'
  | 'user_update'
  | 'user_delete';

export interface AuditEntry {
  actorUserId: number | null;
  actorUsername: string;
  action: AuditAction;
  senderRowId?: number | null;
  senderId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/**
 * Writes one audit row. Pass `conn` to enlist in the caller's transaction
 * so a sender change and its audit row commit together or not at all.
 */
export async function recordAudit(
  entry: AuditEntry,
  conn?: PoolConnection,
): Promise<void> {
  const executor = conn ?? pool;
  await executor.execute(
    `INSERT INTO sender_audit_log
       (actor_user_id, actor_username, action, sender_row_id, sender_id,
        before_json, after_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.actorUserId,
      entry.actorUsername,
      entry.action,
      entry.senderRowId ?? null,
      entry.senderId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.ip ?? null,
    ],
  );
}
