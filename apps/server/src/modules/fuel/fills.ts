// Fills: those someone records, those that arrive in a file and those
// the sensor detected. Also the module's settings on the account.
import {
  FUEL_IMPORT_MAX_ROWS,
  type FuelFill,
  type FuelFillSource,
  type FuelImportResult,
  type FuelSettings,
  type Language,
  type fuelFillSchema,
  type fuelImportSchema,
  type fuelSettingsSchema,
  headerKey,
  parseAmount,
  parseCsv,
  parseDateTime,
} from "@opengps/shared";
import type { z } from "zod";
import { type Tenant, isUuid } from "../../core/access";
import { audit } from "../../core/audit";
import { type HistoryRange, assertRange } from "../../core/history";
import { type Actor, getVehicle, listVehicles } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { badRequest, conflict, notFound } from "../../errors";
import { say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";
import { analyzeFuel, tankOf } from "./fuel";

type FillData = z.output<typeof fuelFillSchema>;
type Deps = Pick<ModuleDeps, "db">;

/** A recorded fill and a detected fill are the same if they are less than this apart. */
const MATCH_MS = 3 * 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Settings ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: FuelSettings = { currency: "USD", zone: "UTC" };

export async function getFuelSettings(db: Queryable, orgId: string): Promise<FuelSettings> {
  const r = await db.query<{ currency: string; zone: string }>(`SELECT currency, zone FROM gps.fuel_settings WHERE org_id = $1`, [orgId]);
  const row = r.rows[0];
  return row ? { currency: row.currency, zone: row.zone } : DEFAULT_SETTINGS;
}

export async function saveFuelSettings(deps: Deps, actor: Actor, data: z.output<typeof fuelSettingsSchema>): Promise<FuelSettings> {
  await deps.db.core.query(
    `INSERT INTO gps.fuel_settings (org_id, currency, zone) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET currency = EXCLUDED.currency, zone = EXCLUDED.zone`,
    [actor.orgId, data.currency, data.zone],
  );
  await audit(deps.db.core, actor, "fuel.settings", "account", actor.orgId, { currency: data.currency });
  return getFuelSettings(deps.db.core, actor.orgId);
}

// ─── Fills ───────────────────────────────────────────────────────────────────

interface FillRow {
  id: string;
  vehicle_id: string;
  at: Date;
  liters: number;
  total: string | null;
  currency: string | null;
  odometer_km: number | null;
  station: string | null;
  note: string | null;
  source: FuelFillSource;
}
const COLUMNS = `id, vehicle_id, at, liters, total, currency, odometer_km, station, note, source`;
const toFill = (r: FillRow, detectedL: number | null = null): FuelFill => {
  const total = r.total === null ? null : Number(r.total);
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    at: r.at.toISOString(),
    liters: round1(r.liters),
    detectedL,
    total,
    currency: r.currency,
    pricePerL: total !== null && r.liters > 0 ? round2(total / r.liters) : null,
    odometerKm: r.odometer_km,
    station: r.station,
    note: r.note,
    source: r.source,
  };
};

/**
 * A vehicle's fills over a period, from most recent to
 * oldest: the recorded ones, each with how much the tank rose according to the sensor if
 * that fill was detected, and the detected fills that nobody has recorded.
 */
