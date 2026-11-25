// Odometer and engine hours of each vehicle.
//
// The platform keeps them by adding up, as positions arrive, what
// the vehicle travels and the time it spends with the engine on. If the device
// reads the vehicle's own odometer or hours, those apply. In both cases
// they can be adjusted by hand to match what the dashboard shows.
import type { VehicleMeters } from "@opengps/shared";
import type { z } from "zod";
import type { vehicleMetersSchema } from "@opengps/shared";
import type { Bus, CoreEvents } from "../bus";
import type { Db, Queryable } from "../db";
import type { Tenant } from "./access";
import { audit } from "./audit";
import { readParam } from "./readings";
import { type TrackSample, intervals } from "./trips";
import { type Actor, getVehicle } from "./vehicles";

/** If the device stops sending the vehicle's reading for this long, the platform takes over the count again. */
const ECU_LOST_MS = 7 * 86_400_000;

interface Row {
  gps_m: number;
  engine_s: number;
  last_t: Date | null;
  last_lat: number | null;
  last_lon: number | null;
  last_speed: number | null;
  last_ignition: boolean | null;
  ecu_m: number | null;
  ecu_m_at: Date | null;
  ecu_s: number | null;
  ecu_s_at: Date | null;
  odo_offset_m: number;
  odo_source: "gps" | "ecu";
  hrs_offset_s: number;
  hrs_source: "ignition" | "ecu";
  since: Date;
}
const COLUMNS = `gps_m, engine_s, last_t, last_lat, last_lon, last_speed, last_ignition, ecu_m, ecu_m_at, ecu_s, ecu_s_at, odo_offset_m, odo_source, hrs_offset_s, hrs_source, since`;
const EMPTY = (): Row => ({
  gps_m: 0,
  engine_s: 0,
  last_t: null,
  last_lat: null,
  last_lon: null,
  last_speed: null,
  last_ignition: null,
  ecu_m: null,
  ecu_m_at: null,
  ecu_s: null,
  ecu_s_at: null,
  odo_offset_m: 0,
  odo_source: "gps",
  hrs_offset_s: 0,
  hrs_source: "ignition",
  since: new Date(),
});

const odometerM = (r: Row) => (r.odo_source === "ecu" ? (r.ecu_m ?? 0) : r.gps_m) + r.odo_offset_m;
const hoursS = (r: Row) => (r.hrs_source === "ecu" ? (r.ecu_s ?? 0) : r.engine_s) + r.hrs_offset_s;
const round1 = (n: number) => Math.round(n * 10) / 10;
const toMeters = (r: Row): VehicleMeters => ({
  odometerKm: Math.max(0, round1(odometerM(r) / 1000)),
  odometerSource: r.odo_source,
  engineHours: Math.max(0, round1(hoursS(r) / 3600)),
  hoursSource: r.hrs_source,
  since: r.since.toISOString(),
});

async function rowOf(db: Queryable, vehicleId: string): Promise<Row> {
  const r = await db.query<Row>(`SELECT ${COLUMNS} FROM gps.vehicle_meters WHERE vehicle_id = $1`, [vehicleId]);
  return r.rows[0] ?? EMPTY();
}

