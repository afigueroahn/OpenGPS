// What a person can do and see within an account.
//
// Account membership is stored by the session library (auth.member). The
// owner and administrators can do and see everything. Everyone else has a role
// (operator, reader or a custom one) and, optionally, a scope: the list
// of vehicle groups they can see.
import { ALL_MODULES, ALL_PERMISSIONS, BUILTIN_ROLES, type Language, type ModuleKey, OWNER_ROLE, type Permission, type RoleInfo } from "@opengps/shared";
import { knownLanguage } from "../i18n";
import type { Queryable } from "../db";
import { forbidden } from "../errors";
import { say, tr } from "../i18n";

/** Account and scope used to query any data. */
export interface Tenant {
  orgId: string;
  /** Visible groups; null = all. */
  groups: string[] | null;
  /** Vehicles visible one by one, besides those of the groups. Only counts when `groups` is not null. */
  vehicles: string[];
}

export interface Access extends Tenant {
  orgName: string;
  role: string;
  roleName: string;
  permissions: Permission[];
  /** The platform suspended the account. */
  suspended: boolean;
  /** Optional modules enabled on the account. */
  modules: ModuleKey[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/** The roles the platform comes with: the owner, administrator, operator and reader. */
type BuiltinId = "owner" | "admin" | "operator" | "viewer";
/** A role of the platform, with its name and description in a language. */
const worded = (role: RoleInfo, language: Language): RoleInfo => ({
  ...role,
  name: tr(language, `shared.role.${role.id as BuiltinId}`),
  description: tr(language, `shared.roleDescription.${role.id as BuiltinId}`),
});
/** The name of a role in a language: the platform's are translated, a custom one is called as the account named it. */
export const roleNameIn = (role: Pick<RoleInfo, "id" | "name" | "builtin">, language: Language): string =>
  role.builtin ? tr(language, `shared.role.${role.id as BuiltinId}`) : role.name;
const builtin = (id: string, language: Language): RoleInfo | undefined => {
  const found = id === "owner" ? OWNER_ROLE : BUILTIN_ROLES.find((r) => r.id === id);
  return found ? worded(found, language) : undefined;
};
const knownPermissions = (list: string[]): Permission[] => ALL_PERMISSIONS.filter((p) => list.includes(p));
const custom = (row: { id: string; name: string; permissions: string[] }, language: Language): RoleInfo => ({
  id: row.id,
  name: row.name,
  description: tr(language, "core.access.customRole"),
  permissions: knownPermissions(row.permissions),
  builtin: false,
});

/** Roles available in an account: the platform's and the custom ones, described in the reader's language. */
export async function listRoles(db: Queryable, orgId: string, language: Language): Promise<RoleInfo[]> {
  const r = await db.query<{ id: string; name: string; permissions: string[] }>(
    `SELECT id, name, permissions FROM gps.roles WHERE org_id = $1 ORDER BY lower(name)`,
    [orgId],
  );
  return [...BUILTIN_ROLES.map((role) => worded(role, language)), ...r.rows.map((x) => custom(x, language))];
}

/** Resolves a stored role to its name and permissions. A deleted role is equivalent to reader. */
export async function resolveRole(db: Queryable, orgId: string, role: string, language: Language): Promise<RoleInfo> {
  const known = builtin(role, language);
  if (known) return known;
  if (isUuid(role)) {
    const r = await db.query<{ id: string; name: string; permissions: string[] }>(
      `SELECT id, name, permissions FROM gps.roles WHERE org_id = $1 AND id = $2`,
      [orgId, role],
    );
    const found = r.rows[0];
    if (found) return custom(found, language);
  }
  return builtin("viewer", language) as RoleInfo;
}

/** Effective role of a member from what the two tables store. */
export function effectiveRole(baRole: string, accessRole: string | null): string {
  if (baRole === "owner") return "owner";
  if (baRole === "admin") return "admin";
  return accessRole && accessRole !== "admin" ? accessRole : "viewer";
}

/** The language a person chose, or null if they chose none. */
export async function chosenLanguage(db: Queryable, userId: string): Promise<Language | null> {
  const r = await db.query<{ language: string | null }>(`SELECT language FROM gps.user_settings WHERE user_id = $1`, [userId]);
  return knownLanguage(r.rows[0]?.language);
}

/**
 * Makes the first person who signed up and confirmed their email the owner of
 * the platform, if it has none yet. Returns whether it has one now.
 */
export async function claimPlatformOwner(db: Queryable): Promise<boolean> {
  await db.query(
    `INSERT INTO gps.platform_owners (user_id)
     SELECT id FROM auth."user" WHERE "emailVerified" AND NOT EXISTS (SELECT 1 FROM gps.platform_owners) ORDER BY "createdAt", id LIMIT 1
     ON CONFLICT DO NOTHING`,
  );
  const r = await db.query(`SELECT 1 FROM gps.platform_owners LIMIT 1`);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Whether the platform is waiting for its first account with no mail to confirm it: nobody runs it yet and no
 * outgoing mail is set up. That account then comes in without confirming its email; it becomes the owner and sets
 * up the mail from the console.
 */
export async function firstAccountWithoutMail(db: Queryable, smtpHost: string): Promise<boolean> {
  if (smtpHost) return false;
  const r = await db.query<{ taken: boolean }>(`SELECT EXISTS (SELECT 1 FROM gps.platform_owners) OR EXISTS (SELECT 1 FROM auth."user" WHERE "emailVerified") AS taken`);
  return r.rows[0]?.taken === false;
}

/** Whether the person administers the whole platform. */
export async function isPlatformOwner(db: Queryable, userId: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM gps.platform_owners WHERE user_id = $1`, [userId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * A person's access. Uses the preferred account if they belong to it and are not
 * blocked there; otherwise, the last one they joined. Null if they have none.
 * The role's name comes in `language`.
 */
export async function resolveAccess(db: Queryable, userId: string, preferredOrgId: string | null, language: Language): Promise<Access | null> {
  const r = await db.query<{
    id: string;
    name: string;
    ba_role: string;
    access_role: string | null;
    group_scope: string[] | null;
    vehicle_scope: string[] | null;
    suspended: boolean;
    modules: string[];
  }>(
    `SELECT o.id, o.name, m.role AS ba_role, a.role AS access_role, gps.groups_with_children(a.group_scope) AS group_scope, a.vehicle_scope,
            COALESCE(st.suspended, false) AS suspended, COALESCE(st.modules, '{}') AS modules
       FROM auth.member m
       JOIN auth.organization o ON o.id = m."organizationId"
       LEFT JOIN gps.member_access a ON a.org_id = o.id AND a.user_id = m."userId"
       LEFT JOIN gps.account_settings st ON st.org_id = o.id
      WHERE m."userId" = $1 AND NOT COALESCE(a.disabled, false)
      ORDER BY (o.id = $2) DESC, m."createdAt" DESC, m.id
      LIMIT 1`,
    [userId, preferredOrgId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const roleId = effectiveRole(row.ba_role, row.access_role);
  const role = await resolveRole(db, row.id, roleId, language);
  const unrestricted = roleId === "owner" || roleId === "admin";
  return {
    orgId: row.id,
    orgName: row.name,
    role: role.id,
    roleName: role.name,
    permissions: role.permissions,
    groups: unrestricted ? null : row.group_scope,
    vehicles: unrestricted || row.group_scope === null ? [] : (row.vehicle_scope ?? []),
    suspended: row.suspended,
    modules: ALL_MODULES.filter((m) => row.modules.includes(m)),
  };
}

/** Accounts a person belongs to and in which they are not blocked. */
export async function listAccounts(db: Queryable, userId: string): Promise<{ id: string; name: string }[]> {
  const r = await db.query<{ id: string; name: string }>(
    `SELECT o.id, o.name
       FROM auth.member m
       JOIN auth.organization o ON o.id = m."organizationId"
       LEFT JOIN gps.member_access a ON a.org_id = o.id AND a.user_id = m."userId"
      WHERE m."userId" = $1 AND NOT COALESCE(a.disabled, false)
      ORDER BY m."createdAt", m.id`,
    [userId],
  );
  return r.rows;
}

export function requirePermission(access: Pick<Access, "permissions">, permission: Permission): void {
  if (!access.permissions.includes(permission)) throw forbidden(say("core.access.notAllowed"));
}

/** The whole account, for what the platform does on its own or on behalf of someone who sees it all. */
export const wholeAccount = (orgId: string): Tenant => ({ orgId, groups: null, vehicles: [] });

/** For what affects the whole account, such as managing groups. */
export function requireUnrestricted(tenant: Pick<Tenant, "groups">): void {
  if (tenant.groups !== null) throw forbidden(say("core.access.allGroupsOnly"));
}

/**
 * What `scopeSql` takes as its parameter: the groups and the single vehicles
 * the person sees, in one list, or null when they see everything. Identifiers
 * are unique across both tables, so one list serves both comparisons.
 */
export const scopeParam = (tenant: Pick<Tenant, "groups" | "vehicles">): string[] | null => (tenant.groups === null ? null : [...tenant.groups, ...tenant.vehicles]);

/** SQL scope condition on the vehicles table `v`, with `scopeParam` in parameter `n`. */
export const scopeSql = (n: number) => `($${n}::uuid[] IS NULL OR v.group_id = ANY($${n}::uuid[]) OR v.id = ANY($${n}::uuid[]))`;

/** Whether a person sees a vehicle, for what is decided in memory instead of in a query. */
export const seesVehicle = (tenant: Pick<Tenant, "groups" | "vehicles">, vehicle: { id: string; groupId: string | null }): boolean =>
  tenant.groups === null || (vehicle.groupId !== null && tenant.groups.includes(vehicle.groupId)) || tenant.vehicles.includes(vehicle.id);
