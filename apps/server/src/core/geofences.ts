// An account's geofences. As in the rest of the core, every function receives the
// account and the scope of whoever asks: someone who only sees some groups or vehicles only
// sees and touches the geofences of those.
import { type Geofence, type GeofenceGeometry, type GeofenceInput, type WeekSchedule, boundsOf, geofenceSchema } from "@opengps/shared";
import type { z } from "zod";
import type { Bus } from "../bus";
import { type Db, type Queryable, withTransaction } from "../db";
import { badRequest, forbidden, notFound } from "../errors";
import { say } from "../i18n";
import { type Tenant, isUuid, scopeParam, scopeSql } from "./access";
import { audit } from "./audit";
import type { Actor } from "./vehicles";

export interface GeofenceDeps {
  db: Db;
  bus: Bus;
}

/** Geofences an account can have. */
export const MAX_GEOFENCES = 500;

interface Row {
  id: string;
  name: string;
  geometry: GeofenceGeometry;
  kind: Geofence["kind"];
  schedule: WeekSchedule | null;
  min_stay_s: number | null;
  max_stay_s: number | null;
  group_ids: string[] | null;
  vehicle_ids: string[] | null;
  active: boolean;
  created_at: Date;
  inside: number;
}

const toGeofence = (r: Row): Geofence => ({
  id: r.id,
  name: r.name,
  geometry: r.geometry,
  kind: r.kind,
  schedule: r.schedule,
  minStayMin: r.min_stay_s === null ? null : Math.round(r.min_stay_s / 60),
  maxStayMin: r.max_stay_s === null ? null : Math.round(r.max_stay_s / 60),
  groupIds: r.group_ids,
  vehicleIds: r.vehicle_ids,
  active: r.active,
  createdAt: r.created_at.toISOString(),
  inside: r.inside,
});

/**
 * Scope over table `g`: someone who sees everything sees all of them; someone with a narrower scope sees
 * the account-wide ones, those shared with any of their groups and those that apply to a vehicle they see.
 */
const visibleSql = (n: number) => `($${n}::uuid[] IS NULL
  OR (g.group_ids IS NULL AND g.vehicle_ids IS NULL)
  OR g.group_ids && $${n}::uuid[]
  OR EXISTS (SELECT 1 FROM gps.vehicles v
              WHERE v.org_id = g.org_id AND ${scopeSql(n)}
                AND (v.id = ANY(g.vehicle_ids) OR (g.vehicle_ids IS NULL AND v.group_id = ANY(gps.groups_with_children(g.group_ids))))))`;

const SELECT = `
  SELECT g.id, g.name, g.geometry, g.kind, g.schedule, g.min_stay_s, g.max_stay_s, g.group_ids, g.vehicle_ids, g.active, g.created_at,
         (SELECT count(*)::int
            FROM gps.geofence_state s
            JOIN gps.devices d ON d.id = s.device_id
            JOIN gps.vehicles v ON v.id = d.vehicle_id
           WHERE s.geofence_id = g.id AND s.inside
             AND ${scopeSql(2)}) AS inside
    FROM gps.geofences g
   WHERE g.org_id = $1 AND ${visibleSql(2)}`;

export async function listGeofences(db: Queryable, tenant: Tenant): Promise<Geofence[]> {
  const r = await db.query<Row>(`${SELECT} ORDER BY lower(g.name)`, [tenant.orgId, scopeParam(tenant)]);
  return r.rows.map(toGeofence);
}

export async function getGeofence(db: Queryable, tenant: Tenant, id: string): Promise<Geofence> {
  if (!isUuid(id)) throw notFound(say("core.geofences.notFound"));
  const r = await db.query<Row>(`${SELECT} AND g.id = $3`, [tenant.orgId, scopeParam(tenant), id]);
  const row = r.rows[0];
  if (!row) throw notFound(say("core.geofences.notFound"));
  return toGeofence(row);
}

type Parsed = z.output<typeof geofenceSchema>;

interface Scope {
  groupIds: string[] | null;
  vehicleIds: string[] | null;
}

/**
 * Whom the geofence applies to depending on who saves it: certain vehicles,
 * certain groups or, with neither, the whole account. Someone who sees
 * everything chooses freely; someone with a narrower scope cannot create one
 * for the whole account or for groups or vehicles that are not theirs.
 */
async function resolveScope(db: Queryable, actor: Actor, input: Pick<Parsed, "groupIds" | "vehicleIds">): Promise<Scope> {
  if (input.vehicleIds !== null) {
    const ids = [...new Set(input.vehicleIds)];
    const r = await db.query(`SELECT 1 FROM gps.vehicles v WHERE v.org_id = $1 AND v.id = ANY($2::uuid[]) AND ${scopeSql(3)}`, [actor.orgId, ids, scopeParam(actor)]);
    if (r.rowCount !== ids.length) throw badRequest(say("core.scope.vehiclesGone"));
    return { groupIds: null, vehicleIds: ids };
  }
  if (actor.groups !== null) {
    // Someone who only sees single vehicles gets the geofence for those.
    if (input.groupIds === null && actor.groups.length === 0 && actor.vehicles.length > 0) return { groupIds: null, vehicleIds: [...actor.vehicles] };
    const chosen = input.groupIds ?? actor.groups;
    if (chosen.length === 0 || chosen.some((g) => !actor.groups?.includes(g))) {
      throw forbidden(say("core.geofences.ownGroupsOnly"));
    }
    return { groupIds: [...new Set(chosen)], vehicleIds: null };
  }
  if (input.groupIds === null) return { groupIds: null, vehicleIds: null };
  const unique = [...new Set(input.groupIds)];
  if (unique.length === 0) throw badRequest(say("core.geofences.chooseGroup"));
  const r = await db.query(`SELECT 1 FROM gps.vehicle_groups WHERE org_id = $1 AND id = ANY($2::uuid[])`, [actor.orgId, unique]);
  if (r.rowCount !== unique.length) throw badRequest(say("core.scope.groupsGone"));
  return { groupIds: unique, vehicleIds: null };
}