async function save(db: Queryable, orgId: string, vehicleId: string, r: Row): Promise<void> {
  await db.query(
    `INSERT INTO gps.vehicle_meters (vehicle_id, org_id, gps_m, engine_s, last_t, last_lat, last_lon, last_speed, last_ignition, ecu_m, ecu_m_at, ecu_s, ecu_s_at, odo_offset_m, odo_source, hrs_offset_s, hrs_source, since, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now()
      WHERE EXISTS (SELECT 1 FROM gps.vehicles WHERE id = $1)
     ON CONFLICT (vehicle_id) DO UPDATE SET gps_m = EXCLUDED.gps_m, engine_s = EXCLUDED.engine_s, last_t = EXCLUDED.last_t, last_lat = EXCLUDED.last_lat, last_lon = EXCLUDED.last_lon,
       last_speed = EXCLUDED.last_speed, last_ignition = EXCLUDED.last_ignition, ecu_m = EXCLUDED.ecu_m, ecu_m_at = EXCLUDED.ecu_m_at, ecu_s = EXCLUDED.ecu_s, ecu_s_at = EXCLUDED.ecu_s_at,
       odo_offset_m = EXCLUDED.odo_offset_m, odo_source = EXCLUDED.odo_source, hrs_offset_s = EXCLUDED.hrs_offset_s, hrs_source = EXCLUDED.hrs_source, updated_at = now()`,
    [vehicleId, orgId, r.gps_m, r.engine_s, r.last_t, r.last_lat, r.last_lon, r.last_speed, r.last_ignition, r.ecu_m, r.ecu_m_at, r.ecu_s, r.ecu_s_at, r.odo_offset_m, r.odo_source, r.hrs_offset_s, r.hrs_source, r.since],
  );
}

/**
 * Adds the new positions to a vehicle's count. Exported for
 * tests: in operation the position listener calls it.
 */
export function accumulate(row: Row, fixes: CoreEvents["fixes"]["fixes"], protocol: string | null): Row {
  const r = { ...row };
  const fresh = fixes.filter((f) => r.last_t === null || f.t > r.last_t.getTime());
  const newest = fresh[fresh.length - 1];
  if (!newest) return r;
  const samples: TrackSample[] = fresh.map((f) => ({ t: f.t, lat: f.lat, lon: f.lon, speedKmh: f.speedKmh ?? 0, course: null, ignition: f.ignition, odometer: null }));
  if (r.last_t && r.last_lat !== null && r.last_lon !== null) {
    samples.unshift({ t: r.last_t.getTime(), lat: r.last_lat, lon: r.last_lon, speedKmh: r.last_speed ?? 0, course: null, ignition: r.last_ignition, odometer: null });
  }
  // What they showed before adding, so that a change of source does not cause a jump.
  const odoBefore = odometerM(r);
  const hrsBefore = hoursS(r);
  let addedM = 0;
  let addedS = 0;
  for (const it of intervals(samples)) {
    if (it.kind === "moving") addedM += it.meters;
    if (it.kind !== "stopped") addedS += it.seconds;
  }
  r.gps_m += addedM;
  r.engine_s += addedS;
  r.last_t = new Date(newest.t);
  r.last_lat = newest.lat;
  r.last_lon = newest.lon;
  r.last_speed = newest.speedKmh;
  r.last_ignition = newest.ignition;

  // What the device read from the vehicle in these positions, if it reads it.
  for (const f of fresh) {
    const km = readParam("ecuOdometer", f.attributes, protocol);
    if (km !== null && km > 0) {
      r.ecu_m = km * 1000;
      r.ecu_m_at = new Date(f.t);
    }
    const hours = readParam("ecuHours", f.attributes, protocol);
    if (hours !== null && hours > 0) {
      r.ecu_s = hours * 3600;
      r.ecu_s_at = new Date(f.t);
    }
  }
  const alive = (at: Date | null) => at !== null && newest.t - at.getTime() < ECU_LOST_MS;
  const odoSource = r.ecu_m !== null && alive(r.ecu_m_at) ? "ecu" : "gps";
  if (odoSource !== r.odo_source) {
    // When it starts reading it from the vehicle, if nobody had adjusted it, the vehicle's value applies. In other cases it continues from where it was.
    const untouched = odoSource === "ecu" && r.odo_offset_m === 0;
    r.odo_offset_m = untouched ? 0 : odoBefore + addedM - (odoSource === "ecu" ? (r.ecu_m as number) : r.gps_m);
    r.odo_source = odoSource;
  }
  const hrsSource = r.ecu_s !== null && alive(r.ecu_s_at) ? "ecu" : "ignition";
  if (hrsSource !== r.hrs_source) {
    const untouched = hrsSource === "ecu" && r.hrs_offset_s === 0;
    r.hrs_offset_s = untouched ? 0 : hrsBefore + addedS - (hrsSource === "ecu" ? (r.ecu_s as number) : r.engine_s);
    r.hrs_source = hrsSource;
  }
  return r;
}

