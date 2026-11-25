// Fuel: tank level, consumption estimated by norm, actual consumption by
// sensor, fills, drains and efficiency. None of this is stored: it comes from the
// positions at query time, so data that arrives late already counts.
import { FUEL_COUNTER_LITERS, type FuelCounterUnit, type FuelJump, type FuelKind, type FuelReport, type FuelStatus, type FuelTank, type fuelTankSchema } from "@opengps/shared";
import type { z } from "zod";
import type { Tenant } from "../../core/access";
import { audit } from "../../core/audit";
import { type HistoryRange, type HistorySample, MAX_POSITIONS, SAMPLE_COLUMNS, type SampleRow, assertRange, toSample } from "../../core/history";
import { type TrackSample, type TripAnalysis, analyze, decompose, thin } from "../../core/trips";
import { type Actor, getVehicle } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { badRequest, notFound } from "../../errors";
import { say } from "../../i18n";
import { driverWindows } from "../drivers/driving";
import type { ModuleDeps } from "../context";

type TankData = z.output<typeof fuelTankSchema>;

/** Readings that are averaged to remove the sloshing of fuel while moving. */
const FILTER_WINDOW = 5;
/** A rise smaller than this is not a fill: it is sensor noise. Liters, or this fraction of the tank. */
const REFUEL_MIN_L = 5;
const REFUEL_MIN_SHARE = 0.05;
/** The most an idling engine burns per hour, if the tank has no norm: whatever drops beyond that is a drain. */
const DRAIN_IDLE_LH = 3;
/** Readings before the step that are examined to know whether the engine was on: those the filter may have shifted. */
const STEP_SPREAD = 3;
/** On resuming movement, readings that are still useful to know how much the stop ended with. */
const SETTLE_MS = 120_000;
/** Most points the level chart carries. */
const SERIES_MAX = 600;
/** The current level is looked up in the positions of these days. */
const LEVEL_LOOKBACK_DAYS = 7;

const numberOf = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The level reading, if valid. With the engine off, some devices read the
 * level from the vehicle's computer and, since it goes to sleep, send a zero:
 * that zero is not an empty tank and is discarded.
 */
const levelOf = (raw: unknown, ignition: unknown): number | null => {
  const n = numberOf(raw);
  return n === null || (n === 0 && ignition !== true) ? null : n;
};

// ─── Calculation ─────────────────────────────────────────────────────────────

/** Liters that correspond to a device reading. */
export function litersOf(tank: Pick<FuelTank, "capacityL" | "kind" | "calibration">, raw: number): number {
  const kind: FuelKind = tank.kind;
  if (kind === "percent") return (clamp(raw, 0, 100) / 100) * tank.capacityL;
  if (kind === "liters") return clamp(raw, 0, tank.capacityL);
  // Calibration table: between two points it is spread in a straight line; outside the table the end value holds.
  const table = tank.calibration ?? [];
  const first = table[0];
  const last = table[table.length - 1];
  if (!first || !last) return 0;
  if (raw <= first[0]) return clamp(first[1], 0, tank.capacityL);
  if (raw >= last[0]) return clamp(last[1], 0, tank.capacityL);
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i] as [number, number];
    const [x0, y0] = table[i - 1] as [number, number];
    if (raw <= x1) return clamp(y0 + ((raw - x0) / (x1 - x0)) * (y1 - y0), 0, tank.capacityL);
  }
  return clamp(last[1], 0, tank.capacityL);
}

export interface Reading {
  /** Milliseconds. */
  t: number;
  l: number;
}

/** Moving median: each reading becomes the middle one among its neighbors. Removes sloshing peaks. */
export function smooth(readings: Reading[], window = FILTER_WINDOW): Reading[] {
  const half = Math.floor(window / 2);
  return readings.map((r, i) => {
    const near = readings
      .slice(Math.max(0, i - half), i + half + 1)
      .map((x) => x.l)
      .sort((a, b) => a - b);
    return { t: r.t, l: near[Math.floor(near.length / 2)] as number };
  });
}

/**
 * Fuel fills in an already filtered series: each sustained rise of the
 * level above the threshold. Driving never raises the level, so a
 * rise like that can only be a fill.
 */
