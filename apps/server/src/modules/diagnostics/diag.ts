// Diagnostics of a vehicle: what the device reads from it now, its chart over
// a period, its fault codes and the limits above which a notification is sent.
import {
  DIAG_COUNTERS,
  DIAG_LIMITS_DEFAULT,
  DIAG_PARAM_KEYS,
  type DiagFault,
  type DiagLimits,
  type DiagParam,
  type DiagReading,
  type DiagSeries,
  type DiagSettings,
  type DiagStatus,
  type Language,
  type diagLimitsSchema,
  type diagSettingsSchema,
} from "@opengps/shared";
import type { z } from "zod";
import type { Tenant } from "../../core/access";
import { audit } from "../../core/audit";
import { type HistoryRange, MAX_POSITIONS, assertRange } from "../../core/history";
import { getMeters } from "../../core/meters";
import { attrsOf, readParam, unknownAttrs } from "../../core/readings";
import { type Actor, getVehicle } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { badRequest } from "../../errors";
import { say } from "../../i18n";
import type { ModuleDeps } from "../context";
import { describeDtc } from "./dtc";

type Deps = Pick<ModuleDeps, "db">;

/** The latest values are looked up in the positions of these days. */
const LOOKBACK_DAYS = 7;
/** Segments a chart is split into: from each one its minimum and maximum are taken, so peaks are not lost. */
const SERIES_BUCKETS = 300;
const round = (n: number, decimals: number) => Math.round(n * 10 ** decimals) / 10 ** decimals;

// ─── Limits ──────────────────────────────────────────────────────────────────

export async function getDiagSettings(db: Queryable, orgId: string): Promise<DiagSettings> {
  const r = await db.query<{ rpm_max: number | null; temp_max_c: number | null; voltage_min_v: number | null; zone: string }>(
    `SELECT rpm_max, temp_max_c, voltage_min_v, zone FROM gps.diag_settings WHERE org_id = $1`,
    [orgId],
  );
  const row = r.rows[0];
  return row ? { rpmMax: row.rpm_max, tempMaxC: row.temp_max_c, voltageMinV: row.voltage_min_v, zone: row.zone } : { ...DIAG_LIMITS_DEFAULT, zone: "UTC" };
}

async function ownLimits(db: Queryable, vehicleId: string): Promise<Partial<DiagLimits>> {
  const r = await db.query<{ limits: Partial<DiagLimits> }>(`SELECT limits FROM gps.diag_limits WHERE vehicle_id = $1`, [vehicleId]);
  return r.rows[0]?.limits ?? {};
}

/** Current limits of each vehicle, kept for a moment: the watcher asks for them with each position. */
const cache = new Map<string, { at: number; value: DiagLimits & { zone: string } }>();
const CACHE_MS = 30_000;
export const forgetLimits = () => cache.clear();

export async function limitsFor(db: Queryable, orgId: string, vehicleId: string): Promise<DiagLimits & { zone: string }> {
  const hit = cache.get(vehicleId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = { ...(await getDiagSettings(db, orgId)), ...(await ownLimits(db, vehicleId)) };
  cache.set(vehicleId, { at: Date.now(), value });
  return value;
}

/** The minimum battery that is valid for a reading: the limit is for a 12 V system; for a 24 V one it is doubled. */
export const voltageLimit = (limit: number, reading: number) => (reading > 18 && limit < 18 ? limit * 2 : limit);

export async function saveDiagSettings(deps: Deps, actor: Actor, data: z.output<typeof diagSettingsSchema>): Promise<DiagSettings> {
  await deps.db.core.query(
    `INSERT INTO gps.diag_settings (org_id, rpm_max, temp_max_c, voltage_min_v, zone) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id) DO UPDATE SET rpm_max = EXCLUDED.rpm_max, temp_max_c = EXCLUDED.temp_max_c, voltage_min_v = EXCLUDED.voltage_min_v, zone = EXCLUDED.zone`,
    [actor.orgId, data.rpmMax, data.tempMaxC, data.voltageMinV, data.zone],
  );
  forgetLimits();
  await audit(deps.db.core, actor, "diag.settings", "account", actor.orgId, { rpmMax: data.rpmMax, tempMaxC: data.tempMaxC, voltageMinV: data.voltageMinV });
  return getDiagSettings(deps.db.core, actor.orgId);
}

/** Saves a vehicle's own limits: the ones it brings; the ones it does not become the account's again. Answers with its status, described in `language`. */
export async function saveOwnLimits(deps: Deps, actor: Actor, vehicleId: string, data: z.output<typeof diagLimitsSchema>, language: Language): Promise<DiagStatus> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  const own = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
  if (Object.keys(own).length === 0) await deps.db.core.query(`DELETE FROM gps.diag_limits WHERE vehicle_id = $1`, [vehicleId]);
  else {
    await deps.db.core.query(`INSERT INTO gps.diag_limits (vehicle_id, org_id, limits) VALUES ($1, $2, $3::jsonb) ON CONFLICT (vehicle_id) DO UPDATE SET limits = EXCLUDED.limits`, [
      vehicleId,
      actor.orgId,
      JSON.stringify(own),
    ]);
  }
  forgetLimits();
  await audit(deps.db.core, actor, "diag.limits", "vehicle", vehicleId, { name: vehicle.name, ...own });
  return diagStatus(deps, actor, vehicleId, language);
}

