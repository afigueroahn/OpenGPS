// What the simulator keeps in the database: its routes and its simulations.
import { type LonLat, type SimRoute, type SimRouteSummary, type SimScenario, type SimSpread, type SimWaypoint, isClosedLine, lineLengthM, type simRouteSchema, simScenarioSchema, type simulationSchema } from "@opengps/shared";
import type { z } from "zod";
import type { Queryable } from "../db";
import type { DeviceMemory } from "./device";

export type SimulationData = z.output<typeof simulationSchema>;
export type RouteData = z.output<typeof simRouteSchema>;

export interface SimulationRow extends Omit<SimulationData, "scenario" | "host" | "port"> {
  id: string;
  /** Null in one saved before its server was written by hand: the platform's own address, and its brand's port. */
  host: string | null;
  port: number | null;
  scenario: SimScenario;
  desired: "running" | "stopped";
  /** Seconds of trip traveled. */
  tripS: number;
  /** What each device remembers, by identifier. */
  state: Record<string, Partial<DeviceMemory>>;
  routeName: string;
}

interface SimulationRecord {
  id: string;
  name: string;
  model_id: string;
  identifiers: string[];
  host: string | null;
  port: number | null;
  interval_s: number;
  route_id: string;
  route_name: string;
  scenario: unknown;
  spread: SimSpread;
  gap_s: number;
  desired: "running" | "stopped";
  trip_s: number;
  state: Record<string, Partial<DeviceMemory>>;
}

const SELECT = `SELECT s.id, s.name, s.model_id, s.identifiers, s.host, s.port, s.interval_s, s.route_id, r.name AS route_name,
                       s.scenario, s.spread, s.gap_s, s.desired, s.trip_s, s.state
                  FROM gps.simulations s
                  JOIN gps.sim_routes r ON r.id = s.route_id`;

const toRow = (r: SimulationRecord): SimulationRow => ({
  id: r.id,
  name: r.name,
  modelId: r.model_id,
  identifiers: r.identifiers,
  host: r.host,
  port: r.port,
  intervalS: r.interval_s,
  routeId: r.route_id,
  routeName: r.route_name,
  // A scenario saved before a field existed takes that field's starting value.
  scenario: simScenarioSchema.parse(r.scenario ?? {}),
  spread: r.spread,
  gapS: r.gap_s,
  desired: r.desired,
  tripS: r.trip_s,
  state: r.state ?? {},
});

export async function listSimulations(db: Queryable): Promise<SimulationRow[]> {
  const r = await db.query<SimulationRecord>(`${SELECT} ORDER BY s.created_at, s.id`);
  return r.rows.map(toRow);
}

