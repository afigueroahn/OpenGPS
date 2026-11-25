// How much and how each person drove: trips per driver, stretches without rest,
// shifts, score and ranking.
//
// Trips come from the core's saved days, the same ones the
// reports use.
import {
  DRIVER_EVENT_POINTS,
  DRIVER_EVENT_TYPES,
  type DriverDay,
  type DriverEvent,
  type DriverEventType,
  type DriverRank,
  type DriverReport,
  type DriverSettings,
  type Language,
  SHIFT_REST_MIN,
  drivingScore,
} from "@opengps/shared";
import { type Tenant, scopeParam, scopeSql } from "../../core/access";
import { loadBlocks } from "../../core/days";
import { type HistoryRange, assertRange } from "../../core/history";
import type { Queryable } from "../../db";
import { tr } from "../../i18n";
import { getDriver, getSettings } from "./drivers";

/** A trip, with just enough to add up. */
export interface DayTrip {
  start: number;
  end: number;
  meters: number;
  idleS: number;
  maxKmh: number;
}

/**
 * Trips of several vehicles of an account that start within the period, by
 * vehicle and in order. They come from the core's saved days.
 */
export async function loadTrips(db: Queryable, orgId: string, vehicleIds: string[], range: HistoryRange, now = Date.now()): Promise<Map<string, DayTrip[]>> {
  const blocks = await loadBlocks(db, orgId, vehicleIds, range, now);
  return new Map(
    vehicleIds.map((id) => [id, (blocks.get(id)?.trips ?? []).map((t) => ({ start: Date.parse(t.start), end: Date.parse(t.end), meters: t.distanceM, idleS: t.idleS, maxKmh: t.maxSpeedKmh }))]),
  );
}

// ─── Shifts and stretches without rest ───────────────────────────────────────

export interface Shift {
  start: number;
  end: number;
  distanceM: number;
  drivingS: number;
  longestStretchS: number;
  rests: number;
}

/**
 * Groups ordered trips into shifts. A pause of at least `minRestMin` is
 * a rest and cuts the continuous driving stretch; one of `SHIFT_REST_MIN`
 * or more ends the shift.
 */
export function shiftsOf(trips: DayTrip[], settings: Pick<DriverSettings, "minRestMin">): Shift[] {
  const shifts: Shift[] = [];
  let current: Shift | null = null;
  let stretch = 0;
  for (const trip of trips) {
    const pause: number = current ? trip.start - current.end : Number.POSITIVE_INFINITY;
    if (!current || pause >= SHIFT_REST_MIN * 60_000) {
      current = { start: trip.start, end: trip.end, distanceM: 0, drivingS: 0, longestStretchS: 0, rests: 0 };
      shifts.push(current);
      stretch = 0;
    } else if (pause >= settings.minRestMin * 60_000) {
      current.rests += 1;
      stretch = 0;
    }
    const seconds = Math.max(0, Math.round((trip.end - trip.start) / 1000));
    stretch += seconds;
    current.drivingS += seconds;
    current.distanceM += trip.meters;
    current.longestStretchS = Math.max(current.longestStretchS, stretch);
    current.end = Math.max(current.end, trip.end);
  }
  return shifts;
}

const zeroCounts = (): Record<DriverEventType, number> => ({ accel: 0, brake: 0, corner: 0, speeding: 0 });
const pointsOf = (counts: Record<DriverEventType, number>) => DRIVER_EVENT_TYPES.reduce((n, type) => n + counts[type] * DRIVER_EVENT_POINTS[type], 0);

function rankOf(driverId: string | null, name: string, shifts: Shift[], counts: Record<DriverEventType, number>, settings: DriverSettings): DriverRank {
  const distanceM = Math.round(shifts.reduce((n, s) => n + s.distanceM, 0));
  const points = pointsOf(counts);
  return {
    driverId,
    name,
    distanceM,
    drivingS: shifts.reduce((n, s) => n + s.drivingS, 0),
    counts,
    points,
    score: drivingScore(points, distanceM),
    longestStretchS: shifts.reduce((n, s) => Math.max(n, s.longestStretchS), 0),
    daysOverDaily: shifts.filter((s) => s.drivingS > settings.maxDailyMin * 60).length,
  };
}

interface Window {
  vehicle_id: string;
  driver_id: string;
  starts_at: Date;
  ends_at: Date | null;
}

/**
 * Who drove each trip, according to the vehicle's assignments. If the
 * driver changes in the middle of a trip, the trip is split at that instant and
 * each person gets their part, in proportion to time.
 */
