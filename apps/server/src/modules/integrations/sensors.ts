// Integrations: sensors that are not a GPS (a temperature probe, a
// door, a scale). Each one sends its readings over HTTP with its own
// key; if one goes out of its range, it becomes an alert on the vehicle it is mounted on.
import { type Language, SENSORS_MAX, type Sensor, type SensorKind, type SensorSeries, type sensorSchema } from "@opengps/shared";
import type { z } from "zod";
import { type Tenant, isUuid } from "../../core/access";
import { audit } from "../../core/audit";
import { recordEvent } from "../../core/events";
import { decimalMark } from "../../core/export/format";
import { type HistoryRange, assertRange } from "../../core/history";
import { type Actor, getVehicle, listVehicles } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { badRequest, notFound } from "../../errors";
import { say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";
import { hashOf, newSecret, prefixOf } from "./keys";

type Deps = Pick<ModuleDeps, "db" | "bus" | "gate" | "config">;
/** Most points a chart carries. */
const SERIES_MAX = 3000;
/** A reading with a time further ahead than this is taken as from now: the sensor's clock is wrong. */
const FUTURE_MS = 10 * 60_000;

interface Row {
  id: string;
  org_id: string;
  name: string;
  kind: SensorKind;
  unit: string | null;
  vehicle_id: string | null;
  min_value: number | null;
  max_value: number | null;
  key_prefix: string;
  last_value: number | null;
  last_at: Date | null;
  alerting: boolean;
}
const COLUMNS = `id, org_id, name, kind, unit, vehicle_id, min_value, max_value, key_prefix, last_value, last_at, alerting`;
const toSensor = (r: Row, vehicleName: string | null): Sensor => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  unit: r.unit,
  vehicleId: r.vehicle_id,
  vehicleName,
  minValue: r.min_value,
  maxValue: r.max_value,
  keyPrefix: r.key_prefix,
  lastValue: r.last_value,
  lastAt: r.last_at?.toISOString() ?? null,
  alerting: r.alerting,
});

/** The account's sensors. Whoever sees only some groups does not see those mounted on other vehicles. */
export async function listSensors(db: Queryable, tenant: Tenant): Promise<Sensor[]> {
  const names = new Map((await listVehicles(db, tenant)).map((v) => [v.id, v.name]));
  const r = await db.query<Row>(`SELECT ${COLUMNS} FROM gps.sensors WHERE org_id = $1 ORDER BY lower(name)`, [tenant.orgId]);
  return r.rows.filter((s) => s.vehicle_id === null || names.has(s.vehicle_id)).map((s) => toSensor(s, s.vehicle_id ? (names.get(s.vehicle_id) ?? null) : null));
}

async function sensorOf(db: Queryable, tenant: Tenant, id: string): Promise<Row> {
  if (!isUuid(id)) throw notFound(say("integrations.errors.sensorNotFound"));
  const r = await db.query<Row>(`SELECT ${COLUMNS} FROM gps.sensors WHERE id = $1 AND org_id = $2`, [id, tenant.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("integrations.errors.sensorNotFound"));
  if (row.vehicle_id) await getVehicle(db, tenant, row.vehicle_id);
  return row;
}

/** Creates a sensor. Returns, this one time, the key with which it sends its readings. */
export async function createSensor(deps: Deps, actor: Actor, data: z.output<typeof sensorSchema>): Promise<{ sensors: Sensor[]; secret: string }> {
  const db = deps.db.core;
  if (data.vehicleId) await getVehicle(db, actor, data.vehicleId);
  const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.sensors WHERE org_id = $1`, [actor.orgId]);
  if ((count.rows[0]?.n ?? 0) >= SENSORS_MAX) throw badRequest(say("integrations.errors.tooManySensors", { max: SENSORS_MAX }));
  const secret = newSecret("sns");
  await db.query(`INSERT INTO gps.sensors (org_id, name, kind, unit, vehicle_id, min_value, max_value, key_prefix, key_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
    actor.orgId,
    data.name,
    data.kind,
    data.unit,
    data.vehicleId,
    data.minValue,
    data.maxValue,
    prefixOf(secret),
    hashOf(secret),
  ]);
  await audit(db, actor, "integrations.sensor.create", "account", actor.orgId, { name: data.name });
  return { sensors: await listSensors(db, actor), secret };
}

export async function updateSensor(deps: Deps, actor: Actor, id: string, data: z.output<typeof sensorSchema>): Promise<Sensor[]> {
  const db = deps.db.core;
  await sensorOf(db, actor, id);
  if (data.vehicleId) await getVehicle(db, actor, data.vehicleId);
  await db.query(`UPDATE gps.sensors SET name = $2, kind = $3, unit = $4, vehicle_id = $5, min_value = $6, max_value = $7 WHERE id = $1`, [id, data.name, data.kind, data.unit, data.vehicleId, data.minValue, data.maxValue]);
  await audit(db, actor, "integrations.sensor.update", "account", actor.orgId, { name: data.name });
  return listSensors(db, actor);
}

/** Changes the sensor's key: the previous one stops working. */
export async function rotateSensorKey(deps: Deps, actor: Actor, id: string): Promise<string> {
  const row = await sensorOf(deps.db.core, actor, id);
  const secret = newSecret("sns");
  await deps.db.core.query(`UPDATE gps.sensors SET key_prefix = $2, key_hash = $3 WHERE id = $1`, [id, prefixOf(secret), hashOf(secret)]);
  await audit(deps.db.core, actor, "integrations.sensor.key", "account", actor.orgId, { name: row.name });
  return secret;
}

