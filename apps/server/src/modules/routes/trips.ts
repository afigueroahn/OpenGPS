// Routes and logistics: dispatches. Some stops assigned to a vehicle, with
// what happens at each one, the driver's link, the tracking link for each
// delivery and the proofs of delivery.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DeliveryView,
  type Language,
  type DriverTripView,
  type NearbyVehicle,
  ROUTE_PROOF_TYPES,
  type RouteProofKind,
  type RouteStopStatus,
  type RouteTrip,
  type RouteTripStatus,
  type RouteTripStop,
  metersBetween,
  type routeStopUpdateSchema,
  type routeTripSchema,
  vehicleStatus,
} from "@opengps/shared";
import type { z } from "zod";
import { type Tenant, isUuid } from "../../core/access";
import { audit } from "../../core/audit";
import { type Actor, getVehicle, listVehicles } from "../../core/vehicles";
import { filesFolder } from "../../core/files";
import { type Queryable, withTransaction } from "../../db";
import { badRequest, notFound } from "../../errors";
import { say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";
import { type Line, planOf } from "./plans";

type Deps = Pick<ModuleDeps, "db" | "bus" | "config" | "gate">;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");
const iso = (d: Date | null) => d?.toISOString() ?? null;

interface TripRow {
  id: string;
  org_id: string;
  plan_id: string | null;
  name: string;
  vehicle_id: string;
  vehicle_name: string;
  driver: string | null;
  starts_at: Date;
  status: RouteTripStatus;
  line: Line;
  tolerance_m: number;
  off_route: boolean;
  started_at: Date | null;
  finished_at: Date | null;
}
interface StopRow {
  id: string;
  trip_id: string;
  seq: number;
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
  planned_at: Date | null;
  contact: string | null;
  status: RouteStopStatus;
  arrived_at: Date | null;
  done_at: Date | null;
  recipient: string | null;
  note: string | null;
  photo_mime: string | null;
  signature_mime: string | null;
}
const TRIP_SELECT = `SELECT t.id, t.org_id, t.plan_id, t.name, t.vehicle_id, v.name AS vehicle_name, t.driver, t.starts_at, t.status, t.line, t.tolerance_m, t.off_route, t.started_at, t.finished_at
  FROM gps.route_trips t JOIN gps.vehicles v ON v.id = t.vehicle_id`;
const STOP_COLUMNS = `id, trip_id, seq, name, lat, lon, radius_m, planned_at, contact, status, arrived_at, done_at, recipient, note, photo_mime, signature_mime`;

const toStop = (s: StopRow): RouteTripStop => ({
  id: s.id,
  seq: s.seq,
  name: s.name,
  lat: s.lat,
  lon: s.lon,
  radiusM: s.radius_m,
  plannedAt: iso(s.planned_at),
  contact: s.contact,
  status: s.status,
  arrivedAt: iso(s.arrived_at),
  doneAt: iso(s.done_at),
  recipient: s.recipient,
  note: s.note,
  hasPhoto: s.photo_mime !== null,
  hasSignature: s.signature_mime !== null,
});

async function assemble(db: Queryable, rows: TripRow[]): Promise<RouteTrip[]> {
  if (rows.length === 0) return [];
  const stops = await db.query<StopRow>(`SELECT ${STOP_COLUMNS} FROM gps.route_trip_stops WHERE trip_id = ANY($1::uuid[]) ORDER BY seq`, [rows.map((r) => r.id)]);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    planId: t.plan_id,
    vehicleId: t.vehicle_id,
    vehicleName: t.vehicle_name,
    driver: t.driver,
    startsAt: t.starts_at.toISOString(),
    status: t.status,
    startedAt: iso(t.started_at),
    finishedAt: iso(t.finished_at),
    offRoute: t.off_route,
    toleranceM: t.tolerance_m,
    line: t.line,
    stops: stops.rows.filter((s) => s.trip_id === t.id).map(toStop),
  }));
}

