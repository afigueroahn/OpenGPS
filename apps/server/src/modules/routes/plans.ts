// Routes and logistics: the account's points of interest and its planned
// routes, which serve as a template for dispatches.
import { type Poi, type PoiCategory, ROUTE_LINE_MAX, type RoutePlan, type RoutePlanStop, distanceToSegmentM, metersBetween, type poiSchema, type routePlanSchema } from "@opengps/shared";
import type { z } from "zod";
import { type Tenant, isUuid } from "../../core/access";
import { audit } from "../../core/audit";
import { type HistoryRange, loadHistory } from "../../core/history";
import type { Actor } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { badRequest, notFound } from "../../errors";
import { say } from "../../i18n";
import type { ModuleDeps } from "../context";

type Deps = Pick<ModuleDeps, "db">;
export type Line = [number, number][];

/** Length of a path, in meters. */
export const lengthOf = (line: Line) => line.reduce((n, p, i) => (i === 0 ? 0 : n + metersBetween(line[i - 1] as [number, number], p)), 0);

// ─── Points of interest ──────────────────────────────────────────────────────

interface PoiRow {
  id: string;
  name: string;
  category: PoiCategory;
  lat: number;
  lon: number;
  radius_m: number;
  address: string | null;
  phone: string | null;
  notes: string | null;
}
const toPoi = (r: PoiRow): Poi => ({ id: r.id, name: r.name, category: r.category, lat: r.lat, lon: r.lon, radiusM: r.radius_m, address: r.address, phone: r.phone, notes: r.notes });

export async function listPois(db: Queryable, orgId: string): Promise<Poi[]> {
  const r = await db.query<PoiRow>(`SELECT id, name, category, lat, lon, radius_m, address, phone, notes FROM gps.pois WHERE org_id = $1 ORDER BY lower(name)`, [orgId]);
  return r.rows.map(toPoi);
}

export async function savePoi(deps: Deps, actor: Actor, id: string | null, data: z.output<typeof poiSchema>): Promise<Poi[]> {
  const db = deps.db.core;
  const values = [data.name, data.category, data.lat, data.lon, data.radiusM, data.address, data.phone, data.notes];
  if (id === null) {
    await db.query(`INSERT INTO gps.pois (org_id, name, category, lat, lon, radius_m, address, phone, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [actor.orgId, ...values]);
  } else {
    if (!isUuid(id)) throw notFound(say("routes.errors.placeNotFound"));
    const r = await db.query(`UPDATE gps.pois SET name = $3, category = $4, lat = $5, lon = $6, radius_m = $7, address = $8, phone = $9, notes = $10 WHERE id = $1 AND org_id = $2`, [id, actor.orgId, ...values]);
    if (!r.rowCount) throw notFound(say("routes.errors.placeNotFound"));
  }
  await audit(db, actor, id === null ? "routes.poi.create" : "routes.poi.update", "account", actor.orgId, { name: data.name });
  return listPois(db, actor.orgId);
}

export async function deletePoi(deps: Deps, actor: Actor, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound(say("routes.errors.placeNotFound"));
  const r = await deps.db.core.query<{ name: string }>(`DELETE FROM gps.pois WHERE id = $1 AND org_id = $2 RETURNING name`, [id, actor.orgId]);
  if (!r.rows[0]) throw notFound(say("routes.errors.placeNotFound"));
  await audit(deps.db.core, actor, "routes.poi.delete", "account", actor.orgId, { name: r.rows[0].name });
}

/**
 * The name of the point of interest each place falls in, if it falls in one:
 * so reports say "Bodega central" instead of an address.
 */
export async function poiNames(db: Queryable, orgId: string, points: { lat: number; lon: number }[]): Promise<(string | null)[]> {
  if (points.length === 0) return [];
  const pois = await listPois(db, orgId);
  if (pois.length === 0) return points.map(() => null);
  return points.map((p) => {
    let best: { name: string; d: number } | null = null;
    for (const poi of pois) {
      // Discards by latitude before measuring: one degree is about 111 km.
      if (Math.abs(poi.lat - p.lat) * 111_320 > poi.radiusM) continue;
      const d = metersBetween([poi.lon, poi.lat], [p.lon, p.lat]);
      if (d <= poi.radiusM && (!best || d < best.d)) best = { name: poi.name, d };
    }
    return best?.name ?? null;
  });
}

// ─── Planned routes ──────────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  name: string;
  line: Line;
  tolerance_m: number;
  stops: RoutePlanStop[];
  notes: string | null;
}
const toPlan = (r: PlanRow): RoutePlan => ({ id: r.id, name: r.name, line: r.line, toleranceM: r.tolerance_m, lengthM: Math.round(lengthOf(r.line)), notes: r.notes, stops: r.stops });
const PLAN_COLUMNS = `id, name, line, tolerance_m, stops, notes`;

export async function listPlans(db: Queryable, orgId: string): Promise<RoutePlan[]> {
  const r = await db.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM gps.route_plans WHERE org_id = $1 ORDER BY lower(name)`, [orgId]);
  return r.rows.map(toPlan);
}

export async function planOf(db: Queryable, orgId: string, id: string): Promise<RoutePlan> {
  if (!isUuid(id)) throw notFound(say("routes.errors.routeNotFound"));
  const r = await db.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM gps.route_plans WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!r.rows[0]) throw notFound(say("routes.errors.routeNotFound"));
  return toPlan(r.rows[0]);
}

