// Integrations: moving data in and out via spreadsheets. Exports vehicles,
// drivers and geofences to CSV or Excel, and imports them from a CSV with the
// same columns, to load a fleet at once or move it to another system.
import {
  GEOFENCE_KINDS,
  type GeofenceGeometry,
  type GeofenceKind,
  IMPORT_MAX_ROWS,
  type ImportResult,
  LANGUAGES,
  type Language,
  type LonLat,
  TRANSFER_INFO,
  type TransferFormat,
  type TransferKind,
  createVehicleSchema,
  driverSchema,
  geofenceSchema,
  headerKey,
  parseAmount,
  parseCsv,
  issueSay,
} from "@opengps/shared";
import { render, say, shared, tr } from "../../i18n";
import type texts from "../../locales/es/integrations";
import { type Tenant, wholeAccount } from "../../core/access";
import { CATALOG } from "../../core/catalog";
import { buildXlsx } from "../../core/export/xlsx";
import { createGeofence, listGeofences } from "../../core/geofences";
import { createGroup, listGroups } from "../../core/groups";
import { type Actor, createVehicle, listVehicles, updateVehicle } from "../../core/vehicles";
import { AppError, badRequest, notFound } from "../../errors";
import { createDriver, listDrivers } from "../drivers/drivers";
import type { ModuleDeps } from "../context";

type Deps = Pick<ModuleDeps, "db" | "bus" | "traccar" | "config" | "gate">;
type Table = { header: string[]; rows: (string | number | null)[][] };

type Column = keyof typeof texts.transfer.columns;
const titleOf = (language: Language, column: Column) => tr(language, `integrations.transfer.columns.${column}`);
/**
 * The headers a column is recognized by when importing: its title in every
 * language, then other usual names. A file exported in one language imports in any other.
 */
const accepted = (column: Column, ...others: string[]) => [...new Set([...LANGUAGES.map((l) => headerKey(titleOf(l, column))), ...others])];
const VEHICLE = { name: accepted("name", "vehiculo"), plate: accepted("plate", "matricula"), imei: accepted("imei", "id", "identificador", "uniqueid"), model: accepted("model", "equipo"), group: accepted("group") };
const DRIVER = { name: accepted("name", "conductor"), license: accepted("license"), phone: accepted("phone", "celular"), key: accepted("key", "ibutton"), notes: accepted("notes") };
const GEOFENCE = {
  name: accepted("name"),
  points: accepted("points"),
  width: accepted("width"),
  shape: accepted("shape"),
  lat: accepted("lat", "lat"),
  lon: accepted("lon", "lon", "lng"),
  radius: accepted("radius"),
  kind: accepted("kind", "kind"),
};
/** How a corridor's shape begins, written in any language. */
const CORRIDOR = [...new Set(LANGUAGES.map((l) => headerKey(tr(l, "integrations.transfer.shape.corridor"))))];
/** A geofence's kind by its name in any language, or by its own identifier. */
const KINDS = new Map<string, GeofenceKind>(GEOFENCE_KINDS.flatMap((kind) => [...LANGUAGES.map((l) => [headerKey(tr(l, `shared.geofenceKind.${kind}`)), kind] as const), [kind, kind] as const]));
/** Points of a geofence in one cell: "lat lon; lat lon". */
const pointsText = (points: LonLat[]) => points.map(([lon, lat]) => `${lat} ${lon}`).join("; ");

async function requireKind(deps: Deps, orgId: string, kind: TransferKind): Promise<void> {
  const requires = TRANSFER_INFO[kind].requires;
  if (requires && !(await deps.gate.enabled(orgId, requires))) throw notFound();
}

async function tableOf(deps: Deps, tenant: Tenant, kind: TransferKind, language: Language): Promise<Table> {
  const db = deps.db.core;
  const titles = (...columns: Column[]) => columns.map((c) => titleOf(language, c));
  if (kind === "vehicles") {
    const groups = new Map((await listGroups(db, tenant.orgId)).map((g) => [g.id, g.name]));
    const models = new Map(CATALOG.map((m) => [m.id, `${m.brand} ${m.name}`]));
    return {
      header: titles("name", "plate", "imei", "model", "group", "added"),
      rows: (await listVehicles(db, tenant)).map((v) => [v.name, v.plate, v.device?.uniqueId ?? null, v.device ? (models.get(v.device.modelId) ?? v.device.modelId) : null, v.groupId ? (groups.get(v.groupId) ?? null) : null, v.createdAt.slice(0, 10)]),
    };
  }
  if (kind === "drivers") {
    return {
      header: titles("name", "license", "phone", "key", "notes", "active"),
      rows: (await listDrivers(db, tenant)).map((d) => [d.name, d.license, d.phone, d.keyId, d.notes || null, tr(language, d.active ? "integrations.transfer.yes" : "integrations.transfer.no")]),
    };
  }
  return {
    header: titles("name", "shape", "kind", "lat", "lon", "radius", "width", "points"),
    rows: (await listGeofences(db, tenant)).map((g) => {
      const shape = g.geometry;
      const shapeName = tr(language, `integrations.transfer.shape.${shape.shape}`);
      const kindName = tr(language, `shared.geofenceKind.${g.kind}`);
      if (shape.shape === "circle") return [g.name, shapeName, kindName, shape.center[1], shape.center[0], shape.radiusM, null, null];
      if (shape.shape === "polygon") return [g.name, shapeName, kindName, null, null, null, null, pointsText(shape.ring)];
      return [g.name, shapeName, kindName, null, null, null, shape.widthM, pointsText(shape.line)];
    }),
  };
}