/** Dispatches of the vehicles the person sees: those in progress or about to leave, and those of a period. */
export async function listTrips(db: Queryable, tenant: Tenant, range: { from: Date; to: Date }): Promise<RouteTrip[]> {
  const ids = (await listVehicles(db, tenant)).map((v) => v.id);
  const r = await db.query<TripRow>(
    `${TRIP_SELECT}
      WHERE t.vehicle_id = ANY($1::uuid[]) AND (t.status IN ('assigned', 'in_progress') OR (t.starts_at >= $2 AND t.starts_at < $3))
      ORDER BY (t.status IN ('assigned', 'in_progress')) DESC, t.starts_at DESC LIMIT 500`,
    [ids, range.from, range.to],
  );
  return assemble(db, r.rows);
}

async function rowOf(db: Queryable, tenant: Tenant, id: string): Promise<TripRow> {
  if (!isUuid(id)) throw notFound(say("routes.errors.tripNotFound"));
  const r = await db.query<TripRow>(`${TRIP_SELECT} WHERE t.id = $1 AND t.org_id = $2`, [id, tenant.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("routes.errors.tripNotFound"));
  // Whoever does not see the vehicle does not see its dispatches either.
  await getVehicle(db, tenant, row.vehicle_id);
  return row;
}

export async function getTrip(db: Queryable, tenant: Tenant, id: string): Promise<RouteTrip> {
  return (await assemble(db, [await rowOf(db, tenant, id)]))[0] as RouteTrip;
}

export async function createTrip(deps: Deps, actor: Actor, data: z.output<typeof routeTripSchema>): Promise<RouteTrip> {
  const db = deps.db.core;
  const vehicle = await getVehicle(db, actor, data.vehicleId);
  const plan = data.planId ? await planOf(db, actor.orgId, data.planId) : null;
  // A planned route yields its stops, with the time each one is expected to be reached.
  const stops =
    data.stops && data.stops.length > 0
      ? data.stops
      : (plan?.stops ?? []).map((s) => ({ name: s.name, lat: s.lat, lon: s.lon, radiusM: s.radiusM, contact: s.contact, plannedAt: s.etaMin === null ? null : new Date(data.startsAt.getTime() + s.etaMin * 60_000) }));
  if (stops.length === 0) throw badRequest(say("routes.errors.stopNeeded"));
  const line = data.line ?? plan?.line ?? [];
  if (line.length === 1) throw badRequest(say("routes.errors.lineTooShort"));
  const id = await withTransaction(db, async (client) => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO gps.route_trips (org_id, plan_id, name, vehicle_id, driver, starts_at, line, tolerance_m, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING id`,
      [actor.orgId, plan?.id ?? null, data.name, data.vehicleId, data.driver, data.startsAt, JSON.stringify(line), data.toleranceM ?? plan?.toleranceM ?? 150, actor.userId],
    );
    const tripId = (r.rows[0] as { id: string }).id;
    let seq = 0;
    for (const s of stops) {
      await client.query(`INSERT INTO gps.route_trip_stops (org_id, trip_id, seq, name, lat, lon, radius_m, planned_at, contact) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [actor.orgId, tripId, ++seq, s.name, s.lat, s.lon, s.radiusM, s.plannedAt, s.contact]);
    }
    await audit(client, actor, "routes.trip.create", "vehicle", data.vehicleId, { name: vehicle.name, trip: data.name, stops: stops.length });
    return tripId;
  });
  deps.bus.emit("routes_changed", { orgId: actor.orgId });
  return getTrip(db, actor, id);
}

/** If no stop is left to attend, the dispatch is finished. */
export async function finishIfComplete(db: Queryable, tripId: string, at = new Date()): Promise<boolean> {
  const r = await db.query(
    `UPDATE gps.route_trips t SET status = 'done', finished_at = $2, off_route = false
      WHERE t.id = $1 AND t.status IN ('assigned', 'in_progress')
        AND NOT EXISTS (SELECT 1 FROM gps.route_trip_stops s WHERE s.trip_id = t.id AND s.status IN ('pending', 'arrived'))`,
    [tripId, at],
  );
  return Boolean(r.rowCount);
}