function attribute(trips: Map<string, DayTrip[]>, windows: Window[]): Map<string | null, DayTrip[]> {
  const byVehicle = new Map<string, Window[]>();
  for (const w of windows) {
    if (!byVehicle.has(w.vehicle_id)) byVehicle.set(w.vehicle_id, []);
    (byVehicle.get(w.vehicle_id) as Window[]).push(w);
  }
  const out = new Map<string | null, DayTrip[]>();
  for (const [vehicleId, list] of trips) {
    const own = byVehicle.get(vehicleId) ?? [];
    for (const trip of list) {
      const cuts = own
        .flatMap((w) => [w.starts_at.getTime(), w.ends_at?.getTime() ?? Number.POSITIVE_INFINITY])
        .filter((t) => t > trip.start && t < trip.end)
        .sort((x, y) => x - y);
      const edges = [trip.start, ...new Set(cuts), trip.end];
      const whole = Math.max(1, trip.end - trip.start);
      for (let i = 0; i + 1 < edges.length; i++) {
        const start = edges[i] as number;
        const end = edges[i + 1] as number;
        const share = edges.length === 2 ? 1 : (end - start) / whole;
        const w = own.find((x) => x.starts_at.getTime() <= start && (x.ends_at === null || x.ends_at.getTime() > start));
        const key = w?.driver_id ?? null;
        if (!out.has(key)) out.set(key, []);
        (out.get(key) as DayTrip[]).push({ start, end, meters: trip.meters * share, idleS: trip.idleS * share, maxKmh: trip.maxKmh });
      }
    }
  }
  for (const list of out.values()) list.sort((x, y) => x.start - y.start);
  return out;
}

async function windowsOf(db: Queryable, vehicleIds: string[], range: HistoryRange, driverId: string | null = null): Promise<Window[]> {
  const r = await db.query<Window>(
    `SELECT vehicle_id, driver_id, starts_at, ends_at
       FROM gps.driver_assignments
      WHERE vehicle_id = ANY($1::uuid[]) AND starts_at < $3 AND (ends_at IS NULL OR ends_at > $2)
        AND ($4::uuid IS NULL OR driver_id = $4)
      ORDER BY starts_at`,
    [vehicleIds, range.from, range.to, driverId],
  );
  return r.rows;
}

/** Ranking of the account's drivers over a period, from best score to worst. The row of what nobody was assigned to is named in `language`. */
export async function ranking(db: Queryable, tenant: Tenant, range: HistoryRange, groupId: string | null, language: Language, vehicleIds: string[] | null = null): Promise<DriverRank[]> {
  assertRange(range);
  const settings = await getSettings(db, tenant.orgId);
  const vehicles = await db.query<{ id: string }>(
    `SELECT v.id FROM gps.vehicles v WHERE v.org_id = $1 AND ${scopeSql(2)} AND ($3::uuid IS NULL OR v.group_id = ANY(gps.groups_with_children(ARRAY[$3::uuid]))) AND ($4::uuid[] IS NULL OR v.id = ANY($4::uuid[]))`,
    [tenant.orgId, scopeParam(tenant), groupId, vehicleIds],
  );
  const ids = vehicles.rows.map((v) => v.id);
  const byDriver = attribute(await loadTrips(db, tenant.orgId, ids, range), await windowsOf(db, ids, range));

  const counts = new Map<string | null, Record<DriverEventType, number>>();
  const events = await db.query<{ driver_id: string | null; type: DriverEventType; n: string }>(
    `SELECT driver_id, type, count(*) AS n FROM gps.driver_events WHERE org_id = $1 AND vehicle_id = ANY($2::uuid[]) AND at >= $3 AND at < $4 GROUP BY driver_id, type`,
    [tenant.orgId, ids, range.from, range.to],
  );
  for (const row of events.rows) {
    if (!counts.has(row.driver_id)) counts.set(row.driver_id, zeroCounts());
    (counts.get(row.driver_id) as Record<DriverEventType, number>)[row.type] = Number(row.n);
  }

  const names = await db.query<{ id: string; name: string }>(`SELECT id, name FROM gps.drivers WHERE org_id = $1`, [tenant.orgId]);
  const nameOf = new Map(names.rows.map((d) => [d.id, d.name]));
  const keys = new Set<string | null>([...byDriver.keys(), ...counts.keys()]);
  const ranks = [...keys]
    // A deleted driver leaves their events without an owner: they go with what was driven without a driver.
    .filter((key) => key === null || nameOf.has(key))
    .map((key) => rankOf(key, key === null ? tr(language, "drivers.ranking.noDriver") : (nameOf.get(key) as string), shiftsOf(byDriver.get(key) ?? [], settings), counts.get(key) ?? zeroCounts(), settings));
  const order = (r: DriverRank) => (r.driverId === null ? -2 : (r.score ?? -1));
  return ranks.sort((a, b) => order(b) - order(a) || b.distanceM - a.distanceM || a.name.localeCompare(b.name));
}

