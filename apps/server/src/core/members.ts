// Users of an account: invitations, roles, group scope and blocking.
import { randomBytes } from "node:crypto";
import type { InvitationPreview, Language, Member, PendingInvitation, RoleInfo } from "@opengps/shared";
import type { Bus } from "../bus";
import type { Config } from "../config";
import { type Db, type Queryable, withTransaction } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { say, tr } from "../i18n";
import type { Mailer } from "../mail";
import { effectiveRole, isUuid, listRoles, resolveRole, roleNameIn } from "./access";
import { audit } from "./audit";
import { writeMail } from "./mail-templates";
import { assertUserQuota } from "./platform";
import type { Actor } from "./vehicles";

export interface MemberDeps {
  db: Db;
  bus: Bus;
  mailer: Mailer;
  config: Pick<Config, "appName" | "publicUrl" | "defaultLanguage" | "mailTemplates">;
}

const INVITATION_DAYS = 7;
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "23505";

/** The role must be a platform role or a custom role of this account. Its name comes in `language`. */
async function assertRole(db: Queryable, orgId: string, role: string, language: Language): Promise<RoleInfo> {
  const roles = await listRoles(db, orgId, language);
  const found = roles.find((r) => r.id === role);
  if (!found) throw badRequest(say("core.members.roleNotFound"));
  return found;
}

/** The scope's groups must belong to this account. Returns the list without duplicates. */
async function assertGroups(db: Queryable, orgId: string, groups: string[] | null): Promise<string[] | null> {
  if (groups === null) return null;
  const unique = [...new Set(groups)];
  if (unique.length === 0) return [];
  const r = await db.query<{ id: string }>(`SELECT id FROM gps.vehicle_groups WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, unique]);
  if (r.rowCount !== unique.length) throw badRequest(say("core.members.groupsNotFound"));
  return unique;
}

/** The scope's single vehicles must belong to this account. Returns the list without duplicates. */
async function assertVehicles(db: Queryable, orgId: string, vehicles: string[]): Promise<string[]> {
  const unique = [...new Set(vehicles)];
  if (unique.length === 0) return [];
  const r = await db.query(`SELECT 1 FROM gps.vehicles WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, unique]);
  if (r.rowCount !== unique.length) throw badRequest(say("core.members.vehiclesNotFound"));
  return unique;
}

/** The administrator sees everything: a scope only applies to the other roles. */
const scopeFor = (role: string, groups: string[] | null) => (role === "admin" ? null : groups);
/** Single vehicles only count for someone who does not already see everything. */
const vehiclesFor = (groups: string[] | null, vehicles: string[] | null | undefined) => (groups === null ? [] : (vehicles ?? []));

// ─── Reading ─────────────────────────────────────────────────────────────────

export async function listMembers(db: Queryable, orgId: string, meUserId: string, language: Language): Promise<Member[]> {
  const roles = [...(await listRoles(db, orgId, language))];
  const r = await db.query<{
    id: string;
    name: string;
    email: string;
    ba_role: string;
    createdAt: Date;
    access_role: string | null;
    group_scope: string[] | null;
    vehicle_scope: string[] | null;
    disabled: boolean;
  }>(
    `SELECT u.id, u.name, u.email, m.role AS ba_role, m."createdAt", a.role AS access_role, a.group_scope, a.vehicle_scope, COALESCE(a.disabled, false) AS disabled
       FROM auth.member m
       JOIN auth."user" u ON u.id = m."userId"
       LEFT JOIN gps.member_access a ON a.org_id = m."organizationId" AND a.user_id = u.id
      WHERE m."organizationId" = $1
      ORDER BY (m.role = 'owner') DESC, m."createdAt", u.id`,
    [orgId],
  );
  return r.rows.map((m) => {
    const role = effectiveRole(m.ba_role, m.access_role);
    const unrestricted = role === "owner" || role === "admin";
    return {
      userId: m.id,
      name: m.name,
      email: m.email,
      role,
      roleName: role === "owner" ? tr(language, "shared.role.owner") : (roles.find((x) => x.id === role)?.name ?? tr(language, "shared.role.viewer")),
      groups: unrestricted ? null : m.group_scope,
      vehicles: vehiclesFor(unrestricted ? null : m.group_scope, m.vehicle_scope),
      disabled: m.disabled,
      joinedAt: m.createdAt.toISOString(),
      isYou: m.id === meUserId,
    };
  });
}