/** Starts, finishes or cancels a dispatch by hand. */
export async function setTripStatus(deps: Deps, actor: Actor, id: string, status: "in_progress" | "done" | "cancelled"): Promise<RouteTrip> {
  const db = deps.db.core;
  const row = await rowOf(db, actor, id);
  if (row.status === "done" || row.status === "cancelled") throw badRequest(say("routes.errors.tripClosed"));
  if (status === "in_progress") await db.query(`UPDATE gps.route_trips SET status = 'in_progress', started_at = COALESCE(started_at, now()) WHERE id = $1`, [id]);
  else await db.query(`UPDATE gps.route_trips SET status = $2, finished_at = now(), off_route = false, started_at = COALESCE(started_at, CASE WHEN $2 = 'done' THEN now() END) WHERE id = $1`, [id, status]);
  await audit(db, actor, "routes.trip.status", "vehicle", row.vehicle_id, { trip: row.name, status });
  deps.bus.emit("routes_changed", { orgId: actor.orgId });
  return getTrip(db, actor, id);
}

const folderOf = (deps: Pick<ModuleDeps, "config">, orgId: string, tripId: string) => filesFolder(deps.config, "routes", orgId, tripId);

export async function deleteTrip(deps: Deps, actor: Actor, id: string): Promise<void> {
  const row = await rowOf(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.route_trips WHERE id = $1`, [id]);
  await rm(folderOf(deps, actor.orgId, id), { recursive: true, force: true });
  await audit(deps.db.core, actor, "routes.trip.delete", "vehicle", row.vehicle_id, { trip: row.name });
  deps.bus.emit("routes_changed", { orgId: actor.orgId });
}

/** When an account is deleted, its files are removed from disk. */
export async function dropAccountFiles(deps: Pick<ModuleDeps, "config">, orgId: string): Promise<void> {
  await rm(filesFolder(deps.config, "routes", orgId), { recursive: true, force: true });
}

// ─── Stops ───────────────────────────────────────────────────────────────────

/** Records what happened at a stop. Used by the dispatch and the driver's link. */
async function writeStop(deps: Deps, trip: { id: string; org_id: string; status: RouteTripStatus }, stopId: string, data: z.output<typeof routeStopUpdateSchema>): Promise<void> {
  const db = deps.db.core;
  if (trip.status === "cancelled") throw badRequest(say("routes.errors.tripCancelled"));
  const closed = data.status === "done" || data.status === "failed" || data.status === "skipped";
  const r = await db.query(
    `UPDATE gps.route_trip_stops
        SET status = $3, recipient = COALESCE($4, recipient), note = COALESCE($5, note),
            arrived_at = CASE WHEN $3 = 'pending' THEN NULL WHEN $3 IN ('arrived', 'done') THEN COALESCE(arrived_at, now()) ELSE arrived_at END,
            done_at = CASE WHEN $6 THEN COALESCE(done_at, now()) ELSE NULL END
      WHERE id = $1 AND trip_id = $2`,
    [stopId, trip.id, data.status, data.recipient, data.note, closed],
  );
  if (!r.rowCount) throw notFound(say("routes.errors.stopNotFound"));
  // Attending a stop starts the dispatch; attending the last one finishes it.
  if (data.status !== "pending") await db.query(`UPDATE gps.route_trips SET status = 'in_progress', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status = 'assigned'`, [trip.id]);
  await finishIfComplete(db, trip.id);
  deps.bus.emit("routes_changed", { orgId: trip.org_id });
}

async function stopOf(db: Queryable, tenant: Tenant, stopId: string): Promise<{ stop: StopRow; trip: TripRow }> {
  if (!isUuid(stopId)) throw notFound(say("routes.errors.stopNotFound"));
  const r = await db.query<StopRow>(`SELECT ${STOP_COLUMNS} FROM gps.route_trip_stops WHERE id = $1 AND org_id = $2`, [stopId, tenant.orgId]);
  const stop = r.rows[0];
  if (!stop) throw notFound(say("routes.errors.stopNotFound"));
  return { stop, trip: await rowOf(db, tenant, stop.trip_id) };
}

export async function updateStop(deps: Deps, actor: Actor, stopId: string, data: z.output<typeof routeStopUpdateSchema>): Promise<RouteTrip> {
  const { trip } = await stopOf(deps.db.core, actor, stopId);
  await writeStop(deps, trip, stopId, data);
  return getTrip(deps.db.core, actor, trip.id);
}

// ─── Links ───────────────────────────────────────────────────────────────────

/** Creates the driver's link. If there was one, it stops working. */
export async function driverLink(deps: Deps, actor: Actor, tripId: string): Promise<string> {
  const row = await rowOf(deps.db.core, actor, tripId);
  const token = newToken();
  await deps.db.core.query(`UPDATE gps.route_trips SET driver_token = $2 WHERE id = $1`, [tripId, hashOf(token)]);
  await audit(deps.db.core, actor, "routes.trip.link", "vehicle", row.vehicle_id, { trip: row.name });
  return token;
}

/** Creates the public tracking link for a delivery. If there was one, it stops working. */
export async function trackLink(deps: Deps, actor: Actor, stopId: string): Promise<string> {
  const { stop, trip } = await stopOf(deps.db.core, actor, stopId);
  const token = newToken();
  await deps.db.core.query(`UPDATE gps.route_trip_stops SET track_token = $2 WHERE id = $1`, [stopId, hashOf(token)]);
  await audit(deps.db.core, actor, "routes.stop.link", "vehicle", trip.vehicle_id, { trip: trip.name, stop: stop.name });
  return token;
}

/** Days after closing that a link still shows how it ended. */
const LINK_DAYS = 3;
const expired = (trip: TripRow) => trip.finished_at !== null && Date.now() - trip.finished_at.getTime() > LINK_DAYS * 86_400_000;

async function tripByToken(db: Queryable, token: string): Promise<TripRow | null> {
  const r = await db.query<TripRow>(`${TRIP_SELECT} WHERE t.driver_token = $1`, [hashOf(token)]);
  const row = r.rows[0];
  return row && !expired(row) ? row : null;
}
const accountName = async (db: Queryable, orgId: string) => (await db.query<{ name: string }>(`SELECT name FROM auth.organization WHERE id = $1`, [orgId])).rows[0]?.name ?? "";

/** What the driver sees with their link. One that does not exist, was changed or expired responds the same: nothing. */
export async function viewDriver(db: Queryable, token: string): Promise<DriverTripView | null> {
  const row = await tripByToken(db, token);
  if (!row) return null;
  const trip = (await assemble(db, [row]))[0] as RouteTrip;
  return { account: await accountName(db, row.org_id), name: trip.name, vehicleName: trip.vehicleName, driver: trip.driver, status: trip.status, startsAt: trip.startsAt, line: trip.line, stops: trip.stops };
}

export async function driverStop(deps: Deps, token: string, stopId: string, data: z.output<typeof routeStopUpdateSchema>): Promise<DriverTripView | null> {
  const row = await tripByToken(deps.db.core, token);
  if (!row) return null;
  if (!isUuid(stopId)) throw notFound(say("routes.errors.stopNotFound"));
  await writeStop(deps, row, stopId, data);
  return viewDriver(deps.db.core, token);
}

export async function driverStatus(deps: Deps, token: string, status: "in_progress" | "done"): Promise<DriverTripView | null> {
  const db = deps.db.core;
  const row = await tripByToken(db, token);
  if (!row) return null;
  if (row.status === "assigned" || row.status === "in_progress") {
    if (status === "in_progress") await db.query(`UPDATE gps.route_trips SET status = 'in_progress', started_at = COALESCE(started_at, now()) WHERE id = $1`, [row.id]);
    else {
      // Finishing the route marks as skipped the stops that were not attended.
      await db.query(`UPDATE gps.route_trip_stops SET status = 'skipped', done_at = now() WHERE trip_id = $1 AND status IN ('pending', 'arrived')`, [row.id]);
      await db.query(`UPDATE gps.route_trips SET status = 'done', finished_at = now(), off_route = false, started_at = COALESCE(started_at, now()) WHERE id = $1`, [row.id]);
    }
    deps.bus.emit("routes_changed", { orgId: row.org_id });
  }
  return viewDriver(db, token);
}

// ─── Proofs of delivery ──────────────────────────────────────────────────────

const proofPath = (deps: Pick<ModuleDeps, "config">, orgId: string, tripId: string, stopId: string, kind: RouteProofKind) => join(folderOf(deps, orgId, tripId), `${stopId}-${kind}`);

/** Records the proof of delivery photo or signature, from the driver's link. */
export async function driverProof(deps: Deps, token: string, stopId: string, kind: RouteProofKind, file: { mime: string; data: Buffer }): Promise<DriverTripView | null> {
  const db = deps.db.core;
  const row = await tripByToken(db, token);
  if (!row) return null;
  if (row.status === "cancelled") throw badRequest(say("routes.errors.tripCancelled"));
  if (!(ROUTE_PROOF_TYPES as readonly string[]).includes(file.mime)) throw badRequest(say("routes.errors.proofType"));
  if (file.data.length === 0) throw badRequest(say("routes.errors.imageEmpty"));
  if (file.data.length > deps.config.maxUploadMb * 1024 * 1024) throw badRequest(say("routes.errors.imageTooBig", { mb: deps.config.maxUploadMb }));
  if (!isUuid(stopId)) throw notFound(say("routes.errors.stopNotFound"));
  const known = await db.query(`SELECT 1 FROM gps.route_trip_stops WHERE id = $1 AND trip_id = $2`, [stopId, row.id]);
  if (!known.rowCount) throw notFound(say("routes.errors.stopNotFound"));
  await mkdir(folderOf(deps, row.org_id, row.id), { recursive: true });
  await writeFile(proofPath(deps, row.org_id, row.id, stopId, kind), file.data);
  await db.query(`UPDATE gps.route_trip_stops SET ${kind === "photo" ? "photo_mime" : "signature_mime"} = $2 WHERE id = $1`, [stopId, file.mime]);
  deps.bus.emit("routes_changed", { orgId: row.org_id });
  return viewDriver(db, token);
}

export async function readProof(deps: Deps, tenant: Tenant, stopId: string, kind: RouteProofKind): Promise<{ mime: string; data: Buffer }> {
  const { stop, trip } = await stopOf(deps.db.core, tenant, stopId);
  const mime = kind === "photo" ? stop.photo_mime : stop.signature_mime;
  const data = mime ? await readFile(proofPath(deps, trip.org_id, trip.id, stopId, kind)).catch(() => null) : null;
  if (!mime || !data) throw notFound(say("routes.errors.proofNotFound"));
  return { mime, data };
}

// ─── Public tracking of a delivery ───────────────────────────────────────────

export async function viewDelivery(db: Queryable, token: string): Promise<DeliveryView | null> {
  const r = await db.query<StopRow>(`SELECT ${STOP_COLUMNS} FROM gps.route_trip_stops WHERE track_token = $1`, [hashOf(token)]);
  const stop = r.rows[0];
  if (!stop) return null;
  const t = await db.query<TripRow>(`${TRIP_SELECT} WHERE t.id = $1`, [stop.trip_id]);
  const trip = t.rows[0];
  if (!trip || expired(trip)) return null;
  const before = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.route_trip_stops WHERE trip_id = $1 AND seq < $2 AND status IN ('pending', 'arrived')`, [trip.id, stop.seq]);
  // The vehicle's position is shown only while it is on its way to this delivery.
  let vehicle: DeliveryView["vehicle"] = null;
  if (trip.status === "in_progress" && (stop.status === "pending" || stop.status === "arrived")) {
    const s = await db.query<{ lat: number | null; lon: number | null; course: number | null; fix_time: Date | null; speed_kmh: number | null }>(
      `SELECT s.lat, s.lon, s.course, s.fix_time, s.speed_kmh FROM gps.devices d JOIN gps.device_state s ON s.device_id = d.id WHERE d.vehicle_id = $1`,
      [trip.vehicle_id],
    );
    const p = s.rows[0];
    if (p && p.lat !== null && p.lon !== null) vehicle = { lat: p.lat, lon: p.lon, course: p.course, fixTime: iso(p.fix_time), moving: (p.speed_kmh ?? 0) > 3 };
  }
  return {
    account: await accountName(db, trip.org_id),
    stopName: stop.name,
    status: stop.status,
    tripStatus: trip.status,
    plannedAt: iso(stop.planned_at),
    arrivedAt: iso(stop.arrived_at),
    doneAt: iso(stop.done_at),
    stopsBefore: before.rows[0]?.n ?? 0,
    destination: { lat: stop.lat, lon: stop.lon },
    vehicle,
  };
}

