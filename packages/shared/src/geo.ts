// Geofence geometry. Used by the server, which decides whether a vehicle
// is inside, and by the web app, which draws them and validates what the person traces.
import type { SharedSay } from "./locales";

/** Point as maps use it: longitude first. */
export type LonLat = [lon: number, lat: number];

export type GeofenceGeometry =
  | { shape: "circle"; center: LonLat; radiusM: number }
  | { shape: "polygon"; ring: LonLat[] }
  /** Route with tolerance: everything within half a width of the line. */
  | { shape: "corridor"; line: LonLat[]; widthM: number };

export const GEOFENCE_LIMITS = {
  minRadiusM: 20,
  maxRadiusM: 100_000,
  minWidthM: 20,
  maxWidthM: 5_000,
  maxVertices: 100,
  /** Smallest reasonable side of a polygon: below it, the GPS cannot tell it apart. */
  minAreaM2: 400,
} as const;

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const M_PER_DEG = (Math.PI * R) / 180;

export function metersBetween(a: LonLat, b: LonLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Point in meters relative to `origin`, on a local plane. Valid for distances of a few kilometers. */
function local(origin: LonLat, p: LonLat): [number, number] {
  return [(p[0] - origin[0]) * M_PER_DEG * Math.cos(rad(origin[1])), (p[1] - origin[1]) * M_PER_DEG];
}

export function distanceToSegmentM(p: LonLat, a: LonLat, b: LonLat): number {
  const [ax, ay] = local(p, a);
  const [bx, by] = local(p, b);
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  // The point ends up at the plane's origin.
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function distanceToLineM(p: LonLat, line: LonLat[], closed = false): number {
  let best = Number.POSITIVE_INFINITY;
  const last = closed ? line.length : line.length - 1;
  for (let i = 0; i < last; i++) {
    best = Math.min(best, distanceToSegmentM(p, line[i] as LonLat, line[(i + 1) % line.length] as LonLat));
  }
  return line.length === 1 ? metersBetween(p, line[0] as LonLat) : best;
}

/** Does the point fall inside the polygon? Counts the crossings of a ray with its sides. */
export function insideRing(p: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as LonLat;
    const [xj, yj] = ring[j] as LonLat;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance to the edge in meters: negative inside the geofence, positive outside. */
export function signedDistanceM(g: GeofenceGeometry, p: LonLat): number {
  if (g.shape === "circle") return metersBetween(p, g.center) - g.radiusM;
  if (g.shape === "corridor") return distanceToLineM(p, g.line) - g.widthM / 2;
  const edge = distanceToLineM(p, g.ring, true);
  return insideRing(p, g.ring) ? -edge : edge;
}

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** Box containing the geofence with a margin, to quickly discard distant points. */
export function boundsOf(g: GeofenceGeometry, marginM = 100): Bounds {
  const points = g.shape === "circle" ? [g.center] : g.shape === "polygon" ? g.ring : g.line;
  const reach = marginM + (g.shape === "circle" ? g.radiusM : g.shape === "corridor" ? g.widthM / 2 : 0);
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const [lon, lat] of points) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  const dLat = reach / M_PER_DEG;
  const dLon = reach / (M_PER_DEG * Math.max(0.05, Math.cos(rad(Math.max(Math.abs(minLat), Math.abs(maxLat))))));
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

/** Point `meters` from `from`, on the given heading (0 = north, 90 = east). */
export function offset(from: LonLat, meters: number, bearing: number): LonLat {
  const d = meters / R;
  const b = rad(bearing);
  const lat1 = rad(from[1]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = rad(from[0]) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [deg(lon2), deg(lat2)];
}

export function bearing(a: LonLat, b: LonLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Outline of a circle as a polygon, to draw it. */
export function circleRing(center: LonLat, radiusM: number, steps = 72): LonLat[] {
  return Array.from({ length: steps }, (_, i) => offset(center, radiusM, (i * 360) / steps));
}

/** Outline of a corridor: the line widened by half a width on each side, with rounded ends. */
export function corridorRing(line: LonLat[], widthM: number): LonLat[] {
  if (line.length === 0) return [];
  const half = widthM / 2;
  if (line.length === 1) return circleRing(line[0] as LonLat, half, 32);
  const side = (sign: 1 | -1): LonLat[] => {
    const out: LonLat[] = [];
    for (let i = 0; i < line.length; i++) {
      const p = line[i] as LonLat;
      const before = line[i - 1];
      const after = line[i + 1];
      const inB = before ? bearing(before, p) : null;
      const outB = after ? bearing(p, after) : null;
      if (inB !== null && outB !== null) {
        // At a corner, the side rests on the bisector, without straying too far on sharp turns.
        const turn = ((outB - inB + 540) % 360) - 180;
        const reach = Math.min(half / Math.max(0.35, Math.cos(rad(turn / 2))), half * 2.5);
        out.push(offset(p, reach, inB + turn / 2 + sign * 90));
      } else {
        out.push(offset(p, half, ((inB ?? outB) as number) + sign * 90));
      }
    }
    return out;
  };
  const cap = (at: LonLat, heading: number): LonLat[] => Array.from({ length: 7 }, (_, i) => offset(at, half, heading + 90 - ((i + 1) * 180) / 8));
  const first = line[0] as LonLat;
  const last = line[line.length - 1] as LonLat;
  const right = side(1);
  const left = side(-1).reverse();
  return [...right, ...cap(last, bearing(line[line.length - 2] as LonLat, last)), ...left, ...cap(first, bearing(line[1] as LonLat, first))];
}

/** Closed outline of any geofence, to draw it. */
export function outlineOf(g: GeofenceGeometry): LonLat[] {
  if (g.shape === "circle") return circleRing(g.center, g.radiusM);
  if (g.shape === "corridor") return corridorRing(g.line, g.widthM);
  return g.ring;
}

/** Point where the geofence's name goes. */
export function labelPoint(g: GeofenceGeometry): LonLat {
  if (g.shape === "circle") return g.center;
  const points = g.shape === "polygon" ? g.ring : g.line;
  if (g.shape === "corridor") return points[Math.floor(points.length / 2)] as LonLat;
  const sum = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as LonLat, [0, 0] as LonLat);
  return [sum[0] / points.length, sum[1] / points.length];
}

function segmentsCross(a: LonLat, b: LonLat, c: LonLat, d: LonLat): boolean {
  const turn = (p: LonLat, q: LonLat, r: LonLat) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return turn(a, b, c) !== turn(a, b, d) && turn(c, d, a) !== turn(c, d, b);
}

/** Does any side of the polygon cross another? Such a polygon has no clear "inside". */
export function selfIntersects(ring: LonLat[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighboring sides across the closure
      if (segmentsCross(ring[i] as LonLat, ring[(i + 1) % n] as LonLat, ring[j] as LonLat, ring[(j + 1) % n] as LonLat)) return true;
    }
  }
  return false;
}

export function ringAreaM2(ring: LonLat[]): number {
  const origin = ring[0];
  if (!origin) return 0;
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = local(origin, ring[i] as LonLat);
    const [x2, y2] = local(origin, ring[(i + 1) % ring.length] as LonLat);
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/** Why a newly traced geofence is not valid, as a text to say, or null if it is fine. */
export function geometryProblem(g: GeofenceGeometry): SharedSay | null {
  const L = GEOFENCE_LIMITS;
  if (g.shape === "circle") {
    if (g.radiusM < L.minRadiusM) return { key: "geometry.radiusMin", params: { meters: L.minRadiusM } };
    if (g.radiusM > L.maxRadiusM) return { key: "geometry.radiusMax", params: { km: L.maxRadiusM / 1000 } };
    return null;
  }
  if (g.shape === "polygon") {
    if (g.ring.length < 3) return { key: "geometry.zoneMinPoints" };
    if (g.ring.length > L.maxVertices) return { key: "geometry.zoneMaxPoints", params: { max: L.maxVertices } };
    if (selfIntersects(g.ring)) return { key: "geometry.zoneCrosses" };
    if (ringAreaM2(g.ring) < L.minAreaM2) return { key: "geometry.zoneTooSmall" };
    return null;
  }
  if (g.line.length < 2) return { key: "geometry.routeMinPoints" };
  if (g.line.length > L.maxVertices) return { key: "geometry.routeMaxPoints", params: { max: L.maxVertices } };
  if (g.widthM < L.minWidthM) return { key: "geometry.widthMin", params: { meters: L.minWidthM } };
  if (g.widthM > L.maxWidthM) return { key: "geometry.widthMax", params: { km: L.maxWidthM / 1000 } };
  let length = 0;
  for (let i = 0; i < g.line.length - 1; i++) length += metersBetween(g.line[i] as LonLat, g.line[i + 1] as LonLat);
  if (length < 50) return { key: "geometry.routeTooShort" };
  return null;
}
