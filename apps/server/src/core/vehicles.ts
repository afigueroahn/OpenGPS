// Vehicles and devices. It is the only layer that reads or writes these tables, and every
// function receives the account and the scope of whoever asks: no query
// crosses accounts or shows groups that person cannot see.
import type { TrackPoint, Vehicle, VehicleDevice, VehicleState } from "@opengps/shared";
import type { Bus } from "../bus";
import type { Config } from "../config";
import { type Db, type Queryable, withTransaction } from "../db";
import { badRequest, conflict, forbidden, notFound, tooMany } from "../errors";
import { say } from "../i18n";
import type { Traccar } from "../traccar";
import { type Tenant, scopeParam, scopeSql } from "./access";
import { audit } from "./audit";
import { findModel } from "./catalog";
import { assertVehicleQuota } from "./platform";

export interface Actor extends Tenant {
  userId: string;
  ip?: string | null;
}

export interface VehicleDeps {
  db: Db;
  bus: Bus;
  traccar: Traccar;
  config: Pick<Config, "claimWindowMinutes" | "maxPendingDevices">;
}

interface VehicleRow {
  id: string;
  name: string;
  plate: string | null;
  created_at: Date;
  group_id: string | null;
  parked_since: Date | null;
  device_id: number | null;
  unique_id: string | null;
  model_id: string | null;
  model_name: string | null;
  status: "pending" | "active" | null;
  claim_expires_at: Date | null;
  confirmed_at: Date | null;
  last_seen_at: Date | null;
  fix_time: Date | null;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  speed_kmh: number | null;
  course: number | null;
  accuracy: number | null;
  ignition: boolean | null;
  motion: boolean | null;
  ignition_inferred: boolean | null;
  power_v: number | null;
  battery_v: number | null;
  battery_pct: number | null;
  satellites: number | null;
  signal_bars: number | null;
}

const VEHICLE_SELECT = `
  SELECT v.id, v.name, v.plate, v.created_at, v.group_id, v.parked_since,
         d.id AS device_id, d.unique_id, d.model_id, d.model_name, d.status, d.claim_expires_at, d.confirmed_at,
         s.last_seen_at, s.fix_time, s.lat, s.lon, s.altitude, s.speed_kmh, s.course, s.accuracy, s.ignition, s.motion,
         s.ignition_inferred, s.power_v, s.battery_v, s.battery_pct, s.satellites, s.signal_bars
    FROM gps.vehicles v
    LEFT JOIN gps.devices d ON d.vehicle_id = v.id
    LEFT JOIN gps.device_state s ON s.device_id = d.id`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toDevice(row: {
  unique_id: string;
  model_id: string;
  model_name: string | null;
  status: "pending" | "active";
  claim_expires_at: Date | null;
  confirmed_at: Date | null;
}): VehicleDevice {
  return {
    uniqueId: row.unique_id,
    modelId: row.model_id,
    modelName: row.model_name,
    status: row.status,
    claimExpiresAt: iso(row.claim_expires_at),
    confirmedAt: iso(row.confirmed_at),
  };
}

export function toState(row: {
  last_seen_at: Date;
  fix_time: Date | null;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  speed_kmh: number | null;
  course: number | null;
  accuracy: number | null;
  ignition: boolean | null;
  motion: boolean | null;
  ignition_inferred: boolean | null;
  power_v: number | null;
  battery_v: number | null;
  battery_pct: number | null;
  satellites: number | null;
  signal_bars: number | null;
}): VehicleState {
  return {
    lastSeenAt: row.last_seen_at.toISOString(),
    fixTime: iso(row.fix_time),
    lat: row.lat,
    lon: row.lon,
    altitude: row.altitude,
    speedKmh: row.speed_kmh,
    course: row.course,
    accuracy: row.accuracy,
    ignition: row.ignition,
    ignitionInferred: row.ignition_inferred ?? false,
    motion: row.motion,
    powerVoltage: row.power_v,
    batteryVoltage: row.battery_v,
    batteryLevel: row.battery_pct,
    satellites: row.satellites,
    signalBars: row.signal_bars,
  };
}

