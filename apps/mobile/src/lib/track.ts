// Recent trip of the chosen vehicle: what the platform kept of the last hour,
// plus each position that arrives live. Same rules as the web app's
// (apps/web/src/app/AppShell.tsx).
import type { TrackPoint, VehicleState } from "@opengps/shared";

/** Minutes of trip asked for when a vehicle is chosen. */
export const TRACK_MINUTES = 60;
/** Most points kept for the map. */
export const TRACK_MAX_POINTS = 2000;

/** Joins trip points without repeating times, sorted and capped. */
export function mergeTrack(a: TrackPoint[], b: TrackPoint[]): TrackPoint[] {
  const byTime = new Map<string, TrackPoint>();
  for (const p of [...a, ...b]) byTime.set(p.t, p);
  return [...byTime.values()].sort((x, y) => (x.t < y.t ? -1 : 1)).slice(-TRACK_MAX_POINTS);
}

/** The point of a live position; null if it has no fix. */
export function trackPoint(s: VehicleState | null | undefined): TrackPoint | null {
  if (!s || s.lat === null || s.lon === null || !s.fixTime) return null;
  return { t: s.fixTime, lat: s.lat, lon: s.lon, speedKmh: s.speedKmh, course: s.course };
}
