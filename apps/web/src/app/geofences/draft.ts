// Geofence half drawn. It resembles the final one, but may be
// incomplete: a circle without a center, a zone with two points.
import {
  GEOFENCE_COLOR,
  GEOFENCE_LIMITS,
  type Geofence,
  type GeofenceGeometry,
  type GeofenceKind,
  type LonLat,
  bearing,
  circleRing,
  corridorRing,
  metersBetween,
  offset,
} from "@opengps/shared";
import type { Feature, LineString, Polygon } from "geojson";

export type GeofenceDraft =
  | { shape: "circle"; center: LonLat | null; radiusM: number }
  | { shape: "polygon"; ring: LonLat[] }
  | { shape: "corridor"; line: LonLat[]; widthM: number };

export const emptyDraft = (shape: GeofenceDraft["shape"]): GeofenceDraft =>
  shape === "circle" ? { shape, center: null, radiusM: 200 } : shape === "polygon" ? { shape, ring: [] } : { shape, line: [], widthM: 100 };

export const draftOf = (geometry: GeofenceGeometry): GeofenceDraft => structuredClone(geometry);

/** The geofence as it would end up, or null if it still lacks points. */
export function geometryOf(draft: GeofenceDraft): GeofenceGeometry | null {
  if (draft.shape === "circle") return draft.center ? { shape: "circle", center: draft.center, radiusM: draft.radiusM } : null;
  if (draft.shape === "polygon") return draft.ring.length >= 3 ? draft : null;
  return draft.line.length >= 2 ? draft : null;
}

/** Points the person has marked. */
export function pointsOf(draft: GeofenceDraft): LonLat[] {
  if (draft.shape === "circle") return draft.center ? [draft.center] : [];
  return draft.shape === "polygon" ? draft.ring : draft.line;
}

export const colorOf = (kind: GeofenceKind, shape: GeofenceGeometry["shape"]) => GEOFENCE_COLOR[shape === "corridor" ? "corridor" : kind];
export const colorOfGeofence = (g: Pick<Geofence, "kind" | "geometry">) => colorOf(g.kind, g.geometry.shape);

const closed = (ring: LonLat[]): LonLat[] => (ring.length > 0 ? [...ring, ring[0] as LonLat] : ring);
export const polygonOf = (ring: LonLat[]): Polygon => ({ type: "Polygon", coordinates: [closed(ring)] });

/** What is drawn while tracing: the area if possible, and the line joining the points. */
export function draftFeatures(draft: GeofenceDraft): Feature<Polygon | LineString>[] {
  const out: Feature<Polygon | LineString>[] = [];
  if (draft.shape === "circle") {
    if (draft.center) out.push({ type: "Feature", geometry: polygonOf(circleRing(draft.center, draft.radiusM)), properties: {} });
    return out;
  }
  if (draft.shape === "polygon") {
    if (draft.ring.length >= 3) out.push({ type: "Feature", geometry: polygonOf(draft.ring), properties: {} });
    else if (draft.ring.length === 2) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: draft.ring }, properties: {} });
    return out;
  }
  if (draft.line.length >= 2) {
    out.push({ type: "Feature", geometry: polygonOf(corridorRing(draft.line, draft.widthM)), properties: {} });
    out.push({ type: "Feature", geometry: { type: "LineString", coordinates: draft.line }, properties: { axis: true } });
  }
  return out;
}

export interface Handle {
  role: "center" | "radius" | "vertex";
  at: LonLat;
  /** Position of the point in the zone or the route. */
  index: number;
}

/** Points that can be dragged. The radius one stays at the heading where the person left it. */
export function handlesOf(draft: GeofenceDraft, radiusBearing: number): Handle[] {
  if (draft.shape === "circle") {
    if (!draft.center) return [];
    return [
      { role: "center", at: draft.center, index: 0 },
      { role: "radius", at: offset(draft.center, draft.radiusM, radiusBearing), index: 1 },
    ];
  }
  return pointsOf(draft).map((at, index) => ({ role: "vertex" as const, at, index }));
}

const tidy = (p: LonLat): LonLat => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
export const clampRadius = (meters: number) => Math.min(GEOFENCE_LIMITS.maxRadiusM, Math.max(GEOFENCE_LIMITS.minRadiusM, Math.round(meters)));

/** A tap on the map: places the circle center or adds a point. */
export function withTap(draft: GeofenceDraft, at: LonLat): GeofenceDraft {
  const p = tidy(at);
  if (draft.shape === "circle") return { ...draft, center: p };
  const points = pointsOf(draft);
  if (points.length >= GEOFENCE_LIMITS.maxVertices) return draft;
  return draft.shape === "polygon" ? { ...draft, ring: [...draft.ring, p] } : { ...draft, line: [...draft.line, p] };
}

/** A point dragged to another position. Also returns the heading of the radius point. */
export function withDrag(draft: GeofenceDraft, handle: Pick<Handle, "role" | "index">, at: LonLat): { draft: GeofenceDraft; radiusBearing?: number } {
  const p = tidy(at);
  if (draft.shape === "circle") {
    if (!draft.center) return { draft };
    if (handle.role === "center") return { draft: { ...draft, center: p } };
    return { draft: { ...draft, radiusM: clampRadius(metersBetween(draft.center, p)) }, radiusBearing: bearing(draft.center, p) };
  }
  const replace = (list: LonLat[]) => list.map((q, i) => (i === handle.index ? p : q));
  return { draft: draft.shape === "polygon" ? { ...draft, ring: replace(draft.ring) } : { ...draft, line: replace(draft.line) } };
}

/** Removes the last marked point. */
export function withoutLast(draft: GeofenceDraft): GeofenceDraft {
  if (draft.shape === "circle") return { ...draft, center: null };
  return draft.shape === "polygon" ? { ...draft, ring: draft.ring.slice(0, -1) } : { ...draft, line: draft.line.slice(0, -1) };
}