function toVehicle(row: VehicleRow): Vehicle {
  return {
    id: row.id,
    name: row.name,
    plate: row.plate,
    createdAt: row.created_at.toISOString(),
    groupId: row.group_id,
    parkedSince: iso(row.parked_since),
    device:
      row.device_id !== null
        ? toDevice({
            unique_id: row.unique_id as string,
            model_id: row.model_id as string,
            model_name: row.model_name,
            status: row.status as "pending" | "active",
            claim_expires_at: row.claim_expires_at,
            confirmed_at: row.confirmed_at,
          })
        : null,
    state: row.last_seen_at !== null ? toState({ ...row, last_seen_at: row.last_seen_at }) : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "23505";

// ─── Reading ─────────────────────────────────────────────────────────────────

export async function listVehicles(db: Queryable, tenant: Tenant): Promise<Vehicle[]> {
  const r = await db.query<VehicleRow>(`${VEHICLE_SELECT} WHERE v.org_id = $1 AND ${scopeSql(2)} ORDER BY v.created_at, v.id`, [
    tenant.orgId,
    scopeParam(tenant),
  ]);
  return r.rows.map(toVehicle);
}

/** A vehicle from another account, or out of scope, responds the same as one that does not exist. */
export async function getVehicle(db: Queryable, tenant: Tenant, id: string): Promise<Vehicle> {
  if (!UUID.test(id)) throw notFound(say("core.vehicles.notFound"));
  const r = await db.query<VehicleRow>(`${VEHICLE_SELECT} WHERE v.org_id = $1 AND v.id = $2 AND ${scopeSql(3)}`, [tenant.orgId, id, scopeParam(tenant)]);
  const row = r.rows[0];
  if (!row) throw notFound(say("core.vehicles.notFound"));
  return toVehicle(row);
}

/** Latest route points, from oldest to most recent. */
export async function recentTrack(
  db: Queryable,
  tenant: Tenant,
  vehicleId: string,
  opts: { minutes: number; limit: number },
): Promise<TrackPoint[]> {
  await getVehicle(db, tenant, vehicleId);
  const { orgId } = tenant;
  const r = await db.query<{ fix_time: Date; lat: number; lon: number; speed_kmh: number | null; course: number | null }>(
    `SELECT p.fix_time, p.lat, p.lon, p.speed_kmh, p.course
       FROM gps.devices d
       JOIN gps.positions p ON p.device_id = d.id
      WHERE d.org_id = $1 AND d.vehicle_id = $2
        AND p.valid AND p.fix_time >= now() - make_interval(mins => $3)
      ORDER BY p.fix_time DESC
      LIMIT $4`,
    [orgId, vehicleId, opts.minutes, opts.limit],
  );
  return r.rows
    .reverse()
    .map((p) => ({ t: p.fix_time.toISOString(), lat: p.lat, lon: p.lon, speedKmh: p.speed_kmh, course: p.course }));
}

// ─── Adding a GPS device ─────────────────────────────────────────────────────

// Brake on anyone trying other people's identifiers: additions per account in an hour.
const CLAIMS_PER_HOUR = 30;
const claimLog = new Map<string, number[]>();

function checkClaimRate(orgId: string): void {
  const now = Date.now();
  const recent = (claimLog.get(orgId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= CLAIMS_PER_HOUR) {
    throw tooMany(say("core.vehicles.tooManyClaims"));
  }
  recent.push(now);
  claimLog.set(orgId, recent);
}

async function assertCanClaim(deps: VehicleDeps, actor: Actor, uniqueId: string, modelId: string, modelName: string | null | undefined): Promise<void> {
  const family = findModel(modelId);
  if (!family) throw badRequest(say("core.vehicles.chooseBrand"));
  if (modelName && !family.models.includes(modelName)) throw badRequest(say("core.vehicles.chooseModel"));
  checkClaimRate(actor.orgId);

  const taken = await deps.db.core.query<{ org_id: string }>(`SELECT org_id FROM gps.devices WHERE unique_id = $1`, [uniqueId]);
  if (taken.rows[0]) {
    throw taken.rows[0].org_id === actor.orgId
      ? conflict("device_exists", say("core.vehicles.deviceInAccount"))
      : conflict("device_taken", say("core.vehicles.deviceTaken"));
  }

  const pending = await deps.db.core.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM gps.devices WHERE org_id = $1 AND status = 'pending'`,
    [actor.orgId],
  );
  if ((pending.rows[0]?.n ?? 0) >= deps.config.maxPendingDevices) {
    throw tooMany(say("core.vehicles.tooManyPending"));
  }
}

/** Inserts the device already registered in Traccar. If it fails, undoes the registration in Traccar. */
async function insertDevice(
  deps: VehicleDeps,
  actor: Actor,
  input: { uniqueId: string; modelId: string; modelName?: string | null | undefined; vehicleName: string },
  write: (client: Queryable, traccarDeviceId: number) => Promise<string>,
): Promise<string> {
  const registered = await deps.traccar.createDevice(input.uniqueId, input.vehicleName);
  try {
    return await withTransaction(deps.db.core, (client) => write(client, registered.id));
  } catch (err) {
    // It is only removed from Traccar if nobody else claimed it in the meantime.
    const owner = await deps.db.core.query(`SELECT 1 FROM gps.devices WHERE unique_id = $1`, [input.uniqueId]);
    if (owner.rowCount === 0) await deps.traccar.deleteDevice(registered.id).catch(() => {});
    if (isUniqueViolation(err)) throw conflict("device_taken", say("core.vehicles.justTaken"));
    throw err;
  }
}

const INSERT_DEVICE = `
  INSERT INTO gps.devices (org_id, vehicle_id, unique_id, model_id, traccar_device_id, claim_expires_at, created_by, model_name)
  VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6), $7, $8)`;

export async function createVehicle(
  deps: VehicleDeps,
  actor: Actor,
  input: { name: string; plate?: string | null | undefined; uniqueId: string; modelId: string; modelName?: string | null | undefined },
): Promise<Vehicle> {
  // Someone who only sees some groups creates the vehicle inside their first group; otherwise, they would not see it.
  const groupId = actor.groups === null ? null : (actor.groups[0] ?? null);
  if (actor.groups !== null && groupId === null) throw forbidden(say("core.vehicles.noGroup"));
  await assertVehicleQuota(deps.db.core, actor.orgId);
  await assertCanClaim(deps, actor, input.uniqueId, input.modelId, input.modelName);
  const vehicleId = await insertDevice(deps, actor, { ...input, vehicleName: input.name }, async (client, traccarId) => {
    const v = await client.query<{ id: string }>(
      `INSERT INTO gps.vehicles (org_id, name, plate, created_by, group_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [actor.orgId, input.name, input.plate ?? null, actor.userId, groupId],
    );
    const id = (v.rows[0] as { id: string }).id;
    await client.query(INSERT_DEVICE, [
      actor.orgId,
      id,
      input.uniqueId,
      input.modelId,
      traccarId,
      deps.config.claimWindowMinutes,
      actor.userId,
      input.modelName ?? null,
    ]);
    await audit(client, actor, "vehicle.create", "vehicle", id, { name: input.name, uniqueId: input.uniqueId, modelId: input.modelId, ...(input.modelName ? { modelName: input.modelName } : {}) });
    return id;
  });
  deps.bus.emit("devices_changed", {});
  deps.bus.emit("vehicles_changed", { orgId: actor.orgId });
  return getVehicle(deps.db.core, actor, vehicleId);
}

