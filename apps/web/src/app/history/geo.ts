// Calculations over the trip: distance, position at an instant and segments.
import type { HistoryPoint } from "@opengps/shared";

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** With no reports for longer than this, it is not known where the vehicle went. */
export const GAP_S = 600;

/** Index of the last point whose time does not exceed `t`. */
export function indexAt(points: HistoryPoint[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((points[mid] as HistoryPoint).t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Moment {
  lat: number;
  lon: number;
  speed: number;
  course: number | null;
  ignition: boolean | null;
}

/** Where the vehicle was at instant `t` (seconds), between two points if needed. */
export function momentAt(points: HistoryPoint[], t: number): Moment | null {
  if (points.length === 0) return null;
  const i = indexAt(points, t);
  const a = points[i] as HistoryPoint;
  const b = points[i + 1];
  const here = { lat: a.lat, lon: a.lon, speed: a.s, course: a.c, ignition: a.i };
  // In a gap without data the path is not invented: it waits at the last known point.
  if (!b || t <= a.t || b.t - a.t > GAP_S) return here;
  const k = (t - a.t) / (b.t - a.t);
  return {
    lat: a.lat + (b.lat - a.lat) * k,
    lon: a.lon + (b.lon - a.lon) * k,
    speed: a.s + (b.s - a.s) * k,
    course: b.c ?? a.c,
    ignition: a.i,
  };
}

/** Points between two times (seconds), both included. */
export function between(points: HistoryPoint[], from: number, to: number): HistoryPoint[] {
  return points.filter((p) => p.t >= from && p.t <= to);
}

/** The segment between two points is a wait: no progress, or no data. */
export function isWait(a: HistoryPoint, b: HistoryPoint): boolean {
  const seconds = b.t - a.t;
  if (seconds > GAP_S) return true;
  return seconds >= 60 && distanceM(a.lat, a.lon, b.lat, b.lon) < 30;
}