export async function listFills(deps: Deps, tenant: Tenant, vehicleId: string, range: HistoryRange): Promise<FuelFill[]> {
  assertRange(range);
  const db = deps.db.core;
  await getVehicle(db, tenant, vehicleId);
  const recorded = await db.query<FillRow>(`SELECT ${COLUMNS} FROM gps.fuel_fills WHERE vehicle_id = $1 AND at >= $2 AND at < $3 ORDER BY at`, [vehicleId, range.from, range.to]);
  const tank = await tankOf(db, vehicleId);
  const seen = tank?.attr ? (await analyzeFuel(db, tenant.orgId, vehicleId, tank, range)).fills : [];

  // Each recorded one is matched to the detected fill closest in time, if there is one within reach.
  const taken = new Set<number>();
  const out: FuelFill[] = [];
  for (const row of recorded.rows) {
    let best = -1;
    for (let i = 0; i < seen.length; i++) {
      const gap = Math.abs((seen[i] as { t: number }).t - row.at.getTime());
      if (taken.has(i) || gap > MATCH_MS) continue;
      if (best < 0 || gap < Math.abs((seen[best] as { t: number }).t - row.at.getTime())) best = i;
    }
    if (best >= 0) taken.add(best);
    out.push(toFill(row, best >= 0 ? round1((seen[best] as { l: number }).l) : null));
  }
  seen.forEach((jump, i) => {
    if (taken.has(i)) return;
    out.push({ id: null, vehicleId, at: new Date(jump.t).toISOString(), liters: round1(jump.l), detectedL: round1(jump.l), total: null, currency: null, pricePerL: null, odometerKm: null, station: null, note: null, source: "detected" });
  });
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const repeated = (err: unknown) => (err as { code?: string }).code === "23505";

export async function createFill(deps: Deps, actor: Actor, vehicleId: string, data: FillData): Promise<FuelFill> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  const r = await deps.db.core
    .query<FillRow>(
      `INSERT INTO gps.fuel_fills (org_id, vehicle_id, at, liters, total, currency, odometer_km, station, note, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
      [actor.orgId, vehicleId, data.at, data.liters, data.total, data.currency, data.odometerKm, data.station, data.note, data.source, actor.userId],
    )
    .catch((err: unknown) => {
      if (repeated(err)) throw conflict("fill_repeated", say("fuel.errors.fillRepeated"));
      throw err;
    });
  const fill = toFill(r.rows[0] as FillRow);
  await audit(deps.db.core, actor, "fuel.fill.create", "vehicle", vehicleId, { name: vehicle.name, liters: fill.liters, total: fill.total, currency: fill.currency });
  return fill;
}

async function fillOf(db: Queryable, tenant: Tenant, id: string): Promise<FillRow> {
  if (!isUuid(id)) throw notFound(say("fuel.errors.fillNotFound"));
  const r = await db.query<FillRow>(`SELECT ${COLUMNS} FROM gps.fuel_fills WHERE id = $1 AND org_id = $2`, [id, tenant.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("fuel.errors.fillNotFound"));
  // Whoever does not see the vehicle does not see its fills either.
  await getVehicle(db, tenant, row.vehicle_id);
  return row;
}

export async function updateFill(deps: Deps, actor: Actor, id: string, data: FillData): Promise<FuelFill> {
  const row = await fillOf(deps.db.core, actor, id);
  const r = await deps.db.core
    .query<FillRow>(`UPDATE gps.fuel_fills SET at = $2, liters = $3, total = $4, currency = $5, odometer_km = $6, station = $7, note = $8 WHERE id = $1 RETURNING ${COLUMNS}`, [
      id,
      data.at,
      data.liters,
      data.total,
      data.currency,
      data.odometerKm,
      data.station,
      data.note,
    ])
    .catch((err: unknown) => {
      if (repeated(err)) throw conflict("fill_repeated", say("fuel.errors.fillClash"));
      throw err;
    });
  await audit(deps.db.core, actor, "fuel.fill.update", "vehicle", row.vehicle_id, { liters: data.liters, total: data.total });
  return toFill(r.rows[0] as FillRow);
}

export async function deleteFill(deps: Deps, actor: Actor, id: string): Promise<void> {
  const row = await fillOf(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.fuel_fills WHERE id = $1`, [id]);
  await audit(deps.db.core, actor, "fuel.fill.delete", "vehicle", row.vehicle_id, { liters: row.liters, at: row.at.toISOString() });
}

// ─── Import ──────────────────────────────────────────────────────────────────

/** Names each column may come with, without accents or capitals. */
const COLUMN_NAMES = {
  vehicle: ["vehiculo", "placa", "unidad", "vehicle", "plate"],
  date: ["fecha", "fechayhora", "date", "datetime"],
  time: ["hora", "time"],
  liters: ["litros", "cantidad", "liters", "litres", "volumen"],
  total: ["total", "monto", "importe", "costo", "valor", "amount"],
  currency: ["moneda", "currency"],
  odometer: ["odometro", "kilometraje", "km", "odometer"],
  station: ["estacion", "gasolinera", "proveedor", "station"],
  note: ["nota", "notas", "observaciones", "comentario", "note"],
} as const;
type ColumnKey = keyof typeof COLUMN_NAMES;

/**
 * Records the fills from a CSV file. The first row is the
 * headers; the vehicle (by name or plate), the date and the
 * liters are required. Each row that is not understood is returned with its line number and does not
 * stop the others. What is already recorded is not repeated. What is wrong with
 * each row is written in `language`.
 */