/** Connects a GPS device to a vehicle that has none. */
export async function attachDevice(
  deps: VehicleDeps,
  actor: Actor,
  vehicleId: string,
  input: { uniqueId: string; modelId: string; modelName?: string | null | undefined },
): Promise<Vehicle> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  if (vehicle.device) throw conflict("vehicle_has_device", say("core.vehicles.hasDevice"));
  await assertCanClaim(deps, actor, input.uniqueId, input.modelId, input.modelName);
  await insertDevice(deps, actor, { ...input, vehicleName: vehicle.name }, async (client, traccarId) => {
    await client.query(INSERT_DEVICE, [
      actor.orgId,
      vehicleId,
      input.uniqueId,
      input.modelId,
      traccarId,
      deps.config.claimWindowMinutes,
      actor.userId,
      input.modelName ?? null,
    ]);
    await audit(client, actor, "device.attach", "vehicle", vehicleId, { uniqueId: input.uniqueId, modelId: input.modelId, ...(input.modelName ? { modelName: input.modelName } : {}) });
    return vehicleId;
  });
  deps.bus.emit("devices_changed", {});
  deps.bus.emit("vehicles_changed", { orgId: actor.orgId });
  return getVehicle(deps.db.core, actor, vehicleId);
}

// ─── Changes and removals ────────────────────────────────────────────────────

