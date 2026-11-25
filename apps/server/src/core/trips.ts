// Trip engine: turns a series of positions into trips, stops and
// times (moving, idling and stopped).
//
// It is calculated at query time, from the stored positions. This way data
// the device uploads late shows up in the next query on its own, with no
// pending recalculations.
import { type HistorySummary, type Stop, type Trip, metersBetween } from "@opengps/shared";

/** Position as the engine needs it, sorted by time. */
export interface TrackSample {
  /** GPS time in milliseconds. */
  t: number;
  lat: number;
  lon: number;
  speedKmh: number;
  course: number | null;
  ignition: boolean | null;
  /** Device odometer in meters, if it reports it. */
  odometer: number | null;
}

/** From this speed up, the vehicle is considered moving. */
export const TRIP_MOVING_KMH = 5;
/** A pause shorter than this does not break the trip: it is a traffic light. */
export const MIN_STOP_S = 180;
/** With no reports for this long, the trip is considered finished. */
export const MAX_GAP_S = 600;
/** A "trip" shorter than this is GPS noise. */
export const MIN_TRIP_M = 100;
export const MIN_TRIP_S = 60;
/** A jump that would imply more speed than this is discarded from the mileage. */
const MAX_PLAUSIBLE_KMH = 220;
/** Minimum advance between two positions to trust the reported speed. */
const MIN_ADVANCE_KMH = 2;
/** Advance that on its own indicates movement, even if the device reports no speed. */
const CLEAR_ADVANCE_KMH = 15;
const CLEAR_ADVANCE_M = 50;

export type Kind = "moving" | "idle" | "stopped";

/** Segment between two consecutive positions. */
export interface Interval {
  from: number;
  to: number;
  seconds: number;
  meters: number;
  kind: Kind;
  /** Gap with no reports: it is unknown what happened, and it breaks any trip. */
  gap: boolean;
}

/** Segments between consecutive positions, with the distance covered and whether it was moving, idling or stopped. */
export function intervals(samples: TrackSample[]): Interval[] {
  const out: Interval[] = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i] as TrackSample;
    const b = samples[i + 1] as TrackSample;
    const seconds = (b.t - a.t) / 1000;
    if (seconds <= 0) continue;
    const gap = seconds > MAX_GAP_S;
    const raw = metersBetween([a.lon, a.lat], [b.lon, b.lat]);
    const impliedKmh = (raw / seconds) * 3.6;
    const plausible = impliedKmh <= MAX_PLAUSIBLE_KMH;
    const reported = Math.max(a.speedKmh, b.speedKmh) >= TRIP_MOVING_KMH;
    // Moving: the device reports speed and there was also real advance, or the
    // advance is so clear that speed is not needed (devices that do not send it).
    // On an impossible GPS jump the speed is trusted, but it adds no meters.
    let moving = false;
    if (!gap) {
      if (!plausible) moving = reported;
      else moving = (reported && impliedKmh >= MIN_ADVANCE_KMH) || (impliedKmh >= CLEAR_ADVANCE_KMH && raw >= CLEAR_ADVANCE_M);
    }
    // The ignition state the position reported holds until the next one.
    const kind: Kind = moving ? "moving" : !gap && a.ignition === true ? "idle" : "stopped";
    out.push({ from: i, to: i + 1, seconds, meters: moving && plausible ? raw : 0, kind, gap });
  }
  return out;
}

interface Run {
  moving: boolean;
  items: Interval[];
  seconds: number;
}