export async function listInvitations(db: Queryable, orgId: string, language: Language): Promise<PendingInvitation[]> {
  const roles = await listRoles(db, orgId, language);
  const r = await db.query<{ id: string; email: string; expiresAt: Date; role: string | null; group_scope: string[] | null; vehicle_scope: string[] | null }>(
    `SELECT i.id, i.email, i."expiresAt", a.role, a.group_scope, a.vehicle_scope
       FROM auth.invitation i
       LEFT JOIN gps.invitation_access a ON a.invitation_id = i.id
      WHERE i."organizationId" = $1 AND i.status = 'pending' AND i."expiresAt" > now()
      ORDER BY i."createdAt" DESC`,
    [orgId],
  );
  return r.rows.map((i) => {
    const role = i.role ?? "viewer";
    return {
      id: i.id,
      email: i.email,
      role,
      roleName: roles.find((x) => x.id === role)?.name ?? tr(language, "shared.role.viewer"),
      groups: scopeFor(role, i.group_scope),
      vehicles: vehiclesFor(scopeFor(role, i.group_scope), i.vehicle_scope),
      expiresAt: i.expiresAt.toISOString(),
    };
  });
}

/** What whoever opens an invitation link sees, before entering. */
export async function previewInvitation(db: Queryable, id: string, language: Language): Promise<InvitationPreview> {
  const r = await db.query<{ email: string; status: string; expiresAt: Date; org_id: string; org: string; inviter: string; role: string | null }>(
    `SELECT i.email, i.status, i."expiresAt", o.id AS org_id, o.name AS org, u.name AS inviter, a.role
       FROM auth.invitation i
       JOIN auth.organization o ON o.id = i."organizationId"
       JOIN auth."user" u ON u.id = i."inviterId"
       LEFT JOIN gps.invitation_access a ON a.invitation_id = i.id
      WHERE i.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw notFound(say("core.members.invitationNotFound"));
  const role = await resolveRole(db, row.org_id, row.role ?? "viewer", language);
  const status = row.status === "pending" ? (row.expiresAt.getTime() > Date.now() ? "pending" : "expired") : row.status === "accepted" ? "accepted" : "canceled";
  return { accountName: row.org, email: row.email, inviterName: row.inviter, roleName: role.name, status };
}

// ─── Invitations ─────────────────────────────────────────────────────────────

/** `language` is the one of whoever invites: the invitation they get back names the role in it. */
export async function invite(
  deps: MemberDeps,
  actor: Actor & { userName: string; orgName: string },
  input: { email: string; role: string; groups: string[] | null; vehicles?: string[] | undefined },
  language: Language,
): Promise<PendingInvitation> {
  const role = await assertRole(deps.db.core, actor.orgId, input.role, language);
  const groups = scopeFor(role.id, await assertGroups(deps.db.core, actor.orgId, input.groups));
  const vehicles = vehiclesFor(groups, await assertVehicles(deps.db.core, actor.orgId, input.vehicles ?? []));

  const member = await deps.db.core.query(
    `SELECT 1 FROM auth.member m JOIN auth."user" u ON u.id = m."userId" WHERE m."organizationId" = $1 AND lower(u.email) = $2`,
    [actor.orgId, input.email],
  );
  if (member.rowCount) throw conflict("already_member", say("core.members.alreadyMember"));
  await assertUserQuota(deps.db.core, actor.orgId);

  const id = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_DAYS * 24 * 60 * 60 * 1000);
  await withTransaction(deps.db.core, async (client) => {
    // A new invitation to the same email replaces the previous one.
    await client.query(
      `UPDATE auth.invitation SET status = 'canceled' WHERE "organizationId" = $1 AND lower(email) = $2 AND status = 'pending'`,
      [actor.orgId, input.email],
    );
    await client.query(
      `INSERT INTO auth.invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [id, actor.orgId, input.email, role.id === "admin" ? "admin" : "member", expiresAt, actor.userId],
    );
    await client.query(`INSERT INTO gps.invitation_access (invitation_id, org_id, role, group_scope, vehicle_scope) VALUES ($1, $2, $3, $4::uuid[], $5::uuid[])`, [
      id,
      actor.orgId,
      role.id,
      groups,
      vehicles,
    ]);
    // The log keeps the role's name: it is read later, by others.
    await audit(client, actor, "member.invite", "member", input.email, { email: input.email, role: roleNameIn(role, deps.config.defaultLanguage) }); // i18n: stored text
  });

  // Whoever is invited most likely reads the language of whoever invites them.
  const mail = language;
  const words = { inviter: actor.userName, account: actor.orgName, app: deps.config.appName, role: roleNameIn(role, mail), days: INVITATION_DAYS };
  void deps.mailer
    .send({ to: input.email, ...writeMail(deps.config.mailTemplates, "invitation", mail, words, `${deps.config.publicUrl}/invitation?id=${id}`) })
    .catch((err) => console.error("[mail] could not send the invitation:", err.message));

  return { id, email: input.email, role: role.id, roleName: role.name, groups, vehicles, expiresAt: expiresAt.toISOString() };
}

