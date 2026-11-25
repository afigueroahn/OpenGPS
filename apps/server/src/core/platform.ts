// Administration of the whole platform: all accounts, their suspension,
// their quotas and their modules. Used only by platform administrators.
import { statfs } from "node:fs/promises";
import { ALL_MODULES, type AdminAccount, type AdminAccountDetail, type AdminUser, type ModuleKey, type PlatformStats, SIGN_IN_METHODS, type SignInMethod } from "@opengps/shared";
import type { Bus } from "../bus";
import type { Config } from "../config";
import { type Db, type Queryable, withTransaction } from "../db";
import { forbidden, notFound, tooMany } from "../errors";
import { say } from "../i18n";
import { effectiveRole } from "./access";
import { audit } from "./audit";

export interface PlatformDeps {
  db: Db;
  bus: Bus;
  config: Pick<Config, "filesDir">;
}

/** Whoever administers the platform; their actions are logged in the affected account's audit. */
export interface PlatformActor {
  userId: string;
  ip?: string | null;
}

// ─── Quotas ──────────────────────────────────────────────────────────────────

interface Limits {
  max_vehicles: number | null;
  max_users: number | null;
}

async function limitsOf(db: Queryable, orgId: string): Promise<Limits> {
  const r = await db.query<Limits>(`SELECT max_vehicles, max_users FROM gps.account_settings WHERE org_id = $1`, [orgId]);
  return r.rows[0] ?? { max_vehicles: null, max_users: null };
}

/** With no quota defined there is no limit. */
export async function assertVehicleQuota(db: Queryable, orgId: string): Promise<void> {
  const { max_vehicles } = await limitsOf(db, orgId);
  if (max_vehicles === null) return;
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.vehicles WHERE org_id = $1`, [orgId]);
  if ((r.rows[0]?.n ?? 0) >= max_vehicles) {
    throw tooMany(say("core.platform.vehicleQuota", { count: max_vehicles }));
  }
}

/** Counts members and pending invitations. */
export async function assertUserQuota(db: Queryable, orgId: string): Promise<void> {
  const { max_users } = await limitsOf(db, orgId);
  if (max_users === null) return;
  const r = await db.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM auth.member WHERE "organizationId" = $1)::int
          + (SELECT count(*) FROM auth.invitation WHERE "organizationId" = $1 AND status = 'pending' AND "expiresAt" > now())::int AS n`,
    [orgId],
  );
  if ((r.rows[0]?.n ?? 0) >= max_users) {
    throw tooMany(say("core.platform.userQuota", { count: max_users }));
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  name: string;
  createdAt: Date;
  owner_name: string | null;
  owner_email: string | null;
  owner_sign_in_method: string | null;
  owner_last_seen_at: Date | null;
  users: number;
  vehicles: number;
  active_devices: number;
  last_seen_at: Date | null;
  suspended: boolean;
  suspended_reason: string | null;
  max_vehicles: number | null;
  max_users: number | null;
  modules: string[];
}

const ACCOUNT_SELECT = `
  SELECT o.id, o.name, o."createdAt", ow.name AS owner_name, ow.email AS owner_email,
         ow.sign_in_method AS owner_sign_in_method, ow.last_seen_at AS owner_last_seen_at,
         (SELECT count(*) FROM auth.member m WHERE m."organizationId" = o.id)::int AS users,
         (SELECT count(*) FROM gps.vehicles v WHERE v.org_id = o.id)::int AS vehicles,
         (SELECT count(*) FROM gps.devices d WHERE d.org_id = o.id AND d.status = 'active')::int AS active_devices,
         (SELECT max(s.last_seen_at) FROM gps.devices d JOIN gps.device_state s ON s.device_id = d.id WHERE d.org_id = o.id) AS last_seen_at,
         COALESCE(st.suspended, false) AS suspended, st.suspended_reason, st.max_vehicles, st.max_users,
         COALESCE(st.modules, '{}') AS modules
    FROM auth.organization o
    LEFT JOIN LATERAL (
      SELECT u.name, u.email, us.sign_in_method, us.last_seen_at
        FROM auth.member m JOIN auth."user" u ON u.id = m."userId" LEFT JOIN gps.user_settings us ON us.user_id = u.id
       WHERE m."organizationId" = o.id AND m.role = 'owner' ORDER BY m."createdAt" LIMIT 1
    ) ow ON true
    LEFT JOIN gps.account_settings st ON st.org_id = o.id`;