const csvCell = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** A file with the account's vehicles, drivers or geofences, with its titles in `language`. */
export async function exportData(deps: Deps, tenant: Tenant, kind: TransferKind, format: TransferFormat, language: Language): Promise<{ filename: string; mime: string; data: Buffer }> {
  await requireKind(deps, tenant.orgId, kind);
  const table = await tableOf(deps, tenant, kind, language);
  const label = tr(language, `shared.transfer.${kind}`);
  const name = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (format === "xlsx") {
    const widths = table.header.map((h, i) => Math.min(60, Math.max(h.length + 2, ...table.rows.map((r) => String(r[i] ?? "").length + 2))));
    return { filename: `${name}.xlsx`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: buildXlsx([{ name: label, widths, rows: [table.header, ...table.rows] }]) };
  }
  // With the leading mark that tells Excel the text contains accents.
  const text = [table.header, ...table.rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  return { filename: `${name}.csv`, mime: "text/csv; charset=utf-8", data: Buffer.from(`﻿${text}\r\n`, "utf8") };
}

// ─── Import ──────────────────────────────────────────────────────────────────

/** Each row of the file as column → value, with the headers recognized however each person writes them. */
function recordsOf(csv: string): Record<string, string>[] {
  const rows = parseCsv(csv);
  const header = (rows[0] ?? []).map(headerKey);
  if (rows.length < 2) throw badRequest(say("integrations.transfer.noRows"));
  if (rows.length - 1 > IMPORT_MAX_ROWS) throw badRequest(say("integrations.transfer.tooManyRows", { max: IMPORT_MAX_ROWS }));
  return rows.slice(1).map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ""])));
}
/** The value of the first column that exists with one of those headers. */
const pick = (record: Record<string, string>, names: readonly string[]) => {
  for (const name of names) if (record[name]) return record[name] as string;
  return "";
};
/** Why a row could not be saved, said in `language`. */
const messageOf = (err: unknown, language: Language) => (err instanceof AppError ? render(language, err.text) : tr(language, "integrations.transfer.rowFailed"));
/** What is wrong with a row, said in `language`. The shared schemas write the key of their text; zod's own messages come as they are. */
const firstIssue = (error: { issues: readonly object[] }, language: Language) => {
  const issue = error.issues[0] as { message: string; params?: Record<string, unknown> } | undefined;
  const said = issue ? issueSay(issue) : null;
  return said ? render(language, shared(said)) : (issue?.message ?? tr(language, "integrations.transfer.invalidData"));
};

function modelOf(text: string): string | null {
  const key = headerKey(text);
  if (!key) return null;
  const found = CATALOG.find((m) => m.id === text.trim() || headerKey(m.id) === key || headerKey(`${m.brand}${m.name}`) === key || headerKey(m.name) === key || headerKey(m.protocol) === key);
  return found?.id ?? null;
}

async function importVehicles(deps: Deps, actor: Actor, records: Record<string, string>[], language: Language): Promise<ImportResult> {
  const db = deps.db.core;
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };
  const mine = new Set((await listVehicles(db, wholeAccount(actor.orgId))).map((v) => v.device?.uniqueId).filter(Boolean));
  const groups = new Map((await listGroups(db, actor.orgId)).map((g) => [headerKey(g.name), g.id]));
  for (const [i, r] of records.entries()) {
    const row = i + 2;
    const modelText = pick(r, VEHICLE.model);
    const modelId = modelOf(modelText);
    if (!modelId) {
      result.errors.push({ row, message: modelText ? tr(language, "integrations.transfer.unknownModel", { model: modelText }) : tr(language, "integrations.transfer.modelNeeded") });
      continue;
    }
    const parsed = createVehicleSchema.safeParse({ name: pick(r, VEHICLE.name), plate: pick(r, VEHICLE.plate) || null, uniqueId: pick(r, VEHICLE.imei), modelId });
    if (!parsed.success) {
      result.errors.push({ row, message: firstIssue(parsed.error, language) });
      continue;
    }
    if (mine.has(parsed.data.uniqueId)) {
      result.skipped++;
      continue;
    }
    try {
      const vehicle = await createVehicle(deps, actor, parsed.data);
      mine.add(parsed.data.uniqueId);
      result.created++;
      const groupName = pick(r, VEHICLE.group);
      if (groupName) {
        let groupId = groups.get(headerKey(groupName));
        // A group that does not exist is created, if whoever imports can create groups.
        if (!groupId && actor.groups === null) {
          groupId = (await createGroup(deps, actor, groupName.trim().slice(0, 60))).id;
          groups.set(headerKey(groupName), groupId);
        }
        if (groupId) await updateVehicle(deps, actor, vehicle.id, { groupId });
      }
    } catch (err) {
      result.errors.push({ row, message: messageOf(err, language) });
    }
  }
  return result;
}