export async function cancelInvitation(deps: MemberDeps, actor: Actor, id: string): Promise<void> {
  await withTransaction(deps.db.core, async (client) => {
    const r = await client.query<{ email: string }>(
      `UPDATE auth.invitation SET status = 'canceled' WHERE id = $1 AND "organizationId" = $2 AND status = 'pending' RETURNING email`,
      [id, actor.orgId],
    );
    const row = r.rows[0];
    if (!row) throw notFound(say("core.members.invitationNotPending"));
    await audit(client, actor, "member.invite_cancel", "member", row.email, { email: row.email });
  });
}

/**
 * Sets up the access of someone who just accepted an invitation. The
 * account membership is created by the session library; here the role
 * and scope that were promised to them are copied.
 */
export async function applyInvitationAccess(deps: MemberDeps, userId: string, invitationId: string): Promise<string> {
  return withTransaction(deps.db.core, async (client) => {
    const r = await client.query<{ org_id: string; role: string; group_scope: string[] | null; vehicle_scope: string[] | null; email: string }>(
      `SELECT a.org_id, a.role, a.group_scope, a.vehicle_scope, i.email
         FROM auth.invitation i JOIN gps.invitation_access a ON a.invitation_id = i.id
        WHERE i.id = $1 AND i.status = 'accepted'`,
      [invitationId],
    );
    const row = r.rows[0];
    if (!row) throw notFound(say("core.members.invitationInvalid"));
    await client.query(
      `INSERT INTO gps.member_access (org_id, user_id, role, group_scope, vehicle_scope) VALUES ($1, $2, $3, $4::uuid[], $5::uuid[])
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, group_scope = EXCLUDED.group_scope, vehicle_scope = EXCLUDED.vehicle_scope, disabled = false, updated_at = now()`,
      [row.org_id, userId, row.role, scopeFor(row.role, row.group_scope), vehiclesFor(scopeFor(row.role, row.group_scope), row.vehicle_scope)],
    );
    await rememberAccount(client, userId, row.org_id);
    await audit(client, { orgId: row.org_id, userId }, "member.join", "member", userId, { email: row.email });
    return row.org_id;
  });
}

