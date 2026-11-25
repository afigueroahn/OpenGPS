// The reports of module G. All return the same document shape
// (totals, an optional chart and tables), so the screen, the Excel and the PDF
// write them with the same pieces.
//
// Trips and stops come from the core's saved days. Each trip counts
// on the day it started: so a day's mileage is the sum of the
// trips of that day in the trips report.
import {
  ALERT_EVENTS,
  DRIVER_EVENT_TYPES,
  type EventType,
  type Language,
  type MaintDueStatus,
  type MaintExpiryKind,
  type MaintOrderKind,
  type MaintOrderStatus,
  REPORT_INFO,
  REPORT_MAX_ROWS,
  type ReportCell,
  type ReportColumn,
  type ReportDocument,
  type ReportParams,
  type ReportPlace,
  type ReportStat,
  type ReportTable,
  type ReportType,
  type ReportValue,
  SCORE_MIN_KM,
  type TextParams,
} from "@opengps/shared";
import { type Tenant, scopeParam, scopeSql } from "../../core/access";
import { type VehicleBlocks, loadBlocks } from "../../core/days";
import { type Clock, createClock, decimalMark } from "../../core/export/format";
import { knownAddresses } from "../../core/geocode";
import { type HistoryRange, assertRange } from "../../core/history";
import { eventFacts } from "../../core/notify";
import type { Queryable } from "../../db";
import { badRequest, notFound } from "../../errors";
import { type Say, type ServerKey, render, say, tr } from "../../i18n";
import type reportTexts from "../../locales/es/reports";
import { fuelReport } from "../fuel/fuel";
import { ranking } from "../drivers/driving";
import { expiriesOf, schedulesOf } from "../maintenance/due";
import { poiNames } from "../routes/plans";
import type { ModuleDeps } from "../context";

export type ReportDeps = Pick<ModuleDeps, "db" | "gate">;

export interface ReportRequest {
  type: ReportType;
  range: HistoryRange;
  zone: string;
  params: ReportParams;
  /** The language the report is written in: that of whoever reads it. */
  language: Language;
  now?: number;
}

/** Vehicle within a report. */
export interface Car {
  id: string;
  name: string;
  groupId: string | null;
  group: string | null;
}

interface Context {
  deps: ReportDeps;
  db: Queryable;
  tenant: Tenant;
  cars: Car[];
  range: HistoryRange;
  clock: Clock;
  params: ReportParams;
  now: number;
  /** End of the period, not beyond now. */
  until: number;
  /** The language the report is written in. */
  language: Language;
  /** A title of a total, chart, table or column, in the report's language. */
  label: (key: ReportLabel) => string;
  /** A text of the reports in the report's language. */
  t: (key: ServerKey, params?: TextParams) => string;
  /** Alphabetical order of names, in the report's language. */
  byName: (a: string, b: string) => number;
}

/** A title of a total, chart, table or column of a report. */
type ReportLabel = keyof typeof reportTexts.labels;

type Parts = Pick<ReportDocument, "stats" | "tables"> & Partial<Pick<ReportDocument, "chart" | "notes" | "options">>;

/** Most speeding episodes that are listed, and vehicles with a tank that go into a fuel report. */
const MAX_OVER_ROWS = 200_000;
const MAX_FUEL_VEHICLES = 60;
/** Two positions above the limit separated by more than this are two distinct episodes. */
const OVER_GAP_MS = 120_000;
const MAX_EVENTS = 50_000;