async function importDrivers(deps: Deps, actor: Actor, records: Record<string, string>[], language: Language): Promise<ImportResult> {
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };
  const known = new Set((await listDrivers(deps.db.core, wholeAccount(actor.orgId))).map((d) => headerKey(d.name)));
  for (const [i, r] of records.entries()) {
    const row = i + 2;
    const parsed = driverSchema.safeParse({ name: pick(r, DRIVER.name), license: pick(r, DRIVER.license) || null, phone: pick(r, DRIVER.phone) || null, keyId: pick(r, DRIVER.key) || null, notes: pick(r, DRIVER.notes) });
    if (!parsed.success) {
      result.errors.push({ row, message: firstIssue(parsed.error, language) });
      continue;
    }
    if (known.has(headerKey(parsed.data.name))) {
      result.skipped++;
      continue;
    }
    try {
      await createDriver(deps, actor, parsed.data);
      known.add(headerKey(parsed.data.name));
      result.created++;
    } catch (err) {
      result.errors.push({ row, message: messageOf(err, language) });
    }
  }
  return result;
}

/** "14.08 -87.2; 14.09 -87.21" → points [lon, lat]. */
function pointsOf(text: string): LonLat[] | null {
  const out: LonLat[] = [];
  for (const part of text.split(/[;|]/)) {
    const nums = part.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (nums.length === 0) continue;
    if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) return null;
    out.push([nums[1] as number, nums[0] as number]);
  }
  return out;
}

async function importGeofences(deps: Deps, actor: Actor, records: Record<string, string>[], language: Language): Promise<ImportResult> {
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };
  const known = new Set((await listGeofences(deps.db.core, wholeAccount(actor.orgId))).map((g) => headerKey(g.name)));
  for (const [i, r] of records.entries()) {
    const row = i + 2;
    const name = pick(r, GEOFENCE.name);
    const pointsText = pick(r, GEOFENCE.points);
    let geometry: GeofenceGeometry;
    if (pointsText) {
      const points = pointsOf(pointsText);
      if (!points) {
        result.errors.push({ row, message: tr(language, "integrations.transfer.pointsFormat") });
        continue;
      }
      const width = parseAmount(pick(r, GEOFENCE.width));
      const shape = headerKey(pick(r, GEOFENCE.shape));
      geometry = CORRIDOR.some((c) => shape.startsWith(c)) || width ? { shape: "corridor", line: points, widthM: width ?? 100 } : { shape: "polygon", ring: points };
    } else {
      const lat = Number(pick(r, GEOFENCE.lat).replace(",", "."));
      const lon = Number(pick(r, GEOFENCE.lon).replace(",", "."));
      const radius = parseAmount(pick(r, GEOFENCE.radius));
      if (!pick(r, GEOFENCE.lat) || !Number.isFinite(lat) || !Number.isFinite(lon) || !radius) {
        result.errors.push({ row, message: tr(language, "integrations.transfer.circleOrPoints") });
        continue;
      }
      geometry = { shape: "circle", center: [lon, lat], radiusM: radius };
    }
    const parsed = geofenceSchema.safeParse({ name, geometry, kind: KINDS.get(headerKey(pick(r, GEOFENCE.kind))) ?? "notify" });
    if (!parsed.success) {
      result.errors.push({ row, message: firstIssue(parsed.error, language) });
      continue;
    }
    if (known.has(headerKey(parsed.data.name))) {
      result.skipped++;
      continue;
    }
    try {
      await createGeofence(deps, actor, parsed.data);
      known.add(headerKey(parsed.data.name));
      result.created++;
    } catch (err) {
      result.errors.push({ row, message: messageOf(err, language) });
    }
  }
  return result;
}

/** Loads a CSV file. What already exists is left as it is; what cannot be loaded is reported row by row, in `language`. */
export async function importData(deps: Deps, actor: Actor, kind: TransferKind, csv: string, language: Language): Promise<ImportResult> {
  await requireKind(deps, actor.orgId, kind);
  const records = recordsOf(csv);
  if (kind === "vehicles") return importVehicles(deps, actor, records, language);
  if (kind === "drivers") return importDrivers(deps, actor, records, language);
  return importGeofences(deps, actor, records, language);
}