// ─── Dispatch: the nearest available vehicle ─────────────────────────────────

/** The account's vehicles, from nearest to farthest from a destination, in a straight line. Available ones first; why the others are not, in `language`. */
export async function nearest(deps: Deps, tenant: Tenant, point: { lat: number; lon: number }, language: Language, now = Date.now()): Promise<NearbyVehicle[]> {
  const db = deps.db.core;
  const vehicles = await listVehicles(db, tenant);
  const ids = vehicles.map((v) => v.id);
  const busy = await db.query<{ vehicle_id: string; name: string }>(
    `SELECT DISTINCT ON (vehicle_id) vehicle_id, name FROM gps.route_trips
      WHERE vehicle_id = ANY($1::uuid[]) AND (status = 'in_progress' OR (status = 'assigned' AND starts_at < now() + interval '2 hours'))
      ORDER BY vehicle_id, starts_at`,
    [ids],
  );
  const tripOf = new Map(busy.rows.map((b) => [b.vehicle_id, b.name]));
  // With the fleet module, a vehicle in the workshop, out of service or retired is not a candidate.
  const out = new Map<string, string>();
  if (await deps.gate.enabled(tenant.orgId, "D")) {
    const fleet = await db.query<{ vehicle_id: string; status: string; state: string }>(`SELECT vehicle_id, status, state FROM gps.fleet_vehicles WHERE vehicle_id = ANY($1::uuid[]) AND (status <> 'available' OR state <> 'active')`, [ids]);
    for (const f of fleet.rows) {
      out.set(
        f.vehicle_id,
        tr(language, f.state === "retired" ? "shared.fleetState.retired" : f.state === "suspended" ? "shared.fleetState.suspended" : f.status === "workshop" ? "shared.fleetAvailability.workshop" : "shared.fleetAvailability.out_of_service"),
      );
    }
  }
  const list = vehicles.map((v): NearbyVehicle => {
    const status = vehicleStatus(v, now);
    const reporting = status === "moving" || status === "idle" || status === "stopped";
    const lat = v.state?.lat ?? null;
    const lon = v.state?.lon ?? null;
    const trip = tripOf.get(v.id);
    const reason = out.get(v.id) ?? (trip !== undefined ? tr(language, "routes.nearest.onTrip", { name: trip }) : !reporting ? tr(language, "routes.nearest.notReporting") : null);
    return {
      vehicleId: v.id,
      name: v.name,
      distanceM: lat !== null && lon !== null ? Math.round(metersBetween([lon, lat], [point.lon, point.lat])) : null,
      lat,
      lon,
      lastSeenAt: v.state?.lastSeenAt ?? null,
      available: reason === null,
      busy: reason,
    };
  });
  const far = Number.POSITIVE_INFINITY;
  return list.sort((a, b) => Number(b.available) - Number(a.available) || (a.distanceM ?? far) - (b.distanceM ?? far) || a.name.localeCompare(b.name));
}