export function refuels(series: Reading[], capacityL: number): Reading[] {
  const threshold = Math.max(REFUEL_MIN_L, capacityL * REFUEL_MIN_SHARE);
  const tolerance = Math.max(1, capacityL * 0.01);
  const out: Reading[] = [];
  const first = series[0];
  if (!first) return out;
  let low = first.l;
  let high = first.l;
  let highAt = first.t;
  const close = (next: number) => {
    if (high - low >= threshold) out.push({ t: highAt, l: high - low });
    low = high = next;
  };
  for (const p of series.slice(1)) {
    if (high - low >= threshold && p.l < high - tolerance) {
      // After rising, it drops again: the fill ended.
      close(p.l);
      highAt = p.t;
    } else if (p.l < low) {
      low = high = p.l;
      highAt = p.t;
    } else if (p.l > high) {
      high = p.l;
      highAt = p.t;
    }
  }
  close(high);
  return out;
}

/** A stretch without a trip: the vehicle stationary, with the engine off or idling. */
export interface Pause {
  from: number;
  to: number;
  /** Seconds of that stretch with the engine on. */
  idleS: number;
  /** Spans of that stretch with the engine on: [from, to]. */
  idle: [number, number][];
  lat: number;
  lon: number;
}

/** A trip's stops, with how long the engine was on in each one. */
export function pausesOf(samples: TrackSample[]): Pause[] {
  const out: Pause[] = [];
  for (const block of decompose(samples)) {
    const first = block.items[0];
    const last = block.items[block.items.length - 1];
    if (block.trip || !first || !last) continue;
    const start = samples[first.from] as TrackSample;
    const idle = block.items.filter((it) => it.kind === "idle");
    out.push({
      from: start.t,
      to: (samples[last.to] as TrackSample).t,
      idleS: idle.reduce((n, it) => n + it.seconds, 0),
      idle: idle.map((it) => [(samples[it.from] as TrackSample).t, (samples[it.to] as TrackSample).t]),
      lat: start.lat,
      lon: start.lon,
    });
  }
  return out;
}

export interface Drain extends Reading {
  /** With the engine off at the moment the level dropped. */
  engineOff: boolean;
  /** The stop where it happened. */
  pause: Pause;
}