/** What is stored, if it is a way of signing in the platform knows. */
const signInMethod = (stored: string | null): SignInMethod | null => SIGN_IN_METHODS.find((m) => m === stored) ?? null;

function toAccount(r: AccountRow): AdminAccount {
  return {
    id: r.id,
    name: r.name,
    ownerName: r.owner_name,
    ownerEmail: r.owner_email,
    ownerSignInMethod: signInMethod(r.owner_sign_in_method),
    ownerLastAccessAt: r.owner_last_seen_at ? r.owner_last_seen_at.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    users: r.users,
    vehicles: r.vehicles,
    activeDevices: r.active_devices,
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    suspended: r.suspended,
    suspendedReason: r.suspended_reason,
    limits: { maxVehicles: r.max_vehicles, maxUsers: r.max_users },
    modules: ALL_MODULES.filter((m) => r.modules.includes(m)),
  };
}

export async function listAllAccounts(db: Queryable, opts: { search: string; limit: number; offset: number }): Promise<AdminAccount[]> {
  const r = await db.query<AccountRow>(
    `${ACCOUNT_SELECT}
      WHERE $1 = '' OR o.name ILIKE '%' || $1 || '%' OR ow.email ILIKE '%' || $1 || '%'
      ORDER BY o."createdAt" DESC, o.id
      LIMIT $2 OFFSET $3`,
    [opts.search.replace(/[%_\\]/g, "\\$&"), opts.limit, opts.offset],
  );
  return r.rows.map(toAccount);
}

