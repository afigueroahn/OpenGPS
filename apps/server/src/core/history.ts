// History of a vehicle over a period: positions, trips, stops and totals.
import { HISTORY_MAX_DAYS, HISTORY_MAX_POINTS, type HistoryPoint, type HistorySummary, type Stop, type Trip, type Vehicle, type VehicleHistory } from "@opengps/shared";
import type { Queryable } from "../db";
import { badRequest } from "../errors";
import { say } from "../i18n";
import { ignitionFromVoltage } from "../ingest/normalize";
import type { Tenant } from "./access";
import { knownAddresses } from "./geocode";
import { type TrackSample, analyze, distanceM, thin } from "./trips";
import { getVehicle } from "./vehicles";

/** Maximum positions analyzed in one query. */
export const MAX_POSITIONS = 250_000;

export interface HistoryRange {
  from: Date;
  to: Date;
}

export interface HistorySample extends TrackSample {
  altitude: number | null;
}

/** Everything that comes out of a period, before shaping it for the web app or a file. */
export interface HistoryData {
  vehicle: Vehicle;
  summary: HistorySummary;
  trips: Trip[];
  stops: Stop[];
  samples: HistorySample[];
}

export function assertRange({ from, to }: HistoryRange): void {
  if (!(from.getTime() < to.getTime())) throw badRequest(say("core.history.endBeforeStart"));
  // One hour of margin: a month that includes a daylight-saving change lasts one hour longer.
  if (to.getTime() - from.getTime() > HISTORY_MAX_DAYS * 86_400_000 + 3_600_000) {
    throw badRequest(say("core.history.rangeTooLong", { days: HISTORY_MAX_DAYS }), "history_range_too_long");
  }
}

/** Position columns the trip engine needs; `p` is gps.positions. */
export const SAMPLE_COLUMNS = `p.fix_time, p.lat, p.lon, p.speed_kmh, p.course, p.altitude,
            p.attributes->'ignition' AS ignition, p.attributes->'power' AS power, p.attributes->'odometer' AS odometer`;

export interface SampleRow {
  fix_time: Date;
  lat: number;
  lon: number;
  speed_kmh: number | null;
  course: number | null;
  altitude: number | null;
  ignition: unknown;
  power: unknown;
  odometer: unknown;
}

const numberOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export const toSample = (row: SampleRow): HistorySample => ({
  t: row.fix_time.getTime(),
  lat: row.lat,
  lon: row.lon,
  speedKmh: row.speed_kmh ?? 0,
  course: row.course,
  altitude: row.altitude,
  ignition: typeof row.ignition === "boolean" ? row.ignition : ignitionFromVoltage(numberOf(row.power)),
  odometer: numberOf(row.odometer),
});

/**
 * Loads and analyzes the period. Trips are calculated on the fly, so
 * a position the device uploaded late already counts in this response.
 */
export async function loadHistory(
  db: Queryable,
  tenant: Tenant,
  vehicleId: string,
  range: HistoryRange,
  opts: { addresses: boolean },
): Promise<HistoryData> {
  assertRange(range);
  // Checks that the vehicle belongs to the account and to a group this person sees.
  const vehicle = await getVehicle(db, tenant, vehicleId);
  const r = await db.query<SampleRow>(
    `SELECT ${SAMPLE_COLUMNS}
       FROM gps.devices d
       JOIN gps.positions p ON p.device_id = d.id
      WHERE d.org_id = $1 AND d.vehicle_id = $2
        AND p.valid AND p.fix_time >= $3 AND p.fix_time < $4
      ORDER BY p.fix_time
      LIMIT $5`,
    [tenant.orgId, vehicleId, range.from, range.to, MAX_POSITIONS + 1],
  );
  if (r.rows.length > MAX_POSITIONS) {
    throw badRequest(say("core.history.tooManyPositions"), "history_too_large");
  }

  const samples = r.rows.map(toSample);

  const { trips, stops, summary } = analyze(samples);
  if (opts.addresses) {
    const places = [
      ...trips.flatMap((t) => [
        { lat: t.startLat, lon: t.startLon },
        { lat: t.endLat, lon: t.endLon },
      ]),
      ...stops.map((s) => ({ lat: s.lat, lon: s.lon })),
    ];
    const known = await knownAddresses(db, places);
    trips.forEach((trip, i) => {
      trip.startAddress = known[i * 2] ?? null;
      trip.endAddress = known[i * 2 + 1] ?? null;
    });
    stops.forEach((stop, i) => {
      stop.address = known[trips.length * 2 + i] ?? null;
    });
  }

  return {
    vehicle,
    summary: { from: range.from.toISOString(), to: range.to.toISOString(), ...summary },
    trips,
    stops,
    samples,
  };
}

const still = (s: TrackSample) => s.speedKmh < 1;

/**
 * Route for the map and the player. For a stationary vehicle one
 * point every five minutes is enough; if that is still too many, they are spread evenly.
 */
export function mapPoints(samples: HistorySample[], max = HISTORY_MAX_POINTS): HistoryPoint[] {
  const kept: HistorySample[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as HistorySample;
    const prev = kept[kept.length - 1];
    const next = samples[i + 1];
    if (
      prev &&
      next &&
      still(prev) &&
      still(s) &&
      still(next) &&
      s.ignition === prev.ignition &&
      next.ignition === s.ignition &&
      s.t - prev.t < 300_000 &&
      distanceM(prev.lat, prev.lon, s.lat, s.lon) < 30
    ) {
      continue;
    }
    kept.push(s);
  }
  return thin(kept, max).map((s) => ({
    t: Math.round(s.t / 1000),
    lat: Math.round(s.lat * 1e6) / 1e6,
    lon: Math.round(s.lon * 1e6) / 1e6,
    s: Math.round(s.speedKmh),
    c: s.course === null ? null : Math.round(s.course),
    i: s.ignition,
  }));
}

export function toVehicleHistory(data: HistoryData): VehicleHistory {
  return { summary: data.summary, trips: data.trips, stops: data.stops, points: mapPoints(data.samples) };
}
