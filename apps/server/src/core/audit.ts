// Audit log: who did what, on what and from where.
import type { AuditEntry } from "@opengps/shared";
import type { Queryable } from "../db";

export async function audit(
  db: Queryable,
  actor: { orgId: string | null; userId: string | null; ip?: string | null },
  action: string,
  entity: string,
  entityId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO gps.audit_log (org_id, user_id, action, entity, entity_id, detail, ip) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [actor.orgId, actor.userId, action, entity, entityId, JSON.stringify(detail), actor.ip ?? null],
  );
}

/** An account's activity log, from most recent to oldest. */
export async function listAudit(db: Queryable, orgId: string, opts: { limit: number; before?: number | undefined }): Promise<AuditEntry[]> {
  const r = await db.query<{ id: number; at: Date; user_name: string | null; action: string; entity: string | null; detail: Record<string, unknown> }>(
    `SELECT a.id, a.at, u.name AS user_name, a.action, a.entity, a.detail
       FROM gps.audit_log a
       LEFT JOIN auth."user" u ON u.id = a.user_id
      WHERE a.org_id = $1 AND ($2::bigint IS NULL OR a.id < $2)
      ORDER BY a.id DESC
      LIMIT $3`,
    [orgId, opts.before ?? null, opts.limit],
  );
  // What the platform administration does is shown without a personal name.
  return r.rows.map((e) => ({
    id: e.id,
    at: e.at.toISOString(),
    userName: e.action.startsWith("admin.") ? null : e.user_name,
    action: e.action,
    entity: e.entity,
    detail: e.detail,
  }));
}

/** What was done from the platform's administration, in any account or in none, from most recent to oldest. */
export async function listPlatformAudit(db: Queryable, opts: { limit: number; before?: number | undefined }): Promise<AuditEntry[]> {
  const r = await db.query<{ id: number; at: Date; user_name: string | null; action: string; entity: string | null; detail: Record<string, unknown> }>(
    `SELECT a.id, a.at, u.name AS user_name, a.action, a.entity, a.detail
       FROM gps.audit_log a
       LEFT JOIN auth."user" u ON u.id = a.user_id
      WHERE (a.org_id IS NULL OR a.action LIKE 'admin.%') AND ($1::bigint IS NULL OR a.id < $1)
      ORDER BY a.id DESC
      LIMIT $2`,
    [opts.before ?? null, opts.limit],
  );
  return r.rows.map((e) => ({ id: e.id, at: e.at.toISOString(), userName: e.user_name, action: e.action, entity: e.entity, detail: e.detail }));
}