export async function updateVehicle(
  deps: VehicleDeps,
  actor: Actor,
  id: string,
  patch: { name?: string | undefined; plate?: string | null | undefined; groupId?: string | null | undefined },
): Promise<Vehicle> {
  await getVehicle(deps.db.core, actor, id);
  if (patch.groupId !== undefined && actor.groups !== null && (patch.groupId === null || !actor.groups.includes(patch.groupId))) {
    throw forbidden(say("core.vehicles.ownGroupsOnly"));
  }
  if (patch.groupId) {
    // The group must belong to the same account.
    const group = await deps.db.core.query(`SELECT 1 FROM gps.vehicle_groups WHERE org_id = $1 AND id = $2`, [actor.orgId, patch.groupId]);
    if (group.rowCount === 0) throw badRequest(say("core.groups.notFound"));
  }
  await withTransaction(deps.db.core, async (client) => {
    await client.query(
      `UPDATE gps.vehicles
          SET name = COALESCE($3, name),
              plate = CASE WHEN $4 THEN $5 ELSE plate END,
              group_id = CASE WHEN $6 THEN $7::uuid ELSE group_id END,
              updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [actor.orgId, id, patch.name ?? null, patch.plate !== undefined, patch.plate ?? null, patch.groupId !== undefined, patch.groupId ?? null],
    );
    await audit(client, actor, "vehicle.update", "vehicle", id, patch);
  });
  deps.bus.emit("vehicles_changed", { orgId: actor.orgId });
  return getVehicle(deps.db.core, actor, id);
}

/** Deletes the device from the platform, its history and its record in Traccar. */
async function dropDevices(deps: VehicleDeps, client: Queryable, orgId: string, vehicleId: string): Promise<number[]> {
  const removed = await client.query<{ id: number; traccar_device_id: number }>(
    `DELETE FROM gps.devices WHERE org_id = $1 AND vehicle_id = $2 RETURNING id, traccar_device_id`,
    [orgId, vehicleId],
  );
  for (const d of removed.rows) await client.query(`DELETE FROM gps.positions WHERE device_id = $1`, [d.id]);
  return removed.rows.map((d) => d.traccar_device_id);
}

async function dropFromTraccar(deps: VehicleDeps, traccarIds: number[]): Promise<void> {
  for (const id of traccarIds) {
    // If Traccar does not respond, the periodic cleanup removes it later.
    await deps.traccar.deleteDevice(id).catch((err) => console.error(`[traccar] could not remove device ${id}:`, err.message));
  }
}

export async function removeDevice(deps: VehicleDeps, actor: Actor, vehicleId: string): Promise<Vehicle> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  if (!vehicle.device) return vehicle;
  const traccarIds = await withTransaction(deps.db.core, async (client) => {
    const ids = await dropDevices(deps, client, actor.orgId, vehicleId);
    await audit(client, actor, "device.remove", "vehicle", vehicleId, { uniqueId: vehicle.device?.uniqueId });
    return ids;
  });
  await dropFromTraccar(deps, traccarIds);
  deps.bus.emit("devices_changed", {});
  deps.bus.emit("device", { orgId: actor.orgId, vehicleId, groupId: vehicle.groupId, device: null });
  return getVehicle(deps.db.core, actor, vehicleId);
}

export async function deleteVehicle(deps: VehicleDeps, actor: Actor, id: string): Promise<void> {
  const vehicle = await getVehicle(deps.db.core, actor, id);
  const traccarIds = await withTransaction(deps.db.core, async (client) => {
    const ids = await dropDevices(deps, client, actor.orgId, id);
    await client.query(`DELETE FROM gps.vehicles WHERE org_id = $1 AND id = $2`, [actor.orgId, id]);
    // Whoever saw that vehicle on its own, and the geofences that named it, keep the rest of their list.
    await client.query(`UPDATE gps.member_access SET vehicle_scope = array_remove(vehicle_scope, $2::uuid) WHERE org_id = $1`, [actor.orgId, id]);
    await client.query(`UPDATE gps.invitation_access SET vehicle_scope = array_remove(vehicle_scope, $2::uuid) WHERE org_id = $1`, [actor.orgId, id]);
    await client.query(`UPDATE gps.geofences SET vehicle_ids = array_remove(vehicle_ids, $2::uuid), updated_at = now() WHERE org_id = $1 AND vehicle_ids IS NOT NULL`, [actor.orgId, id]);
    await audit(client, actor, "vehicle.delete", "vehicle", id, { name: vehicle.name, uniqueId: vehicle.device?.uniqueId });
    return ids;
  });
  await dropFromTraccar(deps, traccarIds);
  deps.bus.emit("devices_changed", {});
  deps.bus.emit("vehicles_changed", { orgId: actor.orgId });
  deps.bus.emit("geofences_changed", { orgId: actor.orgId });
}

// ─── Parked mode ─────────────────────────────────────────────────────────────

/**
 * Puts the vehicle in parked mode, at the point where it is now, or
 * takes it out of that mode. While it is so, the movement alert notifies if it moves away.
 */
export async function setParked(deps: VehicleDeps, actor: Actor, vehicleId: string, parked: boolean): Promise<Vehicle> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  const { lat, lon } = vehicle.state ?? {};
  if (parked && (lat == null || lon == null)) throw badRequest(say("core.vehicles.noPosition"));
  await withTransaction(deps.db.core, async (client) => {
    await client.query(
      `UPDATE gps.vehicles SET parked_since = CASE WHEN $3 THEN now() END, parked_lat = CASE WHEN $3 THEN $4::float8 END, parked_lon = CASE WHEN $3 THEN $5::float8 END
        WHERE org_id = $1 AND id = $2`,
      [actor.orgId, vehicleId, parked, lat ?? null, lon ?? null],
    );
    await audit(client, actor, parked ? "vehicle.park" : "vehicle.unpark", "vehicle", vehicleId, { name: vehicle.name });
  });
  deps.bus.emit("vehicles_changed", { orgId: actor.orgId });
  return getVehicle(deps.db.core, actor, vehicleId);
}