export async function deleteSensor(deps: Deps, actor: Actor, id: string): Promise<void> {
  const row = await sensorOf(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.sensors WHERE id = $1`, [id]);
  await audit(deps.db.core, actor, "integrations.sensor.delete", "account", actor.orgId, { name: row.name });
}

/** A sensor's readings over a period, thinned out if there are many. */
export async function sensorSeries(db: Queryable, tenant: Tenant, id: string, range: HistoryRange): Promise<SensorSeries> {
  assertRange(range);
  const row = await sensorOf(db, tenant, id);
  const names = row.vehicle_id ? new Map((await listVehicles(db, tenant)).map((v) => [v.id, v.name])) : new Map<string, string>();
  const r = await db.query<{ at: Date; value: number }>(`SELECT at, value FROM gps.sensor_readings WHERE sensor_id = $1 AND at >= $2 AND at < $3 ORDER BY at`, [id, range.from, range.to]);
  const step = Math.max(1, Math.ceil(r.rows.length / SERIES_MAX));
  const points = r.rows.filter((_, i) => i % step === 0 || i === r.rows.length - 1).map((p): [number, number] => [p.at.getTime(), p.value]);
  return { sensor: toSensor(row, row.vehicle_id ? (names.get(row.vehicle_id) ?? null) : null), points };
}

// ─── What the sensor sends ───────────────────────────────────────────────────

const shown = (value: number, unit: string | null, language: Language) => `${decimalMark(language, Math.round(value * 100) / 100)}${unit ? ` ${unit}` : ""}`;

/**
 * Stores the readings a sensor sends with its key. Returns how many were
 * new, or null if the key belongs to no sensor (or its account no longer has the
 * module).
 */
export async function ingest(deps: Deps, token: string, readings: { value: number; at?: Date | undefined }[], now = Date.now()): Promise<number | null> {
  const db = deps.db.core;
  if (!token.startsWith("sns_") || token.length > 100) return null;
  const found = await db.query<Row>(`SELECT ${COLUMNS} FROM gps.sensors WHERE key_hash = $1`, [hashOf(token)]);
  const sensor = found.rows[0];
  if (!sensor || !(await deps.gate.enabled(sensor.org_id, "I"))) return null;
  const list = readings.map((r) => ({ value: r.value, at: r.at && r.at.getTime() <= now + FUTURE_MS ? r.at : new Date(now) })).sort((a, b) => a.at.getTime() - b.at.getTime());
  const stored = await db.query(
    `INSERT INTO gps.sensor_readings (sensor_id, at, value) SELECT $1, * FROM unnest($2::timestamptz[], $3::float8[]) ON CONFLICT (sensor_id, at) DO NOTHING`,
    [sensor.id, list.map((r) => r.at), list.map((r) => r.value)],
  );
  const last = list[list.length - 1] as { value: number; at: Date };
  // Late readings are stored, but "latest" and the alert come from the most recent reading.
  if (sensor.last_at && last.at.getTime() < sensor.last_at.getTime()) return stored.rowCount ?? 0;
  const low = sensor.min_value !== null && last.value < sensor.min_value;
  const high = sensor.max_value !== null && last.value > sensor.max_value;
  const alerting = low || high;
  await db.query(`UPDATE gps.sensors SET last_value = $2, last_at = $3, alerting = $4 WHERE id = $1`, [sensor.id, last.value, last.at, alerting]);
  // It notifies on leaving the range, not on every reading while it stays out.
  if (alerting && !sensor.alerting && sensor.vehicle_id) {
    const car = await db.query<{ device_id: string; group_id: string | null; lat: number | null; lon: number | null }>(
      `SELECT d.id AS device_id, v.group_id, s.lat, s.lon FROM gps.vehicles v JOIN gps.devices d ON d.vehicle_id = v.id LEFT JOIN gps.device_state s ON s.device_id = d.id WHERE v.id = $1`,
      [sensor.vehicle_id],
    );
    const c = car.rows[0];
    if (c) {
      // Why it is an alert is stored with the event and read later.
      const language = deps.config.defaultLanguage; // i18n: stored text
      const value = shown(last.value, sensor.unit, language);
      const reason = high
        ? tr(language, "integrations.sensors.aboveMax", { value, max: shown(sensor.max_value as number, sensor.unit, language) })
        : tr(language, "integrations.sensors.belowMin", { value, min: shown(sensor.min_value as number, sensor.unit, language) });
      await recordEvent(
        deps,
        { orgId: sensor.org_id, vehicleId: sensor.vehicle_id, deviceId: Number(c.device_id), groupId: c.group_id },
        { type: "sensor_alert", at: last.at.getTime(), lat: c.lat, lon: c.lon, speedKmh: null, detail: { subject: sensor.name, reason, value: last.value } },
      );
    }
  }
  return stored.rowCount ?? 0;
}

/** Readings are kept for a year: anything older is deleted. */
export async function pruneReadings(db: Queryable, now = Date.now()): Promise<void> {
  await db.query(`DELETE FROM gps.sensor_readings WHERE at < $1`, [new Date(now - 366 * 86_400_000)]);
}
