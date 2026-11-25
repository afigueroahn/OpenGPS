// Trips and stops of each vehicle, stored per day.
//
// History analyzes a vehicle's positions at query time. A report
// for a month of the whole fleet cannot re-read them all every time, so here
// each finished day is analyzed only once and stored. A position that
// arrives late deletes the stored day, and it is recalculated when requested.
//
// A trip or stop that crosses midnight ends up in two pieces, one per
// day, marked as cut. When joining the days, the pieces are put back
// together: the result is the same as analyzing the whole period at once.
import type { Stop, Trip } from "@opengps/shared";
import type { Bus } from "../bus";
import type { Db, Queryable } from "../db";
import { type HistoryRange, SAMPLE_COLUMNS, type SampleRow, toSample } from "./history";
import { type Interval, MIN_STOP_S, type TrackSample, decompose } from "./trips";

export const DAY_MS = 86_400_000;
/**
 * Each day is analyzed with this margin of positions before and after, so that
 * what happens near midnight is decided the same way in both days.
 */
export const PAD_MS = 3 * 3_600_000;
/** A day is stored once it has been complete for this long: before that, its positions may still be arriving. */
const SETTLE_MS = 3_600_000;
/** Changes when the shape of what is stored or the trip engine's rules change: earlier data is recalculated. */
const VERSION = 1;
/** Vehicles whose positions are read together. */
const VEHICLES_PER_QUERY = 25;
/** An unfinished day is remembered for this long, to avoid re-reading it on every consecutive query. */
const LIVE_TTL_MS = 60_000;
const LIVE_MAX = 5000;

const CUT_START = 1;
const CUT_END = 2;

/** Piece of a trip within a day: start, end, meters, seconds moving and idling, max speed, origin, destination, odometers and cuts. */
type TripPiece = [start: number, end: number, meters: number, movingS: number, idleS: number, maxKmh: number, lat0: number, lon0: number, lat1: number, lon1: number, odo0: number | null, odo1: number | null, cut: number];
/** Piece of a stop: start, end, idle seconds, place and cuts. */
type StopPiece = [start: number, end: number, idleS: number, lat: number, lon: number, cut: number];

/** Time and place of a position. */
type Seen = [t: number, lat: number, lon: number];

export interface DayData {
  /** Positions of the day, and the first and the last. */
  n: number;
  a: Seen | null;
  z: Seen | null;
  t: TripPiece[];
  s: StopPiece[];
}

const EMPTY: DayData = { n: 0, a: null, z: null, t: [], s: [] };

export const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const sum = (items: Interval[], pick: (i: Interval) => number) => items.reduce((n, i) => n + pick(i), 0);

// ─── Calculation ─────────────────────────────────────────────────────────────

/**
 * Pieces of trips and stops that fall in the day [d0, d1). The positions are
 * those of the day plus its margin, sorted. Each interval between two positions
 * belongs to the day in which it starts.
 */
export function dayPieces(samples: TrackSample[], d0: number, d1: number): DayData {
  const data: DayData = { n: 0, a: null, z: null, t: [], s: [] };
  for (const s of samples) {
    if (s.t < d0 || s.t >= d1) continue;
    data.n++;
    data.a ??= [s.t, s.lat, s.lon];
    data.z = [s.t, s.lat, s.lon];
  }
  for (const block of decompose(samples)) {
    const own = block.items.filter((it) => {
      const t = (samples[it.from] as TrackSample).t;
      return t >= d0 && t < d1;
    });
    const head = own[0];
    const tail = own[own.length - 1];
    if (!head || !tail) continue;
    const cut = (block.items[0] !== head ? CUT_START : 0) | (block.items[block.items.length - 1] !== tail ? CUT_END : 0);
    const first = samples[head.from] as TrackSample;
    const last = samples[tail.to] as TrackSample;
    const idleS = sum(own, (i) => (i.kind === "idle" ? i.seconds : 0));
    if (!block.trip) {
      data.s.push([first.t, last.t, idleS, first.lat, first.lon, cut]);
      continue;
    }
    let maxKmh = 0;
    for (let i = head.from; i <= tail.to; i++) maxKmh = Math.max(maxKmh, (samples[i] as TrackSample).speedKmh);
    data.t.push([
      first.t,
      last.t,
      sum(own, (i) => i.meters),
      sum(own, (i) => (i.kind === "moving" ? i.seconds : 0)),
      idleS,
      maxKmh,
      first.lat,
      first.lon,
      last.lat,
      last.lon,
      first.odometer,
      last.odometer,
      cut,
    ]);
  }
  return data;
}