/** Position of the last reading taken at that time or before; -1 if there is none. */
function lastAtOrBefore(series: Reading[], t: number): number {
  let low = 0;
  let high = series.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((series[mid] as Reading).t <= t) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/**
 * Fuel drains in an already filtered series. Within each stop the
 * level is followed: each drop from where it was, until it stops dropping or
 * rises again, is compared with what the engine could have burned idling in that
 * span. If the difference exceeds the threshold, fuel left the tank. This way
 * a fill in the same stop does not mask the drain, nor the reverse. While moving they are not
 * looked for: there a drop is consumption.
 */
export function drains(series: Reading[], pauses: Pause[], tank: Pick<FuelTank, "capacityL" | "normIdleLh">): Drain[] {
  const threshold = Math.max(REFUEL_MIN_L, tank.capacityL * REFUEL_MIN_SHARE);
  const tolerance = Math.max(1, tank.capacityL * 0.01);
  const rate = tank.normIdleLh ?? DRAIN_IDLE_LH;
  const out: Drain[] = [];
  for (const pause of pauses) {
    let start = lastAtOrBefore(series, pause.from + 60_000);
    if (start < 0) start = series.findIndex((r) => r.t >= pause.from);
    const end = lastAtOrBefore(series, pause.to + SETTLE_MS);
    if (start < 0 || end <= start) continue;

    // A drop: from the last reading at the top (`top`) to the lowest (`bottom`).
    let top = start;
    let bottom = start;
    let highLevel = (series[start] as Reading).l;
    const close = () => {
      const from = series[top] as Reading;
      const to = series[bottom] as Reading;
      // What the engine burned idling while it dropped is not a drain.
      const idleMs = pause.idle.reduce((n, [a, z]) => n + Math.max(0, Math.min(z, to.t) - Math.max(a, from.t)), 0);
      const lost = from.l - to.l - (idleMs / 3_600_000) * rate;
      if (lost < threshold) return;
      // The moment: the largest downward step of that drop.
      let where = bottom;
      let step = 0;
      for (let i = top + 1; i <= bottom; i++) {
        const down = (series[i - 1] as Reading).l - (series[i] as Reading).l;
        if (down > step) {
          step = down;
          where = i;
        }
      }
      const at = (series[where] as Reading).t;
      // Engine off if it was not on in that span. Having arrived idling and switching off afterwards does not change it.
      const since = (series[Math.max(top, where - STEP_SPREAD)] as Reading).t;
      out.push({ t: at, l: lost, engineOff: !pause.idle.some(([a, z]) => a < at && z > since), pause });
    };
    for (let i = start + 1; i <= end; i++) {
      const level = (series[i] as Reading).l;
      const falling = bottom !== top;
      if (falling && level > (series[bottom] as Reading).l + tolerance) {
        // After dropping, it rises again: that drop ended, and it continues from here.
        close();
        highLevel = level;
        top = bottom = i;
      } else if (!falling && level >= highLevel - tolerance) {
        // Still at the top: the drop has not started yet.
        highLevel = Math.max(highLevel, level);
        top = bottom = i;
      } else if (level < (series[bottom] as Reading).l) {
        bottom = i;
      }
    }
    close();
  }
  return out;
}

/** Liters burned up to each instant, from the filtered level: what dropped, plus what was filled and minus what was drained. */
function consumedByLevel(series: Reading[], fills: Reading[], drained: Reading[]): (t: number) => number {
  const first = series[0];
  return (t) => {
    if (!first) return 0;
    const i = lastAtOrBefore(series, t);
    const level = i < 0 ? first.l : (series[i] as Reading).l;
    const added = fills.reduce((n, f) => (f.t <= t ? n + f.l : n), 0);
    const removed = drained.reduce((n, d) => (d.t <= t ? n + d.l : n), 0);
    return Math.max(0, first.l - level + added - removed);
  };
}

/** The same with the engine's liter counter: adds what it advances, and ignores a reset. */
function consumedByEcu(readings: Reading[]): (t: number) => number {
  const steps: Reading[] = [];
  let total = 0;
  for (let i = 1; i < readings.length; i++) {
    const delta = (readings[i] as Reading).l - (readings[i - 1] as Reading).l;
    if (delta > 0) total += delta;
    steps.push({ t: (readings[i] as Reading).t, l: total });
  }
  return (t) => {
    let value = 0;
    for (const s of steps) {
      if (s.t > t) break;
      value = s.l;
    }
    return value;
  };
}

// ─── Tank ────────────────────────────────────────────────────────────────────

interface TankRow {
  capacity_l: number;
  attr: string | null;
  kind: FuelKind;
  calibration: [number, number][] | null;
  counter_attr: string | null;
  counter_unit: FuelCounterUnit;
  norm_l100km: number | null;
  norm_idle_lh: number | null;
}
const toTank = (r: TankRow): FuelTank => ({
  capacityL: r.capacity_l,
  attr: r.attr,
  kind: r.kind,
  calibration: r.calibration,
  counterAttr: r.counter_attr,
  counterUnit: r.counter_unit,
  normL100km: r.norm_l100km,
  normIdleLh: r.norm_idle_lh,
});

export async function tankOf(db: Queryable, vehicleId: string): Promise<FuelTank | null> {
  const r = await db.query<TankRow>(`SELECT capacity_l, attr, kind, calibration, counter_attr, counter_unit, norm_l100km, norm_idle_lh FROM gps.fuel_tanks WHERE vehicle_id = $1`, [vehicleId]);
  return r.rows[0] ? toTank(r.rows[0]) : null;
}

/** Tank, current level and the numeric data the device sends, to choose which one carries the level. */
export async function fuelStatus(db: Queryable, tenant: Tenant, vehicleId: string): Promise<FuelStatus> {
  await getVehicle(db, tenant, vehicleId);
  const tank = await tankOf(db, vehicleId);
  const recent = await db.query<{ fix_time: Date; attributes: Record<string, unknown> }>(
    `SELECT p.fix_time, p.attributes
       FROM gps.devices d
       JOIN gps.positions p ON p.device_id = d.id
      WHERE d.vehicle_id = $1 AND p.fix_time > now() - make_interval(days => $2)
      ORDER BY p.fix_time DESC
      LIMIT 200`,
    [vehicleId, LEVEL_LOOKBACK_DAYS],
  );
  const attrs = new Map<string, number>();
  for (const row of recent.rows.slice(0, 30)) {
    for (const [name, value] of Object.entries(row.attributes)) {
      const n = numberOf(value);
      if (n !== null && typeof value !== "boolean" && !attrs.has(name)) attrs.set(name, n);
    }
  }
  let level: FuelStatus["level"] = null;
  if (tank?.attr) {
    const attr = tank.attr;
    const latest = recent.rows
      .map((row) => ({ t: row.fix_time.getTime(), raw: levelOf(row.attributes[attr], row.attributes.ignition) }))
      .filter((x): x is { t: number; raw: number } => x.raw !== null)
      .slice(0, FILTER_WINDOW);
    const newest = latest[0];
    if (newest) {
      const sorted = latest.map((x) => litersOf(tank, x.raw)).sort((a, b) => a - b);
      const liters = sorted[Math.floor(sorted.length / 2)] as number;
      level = { liters: round1(liters), percent: Math.round((liters / tank.capacityL) * 100), at: new Date(newest.t).toISOString() };
    }
  }
  return {
    tank,
    level,
    attrs: [...attrs].map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function saveTank(deps: Pick<ModuleDeps, "db">, actor: Actor, vehicleId: string, data: TankData): Promise<FuelStatus> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  const last = data.calibration?.[data.calibration.length - 1];
  if (data.attr && data.kind === "raw" && last && last[1] > data.capacityL * 1.05) throw badRequest(say("fuel.errors.calibrationOverCapacity"));
  await deps.db.core.query(
    `INSERT INTO gps.fuel_tanks (vehicle_id, org_id, capacity_l, attr, kind, calibration, norm_l100km, norm_idle_lh, counter_attr, counter_unit)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (vehicle_id) DO UPDATE SET capacity_l = EXCLUDED.capacity_l, attr = EXCLUDED.attr, kind = EXCLUDED.kind, calibration = EXCLUDED.calibration,
       norm_l100km = EXCLUDED.norm_l100km, norm_idle_lh = EXCLUDED.norm_idle_lh, counter_attr = EXCLUDED.counter_attr, counter_unit = EXCLUDED.counter_unit,
       updated_at = now()`,
    [
      vehicleId,
      actor.orgId,
      data.capacityL,
      data.attr,
      data.kind,
      data.attr && data.kind === "raw" ? JSON.stringify(data.calibration) : null,
      data.normL100km,
      data.normIdleLh,
      data.counterAttr,
      data.counterAttr ? data.counterUnit : "l",
    ],
  );
  await audit(deps.db.core, actor, "fuel.configure", "vehicle", vehicleId, { name: vehicle.name, capacityL: data.capacityL, attr: data.attr });
  return fuelStatus(deps.db.core, actor, vehicleId);
}

export async function removeTank(deps: Pick<ModuleDeps, "db">, actor: Actor, vehicleId: string): Promise<void> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  const r = await deps.db.core.query(`DELETE FROM gps.fuel_tanks WHERE vehicle_id = $1`, [vehicleId]);
  if (r.rowCount === 0) throw notFound(say("fuel.errors.notConfigured"));
  await audit(deps.db.core, actor, "fuel.remove", "vehicle", vehicleId, { name: vehicle.name });
}

// ─── Report ──────────────────────────────────────────────────────────────────

/** What comes out of a period's positions: the route, the filtered level, the fills and the drains. */
export interface FuelAnalysis {
  samples: HistorySample[];
  trips: TripAnalysis["trips"];
  summary: TripAnalysis["summary"];
  /** Filtered level, in liters. */
  series: Reading[];
  /** Counter of liters burned by the engine, if the device sends it. */
  counter: Reading[];
  fills: Reading[];
  drains: Drain[];
}

/** Reads the period's positions and extracts the level, fills and drains from them. Does not check permissions: the caller does. */
export async function analyzeFuel(db: Queryable, orgId: string, vehicleId: string, tank: FuelTank, range: HistoryRange): Promise<FuelAnalysis> {
  const r = await db.query<SampleRow & { level_raw: unknown; fuel_used: unknown }>(
    `SELECT ${SAMPLE_COLUMNS}, p.attributes->$5::text AS level_raw, p.attributes->$7::text AS fuel_used
       FROM gps.devices d
       JOIN gps.positions p ON p.device_id = d.id
      WHERE d.org_id = $1 AND d.vehicle_id = $2
        AND p.valid AND p.fix_time >= $3 AND p.fix_time < $4
      ORDER BY p.fix_time
      LIMIT $6`,
    // Without a chosen counter, the standard one holds: "fuelUsed", in liters.
    [orgId, vehicleId, range.from, range.to, tank.attr ?? "", MAX_POSITIONS + 1, tank.counterAttr ?? "fuelUsed"],
  );
  if (r.rows.length > MAX_POSITIONS) throw badRequest(say("fuel.errors.tooManyPositions"), "history_too_large");

  const samples = r.rows.map(toSample);
  const { trips, summary } = analyze(samples);
  const levels: Reading[] = [];
  const counter: Reading[] = [];
  const unitL = tank.counterAttr ? FUEL_COUNTER_LITERS[tank.counterUnit] : 1;
  for (const row of r.rows) {
    const t = row.fix_time.getTime();
    const raw = tank.attr ? levelOf(row.level_raw, row.ignition) : null;
    if (raw !== null) levels.push({ t, l: litersOf(tank, raw) });
    const used = numberOf(row.fuel_used);
    if (used !== null) counter.push({ t, l: used * unitL });
  }
  const series = smooth(levels);
  return { samples, trips, summary, series, counter, fills: refuels(series, tank.capacityL), drains: drains(series, pausesOf(samples), tank) };
}

const efficiencyOf = (distanceM: number, liters: number | null) =>
  liters !== null && liters > 0.05 && distanceM >= 1000 ? { kmPerL: round2(distanceM / 1000 / liters), lPer100km: round2((liters * 100_000) / distanceM) } : null;

/** Where the vehicle was at that time: the closest position in time. */
function placeAt(samples: HistorySample[], t: number): { lat: number | null; lon: number | null } {
  let best: HistorySample | null = null;
  for (const s of samples) {
    if (best === null || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    else if (s.t > t) break;
  }
  return best ? { lat: best.lat, lon: best.lon } : { lat: null, lon: null };
}

export async function fuelReport(deps: Pick<ModuleDeps, "db" | "gate">, tenant: Tenant, vehicleId: string, range: HistoryRange): Promise<FuelReport> {
  assertRange(range);
  const db = deps.db.core;
  await getVehicle(db, tenant, vehicleId);
  const tank = await tankOf(db, vehicleId);
  if (!tank) throw notFound(say("fuel.errors.notConfigured"));

  const { samples, trips, summary, series, counter, fills, drains: drained } = await analyzeFuel(db, tenant.orgId, vehicleId, tank, range);
  const km = summary.distanceM / 1000;

  // By norm: what it should have burned according to the distance covered and the idling time.
  const byDistanceL = tank.normL100km === null ? 0 : (km * tank.normL100km) / 100;
  const byIdleL = tank.normIdleLh === null ? 0 : (summary.idleS / 3600) * tank.normIdleLh;
  const estimated = tank.normL100km === null && tank.normIdleLh === null ? null : { liters: round1(byDistanceL + byIdleL), byDistanceL: round1(byDistanceL), byIdleL: round1(byIdleL) };

  // By sensor: the engine counter if the device sends it; otherwise, the level difference plus what was filled and minus what was drained.
  const refueledL = fills.reduce((n, f) => n + f.l, 0);
  const drainedL = drained.reduce((n, d) => n + d.l, 0);
  let consumed: ((t: number) => number) | null = null;
  let real: FuelReport["real"] = null;
  const end = range.to.getTime();
  if (counter.length >= 2) {
    consumed = consumedByEcu(counter);
    real = { liters: round1(consumed(end)), method: "ecu", refueledL: round1(refueledL), drainedL: round1(drainedL) };
  } else if (series.length >= 2) {
    consumed = consumedByLevel(series, fills, drained);
    real = { liters: round1(consumed(end)), method: "level", refueledL: round1(refueledL), drainedL: round1(drainedL) };
  }

  const basis: "real" | "estimated" = real ? "real" : "estimated";
  const used = real?.liters ?? estimated?.liters ?? null;
  const overall = efficiencyOf(summary.distanceM, used);

  // At idle: what it burned, according to the sensor, in the stretches with the engine on without moving.
  let idleRealL: number | null = null;
  if (consumed) {
    idleRealL = 0;
    for (const block of decompose(samples)) {
      for (const it of block.items) {
        if (it.kind === "idle") idleRealL += Math.max(0, consumed((samples[it.to] as HistorySample).t) - consumed((samples[it.from] as HistorySample).t));
      }
    }
  }

  // Paid: the fills recorded in the period, by currency, and the most recent known price per liter.
  const paid = await db.query<{ currency: string; spent: number; liters: number; fills: number }>(
    `SELECT currency, sum(total)::float8 AS spent, sum(liters)::float8 AS liters, count(*)::int AS fills
       FROM gps.fuel_fills
      WHERE vehicle_id = $1 AND at >= $2 AND at < $3 AND total IS NOT NULL
      GROUP BY currency
      ORDER BY sum(total) DESC`,
    [vehicleId, range.from, range.to],
  );
  const costs = paid.rows.map((c) => ({ currency: c.currency, spent: round2(c.spent), liters: round1(c.liters), fills: c.fills }));
  let price: { currency: string; perL: number } | null = null;
  const main = paid.rows[0];
  if (main && main.liters > 0 && main.spent > 0) price = { currency: main.currency, perL: main.spent / main.liters };
  else {
    const latest = await db.query<{ currency: string; per_l: number }>(
      `SELECT currency, (total / liters)::float8 AS per_l FROM gps.fuel_fills WHERE vehicle_id = $1 AND at < $2 AND total > 0 ORDER BY at DESC LIMIT 1`,
      [vehicleId, range.to],
    );
    if (latest.rows[0]) price = { currency: latest.rows[0].currency, perL: latest.rows[0].per_l };
  }
  const costPerKm = price && used !== null && used > 0.05 && km >= 1 ? { currency: price.currency, value: round2((used * price.perL) / km), pricePerL: round2(price.perL), basis } : null;

  // Driver efficiency: to each person, the distance covered and the fuel burned while they had the vehicle.
  const drivers: FuelReport["drivers"] = [];
  if (await deps.gate.enabled(tenant.orgId, "B")) {
    const byDriver = new Map<string, { name: string; distanceM: number; liters: number }>();
    for (const w of await driverWindows(db, vehicleId, range)) {
      const own = byDriver.get(w.driverId) ?? { name: w.name, distanceM: 0, liters: 0 };
      for (const trip of trips) {
        const start = Date.parse(trip.start);
        const stop = Date.parse(trip.end);
        const overlap = Math.min(stop, w.end) - Math.max(start, w.start);
        if (overlap > 0) own.distanceM += trip.distanceM * (overlap / Math.max(1, stop - start));
      }
      if (consumed) own.liters += Math.max(0, consumed(w.end) - consumed(w.start));
      byDriver.set(w.driverId, own);
    }
    for (const [driverId, d] of byDriver) {
      const liters = consumed ? round1(d.liters) : null;
      const eff = efficiencyOf(d.distanceM, liters);
      drivers.push({ driverId, name: d.name, distanceM: Math.round(d.distanceM), liters, kmPerL: eff?.kmPerL ?? null, lPer100km: eff?.lPer100km ?? null });
    }
    drivers.sort((a, b) => b.distanceM - a.distanceM);
  }

  const jump = (p: Reading): FuelJump => ({ at: new Date(p.t).toISOString(), liters: round1(p.l), ...placeAt(samples, p.t) });
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    distanceM: summary.distanceM,
    idleS: summary.idleS,
    series: thin(series, SERIES_MAX).map((p) => ({ t: Math.round(p.t / 1000), l: round1(p.l) })),
    estimated,
    real,
    refuels: fills.map(jump),
    drains: drained.map((d) => ({ ...jump(d), lat: d.pause.lat, lon: d.pause.lon, engineOff: d.engineOff })),
    idle: { seconds: summary.idleS, estimatedL: tank.normIdleLh === null ? null : round1(byIdleL), realL: idleRealL === null ? null : round1(idleRealL) },
    costs,
    costPerKm,
    efficiency: overall ? { ...overall, basis } : null,
    drivers,
  };
}