export async function importFills(deps: Deps, actor: Actor, data: z.output<typeof fuelImportSchema>, language: Language): Promise<FuelImportResult> {
  const db = deps.db.core;
  const rows = parseCsv(data.csv);
  const header = rows[0];
  if (!header || rows.length < 2) throw badRequest(say("fuel.import.noRows"));
  if (rows.length - 1 > FUEL_IMPORT_MAX_ROWS) throw badRequest(say("fuel.import.tooManyRows", { max: FUEL_IMPORT_MAX_ROWS }));
  const keys = header.map(headerKey);
  const at = {} as Record<ColumnKey, number>;
  for (const key of Object.keys(COLUMN_NAMES) as ColumnKey[]) at[key] = keys.findIndex((k) => (COLUMN_NAMES[key] as readonly string[]).includes(k));
  const missing = (["vehicle", "date", "liters"] as const).filter((key) => at[key] < 0);
  if (missing.length > 0) {
    throw badRequest(say("fuel.import.missingColumns", { columns: missing.map((m) => tr(language, `fuel.import.column.${m}`)).join(", ") }));
  }

  const settings = await getFuelSettings(db, actor.orgId);
  const byName = new Map<string, string | null>();
  for (const v of await listVehicles(db, actor)) {
    for (const label of [v.name, v.plate]) {
      if (!label) continue;
      const key = headerKey(label);
      // Two vehicles with the same name or plate: which one is meant is not guessed.
      byName.set(key, byName.has(key) && byName.get(key) !== v.id ? null : v.id);
    }
  }

  const result: FuelImportResult = { imported: 0, repeated: 0, errors: [] };
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[];
    const cell = (key: ColumnKey) => (at[key] < 0 ? "" : (row[at[key]] ?? "").trim());
    const fail = (message: string) => result.errors.push({ line: i + 1, message });

    const vehicleId = byName.get(headerKey(cell("vehicle")));
    if (vehicleId === undefined) {
      fail(cell("vehicle") ? tr(language, "fuel.import.unknownVehicle", { name: cell("vehicle") }) : tr(language, "fuel.import.vehicleMissing"));
      continue;
    }
    if (vehicleId === null) {
      fail(tr(language, "fuel.import.ambiguousVehicle", { name: cell("vehicle") }));
      continue;
    }
    const when = parseDateTime([cell("date"), cell("time")].filter(Boolean).join(" "), data.zone);
    if (when === null) {
      fail(tr(language, "fuel.import.badDate", { value: cell("date") }));
      continue;
    }
    if (when > Date.now() + 86_400_000) {
      fail(tr(language, "shared.validation.dateInFuture"));
      continue;
    }
    const liters = parseAmount(cell("liters"));
    if (liters === null || !(liters > 0) || liters > 5000) {
      fail(tr(language, "fuel.import.badLiters", { value: cell("liters") }));
      continue;
    }
    const total = cell("total") === "" ? null : parseAmount(cell("total"));
    if (cell("total") !== "" && (total === null || total < 0)) {
      fail(tr(language, "fuel.import.badTotal", { value: cell("total") }));
      continue;
    }
    const currency = (cell("currency") || settings.currency).toUpperCase();
    if (total !== null && !/^[A-Z]{3}$/.test(currency)) {
      fail(tr(language, "fuel.import.badCurrency", { value: cell("currency") }));
      continue;
    }
    // The odometer is in whole kilometers: a dot or a comma every three digits separates thousands.
    const odometer = cell("odometer") === "" ? null : /^\d{1,3}(?:[.,\s]\d{3})+$/.test(cell("odometer")) ? Number(cell("odometer").replace(/\D/g, "")) : parseAmount(cell("odometer"));
    const saved = await db.query(
      `INSERT INTO gps.fuel_fills (org_id, vehicle_id, at, liters, total, currency, odometer_km, station, note, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'imported', $10)
       ON CONFLICT (vehicle_id, at, liters) DO NOTHING`,
      [actor.orgId, vehicleId, new Date(when), liters, total, total === null ? null : currency, odometer !== null && odometer >= 0 ? odometer : null, cell("station").slice(0, 80) || null, cell("note").slice(0, 200) || null, actor.userId],
    );
    if (saved.rowCount === 0) result.repeated++;
    else result.imported++;
  }
  await audit(db, actor, "fuel.fill.import", "account", actor.orgId, { imported: result.imported, repeated: result.repeated, errors: result.errors.length });
  return result;
}
