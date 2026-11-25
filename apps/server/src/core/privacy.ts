// Privacy: record of acceptance of the terms and data deletion.
import type { Bus } from "../bus";
import { type Db, type Queryable, withTransaction } from "../db";
import { forbidden, notFound } from "../errors";
import { say } from "../i18n";
import type { Traccar } from "../traccar";
import { audit } from "./audit";

export interface PrivacyDeps {
  db: Db;
  bus: Bus;
  traccar: Traccar;
}

export async function recordConsent(db: Queryable, userId: string, version: string, ip: string | null): Promise<void> {
  await db.query(`INSERT INTO gps.consents (user_id, version, ip) VALUES ($1, $2, $3) ON CONFLICT (user_id, version) DO NOTHING`, [userId, version, ip]);
}

export async function hasConsent(db: Queryable, userId: string, version: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM gps.consents WHERE user_id = $1 AND version = $2`, [userId, version]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Completely deletes an account: vehicles, devices, history, groups, roles,
 * invitations, accesses and activity log; its uploaded files go when the
 * modules hear of it. The people in it are not deleted: they only leave it.
 */
async function deleteAccountData(deps: PrivacyDeps, orgId: string): Promise<void> {
  const members = await deps.db.core.query<{ userId: string }>(`SELECT "userId" FROM auth.member WHERE "organizationId" = $1`, [orgId]);
  const traccarIds = await withTransaction(deps.db.core, async (client) => {
    const devices = await client.query<{ id: number; traccar_device_id: number }>(`SELECT id, traccar_device_id FROM gps.devices WHERE org_id = $1`, [orgId]);
    if (devices.rowCount) await client.query(`DELETE FROM gps.positions WHERE device_id = ANY($1::bigint[])`, [devices.rows.map((d) => d.id)]);
    // The activity log is immutable except in a declared purge, like this one.
    await client.query("SET LOCAL gps.audit_purge = 'on'");
    await client.query(`DELETE FROM gps.audit_log WHERE org_id = $1`, [orgId]);
    // Deleting the account takes with it vehicles, devices, groups, roles, accesses and invitations.
    await client.query(`DELETE FROM auth.organization WHERE id = $1`, [orgId]);
    return devices.rows.map((d) => d.traccar_device_id);
  });
  // Devices stop being authorized on the gateway; if that fails, the periodic cleanup removes them.
  for (const traccarId of traccarIds) await deps.traccar.deleteDevice(traccarId).catch(() => {});
  for (const m of members.rows) deps.bus.emit("access_changed", { orgId, userId: m.userId });
  deps.bus.emit("account_deleted", { orgId });
}

/**
 * Completely deletes the accounts this person owns: vehicles,
 * devices, history, groups, invited users and activity log.
 * It is called right before deleting the person.
 */
export async function deleteOwnedAccounts(deps: PrivacyDeps, userId: string): Promise<number> {
  const owned = await deps.db.core.query<{ id: string }>(`SELECT "organizationId" AS id FROM auth.member WHERE "userId" = $1 AND role = 'owner'`, [userId]);
  for (const { id: orgId } of owned.rows) await deleteAccountData(deps, orgId);
  if (owned.rowCount) deps.bus.emit("devices_changed", {});
  return owned.rowCount ?? 0;
}

/** Whoever administers the platform; what they delete is written in the platform's log, since the account's goes with it. */
export interface AdminActor {
  userId: string;
  ip?: string | null;
}

/**
 * The platform's owner deletes an account with everything in it. Its people stay:
 * whoever has no other account gets an empty one when they sign in again.
 * The account of an owner of the platform is not deleted.
 */
export async function deleteAccountByAdmin(deps: PrivacyDeps, actor: AdminActor, orgId: string): Promise<void> {
  const r = await deps.db.core.query<{ name: string; owned_by_platform: boolean }>(
    `SELECT o.name, EXISTS (SELECT 1 FROM auth.member m JOIN gps.platform_owners p ON p.user_id = m."userId" WHERE m."organizationId" = o.id AND m.role = 'owner') AS owned_by_platform
       FROM auth.organization o WHERE o.id = $1`,
    [orgId],
  );
  const account = r.rows[0];
  if (!account) throw notFound(say("core.platform.accountNotFound"));
  if (account.owned_by_platform) throw forbidden(say("core.platform.ownerAccount"));
  await deleteAccountData(deps, orgId);
  deps.bus.emit("devices_changed", {});
  await audit(deps.db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.account_delete", "account", orgId, { name: account.name });
}

/**
 * The platform's owner deletes a person: the accounts they own, with everything
 * in them, and the person; from the other accounts they only leave.
 * An owner of the platform is not deleted.
 */
export async function deleteUserByAdmin(deps: PrivacyDeps, actor: AdminActor, userId: string): Promise<void> {
  const r = await deps.db.core.query<{ email: string; owner: boolean }>(
    `SELECT u.email, EXISTS (SELECT 1 FROM gps.platform_owners p WHERE p.user_id = u.id) AS owner FROM auth."user" u WHERE u.id = $1`,
    [userId],
  );
  const person = r.rows[0];
  if (!person) throw notFound(say("core.platform.userNotFound"));
  if (person.owner || userId === actor.userId) throw forbidden(say("core.platform.ownerUser"));
  const memberOf = await deps.db.core.query<{ organizationId: string }>(`SELECT "organizationId" FROM auth.member WHERE "userId" = $1 AND role <> 'owner'`, [userId]);
  const accounts = await deleteOwnedAccounts(deps, userId);
  // Their sessions, sign-in methods, memberships and settings go with them.
  await deps.db.core.query(`DELETE FROM auth."user" WHERE id = $1`, [userId]);
  for (const o of memberOf.rows) deps.bus.emit("access_changed", { orgId: o.organizationId, userId });
  await audit(deps.db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.user_delete", "user", userId, { email: person.email, accounts });
}

/** An invited person leaves the account they are in. The owner cannot: they would have to delete it. */
export async function leaveAccount(deps: PrivacyDeps, actor: { orgId: string; userId: string; role: string; email: string; ip?: string | null }): Promise<void> {
  if (actor.role === "owner") throw forbidden(say("core.privacy.ownerCantLeave"));
  await withTransaction(deps.db.core, async (client) => {
    await client.query(`DELETE FROM auth.member WHERE "organizationId" = $1 AND "userId" = $2`, [actor.orgId, actor.userId]);
    await client.query(`DELETE FROM gps.member_access WHERE org_id = $1 AND user_id = $2`, [actor.orgId, actor.userId]);
    await audit(client, actor, "member.leave", "member", actor.userId, { email: actor.email });
  });
  deps.bus.emit("access_changed", { orgId: actor.orgId, userId: actor.userId });
}