export async function getSimulation(db: Queryable, id: string): Promise<SimulationRow | null> {
  const r = await db.query<SimulationRecord>(`${SELECT} WHERE s.id = $1`, [id]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

const values = (data: SimulationData) => [data.name, data.modelId, data.identifiers, data.host, data.port, data.intervalS, data.routeId, JSON.stringify(data.scenario), data.spread, data.gapS];

export async function insertSimulation(db: Queryable, data: SimulationData, userId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO gps.simulations (name, model_id, identifiers, host, port, interval_s, route_id, scenario, spread, gap_s, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11) RETURNING id`,
    [...values(data), userId],
  );
  return (r.rows[0] as { id: string }).id;
}

/** Changing what it simulates starts its trip over: the old progress belongs to another route or another pace. */
export async function updateSimulation(db: Queryable, id: string, data: SimulationData): Promise<boolean> {
  const r = await db.query(
    `UPDATE gps.simulations
        SET name = $1, model_id = $2, identifiers = $3, host = $4, port = $5, interval_s = $6, route_id = $7,
            scenario = $8::jsonb, spread = $9, gap_s = $10, trip_s = 0, state = '{}', updated_at = now()
      WHERE id = $11`,
    [...values(data), id],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function deleteSimulation(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM gps.simulations WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function setDesired(db: Queryable, id: string, desired: "running" | "stopped"): Promise<void> {
  await db.query(`UPDATE gps.simulations SET desired = $2, updated_at = now() WHERE id = $1`, [id, desired]);
}

export async function saveProgress(db: Queryable, id: string, tripS: number, state: Record<string, Partial<DeviceMemory>>): Promise<void> {
  await db.query(`UPDATE gps.simulations SET trip_s = $2, state = $3::jsonb WHERE id = $1`, [id, tripS, JSON.stringify(state)]);
}

/** Of those identifiers, the ones another simulation already uses. */
export async function identifiersInUse(db: Queryable, identifiers: string[], exceptId: string | null): Promise<string[]> {
  const r = await db.query<{ identifier: string }>(
    `SELECT DISTINCT i AS identifier
       FROM gps.simulations s, unnest(s.identifiers) AS i
      WHERE s.identifiers && $1::text[] AND i = ANY($1::text[]) AND ($2::uuid IS NULL OR s.id <> $2)`,
    [identifiers, exceptId],
  );
  return r.rows.map((row) => row.identifier);
}

/** Of those identifiers, the ones added to the platform, with the device each one is. */
export async function registeredDevices(db: Queryable, identifiers: string[]): Promise<Map<string, number>> {
  if (identifiers.length === 0) return new Map();
  const r = await db.query<{ id: number; unique_id: string }>(`SELECT id, unique_id FROM gps.devices WHERE unique_id = ANY($1::text[])`, [identifiers]);
  return new Map(r.rows.map((row) => [row.unique_id, row.id]));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

interface RouteRecord {
  id: string;
  name: string;
  waypoints: SimWaypoint[];
  snapped: boolean;
  line: LonLat[];
  secs: number[] | null;
  length_m: number;
  in_use: number;
}

const ROUTES = `SELECT r.id, r.name, r.waypoints, r.snapped, r.line, r.secs, r.length_m,
                       (SELECT count(*)::int FROM gps.simulations s WHERE s.route_id = r.id) AS in_use
                  FROM gps.sim_routes r`;

const toRoute = (r: RouteRecord): SimRoute => ({
  id: r.id,
  name: r.name,
  lengthM: r.length_m,
  closed: isClosedLine(r.line),
  inUse: r.in_use,
  timed: r.secs !== null,
  waypoints: r.waypoints,
  snapped: r.snapped,
  line: r.line,
  secs: r.secs,
});

export async function listRoutes(db: Queryable): Promise<SimRouteSummary[]> {
  const r = await db.query<RouteRecord>(`${ROUTES} ORDER BY r.name, r.id`);
  return r.rows.map(toRoute).map(({ id, name, lengthM, closed, inUse, timed }) => ({ id, name, lengthM, closed, inUse, timed }));
}

export async function getRoute(db: Queryable, id: string): Promise<SimRoute | null> {
  const r = await db.query<RouteRecord>(`${ROUTES} WHERE r.id = $1`, [id]);
  return r.rows[0] ? toRoute(r.rows[0]) : null;
}

const routeValues = (data: RouteData) => [data.name, JSON.stringify(data.waypoints), data.snapped, JSON.stringify(data.line), data.secs ? JSON.stringify(data.secs) : null, Math.round(lineLengthM(data.line))];

export async function insertRoute(db: Queryable, data: RouteData, userId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO gps.sim_routes (name, waypoints, snapped, line, secs, length_m, created_by)
     VALUES ($1, $2::jsonb, $3, $4::jsonb, $5::jsonb, $6, $7) RETURNING id`,
    [...routeValues(data), userId],
  );
  return (r.rows[0] as { id: string }).id;
}

/** The simulations that travel it start their trip over: where they were belongs to the old path. */
export async function updateRoute(db: Queryable, id: string, data: RouteData): Promise<boolean> {
  const r = await db.query(
    `UPDATE gps.sim_routes SET name = $1, waypoints = $2::jsonb, snapped = $3, line = $4::jsonb, secs = $5::jsonb, length_m = $6, updated_at = now() WHERE id = $7`,
    [...routeValues(data), id],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await db.query(`UPDATE gps.simulations SET trip_s = 0, state = '{}' WHERE route_id = $1`, [id]);
  return true;
}

export async function deleteRoute(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM gps.sim_routes WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}
