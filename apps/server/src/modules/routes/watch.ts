// What the module does on its own with each position of a vehicle that
// has a dispatch: starts it at its time, notes which stops it reaches and
// which it leaves, notifies if it strays from its route's path and marks it
// finished when no stop is left to attend.
import { distanceToLineM, metersBetween } from "@opengps/shared";
import type { CoreEvents, Fix } from "../../bus";
import { recordEvent } from "../../core/events";
import type { ModuleDeps } from "../context";
import type { Line } from "./plans";
import { dropAccountFiles, finishIfComplete } from "./trips";

/** How often it re-reads which vehicles have a dispatch, in case something changed without notice. */
const RELOAD_MS = 60_000;
/** Consecutive positions outside the corridor needed to notify: a single one may be a GPS jump. */
const OFF_ROUTE_FIXES = 2;
/** An assigned dispatch is started on its own from this long before its time. */
const EARLY_START_MS = 30 * 60_000;

export interface RoutesEngine {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
}

interface ActiveStop {
  id: string;
  lat: number;
  lon: number;
  radius_m: number;
  status: "pending" | "arrived";
}
interface ActiveTrip {
  id: string;
  name: string;
  status: "assigned" | "in_progress";
  starts_at: Date;
  line: Line;
  tolerance_m: number;
  off_route: boolean;
  stops: ActiveStop[];
}

export function createRoutesEngine(deps: ModuleDeps): RoutesEngine {
  const db = deps.db.core;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  const off: (() => void)[] = [];
  /** Vehicles with an unclosed dispatch. `null`: they must be read from the database. */
  let active: Map<string, ActiveTrip> | null = null;
  /** Consecutive positions outside the corridor, per dispatch. Kept separately: re-reading the dispatches does not lose it. */
  const strikes = new Map<string, number>();
  const enqueue = (what: string, job: () => Promise<unknown>) => {
    queue = queue.then(job).catch((err: Error) => console.error(`[routes] ${what}:`, err.message));
  };

  async function load(): Promise<Map<string, ActiveTrip>> {
    // For each vehicle, its dispatch in progress or, failing that, the next one due to leave.
    const trips = await db.query<Omit<ActiveTrip, "stops"> & { vehicle_id: string }>(
      `SELECT DISTINCT ON (vehicle_id) vehicle_id, id, name, status, starts_at, line, tolerance_m, off_route
         FROM gps.route_trips WHERE status IN ('assigned', 'in_progress')
        ORDER BY vehicle_id, (status = 'in_progress') DESC, starts_at`,
    );
    const stops = await db.query<ActiveStop & { trip_id: string }>(`SELECT id, trip_id, lat, lon, radius_m, status FROM gps.route_trip_stops WHERE trip_id = ANY($1::uuid[]) AND status IN ('pending', 'arrived') ORDER BY seq`, [trips.rows.map((t) => t.id)]);
    const open = new Set(trips.rows.map((t) => t.id));
    for (const id of strikes.keys()) if (!open.has(id)) strikes.delete(id);
    return new Map(trips.rows.map((t) => [t.vehicle_id, { ...t, stops: stops.rows.filter((s) => s.trip_id === t.id) }]));
  }

  async function handle(p: CoreEvents["fixes"]): Promise<void> {
    active ??= await load();
    const trip = active.get(p.vehicleId);
    if (!trip || !(await deps.gate.enabled(p.orgId, "H"))) return;
    let changed = false;
    for (const fix of p.fixes) changed = (await step(p, trip, fix)) || changed;
    if (changed) {
      active = null;
      deps.bus.emit("routes_changed", { orgId: p.orgId });
    }
  }

  /** Advances the dispatch with a position. Returns whether something people see changed. */
  async function step(p: CoreEvents["fixes"], trip: ActiveTrip, fix: Fix): Promise<boolean> {
    let changed = false;
    const at = new Date(fix.t);
    const here: [number, number] = [fix.lon, fix.lat];
    if (trip.status === "assigned") {
      if (fix.t < trip.starts_at.getTime() - EARLY_START_MS) return false;
      // It leaves at its time, or earlier if it is already at one of its stops.
      const atStop = trip.stops.some((s) => metersBetween(here, [s.lon, s.lat]) <= s.radius_m);
      if (fix.t < trip.starts_at.getTime() && !atStop) return false;
      await db.query(`UPDATE gps.route_trips SET status = 'in_progress', started_at = $2 WHERE id = $1 AND status = 'assigned'`, [trip.id, at]);
      trip.status = "in_progress";
      changed = true;
    }
    let nearStop = false;
    for (const stop of trip.stops) {
      const d = metersBetween(here, [stop.lon, stop.lat]);
      if (d <= stop.radius_m) {
        nearStop = true;
        if (stop.status === "pending") {
          await db.query(`UPDATE gps.route_trip_stops SET status = 'arrived', arrived_at = $2 WHERE id = $1 AND status = 'pending'`, [stop.id, at]);
          stop.status = "arrived";
          changed = true;
        }
      } else if (stop.status === "arrived" && d > stop.radius_m * 2) {
        // It left the place without anyone noting the delivery: it stays as visited.
        await db.query(`UPDATE gps.route_trip_stops SET status = 'done', done_at = $2 WHERE id = $1 AND status = 'arrived'`, [stop.id, at]);
        trip.stops = trip.stops.filter((s) => s.id !== stop.id);
        changed = true;
      }
    }
    // Outside the corridor: far from the path and from all its stops.
    if (trip.line.length >= 2) {
      const meters = distanceToLineM(here, trip.line);
      const outside = meters > trip.tolerance_m && !nearStop;
      const count = outside ? (strikes.get(trip.id) ?? 0) + 1 : 0;
      strikes.set(trip.id, count);
      if (outside !== trip.off_route && (!outside || count >= OFF_ROUTE_FIXES)) {
        trip.off_route = outside;
        await db.query(`UPDATE gps.route_trips SET off_route = $2 WHERE id = $1`, [trip.id, outside]);
        await recordEvent(
          deps,
          { orgId: p.orgId, vehicleId: p.vehicleId, deviceId: p.deviceId, groupId: p.groupId },
          { type: outside ? "route_deviation" : "route_return", at: fix.t, lat: fix.lat, lon: fix.lon, speedKmh: fix.speedKmh, detail: { geofenceName: trip.name, ...(outside ? { meters: Math.round(meters) } : {}) } },
        );
        changed = true;
      }
    }
    if (changed && (await finishIfComplete(db, trip.id, at))) trip.stops = [];
    return changed;
  }

  return {
    start() {
      off.push(
        deps.bus.on("fixes", (payload) => enqueue("could not follow a dispatch", () => handle(payload))),
        // What changes from the dispatch or from the driver's link is re-read.
        deps.bus.on("routes_changed", () => {
          enqueue("could not read the dispatches", async () => {
            active = null;
          });
        }),
        deps.bus.on("account_deleted", (e) => enqueue("could not delete an account's files", () => dropAccountFiles(deps, e.orgId))),
      );
      timer = setInterval(() => enqueue("could not read the dispatches", async () => (active = null)), RELOAD_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const stop of off.splice(0)) stop();
    },
    idle: () => queue.then(() => undefined),
  };
}
