// Fleet: each vehicle's extended profile, its availability, whether it is
// in service or retired, its documents and its useful life.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FLEET_DOCUMENTS_MAX,
  FLEET_DOCUMENT_TYPES,
  type FleetAvailability,
  type FleetDetail,
  type FleetDocument,
  type FleetDocumentKind,
  type FleetLife,
  type FleetLogEntry,
  type FleetState,
  type FleetStatus,
  type FleetVehicle,
  type Language,
  type Vehicle,
  type fleetDocumentSchema,
  type fleetProfileSchema,
  type fleetStateSchema,
  type fleetStatusSchema,
  vehicleStatus,
} from "@opengps/shared";
import type { z } from "zod";
import { type Tenant, isUuid } from "../../core/access";
import { audit } from "../../core/audit";
import { metersOf } from "../../core/meters";
import { type Actor, getVehicle, listVehicles } from "../../core/vehicles";
import { filesFolder } from "../../core/files";
import type { Queryable } from "../../db";
import { badRequest, notFound } from "../../errors";
import { say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";

type Deps = Pick<ModuleDeps, "db" | "config" | "gate">;

/** An "expiring" document is one that expires within these days, or already expired. */
export const EXPIRING_DAYS = 30;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

interface Row {
  vehicle_id: string;
  vin: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  kind: string | null;
  status: FleetStatus;
  status_note: string | null;
  status_since: Date;
  state: FleetState;
  state_note: string | null;
  state_since: Date;
  purchase_date: string | null;
  purchase_price: string | null;
  currency: string | null;
  salvage_value: string | null;
  life_years: number | null;
  purchase_odo_km: number | null;
  notes: string | null;
}
const COLUMNS = `vehicle_id, vin, brand, model, year, color, kind, status, status_note, status_since, state, state_note, state_since,
  purchase_date::text AS purchase_date, purchase_price, currency, salvage_value, life_years, purchase_odo_km, notes`;

/** Straight-line depreciation and total cost of ownership. `null` if the price, the date or the useful-life years are missing. */
export function lifeOf(
  row: Pick<Row, "purchase_date" | "purchase_price" | "currency" | "salvage_value" | "life_years" | "purchase_odo_km">,
  expenses: number,
  odometerKm: number | null,
  now = Date.now(),
): FleetLife | null {
  if (!row.purchase_date || row.purchase_price === null || !row.currency || !row.life_years) return null;
  const price = Number(row.purchase_price);
  const salvage = Math.min(price, Number(row.salvage_value ?? 0));
  const bought = Date.parse(`${row.purchase_date}T00:00:00Z`);
  const ageYears = Math.max(0, (now - bought) / (365.25 * 86_400_000));
  const perYear = (price - salvage) / row.life_years;
  const depreciated = Math.min(price - salvage, perYear * ageYears);
  const end = new Date(bought);
  end.setUTCMonth(end.getUTCMonth() + Math.round(row.life_years * 12));
  const km = odometerKm !== null && odometerKm - (row.purchase_odo_km ?? 0) > 0 ? odometerKm - (row.purchase_odo_km ?? 0) : null;
  const totalCost = depreciated + expenses;
  return {
    currency: row.currency,
    ageYears: round1(ageYears),
    perYear: round2(perYear),
    depreciated: round2(depreciated),
    bookValue: round2(price - depreciated),
    usedPercent: Math.min(100, Math.round((ageYears / row.life_years) * 100)),
    endsOn: end.toISOString().slice(0, 10),
    expenses: round2(expenses),
    totalCost: round2(totalCost),
    km: km === null ? null : Math.round(km),
    costPerKm: km !== null && km >= 1 ? round2(totalCost / km) : null,
  };
}

const availabilityOf = (status: FleetStatus, vehicle: Vehicle): FleetAvailability => {
  if (status !== "available") return status;
  const live = vehicleStatus(vehicle);
  return live === "moving" || live === "idle" ? "on_route" : "available";
};

/** Who each vehicle is assigned to now: its driver, if the account tracks drivers; otherwise, what is noted in fleet. */
async function assignedNow(deps: Deps, orgId: string, vehicleIds: string[]): Promise<Map<string, string>> {
  const withDrivers = await deps.gate.enabled(orgId, "B");
  const r = withDrivers
    ? await deps.db.core.query<{ vehicle_id: string; person: string }>(
        `SELECT a.vehicle_id, d.name AS person FROM gps.driver_assignments a JOIN gps.drivers d ON d.id = a.driver_id WHERE a.vehicle_id = ANY($1::uuid[]) AND a.ends_at IS NULL`,
        [vehicleIds],
      )
    : await deps.db.core.query<{ vehicle_id: string; person: string }>(
        `SELECT DISTINCT ON (vehicle_id) vehicle_id, person FROM gps.fleet_assignments
          WHERE vehicle_id = ANY($1::uuid[]) AND starts_on <= current_date AND (ends_on IS NULL OR ends_on >= current_date)
          ORDER BY vehicle_id, starts_on DESC`,
        [vehicleIds],
      );
  return new Map(r.rows.map((x) => [x.vehicle_id, x.person]));
}

async function build(deps: Deps, tenant: Tenant, vehicles: Vehicle[]): Promise<FleetVehicle[]> {
  const db = deps.db.core;
  const ids = vehicles.map((v) => v.id);
  if (ids.length === 0) return [];
  const rows = await db.query<Row>(`SELECT ${COLUMNS} FROM gps.fleet_vehicles WHERE vehicle_id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.rows.map((r) => [r.vehicle_id, r]));
  const docs = await db.query<{ vehicle_id: string; total: number; expiring: number; photo: string | null }>(
    `SELECT vehicle_id, count(*) FILTER (WHERE kind <> 'photo')::int AS total,
            count(*) FILTER (WHERE expires_on IS NOT NULL AND expires_on <= current_date + $2::int)::int AS expiring,
            (array_agg(id ORDER BY created_at DESC) FILTER (WHERE kind = 'photo'))[1] AS photo
       FROM gps.fleet_documents WHERE vehicle_id = ANY($1::uuid[]) GROUP BY vehicle_id`,
    [ids, EXPIRING_DAYS],
  );
  const docsOf = new Map(docs.rows.map((d) => [d.vehicle_id, d]));
  // What has been spent on each vehicle since purchase, in the currency it was bought in.
  const spent = await db.query<{ vehicle_id: string; total: number }>(
    `SELECT e.vehicle_id, sum(e.amount)::float8 AS total
       FROM gps.fleet_expenses e JOIN gps.fleet_vehicles f ON f.vehicle_id = e.vehicle_id
      WHERE e.vehicle_id = ANY($1::uuid[]) AND e.currency = f.currency AND (f.purchase_date IS NULL OR e.on_date >= f.purchase_date)
      GROUP BY e.vehicle_id`,
    [ids],
  );
  const spentOf = new Map(spent.rows.map((s) => [s.vehicle_id, s.total]));
  // With the fuel module, what was paid in fills is also a vehicle expense.
  if (await deps.gate.enabled(tenant.orgId, "F")) {
    const fuel = await db.query<{ vehicle_id: string; total: number }>(
      `SELECT l.vehicle_id, sum(l.total)::float8 AS total
         FROM gps.fuel_fills l JOIN gps.fleet_vehicles f ON f.vehicle_id = l.vehicle_id
        WHERE l.vehicle_id = ANY($1::uuid[]) AND l.total > 0 AND l.currency = f.currency AND (f.purchase_date IS NULL OR l.at >= f.purchase_date)
        GROUP BY l.vehicle_id`,
      [ids],
    );
    for (const row of fuel.rows) spentOf.set(row.vehicle_id, (spentOf.get(row.vehicle_id) ?? 0) + row.total);
  }
  // And with the maintenance one, what its completed work orders cost.
  if (await deps.gate.enabled(tenant.orgId, "E")) {
    const work = await db.query<{ vehicle_id: string; total: number }>(
      `SELECT o.vehicle_id, sum(o.labor_cost + COALESCE((SELECT sum(l.quantity * l.unit_cost) FROM gps.maint_order_parts l WHERE l.order_id = o.id), 0))::float8 AS total
         FROM gps.maint_orders o JOIN gps.fleet_vehicles f ON f.vehicle_id = o.vehicle_id
        WHERE o.vehicle_id = ANY($1::uuid[]) AND o.status = 'done' AND o.currency = f.currency AND (f.purchase_date IS NULL OR o.done_on >= f.purchase_date)
        GROUP BY o.vehicle_id`,
      [ids],
    );
    for (const row of work.rows) spentOf.set(row.vehicle_id, (spentOf.get(row.vehicle_id) ?? 0) + row.total);
  }
  const meters = await metersOf(db, ids);
  const assigned = await assignedNow(deps, tenant.orgId, ids);
  const now = new Date();
  return vehicles.map((v) => {
    const r = byId.get(v.id);
    const odometerKm = meters.get(v.id)?.odometerKm ?? null;
    const status = r?.status ?? "available";
    return {
      vehicleId: v.id,
      name: v.name,
      plate: v.plate,
      groupId: v.groupId,
      vin: r?.vin ?? null,
      brand: r?.brand ?? null,
      model: r?.model ?? null,
      year: r?.year ?? null,
      color: r?.color ?? null,
      kind: r?.kind ?? null,
      notes: r?.notes ?? null,
      photoId: docsOf.get(v.id)?.photo ?? null,
      status,
      availability: availabilityOf(status, v),
      statusNote: r?.status_note ?? null,
      statusSince: (r?.status_since ?? new Date(v.createdAt)).toISOString(),
      state: r?.state ?? "active",
      stateNote: r?.state_note ?? null,
      stateSince: (r?.state_since ?? new Date(v.createdAt)).toISOString(),
      purchaseDate: r?.purchase_date ?? null,
      purchasePrice: r?.purchase_price == null ? null : Number(r.purchase_price),
      currency: r?.currency ?? null,
      salvageValue: r?.salvage_value == null ? null : Number(r.salvage_value),
      lifeYears: r?.life_years ?? null,
      purchaseOdometerKm: r?.purchase_odo_km ?? null,
      assignedTo: assigned.get(v.id) ?? null,
      odometerKm,
      documents: docsOf.get(v.id)?.total ?? 0,
      expiring: docsOf.get(v.id)?.expiring ?? 0,
      life: r ? lifeOf(r, spentOf.get(v.id) ?? 0, odometerKm, now.getTime()) : null,
    };
  });
}

/** The fleet this person can see, by name. */
export async function listFleet(deps: Deps, tenant: Tenant): Promise<FleetVehicle[]> {
  return build(deps, tenant, await listVehicles(deps.db.core, tenant));
}

// ─── Documents ───────────────────────────────────────────────────────────────

interface DocRow {
  id: string;
  vehicle_id: string;
  kind: FleetDocumentKind;
  name: string;
  mime: string;
  size: number;
  expires_on: string | null;
  note: string | null;
  created_at: Date;
}
const DOC_COLUMNS = `id, vehicle_id, kind, name, mime, size, expires_on::text AS expires_on, note, created_at`;
const toDoc = (r: DocRow): FleetDocument => ({ id: r.id, vehicleId: r.vehicle_id, kind: r.kind, name: r.name, mime: r.mime, size: r.size, expiresOn: r.expires_on, note: r.note, createdAt: r.created_at.toISOString() });
/** Each vehicle's files go in its folder, inside that of its account. On disk they are named by their identifier. */
const folderOf = (deps: Pick<ModuleDeps, "config">, orgId: string, vehicleId: string) => filesFolder(deps.config, "fleet", orgId, vehicleId);
const cleanName = (name: string, language: Language) =>
  name
    .replace(/[/\\]/g, " ")
    // oxlint-disable-next-line no-control-regex -- removed on purpose
    .replace(/[\u0000-\u001F<>:"|?*]/g, "")
    .trim()
    .slice(0, 120) || tr(language, "fleet.documents.unnamed");

export async function getFleetVehicle(deps: Deps, tenant: Tenant, vehicleId: string): Promise<FleetDetail> {
  const vehicle = await getVehicle(deps.db.core, tenant, vehicleId);
  const [base] = await build(deps, tenant, [vehicle]);
  const log = await deps.db.core.query<{ at: Date; field: "status" | "state"; value: string; note: string | null; user_name: string | null }>(
    `SELECT at, field, value, note, user_name FROM gps.fleet_log WHERE vehicle_id = $1 ORDER BY at DESC LIMIT 50`,
    [vehicleId],
  );
  const docs = await deps.db.core.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM gps.fleet_documents WHERE vehicle_id = $1 ORDER BY (kind = 'photo'), expires_on NULLS LAST, created_at DESC`, [vehicleId]);
  return {
    ...(base as FleetVehicle),
    log: log.rows.map((l): FleetLogEntry => ({ at: l.at.toISOString(), field: l.field, value: l.value, note: l.note, userName: l.user_name })),
    docs: docs.rows.map(toDoc),
  };
}

/** Leaves the vehicle's profile created if it does not have one yet. */
/** The profile is created the first time something is saved; its availability and registration count from when the vehicle exists. */
const ensure = (db: Queryable, orgId: string, vehicleId: string) =>
  db.query(
    `INSERT INTO gps.fleet_vehicles (vehicle_id, org_id, status_since, state_since)
     SELECT v.id, v.org_id, v.created_at, v.created_at FROM gps.vehicles v WHERE v.id = $1 AND v.org_id = $2
     ON CONFLICT (vehicle_id) DO NOTHING`,
    [vehicleId, orgId],
  );

export async function saveProfile(deps: Deps, actor: Actor, vehicleId: string, data: z.output<typeof fleetProfileSchema>): Promise<FleetDetail> {
  const db = deps.db.core;
  const vehicle = await getVehicle(db, actor, vehicleId);
  await ensure(db, actor.orgId, vehicleId);
  await db.query(
    `UPDATE gps.fleet_vehicles SET vin = $2, brand = $3, model = $4, year = $5, color = $6, kind = $7, notes = $8, purchase_date = $9, purchase_price = $10, currency = $11,
            salvage_value = $12, life_years = $13, purchase_odo_km = $14, updated_at = now() WHERE vehicle_id = $1`,
    [vehicleId, data.vin, data.brand, data.model, data.year, data.color, data.kind, data.notes, data.purchaseDate, data.purchasePrice, data.currency, data.salvageValue, data.lifeYears, data.purchaseOdometerKm],
  );
  await audit(db, actor, "fleet.profile", "vehicle", vehicleId, { name: vehicle.name, vin: data.vin, brand: data.brand, model: data.model, year: data.year });
  return getFleetVehicle(deps, actor, vehicleId);
}

async function userName(db: Queryable, userId: string): Promise<string | null> {
  const r = await db.query<{ name: string }>(`SELECT name FROM auth."user" WHERE id = $1`, [userId]);
  return r.rows[0]?.name ?? null;
}

async function setField(deps: Deps, actor: Actor, vehicleId: string, field: "status" | "state", value: string, note: string | null): Promise<FleetDetail> {
  const db = deps.db.core;
  const vehicle = await getVehicle(db, actor, vehicleId);
  await ensure(db, actor.orgId, vehicleId);
  // Column names come from the closed list above, not from the caller.
  const changed = await db.query(`UPDATE gps.fleet_vehicles SET ${field} = $2, ${field}_note = $3, ${field}_since = now(), updated_at = now() WHERE vehicle_id = $1 AND (${field} <> $2 OR ${field}_note IS DISTINCT FROM $3)`, [
    vehicleId,
    value,
    note,
  ]);
  if (changed.rowCount) {
    await db.query(`INSERT INTO gps.fleet_log (org_id, vehicle_id, field, value, note, user_id, user_name) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [actor.orgId, vehicleId, field, value, note, actor.userId, await userName(db, actor.userId)]);
    await audit(db, actor, `fleet.${field}`, "vehicle", vehicleId, { name: vehicle.name, [field]: value, note });
  }
  return getFleetVehicle(deps, actor, vehicleId);
}
export const setStatus = (deps: Deps, actor: Actor, vehicleId: string, data: z.output<typeof fleetStatusSchema>) => setField(deps, actor, vehicleId, "status", data.status, data.note);
export const setState = (deps: Deps, actor: Actor, vehicleId: string, data: z.output<typeof fleetStateSchema>) => setField(deps, actor, vehicleId, "state", data.state, data.note);

export async function addDocument(deps: Deps, actor: Actor, vehicleId: string, meta: z.output<typeof fleetDocumentSchema>, file: { mime: string; data: Buffer }): Promise<FleetDetail> {
  const db = deps.db.core;
  const vehicle = await getVehicle(db, actor, vehicleId);
  if (!(FLEET_DOCUMENT_TYPES as readonly string[]).includes(file.mime)) throw badRequest(say("fleet.errors.fileType"));
  if (meta.kind === "photo" && file.mime === "application/pdf") throw badRequest(say("fleet.errors.photoNotImage"));
  if (file.data.length === 0) throw badRequest(say("shared.validation.fileEmpty"));
  if (file.data.length > deps.config.maxUploadMb * 1024 * 1024) throw badRequest(say("fleet.errors.fileTooBig", { mb: deps.config.maxUploadMb }));
  const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.fleet_documents WHERE vehicle_id = $1`, [vehicleId]);
  if ((count.rows[0]?.n ?? 0) >= FLEET_DOCUMENTS_MAX) throw badRequest(say("fleet.errors.tooManyFiles", { max: FLEET_DOCUMENTS_MAX }));
  const name = cleanName(meta.name, deps.config.defaultLanguage); // i18n: stored text
  const created = await db.query<{ id: string }>(
    `INSERT INTO gps.fleet_documents (org_id, vehicle_id, kind, name, mime, size, expires_on, note, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [actor.orgId, vehicleId, meta.kind, name, file.mime, file.data.length, meta.kind === "photo" ? null : (meta.expiresOn ?? null), meta.note || null, actor.userId],
  );
  const id = (created.rows[0] as { id: string }).id;
  try {
    await mkdir(folderOf(deps, actor.orgId, vehicleId), { recursive: true });
    await writeFile(join(folderOf(deps, actor.orgId, vehicleId), id), file.data);
  } catch (err) {
    // Without the file on disk, the note is useless.
    await db.query(`DELETE FROM gps.fleet_documents WHERE id = $1`, [id]);
    throw err;
  }
  await audit(db, actor, "fleet.document.add", "vehicle", vehicleId, { name: vehicle.name, file: name, kind: meta.kind });
  return getFleetVehicle(deps, actor, vehicleId);
}

async function docOf(db: Queryable, tenant: Tenant, id: string): Promise<DocRow & { org_id: string }> {
  if (!isUuid(id)) throw notFound(say("fleet.errors.documentNotFound"));
  const r = await db.query<DocRow & { org_id: string }>(`SELECT ${DOC_COLUMNS}, org_id FROM gps.fleet_documents WHERE id = $1 AND org_id = $2`, [id, tenant.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("fleet.errors.documentNotFound"));
  // Whoever does not see the vehicle does not see its documents either.
  await getVehicle(db, tenant, row.vehicle_id);
  return row;
}

export async function readDocument(deps: Deps, tenant: Tenant, id: string): Promise<{ name: string; mime: string; data: Buffer }> {
  const row = await docOf(deps.db.core, tenant, id);
  const data = await readFile(join(folderOf(deps, row.org_id, row.vehicle_id), row.id)).catch(() => null);
  if (!data) throw notFound(say("fleet.errors.documentGone"));
  return { name: row.name, mime: row.mime, data };
}

export async function deleteDocument(deps: Deps, actor: Actor, id: string): Promise<FleetDetail> {
  const row = await docOf(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.fleet_documents WHERE id = $1`, [id]);
  await rm(join(folderOf(deps, row.org_id, row.vehicle_id), row.id), { force: true });
  await audit(deps.db.core, actor, "fleet.document.delete", "vehicle", row.vehicle_id, { file: row.name, kind: row.kind });
  return getFleetVehicle(deps, actor, row.vehicle_id);
}

/** When an account is deleted, its files are removed from disk. */
export async function dropAccountFiles(deps: Pick<ModuleDeps, "config">, orgId: string): Promise<void> {
  await rm(filesFolder(deps.config, "fleet", orgId), { recursive: true, force: true });
}

/** Cleanup: deleting a vehicle removes its documents from the database, and here the folders of those that no longer exist are removed from disk. */
export async function pruneFiles(deps: Pick<ModuleDeps, "config" | "db">, orgId: string): Promise<void> {
  const root = filesFolder(deps.config, "fleet", orgId);
  const folders = await readdir(root).catch(() => [] as string[]);
  if (folders.length === 0) return;
  const alive = await deps.db.core.query<{ id: string }>(`SELECT id FROM gps.vehicles WHERE org_id = $1`, [orgId]);
  const known = new Set(alive.rows.map((v) => v.id));
  for (const folder of folders) if (isUuid(folder) && !known.has(folder)) await rm(join(root, folder), { recursive: true, force: true });
}
