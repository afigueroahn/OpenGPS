// Vehicle groups of an account. As in the rest of the core, every function
// receives the account (orgId).
import type { VehicleGroup } from "@opengps/shared";
import type { Bus } from "../bus";
import { type Db, type Queryable, withTransaction } from "../db";
import { conflict, notFound } from "../errors";
import { say } from "../i18n";
import { audit } from "./audit";
import type { Actor } from "./vehicles";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "23505";
const DUPLICATE = () => conflict("group_exists", say("core.groups.exists"));

export async function listGroups(db: Queryable, orgId: string): Promise<VehicleGroup[]> {
  const r = await db.query<{ id: string; name: string; parent_id: string | null; vehicle_count: number }>(
    `SELECT g.id, g.name, g.parent_id, count(v.id)::int AS vehicle_count
       FROM gps.vehicle_groups g
       LEFT JOIN gps.vehicles v ON v.group_id = g.id
      WHERE g.org_id = $1
      GROUP BY g.id
      ORDER BY lower(g.name)`,
    [orgId],
  );
  return r.rows.map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id, vehicleCount: g.vehicle_count }));
}

export async function createGroup(deps: { db: Db; bus: Bus }, actor: Actor, name: string): Promise<VehicleGroup> {
  try {
    const id = await withTransaction(deps.db.core, async (client) => {
      const r = await client.query<{ id: string }>(`INSERT INTO gps.vehicle_groups (org_id, name) VALUES ($1, $2) RETURNING id`, [actor.orgId, name]);
      const created = (r.rows[0] as { id: string }).id;
      await audit(client, actor, "group.create", "group", created, { name });
      return created;
    });
    return { id, name, parentId: null, vehicleCount: 0 };
  } catch (err) {
    throw isUniqueViolation(err) ? DUPLICATE() : err;
  }
}

export async function renameGroup(deps: { db: Db; bus: Bus }, actor: Actor, id: string, name: string): Promise<void> {
  if (!UUID.test(id)) throw notFound(say("core.groups.notFound"));
  try {
    await withTransaction(deps.db.core, async (client) => {
      const r = await client.query(`UPDATE gps.vehicle_groups SET name = $3 WHERE org_id = $1 AND id = $2`, [actor.orgId, id, name]);
      if (r.rowCount === 0) throw notFound(say("core.groups.notFound"));
      await audit(client, actor, "group.rename", "group", id, { name });
    });
  } catch (err) {
    throw isUniqueViolation(err) ? DUPLICATE() : err;
  }
}

/** Deletes the group; its vehicles are left without a group. */
export async function deleteGroup(deps: { db: Db; bus: Bus }, actor: Actor, id: string): Promise<void> {
  if (!UUID.test(id)) throw notFound(say("core.groups.notFound"));
  await withTransaction(deps.db.core, async (client) => {
    const r = await client.query(`DELETE FROM gps.vehicle_groups WHERE org_id = $1 AND id = $2`, [actor.orgId, id]);
    if (r.rowCount === 0) throw notFound(say("core.groups.notFound"));
    // Someone who only saw that group does not start seeing everything: they keep the ones they have left.
    await client.query(`UPDATE gps.member_access SET group_scope = array_remove(group_scope, $2::uuid) WHERE org_id = $1 AND group_scope IS NOT NULL`, [actor.orgId, id]);
    await client.query(`UPDATE gps.invitation_access SET group_scope = array_remove(group_scope, $2::uuid) WHERE org_id = $1 AND group_scope IS NOT NULL`, [actor.orgId, id]);
    // A geofence that only applied to that group is left with no vehicles; it does not start applying to all.
    await client.query(`UPDATE gps.geofences SET group_ids = array_remove(group_ids, $2::uuid), updated_at = now() WHERE org_id = $1 AND group_ids IS NOT NULL`, [actor.orgId, id]);
    await audit(client, actor, "group.delete", "group", id);
  });
  deps.bus.emit("vehicles_changed", { orgId: actor.orgId });
  deps.bus.emit("geofences_changed", { orgId: actor.orgId });
}