export async function rememberAccount(db: Queryable, userId: string, orgId: string): Promise<void> {
  await db.query(
    `INSERT INTO gps.user_settings (user_id, last_org_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET last_org_id = EXCLUDED.last_org_id`,
    [userId, orgId],
  );
}

// ─── Changes to a member ─────────────────────────────────────────────────────

async function targetMember(db: Queryable, orgId: string, userId: string): Promise<{ baRole: string; name: string; email: string }> {
  const r = await db.query<{ role: string; name: string; email: string }>(
    `SELECT m.role, u.name, u.email FROM auth.member m JOIN auth."user" u ON u.id = m."userId" WHERE m."organizationId" = $1 AND m."userId" = $2`,
    [orgId, userId],
  );
  const row = r.rows[0];
  if (!row) throw notFound(say("core.members.notMember"));
  return { baRole: row.role, name: row.name, email: row.email };
}

function assertCanChange(actor: Actor, target: { baRole: string }, targetUserId: string): void {
  if (target.baRole === "owner") throw forbidden(say("core.members.ownerFixed"));
  if (targetUserId === actor.userId) throw forbidden(say("core.members.notYourself"));
}

export async function updateMember(
  deps: MemberDeps,
  actor: Actor,
  userId: string,
  patch: { role?: string | undefined; groups?: string[] | null | undefined; vehicles?: string[] | undefined; disabled?: boolean | undefined },
): Promise<void> {
  const target = await targetMember(deps.db.core, actor.orgId, userId);
  assertCanChange(actor, target, userId);
  // The log keeps the role's name: it is read later, by others.
  const role = patch.role !== undefined ? await assertRole(deps.db.core, actor.orgId, patch.role, deps.config.defaultLanguage) : null; // i18n: stored text
  const groups = patch.groups !== undefined ? await assertGroups(deps.db.core, actor.orgId, patch.groups) : undefined;
  const vehicles = patch.vehicles !== undefined ? await assertVehicles(deps.db.core, actor.orgId, patch.vehicles) : undefined;

  await withTransaction(deps.db.core, async (client) => {
    const current = await client.query<{ role: string; group_scope: string[] | null; vehicle_scope: string[]; disabled: boolean }>(
      `SELECT role, group_scope, vehicle_scope, disabled FROM gps.member_access WHERE org_id = $1 AND user_id = $2`,
      [actor.orgId, userId],
    );
    const before = current.rows[0] ?? { role: effectiveRole(target.baRole, null), group_scope: null, vehicle_scope: [], disabled: false };
    const nextRole = role?.id ?? effectiveRole(target.baRole, before.role);
    const nextGroups = scopeFor(nextRole, groups !== undefined ? groups : before.group_scope);
    const nextVehicles = vehiclesFor(nextGroups, vehicles !== undefined ? vehicles : before.vehicle_scope);
    const nextDisabled = patch.disabled ?? before.disabled;

    await client.query(`UPDATE auth.member SET role = $3 WHERE "organizationId" = $1 AND "userId" = $2`, [
      actor.orgId,
      userId,
      nextRole === "admin" ? "admin" : "member",
    ]);
    await client.query(
      `INSERT INTO gps.member_access (org_id, user_id, role, group_scope, vehicle_scope, disabled) VALUES ($1, $2, $3, $4::uuid[], $5::uuid[], $6)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, group_scope = EXCLUDED.group_scope, vehicle_scope = EXCLUDED.vehicle_scope, disabled = EXCLUDED.disabled, updated_at = now()`,
      [actor.orgId, userId, nextRole, nextGroups, nextVehicles, nextDisabled],
    );
    await audit(client, actor, patch.disabled === true ? "member.block" : patch.disabled === false ? "member.unblock" : "member.update", "member", userId, {
      email: target.email,
      ...(role ? { role: role.name } : {}),
      ...(groups !== undefined ? { groups: nextGroups === null ? "todos" : nextGroups.length } : {}),
      ...(vehicles !== undefined ? { vehicles: nextVehicles.length } : {}),
    });
  });
  deps.bus.emit("access_changed", { orgId: actor.orgId, userId });
}