/** Groups consecutive segments into "moving" and "not advancing". A gap with no reports always separates them. */
function runs(list: Interval[]): Run[] {
  const out: Run[] = [];
  for (const it of list) {
    const moving = it.kind === "moving";
    const last = out[out.length - 1];
    const previous = last?.items[last.items.length - 1];
    if (last && last.moving === moving && !it.gap && !previous?.gap) {
      last.items.push(it);
      last.seconds += it.seconds;
    } else {
      out.push({ moving, items: [it], seconds: it.seconds });
    }
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();
const sum = (items: Interval[], pick: (i: Interval) => number) => items.reduce((n, i) => n + pick(i), 0);

function buildTrip(samples: TrackSample[], items: Interval[]): Trip {
  const first = samples[(items[0] as Interval).from] as TrackSample;
  const last = samples[(items[items.length - 1] as Interval).to] as TrackSample;
  const durationS = (last.t - first.t) / 1000;
  let meters = sum(items, (i) => i.meters);
  // If the device has an odometer and it is consistent with the calculation, it is more accurate.
  if (first.odometer !== null && last.odometer !== null) {
    const byOdometer = last.odometer - first.odometer;
    if (byOdometer > 0 && byOdometer <= meters * 1.5 + 1000 && byOdometer >= meters * 0.5) meters = byOdometer;
  }
  const movingS = sum(items, (i) => (i.kind === "moving" ? i.seconds : 0));
  let maxSpeed = 0;
  for (let i = (items[0] as Interval).from; i <= (items[items.length - 1] as Interval).to; i++) {
    maxSpeed = Math.max(maxSpeed, (samples[i] as TrackSample).speedKmh);
  }
  return {
    start: iso(first.t),
    end: iso(last.t),
    durationS: Math.round(durationS),
    distanceM: Math.round(meters),
    maxSpeedKmh: Math.round(maxSpeed),
    avgSpeedKmh: movingS > 0 ? Math.round((meters / movingS) * 3.6) : 0,
    idleS: Math.round(sum(items, (i) => (i.kind === "idle" ? i.seconds : 0))),
    startLat: first.lat,
    startLon: first.lon,
    endLat: last.lat,
    endLon: last.lon,
    startAddress: null,
    endAddress: null,
  };
}

function buildStop(samples: TrackSample[], items: Interval[]): Stop {
  const first = samples[(items[0] as Interval).from] as TrackSample;
  const last = samples[(items[items.length - 1] as Interval).to] as TrackSample;
  return {
    start: iso(first.t),
    end: iso(last.t),
    durationS: Math.round((last.t - first.t) / 1000),
    lat: first.lat,
    lon: first.lon,
    idleS: Math.round(sum(items, (i) => (i.kind === "idle" ? i.seconds : 0))),
    address: null,
  };
}

export interface TripAnalysis {
  trips: Trip[];
  stops: Stop[];
  summary: Omit<HistorySummary, "from" | "to">;
}

/** Stretch of the route that is entirely trip or entirely stop, with its intervals. */
export interface Block {
  trip: boolean;
  items: Interval[];
}

/**
 * Splits time-sorted positions into alternating blocks of trip and
 * non-trip. Used by history, which analyzes a continuous period, and by the days
 * stored, which analyze it in pieces.
 */
export function decompose(samples: TrackSample[]): Block[] {
  const all = intervals(samples);
  const grouped = runs(all);

  // 1. A short pause between two moving segments is still part of the trip.
  const blocks: Block[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const run = grouped[i] as Run;
    const last = blocks[blocks.length - 1];
    const next = grouped[i + 1];
    const hasGap = run.items.some((it) => it.gap);
    const shortPause = !run.moving && !hasGap && run.seconds < MIN_STOP_S && last?.trip === true && next?.moving === true;
    if (run.moving || shortPause) {
      if (last?.trip) last.items.push(...run.items);
      else blocks.push({ trip: true, items: [...run.items] });
    } else if (last && !last.trip) {
      last.items.push(...run.items);
    } else {
      blocks.push({ trip: false, items: [...run.items] });
    }
  }

  // 2. A tiny "trip" is GPS noise: it merges with the surrounding stop.
  const merged: Block[] = [];
  for (const block of blocks) {
    const tiny = block.trip && (sum(block.items, (i) => i.meters) < MIN_TRIP_M || sum(block.items, (i) => i.seconds) < MIN_TRIP_S);
    const asTrip = block.trip && !tiny;
    const last = merged[merged.length - 1];
    if (last && !last.trip && !asTrip) last.items.push(...block.items);
    else merged.push({ trip: asTrip, items: [...block.items] });
  }
  return merged;
}

/** Analyzes time-sorted positions. */
export function analyze(samples: TrackSample[]): TripAnalysis {
  const merged = decompose(samples);

  const trips: Trip[] = [];
  const stops: Stop[] = [];
  for (const block of merged) {
    if (block.trip) trips.push(buildTrip(samples, block.items));
    else if (sum(block.items, (i) => i.seconds) >= MIN_STOP_S) stops.push(buildStop(samples, block.items));
  }

  // The times come from the same blocks, so they match trips and stops.
  let movingS = 0;
  let idleS = 0;
  let stoppedS = 0;
  for (const block of merged) {
    for (const it of block.items) {
      // "Movement" outside a trip is GPS noise: it counts as stopped.
      if (block.trip && it.kind === "moving") movingS += it.seconds;
      else if (it.kind === "idle") idleS += it.seconds;
      else stoppedS += it.seconds;
    }
  }
  const distance = trips.reduce((n, t) => n + t.distanceM, 0);
  return {
    trips,
    stops,
    summary: {
      distanceM: distance,
      movingS: Math.round(movingS),
      idleS: Math.round(idleS),
      stoppedS: Math.round(stoppedS),
      maxSpeedKmh: trips.reduce((n, t) => Math.max(n, t.maxSpeedKmh), 0),
      avgSpeedKmh: movingS > 0 ? Math.round((distance / movingS) * 3.6) : 0,
      trips: trips.length,
      stops: stops.length,
      positions: samples.length,
    },
  };
}

/**
 * Thins the route for the map: keeps the first and the last point and
 * spreads the rest evenly, without exceeding `max`.
 */
export function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)] as T);
  return out;
}