// ─── Fault codes ─────────────────────────────────────────────────────────────

interface FaultRow {
  code: string;
  first_seen: Date;
  last_seen: Date;
  cleared_at: Date | null;
}
const toFault = (r: FaultRow, language: Language): DiagFault => ({
  code: r.code,
  ...describeDtc(r.code, language),
  firstSeenAt: r.first_seen.toISOString(),
  lastSeenAt: r.last_seen.toISOString(),
  clearedAt: r.cleared_at?.toISOString() ?? null,
});

/** A vehicle's fault codes, described in `language`: active first, then resolved, from most recent to oldest. */
export async function listFaults(db: Queryable, tenant: Tenant, vehicleId: string, language: Language, limit = 100): Promise<DiagFault[]> {
  await getVehicle(db, tenant, vehicleId);
  const r = await db.query<FaultRow>(`SELECT code, first_seen, last_seen, cleared_at FROM gps.vehicle_faults WHERE vehicle_id = $1 ORDER BY (cleared_at IS NULL) DESC, first_seen DESC LIMIT $2`, [vehicleId, limit]);
  return r.rows.map((row) => toFault(row, language));
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function diagStatus(deps: Deps, tenant: Tenant, vehicleId: string, language: Language): Promise<DiagStatus> {
  const db = deps.db.core;
  await getVehicle(db, tenant, vehicleId);
  const recent = await db.query<{ fix_time: Date; attributes: Record<string, unknown>; protocol: string | null }>(
    `SELECT p.fix_time, p.attributes, p.protocol
       FROM gps.devices d
       JOIN gps.positions p ON p.device_id = d.id
      WHERE d.vehicle_id = $1 AND p.fix_time > now() - make_interval(days => $2)
      ORDER BY p.fix_time DESC
      LIMIT 300`,
    [vehicleId, LOOKBACK_DAYS],
  );
  // For each datum, the most recent one the device has sent: not all come in every position.
  const found = new Map<DiagParam, DiagReading>();
  for (const row of recent.rows) {
    for (const param of DIAG_PARAM_KEYS) {
      if (found.has(param)) continue;
      const value = readParam(param, row.attributes, row.protocol);
      if (value !== null) found.set(param, { param, value, at: row.fix_time.toISOString() });
    }
    if (found.size === DIAG_PARAM_KEYS.length) break;
  }
  const newest = recent.rows[0];
  const settings = await getDiagSettings(db, tenant.orgId);
  const own = await ownLimits(db, vehicleId);
  return {
    readings: DIAG_PARAM_KEYS.flatMap((param) => found.get(param) ?? []),
    faults: await listFaults(db, tenant, vehicleId, language, 30),
    others: newest ? unknownAttrs(newest.attributes, newest.protocol) : [],
    limits: { rpmMax: settings.rpmMax, tempMaxC: settings.tempMaxC, voltageMinV: settings.voltageMinV, ...own },
    own,
    meters: await getMeters(db, tenant, vehicleId),
  };
}

// ─── Chart ───────────────────────────────────────────────────────────────────

/** Leaves at most two points per segment: the lowest and the highest, in their order. This way a brief peak does not disappear. */
export function keepPeaks(points: { t: number; v: number }[], buckets = SERIES_BUCKETS): { t: number; v: number }[] {
  if (points.length <= buckets * 2) return points;
  const out: { t: number; v: number }[] = [];
  const size = points.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const slice = points.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    const first = slice[0];
    if (!first) continue;
    let low = first;
    let high = first;
    for (const p of slice) {
      if (p.v < low.v) low = p;
      if (p.v > high.v) high = p;
    }
    if (low === high) out.push(low);
    else out.push(...(low.t < high.t ? [low, high] : [high, low]));
  }
  return out;
}