export async function removeMember(deps: MemberDeps, actor: Actor, userId: string): Promise<void> {
  const target = await targetMember(deps.db.core, actor.orgId, userId);
  assertCanChange(actor, target, userId);
  await withTransaction(deps.db.core, async (client) => {
    await client.query(`DELETE FROM auth.member WHERE "organizationId" = $1 AND "userId" = $2`, [actor.orgId, userId]);
    await client.query(`DELETE FROM gps.member_access WHERE org_id = $1 AND user_id = $2`, [actor.orgId, userId]);
    await audit(client, actor, "member.remove", "member", userId, { email: target.email });
  });
  deps.bus.emit("access_changed", { orgId: actor.orgId, userId });
}

// ─── Custom roles ────────────────────────────────────────────────────────────

const DUPLICATE_ROLE = () => conflict("role_exists", say("core.members.roleExists"));

export async function createRole(deps: MemberDeps, actor: Actor, input: { name: string; permissions: string[] }): Promise<void> {
  try {
    await withTransaction(deps.db.core, async (client) => {
      const r = await client.query<{ id: string }>(`INSERT INTO gps.roles (org_id, name, permissions) VALUES ($1, $2, $3::text[]) RETURNING id`, [
        actor.orgId,
        input.name,
        input.permissions,
      ]);
      await audit(client, actor, "role.create", "role", (r.rows[0] as { id: string }).id, { name: input.name });
    });
  } catch (err) {
    throw isUniqueViolation(err) ? DUPLICATE_ROLE() : err;
  }
}

export async function updateRole(deps: MemberDeps, actor: Actor, id: string, input: { name: string; permissions: string[] }): Promise<void> {
  if (!isUuid(id)) throw notFound(say("core.members.roleNotFound"));
  let affected: string[] = [];
  try {
    await withTransaction(deps.db.core, async (client) => {
      const r = await client.query(`UPDATE gps.roles SET name = $3, permissions = $4::text[] WHERE org_id = $1 AND id = $2`, [
        actor.orgId,
        id,
        input.name,
        input.permissions,
      ]);
      if (r.rowCount === 0) throw notFound(say("core.members.roleNotFound"));
      const members = await client.query<{ user_id: string }>(`SELECT user_id FROM gps.member_access WHERE org_id = $1 AND role = $2`, [actor.orgId, id]);
      affected = members.rows.map((m) => m.user_id);
      await audit(client, actor, "role.update", "role", id, { name: input.name });
    });
  } catch (err) {
    throw isUniqueViolation(err) ? DUPLICATE_ROLE() : err;
  }
  for (const userId of affected) deps.bus.emit("access_changed", { orgId: actor.orgId, userId });
}

/** Deletes the role; those who had it become readers. */
export async function deleteRole(deps: MemberDeps, actor: Actor, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound(say("core.members.roleNotFound"));
  let affected: string[] = [];
  await withTransaction(deps.db.core, async (client) => {
    const r = await client.query<{ name: string }>(`DELETE FROM gps.roles WHERE org_id = $1 AND id = $2 RETURNING name`, [actor.orgId, id]);
    const row = r.rows[0];
    if (!row) throw notFound(say("core.members.roleNotFound"));
    const members = await client.query<{ user_id: string }>(
      `UPDATE gps.member_access SET role = 'viewer', updated_at = now() WHERE org_id = $1 AND role = $2 RETURNING user_id`,
      [actor.orgId, id],
    );
    affected = members.rows.map((m) => m.user_id);
    await client.query(`UPDATE gps.invitation_access SET role = 'viewer' WHERE org_id = $1 AND role = $2`, [actor.orgId, id]);
    await audit(client, actor, "role.delete", "role", id, { name: row.name });
  });
  for (const userId of affected) deps.bus.emit("access_changed", { orgId: actor.orgId, userId });
}