/** Complete trip, already joined if it crossed from one day to another. */
export interface DayTrip extends Trip {
  /** Time moving, without the short pauses. */
  movingS: number;
  /** It started before the loaded days: only its end is here. */
  openStart: boolean;
}
export interface DayStop extends Stop {
  /** It started before what is loaded, or continues afterwards. */
  openStart: boolean;
  openEnd: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Joins the pieces of consecutive days of a vehicle into complete trips and
 * stops, in order. Gives the same result as analyzing all positions together.
 *
 * Trips and stops follow one another without gaps: a stop starts where the
 * previous trip ended and ends where the next one starts. If the device was silent
 * for longer than a day's margin, that silence is not in any piece, and it is
 * rebuilt here with that rule.
 */
export function assemble(days: DayData[]): { trips: DayTrip[]; stops: DayStop[] } {
  const trips: DayTrip[] = [];
  const stops: DayStop[] = [];
  let trip: TripPiece | null = null;
  let tripOpenStart = false;
  let stop: StopPiece | null = null;
  /** Since when and where it has been not traveling, if there is no stop piece yet to say so: the end of the last trip, or the first position. */
  let anchor: Seen | null = null;
  let started = false;
  /** Time of the last position seen. */
  let lastSeen = 0;

  const closeTrip = () => {
    if (!trip) return;
    const [start, end, calc, movingS, idleS, maxKmh, lat0, lon0, lat1, lon1, odo0, odo1] = trip;
    let meters = calc;
    // If the device has an odometer and it is consistent with the calculation, it is more accurate.
    if (odo0 !== null && odo1 !== null) {
      const byOdometer = odo1 - odo0;
      if (byOdometer > 0 && byOdometer <= meters * 1.5 + 1000 && byOdometer >= meters * 0.5) meters = byOdometer;
    }
    trips.push({
      start: iso(start),
      end: iso(end),
      durationS: Math.round((end - start) / 1000),
      distanceM: Math.round(meters),
      maxSpeedKmh: Math.round(maxKmh),
      avgSpeedKmh: movingS > 0 ? Math.round((meters / movingS) * 3.6) : 0,
      idleS: Math.round(idleS),
      startLat: lat0,
      startLon: lon0,
      endLat: lat1,
      endLon: lon1,
      startAddress: null,
      endAddress: null,
      movingS: Math.round(movingS),
      openStart: tripOpenStart,
    });
    anchor = [end, lat1, lon1];
    trip = null;
  };
  const closeStop = () => {
    if (!stop) return;
    const [start, end, idleS, lat, lon, cut] = stop;
    if (end - start >= MIN_STOP_S * 1000) {
      stops.push({ start: iso(start), end: iso(end), durationS: Math.round((end - start) / 1000), lat, lon, idleS: Math.round(idleS), address: null, openStart: (cut & CUT_START) !== 0, openEnd: (cut & CUT_END) !== 0 });
    }
    stop = null;
  };

  for (const day of days) {
    if (!started && day.a) {
      started = true;
      anchor = [...day.a];
    }
    // The pieces of a day, trips and stops, in the order they happened.
    let ti = 0;
    let si = 0;
    while (ti < day.t.length || si < day.s.length) {
      const nextTrip = day.t[ti];
      const nextStop = day.s[si];
      if (nextTrip && (!nextStop || nextTrip[0] < nextStop[0])) {
        ti++;
        const open: TripPiece | null = trip;
        if (open && open[12] & CUT_END && nextTrip[12] & CUT_START) {
          // The same trip, which crossed midnight.
          open[1] = nextTrip[1];
          open[2] += nextTrip[2];
          open[3] += nextTrip[3];
          open[4] += nextTrip[4];
          open[5] = Math.max(open[5], nextTrip[5]);
          open[8] = nextTrip[8];
          open[9] = nextTrip[9];
          open[11] = nextTrip[11];
          open[12] = (open[12] & CUT_START) | (nextTrip[12] & CUT_END);
        } else {
          closeTrip();
          const before: Seen | null = anchor;
          const waiting: StopPiece | null = stop;
          // The previous stop extends up to the start of this trip.
          if (waiting) waiting[1] = nextTrip[0];
          else if (before && nextTrip[0] > before[0]) stop = [before[0], nextTrip[0], 0, before[1], before[2], 0];
          closeStop();
          trip = [...nextTrip];
          tripOpenStart = (nextTrip[12] & CUT_START) !== 0;
        }
        if (!((trip as TripPiece)[12] & CUT_END)) closeTrip();
      } else if (nextStop) {
        si++;
        closeTrip();
        const open: StopPiece | null = stop;
        if (open) {
          // Two pieces with no trip in between are the same stop, even if the device was silent between them.
          open[1] = nextStop[1];
          open[2] += nextStop[2];
          open[5] = (open[5] & CUT_START) | (nextStop[5] & CUT_END);
        } else {
          const before: Seen | null = anchor;
          stop = [...nextStop];
          // It started when the previous trip ended, at that same place.
          if (before) {
            stop[0] = before[0];
            stop[3] = before[1];
            stop[4] = before[2];
            stop[5] &= ~CUT_START;
          }
          anchor = null;
        }
      }
    }
    if (day.z) lastSeen = day.z[0];
  }
  closeTrip();
  // What it kept reporting without moving after the last piece is also a stop.
  const waiting: StopPiece | null = stop;
  const before: Seen | null = anchor;
  if (waiting) waiting[1] = Math.max(waiting[1], lastSeen);
  else if (before && lastSeen > before[0]) stop = [before[0], lastSeen, 0, before[1], before[2], 0];
  closeStop();
  return { trips, stops };
}

// ─── Reading and storing ─────────────────────────────────────────────────────

const live = new Map<string, { at: number; data: DayData }>();

/**
 * Pieces of each day from `first` to `last` for several vehicles of an account.
 * What is not stored is calculated; a day that is already complete gets stored. With
 * `fillOnly` it only fills in what is missing and returns nothing, to prepare the
 * database without loading what is already there.
 */
export async function loadDays(
  db: Queryable,
  orgId: string,
  vehicleIds: string[],
  first: number,
  last: number,
  opts: { now?: number; fillOnly?: boolean } = {},
): Promise<Map<string, DayData[]>> {
  const now = opts.now ?? Date.now();
  const out = new Map<string, DayData[]>(vehicleIds.map((id) => [id, []]));
  if (vehicleIds.length === 0 || last < first) return out;
  const known = new Map<string, DayData>();
  const key = (id: string, day: number) => `${id}:${day}`;

  const cached = await db.query<{ vehicle_id: string; day: string; data: DayData | null }>(
    `SELECT vehicle_id, day::text, ${opts.fillOnly ? "NULL::jsonb" : "data"} AS data
       FROM gps.vehicle_days
      WHERE vehicle_id = ANY($1::uuid[]) AND day BETWEEN $2::date AND $3::date AND version = $4`,
    [vehicleIds, dateOf(first), dateOf(last), VERSION],
  );
  for (const row of cached.rows) known.set(key(row.vehicle_id, dayOf(Date.parse(`${row.day}T00:00:00Z`))), row.data ?? EMPTY);

  for (let day = first; day <= last; day++) {
    const d0 = day * DAY_MS;
    const d1 = d0 + DAY_MS;
    if (d0 > now) break;
    const settled = d1 + PAD_MS + SETTLE_MS <= now;
    const missing: string[] = [];
    for (const id of vehicleIds) {
      if (known.has(key(id, day))) continue;
      const recent = settled ? undefined : live.get(key(id, day));
      if (recent && now - recent.at < LIVE_TTL_MS && now >= recent.at) known.set(key(id, day), recent.data);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += VEHICLES_PER_QUERY) {
      const ids = missing.slice(i, i + VEHICLES_PER_QUERY);
      const r = await db.query<SampleRow & { vehicle_id: string }>(
        `SELECT d.vehicle_id, ${SAMPLE_COLUMNS}
           FROM gps.devices d
           JOIN gps.positions p ON p.device_id = d.id
          WHERE d.org_id = $1 AND d.vehicle_id = ANY($2::uuid[])
            AND p.valid AND p.fix_time >= $3 AND p.fix_time < $4
          ORDER BY d.vehicle_id, p.fix_time`,
        [orgId, ids, new Date(d0 - PAD_MS), new Date(d1 + PAD_MS)],
      );
      const samples = new Map<string, TrackSample[]>(ids.map((id) => [id, []]));
      for (const row of r.rows) (samples.get(row.vehicle_id) as TrackSample[]).push(toSample(row));
      const computed = ids.map((id) => dayPieces(samples.get(id) as TrackSample[], d0, d1));
      ids.forEach((id, n) => known.set(key(id, day), computed[n] as DayData));
      if (settled) {
        await db.query(
          `INSERT INTO gps.vehicle_days (vehicle_id, day, version, data)
           SELECT x.vehicle_id, $2::date, $4, x.data
             FROM unnest($1::uuid[], $3::jsonb[]) AS x (vehicle_id, data)
            WHERE EXISTS (SELECT 1 FROM gps.vehicles v WHERE v.id = x.vehicle_id AND v.org_id = $5)
           ON CONFLICT (vehicle_id, day) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data, computed_at = now()`,
          [ids, dateOf(day), computed.map((d) => JSON.stringify(d)), VERSION, orgId],
        );
      } else {
        if (live.size > LIVE_MAX) live.clear();
        ids.forEach((id, n) => live.set(key(id, day), { at: now, data: computed[n] as DayData }));
      }
    }
    if (!opts.fillOnly) for (const id of vehicleIds) (out.get(id) as DayData[]).push(known.get(key(id, day)) ?? EMPTY);
  }
  return out;
}

export interface VehicleBlocks {
  /** Trips that started within the period, whole even if they end later. */
  trips: DayTrip[];
  /** Stops that touch the period, clipped to it. */
  stops: DayStop[];
}

/**
 * Trips and stops of several vehicles in a period. Each trip is counted
 * only once, in the period in which it started; this way, consecutive periods do not
 * repeat or split it.
 */
export async function loadBlocks(db: Queryable, orgId: string, vehicleIds: string[], range: HistoryRange, now = Date.now()): Promise<Map<string, VehicleBlocks>> {
  const from = range.from.getTime();
  const to = Math.min(range.to.getTime(), now);
  const out = new Map<string, VehicleBlocks>();
  // One extra day at the end: that is where the trip crossing the last midnight ends.
  const days = await loadDays(db, orgId, vehicleIds, dayOf(from), dayOf(Math.max(from, range.to.getTime() - 1)) + 1, { now });
  for (const [id, list] of days) {
    const whole = assemble(list);
    const stops: DayStop[] = [];
    for (const stop of whole.stops) {
      const start = Date.parse(stop.start);
      const end = Date.parse(stop.end);
      const a = Math.max(start, from);
      const b = Math.min(end, to);
      if (b - a < MIN_STOP_S * 1000) continue;
      const share = end > start ? (b - a) / (end - start) : 1;
      stops.push({
        ...stop,
        start: iso(a),
        end: iso(b),
        durationS: Math.round((b - a) / 1000),
        idleS: Math.round(stop.idleS * share),
        openStart: stop.openStart || a > start,
        openEnd: stop.openEnd || b < end,
      });
    }
    out.set(id, {
      trips: whole.trips.filter((t) => !t.openStart && Date.parse(t.start) >= from && Date.parse(t.start) < range.to.getTime()),
      stops,
    });
  }
  return out;
}

// ─── Validity of what is stored ──────────────────────────────────────────────

/** Forgets a vehicle's stored days: all of them, or those whose analysis includes those instants. */
export async function forgetDays(db: Queryable, vehicleId: string, times?: number[]): Promise<void> {
  for (const k of live.keys()) if (k.startsWith(`${vehicleId}:`)) live.delete(k);
  if (!times) {
    await db.query(`DELETE FROM gps.vehicle_days WHERE vehicle_id = $1`, [vehicleId]);
    return;
  }
  const days = [...new Set(times.flatMap((t) => [dayOf(t - PAD_MS), dayOf(t), dayOf(t + PAD_MS)]))].map(dateOf);
  if (days.length > 0) await db.query(`DELETE FROM gps.vehicle_days WHERE vehicle_id = $1 AND day = ANY($2::date[])`, [vehicleId, days]);
}

/** With history retention, what is stored lasts no longer than the positions it came from. */
export async function purgeDays(db: Queryable, retentionDays: number): Promise<void> {
  if (retentionDays > 0) await db.query(`DELETE FROM gps.vehicle_days WHERE day < (now() - make_interval(days => $1))::date`, [retentionDays]);
}

export interface DayKeeper {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
}

/** Keeps what is stored up to date: deletes it when a late position arrives or the vehicle's device changes. */
export function createDayKeeper(deps: { db: Db; bus: Bus }): DayKeeper {
  let queue: Promise<unknown> = Promise.resolve();
  const off: (() => void)[] = [];
  const enqueue = (job: () => Promise<unknown>) => {
    queue = queue.then(job).catch((err: Error) => console.error("[days] could not forget a stored day:", err.message));
  };
  return {
    start() {
      off.push(
        deps.bus.on("fixes", (payload) => {
          // Only what falls in a day that could already be stored matters.
          const horizon = Date.now() - PAD_MS - SETTLE_MS;
          const late = payload.fixes.filter((f) => (dayOf(f.t - PAD_MS) + 1) * DAY_MS <= horizon).map((f) => f.t);
          if (late.length > 0) enqueue(() => forgetDays(deps.db.core, payload.vehicleId, late));
        }),
        // With another device installed, or none, the vehicle's route is different.
        deps.bus.on("device", (e) => enqueue(() => forgetDays(deps.db.core, e.vehicleId))),
      );
    },
    stop() {
      for (const unsubscribe of off.splice(0)) unsubscribe();
    },
    idle: () => queue.then(() => undefined),
  };
}