export async function diagSeries(deps: Deps, tenant: Tenant, vehicleId: string, param: DiagParam, range: HistoryRange): Promise<DiagSeries> {
  assertRange(range);
  const db = deps.db.core;
  await getVehicle(db, tenant, vehicleId);
  const model = await db.query<{ protocol: string }>(`SELECT m.protocol FROM gps.devices d JOIN gps.device_models m ON m.id = d.model_id WHERE d.vehicle_id = $1`, [vehicleId]);
  const sources = attrsOf(param, model.rows[0]?.protocol ?? null);
  const points: { t: number; v: number }[] = [];
  if (sources.length > 0) {
    // Only the positions that carry that datum, under any of the names it may come with.
    const r = await db.query<{ fix_time: Date; values: unknown[] }>(
      `SELECT p.fix_time, ARRAY(SELECT p.attributes->a FROM unnest($5::text[]) AS a) AS values
         FROM gps.devices d
         JOIN gps.positions p ON p.device_id = d.id
        WHERE d.org_id = $1 AND d.vehicle_id = $2 AND p.fix_time >= $3 AND p.fix_time < $4 AND p.attributes ?| $5::text[]
        ORDER BY p.fix_time
        LIMIT $6`,
      [tenant.orgId, vehicleId, range.from, range.to, sources.map((s) => s.attr), MAX_POSITIONS + 1],
    );
    if (r.rows.length > MAX_POSITIONS) throw badRequest(say("diagnostics.errors.tooManyPositions"), "history_too_large");
    for (const row of r.rows) {
      const i = row.values.findIndex((v) => typeof v === "number" && Number.isFinite(v));
      if (i >= 0) points.push({ t: Math.round(row.fix_time.getTime() / 1000), v: (row.values[i] as number) * (sources[i] as { scale: number }).scale });
    }
  }
  const decimals = param === "deviceBattery" ? 2 : 1;
  const values = points.map((p) => p.v);
  const limits = await limitsFor(db, tenant.orgId, vehicleId);
  const last = values[values.length - 1];
  let limit: number | null = null;
  if (param === "rpm") limit = limits.rpmMax;
  if (param === "coolantTemp") limit = limits.tempMaxC;
  if (param === "power" && limits.voltageMinV !== null) limit = voltageLimit(limits.voltageMinV, last ?? 12);
  // A counter that resets mid-period: only what it advanced is added.
  let delta: number | null = null;
  if (DIAG_COUNTERS.includes(param) && values.length >= 2) {
    delta = 0;
    for (let i = 1; i < values.length; i++) delta += Math.max(0, (values[i] as number) - (values[i - 1] as number));
    delta = round(delta, 1);
  }
  return {
    param,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    points: keepPeaks(points).map((p) => ({ t: p.t, v: round(p.v, decimals) })),
    min: values.length ? round(values.reduce((n, v) => Math.min(n, v), Number.POSITIVE_INFINITY), decimals) : null,
    max: values.length ? round(values.reduce((n, v) => Math.max(n, v), Number.NEGATIVE_INFINITY), decimals) : null,
    avg: values.length ? round(values.reduce((n, v) => n + v, 0) / values.length, decimals) : null,
    delta,
    limit,
  };
}