export async function getAccountDetail(db: Queryable, id: string): Promise<AdminAccountDetail> {
  const r = await db.query<AccountRow>(`${ACCOUNT_SELECT} WHERE o.id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound(say("core.platform.accountNotFound"));
  const members = await db.query<{
    id: string;
    name: string;
    email: string;
    ba_role: string;
    access_role: string | null;
    banned: boolean | null;
    platform_owner: boolean;
    sign_in_method: string | null;
    last_seen_at: Date | null;
  }>(
    `SELECT u.id, u.name, u.email, m.role AS ba_role, a.role AS access_role, u.banned, EXISTS (SELECT 1 FROM gps.platform_owners p WHERE p.user_id = u.id) AS platform_owner,
            us.sign_in_method, us.last_seen_at
       FROM auth.member m
       JOIN auth."user" u ON u.id = m."userId"
       LEFT JOIN gps.member_access a ON a.org_id = m."organizationId" AND a.user_id = u.id
       LEFT JOIN gps.user_settings us ON us.user_id = u.id
      WHERE m."organizationId" = $1
      ORDER BY (m.role = 'owner') DESC, m."createdAt"`,
    [id],
  );
  return {
    ...toAccount(row),
    members: members.rows.map(
      (m): AdminUser => ({
        id: m.id,
        name: m.name,
        email: m.email,
        role: effectiveRole(m.ba_role, m.access_role),
        banned: m.banned === true,
        platformOwner: m.platform_owner,
        signInMethod: signInMethod(m.sign_in_method),
        lastAccessAt: m.last_seen_at ? m.last_seen_at.toISOString() : null,
      }),
    ),
    ownedByPlatformOwner: members.rows.some((m) => m.ba_role === "owner" && m.platform_owner),
  };
}

export async function platformStats(deps: PlatformDeps): Promise<PlatformStats> {
  const r = await deps.db.core.query<{
    accounts: number;
    suspended: number;
    users: number;
    vehicles: number;
    active: number;
    pending: number;
    reporting: number;
    today: number;
  }>(
    `SELECT (SELECT count(*) FROM auth.organization)::int AS accounts,
            (SELECT count(*) FROM gps.account_settings WHERE suspended)::int AS suspended,
            (SELECT count(*) FROM auth."user")::int AS users,
            (SELECT count(*) FROM gps.vehicles)::int AS vehicles,
            (SELECT count(*) FROM gps.devices WHERE status = 'active')::int AS active,
            (SELECT count(*) FROM gps.devices WHERE status = 'pending')::int AS pending,
            (SELECT count(*) FROM gps.device_state WHERE last_seen_at > now() - interval '10 minutes')::int AS reporting,
            (SELECT count(*) FROM gps.positions WHERE fix_time >= date_trunc('day', now()))::int AS today`,
  );
  const row = r.rows[0];
  let diskUsedPercent: number | null = null;
  try {
    const disk = await statfs(deps.config.filesDir);
    diskUsedPercent = Math.round((1 - disk.bavail / disk.blocks) * 100);
  } catch {
    /* in development the folder may not exist */
  }
  return {
    accounts: row?.accounts ?? 0,
    suspendedAccounts: row?.suspended ?? 0,
    users: row?.users ?? 0,
    vehicles: row?.vehicles ?? 0,
    activeDevices: row?.active ?? 0,
    pendingDevices: row?.pending ?? 0,
    reportingNow: row?.reporting ?? 0,
    positionsToday: row?.today ?? 0,
    diskUsedPercent,
  };
}

// ─── Changes ─────────────────────────────────────────────────────────────────

export async function updateAccount(
  deps: PlatformDeps,
  actor: PlatformActor,
  id: string,
  patch: {
    suspended?: boolean | undefined;
    suspendedReason?: string | undefined;
    maxVehicles?: number | null | undefined;
    maxUsers?: number | null | undefined;
    modules?: ModuleKey[] | undefined;
  },
): Promise<AdminAccountDetail> {
  await getAccountDetail(deps.db.core, id);
  await withTransaction(deps.db.core, async (client) => {
    await client.query(`INSERT INTO gps.account_settings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`, [id]);
    await client.query(
      `UPDATE gps.account_settings SET
         suspended        = COALESCE($2, suspended),
         suspended_reason = CASE WHEN $2 IS NULL THEN suspended_reason WHEN $2 THEN $3 ELSE NULL END,
         max_vehicles     = CASE WHEN $4 THEN $5::int ELSE max_vehicles END,
         max_users        = CASE WHEN $6 THEN $7::int ELSE max_users END,
         modules          = COALESCE($8::text[], modules),
         updated_at       = now()
       WHERE org_id = $1`,
      [
        id,
        patch.suspended ?? null,
        patch.suspendedReason?.trim() || null,
        patch.maxVehicles !== undefined,
        patch.maxVehicles ?? null,
        patch.maxUsers !== undefined,
        patch.maxUsers ?? null,
        patch.modules ?? null,
      ],
    );
    const action = patch.suspended === true ? "admin.account_suspend" : patch.suspended === false ? "admin.account_unsuspend" : "admin.account_update";
    await audit(client, { orgId: id, userId: actor.userId, ip: actor.ip ?? null }, action, "account", id, patch);
  });

  // Anyone connected to that account reconnects with the new conditions.
  if (patch.modules !== undefined) deps.bus.emit("modules_changed", { orgId: id });
  if (patch.suspended !== undefined || patch.modules !== undefined) {
    const members = await deps.db.core.query<{ userId: string }>(`SELECT "userId" FROM auth.member WHERE "organizationId" = $1`, [id]);
    for (const m of members.rows) deps.bus.emit("access_changed", { orgId: id, userId: m.userId });
  }
  return getAccountDetail(deps.db.core, id);
}

/** Suspends or reactivates a person across the whole platform. On suspension their sessions are closed. */
export async function setUserBanned(deps: PlatformDeps, actor: PlatformActor, userId: string, banned: boolean, reason: string | null): Promise<void> {
  if (userId === actor.userId) throw forbidden(say("core.platform.notYourself"));
  await withTransaction(deps.db.core, async (client) => {
    const r = await client.query<{ email: string }>(
      `UPDATE auth."user" SET banned = $2, "banReason" = $3, "banExpires" = NULL WHERE id = $1 RETURNING email`,
      [userId, banned, banned ? reason : null],
    );
    const row = r.rows[0];
    if (!row) throw notFound(say("core.platform.userNotFound"));
    if (banned) await client.query(`DELETE FROM auth.session WHERE "userId" = $1`, [userId]);
    await audit(client, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, banned ? "admin.user_ban" : "admin.user_unban", "user", userId, {
      email: row.email,
      ...(reason ? { reason } : {}),
    });
  });
  if (banned) {
    const orgs = await deps.db.core.query<{ organizationId: string }>(`SELECT "organizationId" FROM auth.member WHERE "userId" = $1`, [userId]);
    for (const o of orgs.rows) deps.bus.emit("access_changed", { orgId: o.organizationId, userId });
  }
}