export async function savePlan(deps: Deps, actor: Actor, id: string | null, data: z.output<typeof routePlanSchema>): Promise<RoutePlan[]> {
  const db = deps.db.core;
  if (data.line.length === 1) throw badRequest(say("routes.errors.lineTooShort"));
  const values = [data.name, JSON.stringify(data.line), data.toleranceM, JSON.stringify(data.stops), data.notes];
  if (id === null) {
    await db.query(`INSERT INTO gps.route_plans (org_id, name, line, tolerance_m, stops, notes) VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6)`, [actor.orgId, ...values]);
  } else {
    await planOf(db, actor.orgId, id);
    await db.query(`UPDATE gps.route_plans SET name = $2, line = $3::jsonb, tolerance_m = $4, stops = $5::jsonb, notes = $6 WHERE id = $1`, [id, ...values]);
  }
  await audit(db, actor, id === null ? "routes.plan.create" : "routes.plan.update", "account", actor.orgId, { name: data.name, stops: data.stops.length });
  return listPlans(db, actor.orgId);
}

export async function deletePlan(deps: Deps, actor: Actor, id: string): Promise<void> {
  const plan = await planOf(deps.db.core, actor.orgId, id);
  await deps.db.core.query(`DELETE FROM gps.route_plans WHERE id = $1`, [id]);
  await audit(deps.db.core, actor, "routes.plan.delete", "account", actor.orgId, { name: plan.name });
}

// ─── The path of an actual trip ──────────────────────────────────────────────

/** Removes the points that do not change the drawing of the path by more than `toleranceM` meters. */
export function simplify(line: Line, toleranceM: number): Line {
  if (line.length <= 2) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop() as [number, number];
    let far = -1;
    let max = toleranceM;
    for (let i = from + 1; i < to; i++) {
      const d = distanceToSegmentM(line[i] as [number, number], line[from] as [number, number], line[to] as [number, number]);
      if (d > max) {
        max = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([from, far], [far, to]);
    }
  }
  return line.filter((_, i) => keep[i] === 1);
}

/** The path a vehicle took over a period, thinned out to serve as a route. */
export async function lineFromHistory(db: Queryable, tenant: Tenant, vehicleId: string, range: HistoryRange): Promise<{ line: Line; lengthM: number }> {
  const history = await loadHistory(db, tenant, vehicleId, range, { addresses: false });
  const raw: Line = history.samples.map((s) => [s.lon, s.lat]);
  if (raw.length < 2) throw badRequest(say("routes.errors.noHistory"));
  let tolerance = 12;
  let line = simplify(raw, tolerance);
  while (line.length > ROUTE_LINE_MAX) {
    tolerance *= 2;
    line = simplify(raw, tolerance);
  }
  return { line: line.map(([lon, lat]) => [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]), lengthM: Math.round(lengthOf(line)) };
}