export interface MeterKeeper {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
}

export function createMeterKeeper(deps: { db: Db; bus: Bus }): MeterKeeper {
  const db = deps.db.core;
  let queue: Promise<unknown> = Promise.resolve();
  const off: (() => void)[] = [];
  /** Protocol of each device: where the vehicle's data comes in depends on it. */
  const protocols = new Map<number, string | null>();

  async function protocolOf(deviceId: number): Promise<string | null> {
    if (protocols.has(deviceId)) return protocols.get(deviceId) ?? null;
    const r = await db.query<{ protocol: string }>(`SELECT m.protocol FROM gps.devices d JOIN gps.device_models m ON m.id = d.model_id WHERE d.id = $1`, [deviceId]);
    const protocol = r.rows[0]?.protocol ?? null;
    protocols.set(deviceId, protocol);
    return protocol;
  }

  async function onFixes(payload: CoreEvents["fixes"]): Promise<void> {
    if (payload.fixes.length === 0) return;
    const before = await rowOf(db, payload.vehicleId);
    const after = accumulate(before, payload.fixes, await protocolOf(payload.deviceId));
    if (after.last_t?.getTime() !== before.last_t?.getTime()) await save(db, payload.orgId, payload.vehicleId, after);
  }

  return {
    start() {
      off.push(
        deps.bus.on("fixes", (payload) => {
          queue = queue.then(() => onFixes(payload)).catch((err: Error) => console.error("[meters] could not add up a position:", err.message));
        }),
        deps.bus.on("devices_changed", () => protocols.clear()),
      );
    },
    stop() {
      for (const stop of off.splice(0)) stop();
    },
    idle: () => queue.then(() => undefined),
  };
}

/** Odometer and hours of a vehicle this person can see. */
export async function getMeters(db: Queryable, tenant: Tenant, vehicleId: string): Promise<VehicleMeters> {
  await getVehicle(db, tenant, vehicleId);
  return toMeters(await rowOf(db, vehicleId));
}

/** Those of several vehicles at once, without checking permissions: the caller does that. */
export async function metersOf(db: Queryable, vehicleIds: string[]): Promise<Map<string, VehicleMeters>> {
  const r = await db.query<Row & { vehicle_id: string }>(`SELECT vehicle_id, ${COLUMNS} FROM gps.vehicle_meters WHERE vehicle_id = ANY($1::uuid[])`, [vehicleIds]);
  return new Map(r.rows.map((row) => [row.vehicle_id, toMeters(row)]));
}

/** Adjusts the odometer or hours to what the dashboard shows. From there they keep adding up. */
export async function setMeters(deps: { db: Db }, actor: Actor, vehicleId: string, data: z.output<typeof vehicleMetersSchema>): Promise<VehicleMeters> {
  const db = deps.db.core;
  const vehicle = await getVehicle(db, actor, vehicleId);
  const row = await rowOf(db, vehicleId);
  const before = toMeters(row);
  if (data.odometerKm !== undefined) row.odo_offset_m = data.odometerKm * 1000 - (odometerM(row) - row.odo_offset_m);
  if (data.engineHours !== undefined) row.hrs_offset_s = data.engineHours * 3600 - (hoursS(row) - row.hrs_offset_s);
  await save(db, actor.orgId, vehicleId, row);
  const after = toMeters(row);
  await audit(db, actor, "meters.adjust", "vehicle", vehicleId, {
    name: vehicle.name,
    ...(data.odometerKm !== undefined ? { odometerKm: after.odometerKm, odometerBefore: before.odometerKm } : {}),
    ...(data.engineHours !== undefined ? { engineHours: after.engineHours, hoursBefore: before.engineHours } : {}),
  });
  return after;
}