const col = (label: string, type: ReportCell = "text"): ReportColumn => ({ label, type });
const stat = (label: string, type: ReportCell, value: ReportValue): ReportStat => ({ label, type, value });
const place = (lat: number, lon: number): ReportPlace => ({ lat, lon, address: null });
const table = (title: string, columns: ReportColumn[], rows: ReportValue[][], totals: ReportValue[] | null = null): ReportTable => ({
  title,
  columns,
  rows: rows.slice(0, REPORT_MAX_ROWS),
  totals,
  total: rows.length,
});
const sumOf = <T>(list: T[], pick: (item: T) => number) => list.reduce((n, item) => n + pick(item), 0);
const maxOf = <T>(list: T[], pick: (item: T) => number) => list.reduce((n, item) => Math.max(n, pick(item)), 0);
/** Alphabetical order of names in a language, with the numbers in them in their order. */
export const nameOrder = (language: Language) => (a: string, b: string) => a.localeCompare(b, language, { numeric: true });
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
/** "4.777,50 HNL" in Spanish, "4,777.50 HNL" in English: with thousands separator, as on the web. */
function moneyText(amount: number, currency: string, language: Language): string {
  const [whole, cents] = amount.toFixed(2).split(".") as [string, string];
  const [thousands, decimals] = language === "es" ? [".", ","] : [",", "."];
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands)}${decimals}${cents} ${currency}`;
}
/** "3 de 10", in the report's language. */
const ofTotal = (c: Context, part: number, whole: number) => c.t("reports.values.ofTotal", { part, whole });

/** Days of the period in the time zone of whoever requests it: "2026-11-21". */
export function dayKeys(clock: Clock, from: number, to: number): string[] {
  const out: string[] = [];
  for (let t = from; t < to; t += 3_600_000) {
    const day = clock.date(t);
    if (out[out.length - 1] !== day) out.push(day);
  }
  return out;
}

/**
 * The report's vehicles: those the person can see, from a group or chosen one by
 * one. They come in no particular order: whoever shows them sorts them in the
 * reader's language. The label says which they are, to be said in that language.
 */
export async function carsOf(db: Queryable, tenant: Tenant, params: Pick<ReportParams, "groupId" | "vehicleIds">): Promise<{ cars: Car[]; label: Say | string }> {
  const r = await db.query<{ id: string; name: string; group_id: string | null; group_name: string | null }>(
    `SELECT v.id, v.name, v.group_id, g.name AS group_name
       FROM gps.vehicles v
       LEFT JOIN gps.vehicle_groups g ON g.id = v.group_id
      WHERE v.org_id = $1 AND ${scopeSql(2)}
        AND ($3::uuid IS NULL OR v.group_id = ANY(gps.groups_with_children(ARRAY[$3::uuid])))
        AND ($4::uuid[] IS NULL OR v.id = ANY($4::uuid[]))`,
    [tenant.orgId, scopeParam(tenant), params.groupId, params.vehicleIds],
  );
  const cars = r.rows.map((v) => ({ id: v.id, name: v.name, groupId: v.group_id, group: v.group_name }));
  if (params.vehicleIds) {
    if (cars.length === 0) throw badRequest(say("reports.errors.noVehicleInReach"));
    return { cars, label: cars.length === 1 ? (cars[0] as Car).name : say("reports.scope.chosen", { count: cars.length }) };
  }
  if (params.groupId) {
    const group = await db.query<{ name: string }>(`SELECT name FROM gps.vehicle_groups WHERE id = $1 AND org_id = $2 AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`, [
      params.groupId,
      tenant.orgId,
      tenant.groups,
    ]);
    if (!group.rows[0]) throw notFound(say("reports.errors.groupNotFound"));
    return { cars, label: say("reports.scope.group", { name: group.rows[0].name }) };
  }
  return { cars, label: say("reports.scope.all") };
}

const blocksOf = (c: Context): Promise<Map<string, VehicleBlocks>> =>
  loadBlocks(
    c.db,
    c.tenant.orgId,
    c.cars.map((car) => car.id),
    c.range,
    c.now,
  );
const none: VehicleBlocks = { trips: [], stops: [] };

// ─── Trips ───────────────────────────────────────────────────────────────────

async function trips(c: Context): Promise<Parts> {
  const blocks = await blocksOf(c);
  const rows: ReportValue[][] = [];
  let count = 0;
  let meters = 0;
  let seconds = 0;
  let idle = 0;
  let top = 0;
  let used = 0;
  for (const car of c.cars) {
    const list = (blocks.get(car.id) ?? none).trips;
    if (list.length > 0) used++;
    for (const t of list) {
      count++;
      meters += t.distanceM;
      seconds += t.durationS;
      idle += t.idleS;
      top = Math.max(top, t.maxSpeedKmh);
      rows.push([car.name, t.start, t.end, t.durationS, t.distanceM, t.maxSpeedKmh, t.avgSpeedKmh, t.idleS, place(t.startLat, t.startLon), place(t.endLat, t.endLon)]);
    }
  }
  const { label } = c;
  return {
    stats: [
      stat(label("trips"), "integer", count),
      stat(label("distance"), "distance", meters),
      stat(label("tripTime"), "duration", seconds),
      stat(label("topSpeed"), "speed", count ? top : null),
      stat(label("vehiclesWithTrips"), "text", ofTotal(c, used, c.cars.length)),
    ],
    tables: [
      table(
        label("trips"),
        [
          col(label("vehicle")),
          col(label("start"), "datetime"),
          col(label("end"), "datetime"),
          col(label("duration"), "duration"),
          col(label("distance"), "distance"),
          col(label("maxSpeed"), "speed"),
          col(label("avgSpeed"), "speed"),
          col(label("idle"), "duration"),
          col(label("origin"), "place"),
          col(label("destination"), "place"),
        ],
        rows,
        count ? [label("total"), null, null, seconds, meters, top, null, idle, null, null] : null,
      ),
    ],
    notes: [c.t("reports.notes.trips")],
  };
}

// ─── Stops ───────────────────────────────────────────────────────────────────

async function stops(c: Context): Promise<Parts> {
  const blocks = await blocksOf(c);
  const minimum = c.params.minStopMin * 60;
  const rows: ReportValue[][] = [];
  let seconds = 0;
  let idle = 0;
  let longest = 0;
  for (const car of c.cars) {
    for (const s of (blocks.get(car.id) ?? none).stops) {
      if (s.durationS < minimum) continue;
      seconds += s.durationS;
      idle += s.idleS;
      longest = Math.max(longest, s.durationS);
      rows.push([car.name, s.start, s.end, s.durationS, s.idleS, place(s.lat, s.lon)]);
    }
  }
  const { label } = c;
  return {
    options: [c.t("reports.options.minStop", { min: c.params.minStopMin })],
    stats: [
      stat(label("stops"), "integer", rows.length),
      stat(label("stoppedTime"), "duration", seconds),
      stat(label("longestStop"), "duration", rows.length ? longest : null),
      stat(label("engineOn"), "duration", idle),
    ],
    tables: [
      table(
        label("stops"),
        [col(label("vehicle")), col(label("start"), "datetime"), col(label("end"), "datetime"), col(label("duration"), "duration"), col(label("engineOn"), "duration"), col(label("place"), "place")],
        rows,
        rows.length ? [label("total"), null, null, seconds, idle, null] : null,
      ),
    ],
    notes: [c.t("reports.notes.stops")],
  };
}

// ─── Mileage ─────────────────────────────────────────────────────────────────

interface DayTotals {
  meters: number;
  trips: number;
  seconds: number;
  moving: number;
  idle: number;
  cars: Set<string>;
}
const emptyDay = (): DayTotals => ({ meters: 0, trips: 0, seconds: 0, moving: 0, idle: 0, cars: new Set() });

/** What belongs to each vehicle and each day, from the trips. */
function tally(c: Context, blocks: Map<string, VehicleBlocks>) {
  const days = new Map<string, DayTotals>(dayKeys(c.clock, c.range.from.getTime(), c.until).map((d) => [d, emptyDay()]));
  const perCar = new Map<string, { meters: number; trips: number; seconds: number; moving: number; idle: number; top: number; days: Map<string, DayTotals> }>();
  for (const car of c.cars) {
    const own = { meters: 0, trips: 0, seconds: 0, moving: 0, idle: 0, top: 0, days: new Map<string, DayTotals>() };
    perCar.set(car.id, own);
    const add = (date: string, fill: (d: DayTotals) => void) => {
      if (!days.has(date)) days.set(date, emptyDay());
      if (!own.days.has(date)) own.days.set(date, emptyDay());
      fill(days.get(date) as DayTotals);
      fill(own.days.get(date) as DayTotals);
    };
    const data = blocks.get(car.id) ?? none;
    for (const t of data.trips) {
      own.meters += t.distanceM;
      own.trips++;
      own.seconds += t.durationS;
      own.moving += t.movingS;
      own.idle += t.idleS;
      own.top = Math.max(own.top, t.maxSpeedKmh);
      add(c.clock.date(Date.parse(t.start)), (d) => {
        d.meters += t.distanceM;
        d.trips++;
        d.seconds += t.durationS;
        d.moving += t.movingS;
        d.idle += t.idleS;
        d.cars.add(car.id);
      });
    }
    // Engine on during a stop also counts as idling.
    for (const s of data.stops) {
      if (s.idleS === 0) continue;
      own.idle += s.idleS;
      add(c.clock.date(Date.parse(s.start)), (d) => {
        d.idle += s.idleS;
      });
    }
  }
  return { days: new Map([...days].sort(([a], [b]) => (a < b ? -1 : 1))), perCar };
}

async function mileage(c: Context): Promise<Parts> {
  const { days, perCar } = tally(c, await blocksOf(c));
  const total = sumOf([...perCar.values()], (x) => x.meters);
  const totalTrips = sumOf([...perCar.values()], (x) => x.trips);
  const used = c.cars.filter((car) => (perCar.get(car.id)?.trips ?? 0) > 0);
  const daysWith = (id: string) => [...(perCar.get(id)?.days ?? [])].filter(([, d]) => d.trips > 0).length;

  const { label } = c;
  const byCar = [...c.cars]
    .sort((a, b) => (perCar.get(b.id)?.meters ?? 0) - (perCar.get(a.id)?.meters ?? 0) || c.byName(a.name, b.name))
    .map((car): ReportValue[] => {
      const own = perCar.get(car.id);
      const active = daysWith(car.id);
      return [car.name, car.group, own?.meters ?? 0, own?.trips ?? 0, active, active ? Math.round((own?.meters ?? 0) / active) : null];
    });
  const byDay = [...days].map(([date, d]): ReportValue[] => [date, d.meters, d.trips, d.cars.size]);
  const detail: ReportValue[][] = [];
  for (const [date] of days) {
    for (const car of c.cars) {
      const d = perCar.get(car.id)?.days.get(date);
      if (d && d.trips > 0) detail.push([date, car.name, d.meters, d.trips, d.seconds]);
    }
  }
  const groups = new Map<string, { name: string; cars: number; meters: number; trips: number }>();
  for (const car of c.cars) {
    const key = car.groupId ?? "";
    const g = groups.get(key) ?? { name: car.group ?? c.t("reports.values.noGroup"), cars: 0, meters: 0, trips: 0 };
    g.cars++;
    g.meters += perCar.get(car.id)?.meters ?? 0;
    g.trips += perCar.get(car.id)?.trips ?? 0;
    groups.set(key, g);
  }
  const best = [...days].reduce<[string, number] | null>((top, [date, d]) => (d.meters > (top?.[1] ?? 0) ? [date, d.meters] : top), null);

  const tables = [
    table(
      label("byVehicle"),
      [col(label("vehicle")), col(label("group")), col(label("distance"), "distance"), col(label("trips"), "integer"), col(label("daysWithTrips"), "integer"), col(label("avgPerTripDay"), "distance")],
      byCar,
      [label("total"), null, total, totalTrips, null, null],
    ),
    table(label("byDay"), [col(label("day"), "date"), col(label("distance"), "distance"), col(label("trips"), "integer"), col(label("vehiclesWithTrips"), "integer")], byDay, [label("total"), total, totalTrips, null]),
  ];
  // The per-group table only says something if the account uses groups.
  if ([...groups.keys()].some((key) => key !== "")) {
    tables.push(
      table(
        label("byGroup"),
        [col(label("group")), col(label("vehicles"), "integer"), col(label("distance"), "distance"), col(label("trips"), "integer")],
        [...groups.values()].sort((a, b) => b.meters - a.meters || c.byName(a.name, b.name)).map((g) => [g.name, g.cars, g.meters, g.trips]),
        [label("total"), c.cars.length, total, totalTrips],
      ),
    );
  }
  tables.push(
    table(label("byDayAndVehicle"), [col(label("day"), "date"), col(label("vehicle")), col(label("distance"), "distance"), col(label("trips"), "integer"), col(label("tripTime"), "duration")], detail),
  );
  return {
    stats: [
      stat(label("distance"), "distance", total),
      stat(label("avgPerDay"), "distance", days.size ? Math.round(total / days.size) : 0),
      stat(label("topDay"), "date", best ? best[0] : null),
      stat(label("vehiclesWithTrips"), "text", ofTotal(c, used.length, c.cars.length)),
    ],
    chart: {
      title: label("kmPerDay"),
      unit: "distance",
      labels: [...days.keys()],
      labelType: "date",
      series: [{ name: label("distance"), values: [...days.values()].map((d) => d.meters) }],
    },
    tables,
    notes: [c.t("reports.notes.mileage")],
  };
}

// ─── Speeds ──────────────────────────────────────────────────────────────────

interface Episode {
  vehicleId: string;
  start: number;
  end: number;
  maxKmh: number;
  lat: number;
  lon: number;
}

/** Consecutive stretches above the limit. Each ends at the first position that is already below. */
export async function speedEpisodes(db: Queryable, orgId: string, vehicleIds: string[], range: HistoryRange, limitKmh: number): Promise<Episode[]> {
  if (vehicleIds.length === 0) return [];
  const r = await db.query<{ vehicle_id: string; fix_time: Date; speed_kmh: number; lat: number; lon: number; prev_speed: number | null; prev_time: Date | null; next_time: Date | null }>(
    `SELECT x.vehicle_id, x.fix_time, x.speed_kmh, x.lat, x.lon, x.prev_speed, x.prev_time, x.next_time
       FROM (
         SELECT d.vehicle_id, p.fix_time, p.speed_kmh, p.lat, p.lon,
                lag(p.speed_kmh) OVER w AS prev_speed, lag(p.fix_time) OVER w AS prev_time, lead(p.fix_time) OVER w AS next_time
           FROM gps.devices d
           JOIN gps.positions p ON p.device_id = d.id
          WHERE d.org_id = $1 AND d.vehicle_id = ANY($2::uuid[])
            AND p.valid AND p.fix_time >= $3 AND p.fix_time < $4
         WINDOW w AS (PARTITION BY p.device_id ORDER BY p.fix_time)
       ) x
      WHERE x.speed_kmh > $5
      ORDER BY x.vehicle_id, x.fix_time
      LIMIT $6`,
    [orgId, vehicleIds, range.from, range.to, limitKmh, MAX_OVER_ROWS + 1],
  );
  if (r.rows.length > MAX_OVER_ROWS) throw badRequest(say("reports.errors.tooManySpeeding"));
  const out: Episode[] = [];
  let current: Episode | null = null;
  for (const row of r.rows) {
    const t = row.fix_time.getTime();
    const follows = current !== null && current.vehicleId === row.vehicle_id && row.prev_speed !== null && row.prev_speed > limitKmh && row.prev_time !== null && t - row.prev_time.getTime() <= OVER_GAP_MS;
    if (!follows || !current) {
      current = { vehicleId: row.vehicle_id, start: t, end: t, maxKmh: row.speed_kmh, lat: row.lat, lon: row.lon };
      out.push(current);
    } else if (row.speed_kmh > current.maxKmh) {
      current.maxKmh = row.speed_kmh;
      current.lat = row.lat;
      current.lon = row.lon;
    }
    // It lasts until the next position, which is already below or is another stretch.
    const next = row.next_time?.getTime() ?? t;
    current.end = next - t <= OVER_GAP_MS ? next : t;
  }
  return out;
}

async function speed(c: Context): Promise<Parts> {
  const limit = c.params.speedLimitKmh;
  const { perCar } = tally(c, await blocksOf(c));
  const episodes = await speedEpisodes(
    c.db,
    c.tenant.orgId,
    c.cars.map((car) => car.id),
    c.range,
    limit,
  );
  const over = new Map<string, Episode[]>();
  for (const e of episodes) over.set(e.vehicleId, [...(over.get(e.vehicleId) ?? []), e]);
  const nameOf = new Map(c.cars.map((car) => [car.id, car.name]));
  const secondsOf = (list: Episode[]) => Math.round(sumOf(list, (e) => e.end - e.start) / 1000);

  const byCar = c.cars.map((car): ReportValue[] => {
    const own = perCar.get(car.id);
    const list = over.get(car.id) ?? [];
    const top = Math.max(own?.top ?? 0, Math.round(maxOf(list, (e) => e.maxKmh)));
    return [car.name, own?.trips || list.length ? top : null, own && own.moving > 0 ? Math.round((own.meters / own.moving) * 3.6) : null, list.length, secondsOf(list)];
  });
  byCar.sort((a, b) => (b[3] as number) - (a[3] as number) || ((b[1] as number | null) ?? 0) - ((a[1] as number | null) ?? 0));
  const topSpeed = maxOf(byCar, (row) => (row[1] as number | null) ?? 0);
  const { label } = c;
  return {
    options: [c.t("reports.options.speedLimit", { limit })],
    stats: [
      stat(label("speeding"), "integer", episodes.length),
      stat(label("vehiclesSpeeding"), "text", ofTotal(c, over.size, c.cars.length)),
      stat(label("speedingTime"), "duration", secondsOf(episodes)),
      stat(label("topSpeed"), "speed", topSpeed || null),
    ],
    tables: [
      table(
        label("byVehicle"),
        [col(label("vehicle")), col(label("maxSpeed"), "speed"), col(label("avgMovingSpeed"), "speed"), col(label("speeding"), "integer"), col(label("speedingTime"), "duration")],
        byCar,
      ),
      table(
        label("speeding"),
        [col(label("vehicle")), col(label("start"), "datetime"), col(label("duration"), "duration"), col(label("maxSpeed"), "speed"), col(label("overLimit"), "speed"), col(label("place"), "place")],
        episodes
          .map((e) => ({ e, name: nameOf.get(e.vehicleId) ?? "" }))
          .sort((a, b) => c.byName(a.name, b.name) || a.e.start - b.e.start)
          .map(({ e, name }) => [name, new Date(e.start).toISOString(), Math.round((e.end - e.start) / 1000), Math.round(e.maxKmh), Math.round(e.maxKmh - limit), place(e.lat, e.lon)]),
      ),
    ],
    notes: [c.t("reports.notes.speed")],
  };
}

// ─── Geofences ───────────────────────────────────────────────────────────────

const ENTRIES: EventType[] = ["geofence_enter", "zone_forbidden", "route_return"];
const EXITS: EventType[] = ["geofence_exit", "zone_left", "route_deviation"];

async function geofences(c: Context): Promise<Parts> {
  const r = await c.db.query<{ type: EventType; at: Date; vehicle_id: string; geofence_id: string | null; detail: { geofenceName?: string; stayedMin?: number } }>(
    `SELECT e.type, e.at, e.vehicle_id, e.geofence_id, e.detail
       FROM gps.events e
      WHERE e.org_id = $1 AND e.vehicle_id = ANY($2::uuid[]) AND e.at >= $3 AND e.at < $4 AND e.type = ANY($5::text[])
      ORDER BY e.at, e.id
      LIMIT $6`,
    [c.tenant.orgId, c.cars.map((car) => car.id), c.range.from, c.range.to, [...ENTRIES, ...EXITS], MAX_EVENTS],
  );
  const nameOf = new Map(c.cars.map((car) => [car.id, car.name]));
  interface Visit {
    key: string;
    fence: string;
    car: string;
    enter: number | null;
    exit: number | null;
    seconds: number | null;
  }
  const visits: Visit[] = [];
  const open = new Map<string, Visit>();
  const perFence = new Map<string, { name: string; entries: number; exits: number; cars: Set<string>; seconds: number; timed: number }>();
  const fenceOf = (key: string, name: string) => {
    if (!perFence.has(key)) perFence.set(key, { name, entries: 0, exits: 0, cars: new Set(), seconds: 0, timed: 0 });
    return perFence.get(key) as NonNullable<ReturnType<typeof perFence.get>>;
  };
  for (const e of r.rows) {
    const name = e.detail.geofenceName ?? c.t("reports.values.deletedGeofence");
    const key = e.geofence_id ?? name;
    const fence = fenceOf(key, name);
    fence.cars.add(e.vehicle_id);
    const slot = `${key}:${e.vehicle_id}`;
    const at = e.at.getTime();
    if (ENTRIES.includes(e.type)) {
      fence.entries++;
      const visit: Visit = { key, fence: name, car: nameOf.get(e.vehicle_id) ?? "", enter: at, exit: null, seconds: null };
      visits.push(visit);
      open.set(slot, visit);
      continue;
    }
    fence.exits++;
    const visit = open.get(slot);
    if (visit) {
      visit.exit = at;
      visit.seconds = Math.round((at - (visit.enter as number)) / 1000);
      open.delete(slot);
    } else {
      // It entered before the period: the entry comes from what the exit itself says about how long it was in.
      const stayed = typeof e.detail.stayedMin === "number" ? e.detail.stayedMin * 60 : null;
      visits.push({ key, fence: name, car: nameOf.get(e.vehicle_id) ?? "", enter: stayed === null ? null : at - stayed * 1000, exit: at, seconds: stayed });
    }
  }
  // Whoever entered and has not left is still inside: their stay runs until the end of the period.
  for (const visit of open.values()) visit.seconds = Math.round((c.until - (visit.enter as number)) / 1000);
  for (const visit of visits) {
    if (visit.seconds === null) continue;
    const fence = perFence.get(visit.key);
    if (fence) {
      fence.seconds += visit.seconds;
      fence.timed++;
    }
  }
  const time = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const fences = [...perFence.values()].sort((a, b) => c.byName(a.name, b.name));
  const totalSeconds = sumOf(fences, (f) => f.seconds);
  const { label } = c;
  return {
    stats: [
      stat(label("entries"), "integer", sumOf(fences, (f) => f.entries)),
      stat(label("exits"), "integer", sumOf(fences, (f) => f.exits)),
      stat(label("activeGeofences"), "integer", fences.length),
      stat(label("timeInside"), "duration", totalSeconds),
    ],
    tables: [
      table(
        label("byGeofence"),
        [col(label("geofence")), col(label("entries"), "integer"), col(label("exits"), "integer"), col(label("vehicles"), "integer"), col(label("timeInside"), "duration"), col(label("avgPerVisit"), "duration")],
        fences.map((f) => [f.name, f.entries, f.exits, f.cars.size, f.seconds, f.timed ? Math.round(f.seconds / f.timed) : null]),
      ),
      table(
        label("visits"),
        [col(label("geofence")), col(label("vehicle")), col(label("entry"), "datetime"), col(label("exit"), "datetime"), col(label("stay"), "duration")],
        visits.sort((a, b) => c.byName(a.fence, b.fence) || c.byName(a.car, b.car) || (a.enter ?? a.exit ?? 0) - (b.enter ?? b.exit ?? 0)).map((v) => [v.fence, v.car, time(v.enter), time(v.exit), v.seconds]),
      ),
    ],
    notes: [c.t("reports.notes.geofences")],
  };
}

// ─── Alarms ──────────────────────────────────────────────────────────────────

/** Alarm types that have their own column in the per-vehicle table. */
const MATRIX_TYPES = 6;

async function alarms(c: Context): Promise<Parts> {
  const r = await c.db.query<{ type: EventType; at: Date; vehicle_id: string; lat: number | null; lon: number | null; detail: Record<string, unknown> }>(
    `SELECT e.type, e.at, e.vehicle_id, e.lat, e.lon, e.detail
       FROM gps.events e
      WHERE e.org_id = $1 AND e.vehicle_id = ANY($2::uuid[]) AND e.at >= $3 AND e.at < $4 AND e.type = ANY($5::text[])
      ORDER BY e.at, e.id
      LIMIT $6`,
    [c.tenant.orgId, c.cars.map((car) => car.id), c.range.from, c.range.to, ALERT_EVENTS, MAX_EVENTS],
  );
  const nameOf = new Map(c.cars.map((car) => [car.id, car.name]));
  const eventLabel = (type: EventType) => c.t(`shared.event.${type}`);
  const days = new Map<string, number>(dayKeys(c.clock, c.range.from.getTime(), c.until).map((d) => [d, 0]));
  const perType = new Map<EventType, { count: number; cars: Set<string> }>();
  const perCar = new Map<string, Map<EventType, number>>();
  const detail: ReportValue[][] = [];
  for (const e of r.rows) {
    const date = c.clock.date(e.at.getTime());
    days.set(date, (days.get(date) ?? 0) + 1);
    const type = perType.get(e.type) ?? { count: 0, cars: new Set<string>() };
    type.count++;
    type.cars.add(e.vehicle_id);
    perType.set(e.type, type);
    const own = perCar.get(e.vehicle_id) ?? new Map<EventType, number>();
    own.set(e.type, (own.get(e.type) ?? 0) + 1);
    perCar.set(e.vehicle_id, own);
    const { geofenceName, ruleName } = e.detail as { geofenceName?: string; ruleName?: string };
    const facts = [geofenceName, ...eventFacts({ type: e.type, detail: e.detail }, c.language), ruleName ? c.t("reports.values.alertRule", { name: ruleName }) : undefined].filter(Boolean);
    detail.push([e.at.toISOString(), nameOf.get(e.vehicle_id) ?? "", eventLabel(e.type), facts.join(" · "), e.lat !== null && e.lon !== null ? place(e.lat, e.lon) : null]);
  }
  const types = [...perType].sort(([, a], [, b]) => b.count - a.count);
  const shown = types.slice(0, MATRIX_TYPES).map(([type]) => type);
  const rest = types.length > shown.length;
  const matrix = [...perCar]
    .map(([id, own]) => {
      const total = sumOf([...own.values()], (n) => n);
      const picked = shown.map((type) => own.get(type) ?? 0);
      return { name: nameOf.get(id) ?? "", row: [nameOf.get(id) ?? "", total, ...picked, ...(rest ? [total - sumOf(picked, (n) => n)] : [])] as ReportValue[], total };
    })
    .sort((a, b) => b.total - a.total || c.byName(a.name, b.name))
    .map((x) => x.row);
  const top = types[0];
  const { label } = c;
  return {
    stats: [
      stat(label("alarms"), "integer", r.rows.length),
      stat(label("vehiclesWithAlarms"), "text", ofTotal(c, perCar.size, c.cars.length)),
      stat(label("mostFrequent"), "text", top ? eventLabel(top[0]) : null),
      stat(label("avgPerDay"), "decimal", days.size ? Math.round((r.rows.length / days.size) * 10) / 10 : 0),
    ],
    chart: { title: label("alarmsPerDay"), unit: "integer", labels: [...days.keys()], labelType: "date", series: [{ name: label("alarms"), values: [...days.values()] }] },
    tables: [
      table(
        label("byType"),
        [col(label("type")), col(label("count"), "integer"), col(label("vehicles"), "integer")],
        types.map(([type, t]) => [eventLabel(type), t.count, t.cars.size]),
        r.rows.length ? [label("total"), r.rows.length, perCar.size] : null,
      ),
      table(
        label("byVehicle"),
        [col(label("vehicle")), col(label("total"), "integer"), ...shown.map((type) => col(eventLabel(type), "integer")), ...(rest ? [col(label("others"), "integer")] : [])],
        matrix,
      ),
      table(label("detail"), [col(label("dateTime"), "datetime"), col(label("vehicle")), col(label("type")), col(label("detail")), col(label("place"), "place")], detail),
    ],
    notes: r.rows.length >= MAX_EVENTS ? [c.t("reports.notes.alarmsCapped", { max: MAX_EVENTS })] : [],
  };
}

// ─── Utilization ─────────────────────────────────────────────────────────────

async function utilization(c: Context): Promise<Parts> {
  const { days, perCar } = tally(c, await blocksOf(c));
  const period = Math.max(0, Math.round((c.until - c.range.from.getTime()) / 1000));
  const dayCount = days.size;
  const rows = c.cars.map((car) => {
    const own = perCar.get(car.id);
    const active = [...(own?.days ?? [])].filter(([, d]) => d.trips > 0).length;
    const seconds = own?.seconds ?? 0;
    return { car, seconds, row: [car.name, car.group, active, seconds, own?.idle ?? 0, Math.max(0, period - seconds), percent(seconds, period), own?.meters ?? 0, own?.trips ?? 0] as ReportValue[] };
  });
  rows.sort((a, b) => b.seconds - a.seconds || c.byName(a.car.name, b.car.name));
  const total = sumOf(rows, (x) => x.seconds);
  const idle = sumOf([...perCar.values()], (x) => x.idle);
  const unused = rows.filter((x) => x.seconds === 0).length;
  const { label } = c;
  return {
    stats: [
      stat(label("avgUse"), "percent", percent(total, period * c.cars.length)),
      stat(label("tripTime"), "duration", total),
      stat(label("idle"), "duration", idle),
      stat(label("unusedVehicles"), "text", ofTotal(c, unused, c.cars.length)),
    ],
    chart: {
      title: label("usageHoursPerDay"),
      unit: "duration",
      labels: [...days.keys()],
      labelType: "date",
      series: [
        { name: label("moving"), values: [...days.values()].map((d) => d.moving) },
        { name: label("idle"), values: [...days.values()].map((d) => d.idle) },
      ],
    },
    tables: [
      table(
        label("byVehicle"),
        [
          col(label("vehicle")),
          col(label("group")),
          col(c.t("reports.labels.daysUsed", { days: dayCount }), "integer"),
          col(label("onTrips"), "duration"),
          col(label("idle"), "duration"),
          col(label("notTraveling"), "duration"),
          col(label("use"), "percent"),
          col(label("distance"), "distance"),
          col(label("trips"), "integer"),
        ],
        rows.map((x) => x.row),
        [label("total"), null, null, total, idle, Math.max(0, period * c.cars.length - total), percent(total, period * c.cars.length), sumOf([...perCar.values()], (x) => x.meters), sumOf([...perCar.values()], (x) => x.trips)],
      ),
      table(
        label("byDay"),
        [col(label("day"), "date"), col(label("vehiclesUsed"), "integer"), col(label("onTrips"), "duration"), col(label("moving"), "duration"), col(label("idle"), "duration"), col(label("distance"), "distance")],
        [...days].map(([date, d]) => [date, d.cars.size, d.seconds, d.moving, d.idle, d.meters]),
      ),
    ],
    notes: [c.t("reports.notes.utilizationUse"), c.t("reports.notes.utilizationIdle")],
  };
}

// ─── Drivers (module B) ──────────────────────────────────────────────────────

async function drivers(c: Context): Promise<Parts> {
  const ranks = await ranking(c.db, c.tenant, c.range, c.params.groupId, c.clock.language, c.params.vehicleIds);
  const people = ranks.filter((r) => r.driverId !== null);
  const scored = people.filter((r) => r.score !== null);
  const events = (r: (typeof ranks)[number]) => sumOf([...DRIVER_EVENT_TYPES], (type) => r.counts[type]);
  const { label } = c;
  return {
    stats: [
      stat(label("drivers"), "integer", people.length),
      stat(label("avgScore"), "integer", scored.length ? Math.round(sumOf(scored, (r) => r.score ?? 0) / scored.length) : null),
      stat(label("events"), "integer", sumOf(ranks, events)),
      stat(label("distance"), "distance", sumOf(ranks, (r) => r.distanceM)),
    ],
    tables: [
      table(
        label("drivers"),
        [
          col(label("driver")),
          col(label("score"), "integer"),
          col(label("distance"), "distance"),
          col(label("driving"), "duration"),
          ...DRIVER_EVENT_TYPES.map((type) => col(c.t(`shared.driverEvent.${type}`), "integer")),
          col(label("longestStretch"), "duration"),
          col(label("daysOverMax"), "integer"),
        ],
        ranks.map((r) => [r.name, r.driverId === null ? null : r.score, r.distanceM, r.drivingS, ...DRIVER_EVENT_TYPES.map((type) => r.counts[type]), r.longestStretchS, r.daysOverDaily]),
      ),
    ],
    notes: [c.t("reports.notes.drivers", { km: SCORE_MIN_KM })],
  };
}

// ─── Fuel (module F) ─────────────────────────────────────────────────────────

async function fuel(c: Context): Promise<Parts> {
  const tanks = await c.db.query<{ vehicle_id: string }>(`SELECT vehicle_id FROM gps.fuel_tanks WHERE vehicle_id = ANY($1::uuid[])`, [c.cars.map((car) => car.id)]);
  const withTank = new Set(tanks.rows.map((t) => t.vehicle_id));
  const cars = c.cars.filter((car) => withTank.has(car.id));
  if (cars.length > MAX_FUEL_VEHICLES) throw badRequest(say("reports.errors.tooManyFuelVehicles", { max: MAX_FUEL_VEHICLES }));
  const rows: ReportValue[][] = [];
  const fills: ReportValue[][] = [];
  const drains: ReportValue[][] = [];
  const paid = new Map<string, { spent: number; liters: number; fills: number }>();
  let meters = 0;
  let liters = 0;
  let metersWithLiters = 0;
  let refueled = 0;
  let drained = 0;
  const money = (amount: number, currency: string) => moneyText(amount, currency, c.language);
  for (const car of cars) {
    const report = await fuelReport(c.deps, c.tenant, car.id, c.range);
    const used = report.real?.liters ?? report.estimated?.liters ?? null;
    meters += report.distanceM;
    if (used !== null) {
      liters += used;
      metersWithLiters += report.distanceM;
    }
    refueled += report.real?.refueledL ?? 0;
    drained += report.real?.drainedL ?? 0;
    for (const cost of report.costs) {
      const sum = paid.get(cost.currency) ?? { spent: 0, liters: 0, fills: 0 };
      paid.set(cost.currency, { spent: sum.spent + cost.spent, liters: sum.liters + cost.liters, fills: sum.fills + cost.fills });
    }
    rows.push([
      car.name,
      report.distanceM,
      report.real?.liters ?? null,
      report.real ? c.t(report.real.method === "ecu" ? "reports.values.engineCounter" : "reports.values.tankLevel") : null,
      report.estimated?.liters ?? null,
      report.idle.realL ?? report.idle.estimatedL,
      report.refuels.length,
      report.real?.refueledL ?? 0,
      report.drains.length,
      report.real?.drainedL ?? 0,
      report.efficiency?.kmPerL ?? null,
      report.efficiency?.lPer100km ?? null,
      report.costs.map((cost) => money(cost.spent, cost.currency)).join(" + ") || null,
      report.costPerKm ? money(report.costPerKm.value, report.costPerKm.currency) : null,
    ]);
    for (const f of report.refuels) fills.push([car.name, f.at, f.liters]);
    for (const d of report.drains) drains.push([car.name, d.at, d.liters, c.t(d.engineOff ? "reports.values.engineOffTheft" : "reports.values.engineOn")]);
  }
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const costs = [...paid].map(([currency, sum]): ReportValue[] => [currency, sum.fills, round1(sum.liters), money(sum.spent, currency), sum.liters > 0 ? money(sum.spent / sum.liters, currency) : null]);
  const { label } = c;
  return {
    stats: [
      stat(label("consumption"), "liters", round1(liters)),
      stat(label("refueled"), "liters", round1(refueled)),
      stat(label("drained"), "liters", round1(drained)),
      stat(label("efficiency"), "text", liters > 0.05 && metersWithLiters >= 1000 ? `${decimalMark(c.language, (metersWithLiters / 1000 / liters).toFixed(2))} km/L` : null),
      stat(label("vehiclesWithTank"), "text", ofTotal(c, cars.length, c.cars.length)),
    ],
    tables: [
      table(
        label("byVehicle"),
        [
          col(label("vehicle")),
          col(label("distance"), "distance"),
          col(label("measured"), "liters"),
          col(label("howMeasured")),
          col(label("byNorm"), "liters"),
          col(label("idling"), "liters"),
          col(label("refuels"), "integer"),
          col(label("refueled"), "liters"),
          col(label("drains"), "integer"),
          col(label("drained"), "liters"),
          col("km/L", "decimal"),
          col("L/100 km", "decimal"),
          col(label("paid")),
          col(label("costPerKm")),
        ],
        rows,
        rows.length ? [label("total"), meters, null, null, null, null, fills.length, round1(refueled), drains.length, round1(drained), null, null, null, null] : null,
      ),
      table(label("refuels"), [col(label("vehicle")), col(label("dateTime"), "datetime"), col(label("liters"), "liters")], fills, fills.length ? [label("total"), null, round1(refueled)] : null),
      table(
        label("drains"),
        [col(label("vehicle")), col(label("dateTime"), "datetime"), col(label("liters"), "liters"), col(label("engine"))],
        drains,
        drains.length ? [label("total"), null, round1(drained), null] : null,
      ),
      table(label("paidInFillUps"), [col(label("currency")), col(label("fillUps"), "integer"), col(label("liters"), "liters"), col(label("total")), col(label("pricePerLiter"))], costs, null),
    ],
    notes: [c.t("reports.notes.fuelWhich"), c.t("reports.notes.fuelDetected"), c.t("reports.notes.fuelPaid")],
  };
}

// ─── Maintenance ─────────────────────────────────────────────────────────────

/** Services completed in the period, what they cost and what is pending today. */
async function maintenance(c: Context): Promise<Parts> {
  const ids = c.cars.map((car) => car.id);
  const names = new Map(c.cars.map((car) => [car.id, car.name]));
  const from = c.clock.date(c.range.from.getTime());
  const to = c.clock.date(c.until - 1);
  const done = await c.db.query<{ vehicle_id: string; number: number; kind: MaintOrderKind; title: string; done_on: string; odometer_km: number | null; labor_cost: string; parts_cost: string; currency: string; workshop: string | null }>(
    `SELECT o.vehicle_id, o.number, o.kind, o.title, o.done_on::text AS done_on, o.odometer_km, o.labor_cost, o.currency, w.name AS workshop,
            COALESCE((SELECT sum(l.quantity * l.unit_cost) FROM gps.maint_order_parts l WHERE l.order_id = o.id), 0) AS parts_cost
       FROM gps.maint_orders o LEFT JOIN gps.maint_workshops w ON w.id = o.workshop_id
      WHERE o.vehicle_id = ANY($1::uuid[]) AND o.status = 'done' AND o.done_on BETWEEN $2 AND $3
      ORDER BY o.done_on, o.number`,
    [ids, from, to],
  );
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const services: ReportValue[][] = [];
  const costs = new Map<string, { vehicle: string; currency: string; orders: number; labor: number; parts: number }>();
  const byCurrency = new Map<string, number>();
  for (const o of done.rows) {
    const labor = Number(o.labor_cost);
    const parts = round2(Number(o.parts_cost));
    const vehicle = names.get(o.vehicle_id) ?? "";
    services.push([o.done_on, vehicle, o.number, c.t(`shared.maintOrderKind.${o.kind}`), o.title, o.workshop, o.odometer_km === null ? null : Math.round(o.odometer_km), labor, parts, round2(labor + parts), o.currency]);
    const key = `${o.vehicle_id}|${o.currency}`;
    const sum = costs.get(key) ?? { vehicle, currency: o.currency, orders: 0, labor: 0, parts: 0 };
    sum.orders += 1;
    sum.labor += labor;
    sum.parts += parts;
    costs.set(key, sum);
    byCurrency.set(o.currency, (byCurrency.get(o.currency) ?? 0) + labor + parts);
  }
  const costRows: ReportValue[][] = [...costs.values()]
    .sort((a, b) => c.byName(a.vehicle, b.vehicle) || a.currency.localeCompare(b.currency))
    .map((x) => [x.vehicle, x.currency, x.orders, round2(x.labor), round2(x.parts), round2(x.labor + x.parts)]);

  // What is pending is today's, not the period's: what needs attention when the report is read.
  const schedules = (await schedulesOf(c.db, c.cars, c.clock.zone, c.now, c.language)).filter((s) => s.status !== "ok");
  const expiries = (await expiriesOf(c.deps, c.tenant.orgId, c.cars, c.clock.zone, c.now)).filter((e) => e.status !== "ok");
  const open = await c.db.query<{ vehicle_id: string; number: number; title: string; status: MaintOrderStatus; opened_on: string }>(
    `SELECT vehicle_id, number, title, status, opened_on::text AS opened_on FROM gps.maint_orders WHERE vehicle_id = ANY($1::uuid[]) AND status IN ('open', 'in_progress') ORDER BY opened_on, number`,
    [ids],
  );
  const dueLabel = (status: MaintDueStatus) => c.t(`shared.maintDue.${status}`);
  const expiryKind = (kind: MaintExpiryKind) => c.t(`shared.maintExpiry.${kind}`);
  const pending: ReportValue[][] = [
    ...schedules.map((s): ReportValue[] => [s.vehicleName, c.t("reports.values.scheduledService"), s.planName, dueLabel(s.status), s.reason, s.dueOn]),
    ...expiries.map((e): ReportValue[] => [
      e.vehicleName,
      c.t("reports.values.expiry"),
      e.name ? `${expiryKind(e.kind)} · ${e.name}` : expiryKind(e.kind),
      dueLabel(e.status),
      e.daysLeft < 0 ? c.t("reports.values.expired") : e.daysLeft === 0 ? c.t("reports.values.expiresToday") : c.t("reports.values.daysLeft", { count: e.daysLeft }),
      e.expiresOn,
    ]),
    ...open.rows.map((o): ReportValue[] => [
      names.get(o.vehicle_id) ?? "",
      c.t("reports.values.workOrder"),
      c.t("reports.values.orderTitle", { number: o.number, title: o.title }),
      c.t(`shared.maintOrderStatus.${o.status}`),
      c.t("reports.values.openedOn", { date: o.opened_on.split("-").reverse().join("/") }),
      null,
    ]),
  ];
  const money = (amount: number, currency: string) => moneyText(amount, currency, c.language);
  const spent = [...byCurrency].sort((a, b) => b[1] - a[1]);
  const { label } = c;
  return {
    stats: [
      stat(label("servicesDone"), "integer", done.rows.length),
      stat(label("preventive"), "integer", done.rows.filter((o) => o.kind === "preventive").length),
      stat(label("corrective"), "integer", done.rows.filter((o) => o.kind === "corrective").length),
      stat(label("cost"), "text", spent.length ? spent.map(([currency, total]) => money(total, currency)).join(" · ") : "—"),
      stat(label("servicesDue"), "integer", schedules.filter((s) => s.status === "due").length),
      stat(label("openOrders"), "integer", open.rows.length),
    ],
    tables: [
      table(
        label("servicesDone"),
        [
          col(label("date"), "date"),
          col(label("vehicle")),
          col(label("order"), "integer"),
          col(label("type")),
          col(label("work")),
          col(label("workshop")),
          col(label("odometerKm"), "integer"),
          col(label("labor"), "decimal"),
          col(label("parts"), "decimal"),
          col(label("total"), "decimal"),
          col(label("currency")),
        ],
        services,
      ),
      table(
        label("costByVehicle"),
        [col(label("vehicle")), col(label("currency")), col(label("orders"), "integer"), col(label("labor"), "decimal"), col(label("parts"), "decimal"), col(label("total"), "decimal")],
        costRows,
      ),
      table(label("pendingToday"), [col(label("vehicle")), col(label("what")), col(label("detail")), col(label("status")), col(label("timeLeft")), col(label("deadline"), "date")], pending),
    ],
    notes: [c.t("reports.notes.maintenanceDone"), c.t("reports.notes.maintenancePending")],
  };
}

// ─── Input ───────────────────────────────────────────────────────────────────

const BUILDERS: Record<ReportType, (c: Context) => Promise<Parts>> = { trips, stops, mileage, speed, geofences, alarms, utilization, drivers, fuel, maintenance };

/** Puts the known address on each place in the tables, without querying the external service. */
async function fillAddresses(db: Queryable, tables: ReportTable[], pois: string | null = null): Promise<void> {
  const places: ReportPlace[] = [];
  for (const t of tables) {
    t.columns.forEach((column, i) => {
      if (column.type !== "place") return;
      for (const row of t.rows) {
        const value = row[i];
        if (value && typeof value === "object") places.push(value);
      }
    });
  }
  const known = await knownAddresses(db, places);
  // With the routes module, a place that falls on one of the account's points of interest carries its name.
  const named = pois ? await poiNames(db, pois, places) : [];
  places.forEach((p, i) => {
    const poi = named[i] ?? null;
    p.address = poi && known[i] ? `${poi} · ${known[i]}` : (poi ?? known[i] ?? null);
  });
}

/** A title that may start with the report's name in lower case ("trips report") starts with a capital. */
const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The report, written in the language of the request. */
export async function buildReport(deps: ReportDeps, tenant: Tenant, request: ReportRequest): Promise<ReportDocument> {
  const { type, range, params } = request;
  const now = request.now ?? Date.now();
  assertRange(range);
  if (range.from.getTime() > now) throw badRequest(say("reports.errors.notStarted"));
  const { language } = request;
  const clock = createClock(request.zone, language);
  const requires = REPORT_INFO[type].requires;
  // A report of a module the account does not have does not exist for it.
  if (requires && !(await deps.gate.enabled(tenant.orgId, requires))) throw notFound();
  const db = deps.db.core;
  const { cars, label: scope } = await carsOf(db, tenant, params);
  const byName = nameOrder(language);
  cars.sort((a, b) => byName(a.name, b.name));
  const t = (key: ServerKey, values?: TextParams) => tr(language, key, values);
  const label = (key: ReportLabel) => tr(language, `reports.labels.${key}`);
  const parts = await BUILDERS[type]({ deps, db, tenant, cars, range, clock, params, now, until: Math.min(range.to.getTime(), now), language, label, t, byName });
  await fillAddresses(db, parts.tables, (await deps.gate.enabled(tenant.orgId, "H")) ? tenant.orgId : null);
  return {
    type,
    title: sentenceCase(t("reports.title", { report: t(`shared.report.${type}`).toLowerCase() })),
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    zone: clock.zone,
    generatedAt: new Date(now).toISOString(),
    scope: render(language, scope),
    options: parts.options ?? [],
    stats: parts.stats,
    chart: parts.chart ?? null,
    tables: parts.tables,
    notes: parts.notes ?? [],
  };
}