const localDate = (zone: string, ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

/** Detail of a driver over a period: totals, shifts and what cost them points. */
export async function driverReport(db: Queryable, tenant: Tenant, driverId: string, range: HistoryRange, zone: string): Promise<DriverReport> {
  assertRange(range);
  const driver = await getDriver(db, tenant, driverId);
  const settings = await getSettings(db, tenant.orgId);
  // Only what they drove in vehicles this person can see counts.
  const visible = await db.query<{ id: string }>(
    `SELECT DISTINCT v.id
       FROM gps.driver_assignments a
       JOIN gps.vehicles v ON v.id = a.vehicle_id
      WHERE a.driver_id = $1 AND v.org_id = $2 AND ${scopeSql(3)} AND a.starts_at < $5 AND (a.ends_at IS NULL OR a.ends_at > $4)`,
    [driverId, tenant.orgId, scopeParam(tenant), range.from, range.to],
  );
  const ids = visible.rows.map((v) => v.id);
  const trips = attribute(await loadTrips(db, tenant.orgId, ids, range), await windowsOf(db, ids, range, driverId)).get(driverId) ?? [];
  const shifts = shiftsOf(trips, settings);

  const rows = await db.query<{ id: string; type: DriverEventType; at: Date; vehicle_id: string; vehicle_name: string; lat: number | null; lon: number | null; speed_kmh: number | null }>(
    `SELECT e.id, e.type, e.at, e.vehicle_id, v.name AS vehicle_name, e.lat, e.lon, e.speed_kmh
       FROM gps.driver_events e
       JOIN gps.vehicles v ON v.id = e.vehicle_id
      WHERE e.org_id = $1 AND e.driver_id = $2 AND e.at >= $4 AND e.at < $5 AND ${scopeSql(3)}
      ORDER BY e.at DESC`,
    [tenant.orgId, driverId, scopeParam(tenant), range.from, range.to],
  );
  const total = zeroCounts();
  const perShift = shifts.map(() => zeroCounts());
  for (const row of rows.rows) {
    total[row.type] += 1;
    // Each event goes to the shift in which it occurred: the last one that started before.
    const at = row.at.getTime();
    let index = -1;
    for (let i = 0; i < shifts.length && (shifts[i] as Shift).start <= at; i++) index = i;
    const own = perShift[index === -1 ? 0 : index];
    if (own) own[row.type] += 1;
  }

  const days: DriverDay[] = shifts.map((s, i) => ({
    date: localDate(zone, s.start),
    start: new Date(s.start).toISOString(),
    end: new Date(s.end).toISOString(),
    distanceM: Math.round(s.distanceM),
    drivingS: s.drivingS,
    longestStretchS: s.longestStretchS,
    rests: s.rests,
    counts: perShift[i] as Record<DriverEventType, number>,
  }));
  const events: DriverEvent[] = rows.rows.slice(0, 500).map((e) => ({
    id: Number(e.id),
    type: e.type,
    at: e.at.toISOString(),
    vehicleId: e.vehicle_id,
    vehicleName: e.vehicle_name,
    lat: e.lat,
    lon: e.lon,
    speedKmh: e.speed_kmh === null ? null : Math.round(e.speed_kmh),
  }));
  return { rank: rankOf(driver.id, driver.name, shifts, total, settings), days, events };
}

/** Stretches of a period in which each driver had a vehicle, in order. Used by the fuel module. */
export async function driverWindows(db: Queryable, vehicleId: string, range: HistoryRange): Promise<{ driverId: string; name: string; start: number; end: number }[]> {
  const r = await db.query<{ driver_id: string; name: string; starts_at: Date; ends_at: Date | null }>(
    `SELECT a.driver_id, dr.name, a.starts_at, a.ends_at
       FROM gps.driver_assignments a
       JOIN gps.drivers dr ON dr.id = a.driver_id
      WHERE a.vehicle_id = $1 AND a.starts_at < $3 AND (a.ends_at IS NULL OR a.ends_at > $2)
      ORDER BY a.starts_at`,
    [vehicleId, range.from, range.to],
  );
  return r.rows.map((w) => ({
    driverId: w.driver_id,
    name: w.name,
    start: Math.max(w.starts_at.getTime(), range.from.getTime()),
    end: Math.min(w.ends_at?.getTime() ?? Number.POSITIVE_INFINITY, range.to.getTime()),
  }));
}