function columns(input: Parsed, scope: Scope) {
  const box = boundsOf(input.geometry as GeofenceGeometry);
  return [
    input.name,
    input.geometry.shape,
    JSON.stringify(input.geometry),
    box.minLat,
    box.maxLat,
    box.minLon,
    box.maxLon,
    // A route always notifies of deviation: its type is that of an authorized zone.
    input.geometry.shape === "corridor" ? "authorized" : input.kind,
    input.schedule ? JSON.stringify(input.schedule) : null,
    input.minStayMin === null ? null : input.minStayMin * 60,
    input.maxStayMin === null ? null : input.maxStayMin * 60,
    scope.groupIds,
    scope.vehicleIds,
    input.active,
  ];
}

export async function createGeofence(deps: GeofenceDeps, actor: Actor, input: Parsed): Promise<Geofence> {
  const id = await withTransaction(deps.db.core, async (client) => {
    const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.geofences WHERE org_id = $1`, [actor.orgId]);
    if ((count.rows[0]?.n ?? 0) >= MAX_GEOFENCES) throw badRequest(say("core.geofences.limit", { max: MAX_GEOFENCES }), "geofence_limit");
    const scope = await resolveScope(client, actor, input);
    const r = await client.query<{ id: string }>(
      `INSERT INTO gps.geofences
         (org_id, created_by, name, shape, geometry, min_lat, max_lat, min_lon, max_lon, kind, schedule, min_stay_s, max_stay_s, group_ids, vehicle_ids, active)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::uuid[], $15::uuid[], $16)
       RETURNING id`,
      [actor.orgId, actor.userId, ...columns(input, scope)],
    );
    const created = (r.rows[0] as { id: string }).id;
    await audit(client, actor, "geofence.create", "geofence", created, { name: input.name, shape: input.geometry.shape });
    return created;
  });
  deps.bus.emit("geofences_changed", { orgId: actor.orgId });
  return getGeofence(deps.db.core, actor, id);
}

export async function updateGeofence(deps: GeofenceDeps, actor: Actor, id: string, input: Parsed): Promise<Geofence> {
  const before = await getGeofence(deps.db.core, actor, id);
  await assertOwnScope(deps.db.core, actor, before);
  await withTransaction(deps.db.core, async (client) => {
    const scope = await resolveScope(client, actor, input);
    await client.query(
      `UPDATE gps.geofences SET
         name = $3, shape = $4, geometry = $5::jsonb, min_lat = $6, max_lat = $7, min_lon = $8, max_lon = $9, kind = $10,
         schedule = $11::jsonb, min_stay_s = $12, max_stay_s = $13, group_ids = $14::uuid[], vehicle_ids = $15::uuid[], active = $16, updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [actor.orgId, id, ...columns(input, scope)],
    );
    // If the shape or whom it applies to changed, what was known about who was inside no longer holds.
    const reshaped =
      JSON.stringify(before.geometry) !== JSON.stringify(input.geometry) ||
      JSON.stringify(before.groupIds) !== JSON.stringify(scope.groupIds) ||
      JSON.stringify(before.vehicleIds) !== JSON.stringify(scope.vehicleIds) ||
      !input.active;
    if (reshaped) await client.query(`DELETE FROM gps.geofence_state WHERE geofence_id = $1`, [id]);
    await audit(client, actor, "geofence.update", "geofence", id, { name: input.name });
  });
  deps.bus.emit("geofences_changed", { orgId: actor.orgId });
  return getGeofence(deps.db.core, actor, id);
}

export async function deleteGeofence(deps: GeofenceDeps, actor: Actor, id: string): Promise<void> {
  const before = await getGeofence(deps.db.core, actor, id);
  await assertOwnScope(deps.db.core, actor, before);
  await withTransaction(deps.db.core, async (client) => {
    await client.query(`DELETE FROM gps.geofences WHERE org_id = $1 AND id = $2`, [actor.orgId, id]);
    await audit(client, actor, "geofence.delete", "geofence", id, { name: before.name });
  });
  deps.bus.emit("geofences_changed", { orgId: actor.orgId });
}

/** Someone with a narrower scope can see a geofence that covers more than they see, but cannot change or delete it. */
async function assertOwnScope(db: Queryable, actor: Actor, geofence: Geofence): Promise<void> {
  if (actor.groups === null) return;
  let own: boolean;
  if (geofence.vehicleIds !== null) {
    const r = await db.query(`SELECT 1 FROM gps.vehicles v WHERE v.org_id = $1 AND v.id = ANY($2::uuid[]) AND ${scopeSql(3)}`, [actor.orgId, geofence.vehicleIds, scopeParam(actor)]);
    own = r.rowCount === geofence.vehicleIds.length;
  } else {
    own = geofence.groupIds !== null && geofence.groupIds.every((g) => actor.groups?.includes(g));
  }
  if (!own) throw forbidden(say("core.geofences.wider"));
}

export type { GeofenceInput };
