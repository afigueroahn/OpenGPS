// Maintenance: work orders with their costs and attachments, and the catalogs
// of workshops and parts.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAINT_FILES_MAX,
  MAINT_FILE_TYPES,
  type MaintOrder,
  type MaintOrderFile,
  type MaintOrderKind,
  type MaintOrderPart,
  type MaintOrderStatus,
  type MaintPart,
  type MaintWorkshop,
  type MaintWorkshopKind,
  type maintFileSchema,
  type maintOrderSchema,
  type maintPartSchema,
  type maintWorkshopSchema,
} from "@opengps/shared";
import type { z } from "zod";
import { type Tenant, isUuid } from "../../core/access";
import { audit } from "../../core/audit";
import { metersOf } from "../../core/meters";
import { type Actor, getVehicle, listVehicles } from "../../core/vehicles";
import { filesFolder } from "../../core/files";
import { type Queryable, withTransaction } from "../../db";
import { badRequest, conflict, notFound } from "../../errors";
import { say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";
import { settingsOf, todayOf } from "./due";

type Deps = Pick<ModuleDeps, "db" | "config">;
const round2 = (n: number) => Math.round(n * 100) / 100;
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "23505";

// ─── Work orders ─────────────────────────────────────────────────────────────

interface OrderRow {
  id: string;
  number: number;
  vehicle_id: string;
  kind: MaintOrderKind;
  status: MaintOrderStatus;
  title: string;
  description: string | null;
  schedule_id: string | null;
  plan_name: string | null;
  workshop_id: string | null;
  workshop_name: string | null;
  opened_on: string;
  done_on: string | null;
  odometer_km: number | null;
  engine_hours: number | null;
  labor_cost: string;
  currency: string;
}
const ORDER_SELECT = `SELECT o.id, o.number, o.vehicle_id, o.kind, o.status, o.title, o.description, o.schedule_id, p.name AS plan_name, o.workshop_id, w.name AS workshop_name,
         o.opened_on::text AS opened_on, o.done_on::text AS done_on, o.odometer_km, o.engine_hours, o.labor_cost, o.currency
    FROM gps.maint_orders o
    LEFT JOIN gps.maint_schedules s ON s.id = o.schedule_id
    LEFT JOIN gps.maint_plans p ON p.id = s.plan_id
    LEFT JOIN gps.maint_workshops w ON w.id = o.workshop_id`;

async function assemble(db: Queryable, rows: OrderRow[], names: Map<string, string>): Promise<MaintOrder[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const parts = await db.query<{ order_id: string; part_id: string | null; name: string; quantity: string; unit_cost: string }>(
    `SELECT order_id, part_id, name, quantity, unit_cost FROM gps.maint_order_parts WHERE order_id = ANY($1::uuid[]) ORDER BY id`,
    [ids],
  );
  const files = await db.query<{ id: string; order_id: string; name: string; mime: string; size: number; created_at: Date }>(
    `SELECT id, order_id, name, mime, size, created_at FROM gps.maint_order_files WHERE order_id = ANY($1::uuid[]) ORDER BY created_at`,
    [ids],
  );
  return rows.map((r) => {
    const own: MaintOrderPart[] = parts.rows.filter((p) => p.order_id === r.id).map((p) => ({ partId: p.part_id, name: p.name, quantity: Number(p.quantity), unitCost: Number(p.unit_cost) }));
    const ownFiles: MaintOrderFile[] = files.rows.filter((f) => f.order_id === r.id).map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, createdAt: f.created_at.toISOString() }));
    const laborCost = Number(r.labor_cost);
    const partsCost = round2(own.reduce((n, p) => n + p.quantity * p.unitCost, 0));
    return {
      id: r.id,
      number: r.number,
      vehicleId: r.vehicle_id,
      vehicleName: names.get(r.vehicle_id) ?? "",
      kind: r.kind,
      status: r.status,
      title: r.title,
      description: r.description,
      scheduleId: r.schedule_id,
      planName: r.plan_name,
      workshopId: r.workshop_id,
      workshopName: r.workshop_name,
      openedOn: r.opened_on,
      doneOn: r.done_on,
      odometerKm: r.odometer_km,
      engineHours: r.engine_hours,
      laborCost,
      partsCost,
      total: round2(laborCost + partsCost),
      currency: r.currency,
      parts: own,
      files: ownFiles,
    };
  });
}

export interface OrderFilter {
  status?: MaintOrderStatus | "pending" | undefined;
  vehicleId?: string | undefined;
  /** Completed between these dates, both inclusive. */
  from?: string | undefined;
  to?: string | undefined;
}

/** The orders of the vehicles the person can see, from most recent to oldest. */
export async function listOrders(db: Queryable, tenant: Tenant, filter: OrderFilter = {}): Promise<MaintOrder[]> {
  const vehicles = filter.vehicleId ? [await getVehicle(db, tenant, filter.vehicleId)] : await listVehicles(db, tenant);
  const names = new Map(vehicles.map((v) => [v.id, v.name]));
  const where = [`o.vehicle_id = ANY($1::uuid[])`];
  const values: unknown[] = [[...names.keys()]];
  if (filter.status === "pending") where.push(`o.status IN ('open', 'in_progress')`);
  else if (filter.status) where.push(`o.status = $${values.push(filter.status)}`);
  if (filter.from) where.push(`o.done_on >= $${values.push(filter.from)}`);
  if (filter.to) where.push(`o.done_on <= $${values.push(filter.to)}`);
  const r = await db.query<OrderRow>(`${ORDER_SELECT} WHERE ${where.join(" AND ")} ORDER BY o.number DESC LIMIT 1000`, values);
  return assemble(db, r.rows, names);
}

async function rowOf(db: Queryable, tenant: Tenant, id: string): Promise<OrderRow> {
  if (!isUuid(id)) throw notFound(say("maintenance.errors.orderNotFound"));
  const r = await db.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1 AND o.org_id = $2`, [id, tenant.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("maintenance.errors.orderNotFound"));
  // Whoever does not see the vehicle does not see its orders either.
  await getVehicle(db, tenant, row.vehicle_id);
  return row;
}

export async function getOrder(db: Queryable, tenant: Tenant, id: string): Promise<MaintOrder> {
  const row = await rowOf(db, tenant, id);
  const vehicle = await getVehicle(db, tenant, row.vehicle_id);
  return (await assemble(db, [row], new Map([[vehicle.id, vehicle.name]])))[0] as MaintOrder;
}

/** What is used of each part is deducted from its stock when the order is completed, and returns if it stops being completed. */
async function moveStock(db: Queryable, orderId: string, sign: 1 | -1): Promise<void> {
  await db.query(
    `UPDATE gps.maint_parts p SET stock = p.stock + $2 * u.quantity
       FROM (SELECT part_id, sum(quantity) AS quantity FROM gps.maint_order_parts WHERE order_id = $1 AND part_id IS NOT NULL GROUP BY part_id) u
      WHERE p.id = u.part_id AND p.stock IS NOT NULL`,
    [orderId, sign],
  );
}

/** Checks that what the order links to belongs to the account and that vehicle, and fills in what is missing when it is completed. */
async function prepare(db: Queryable, actor: Actor, data: z.output<typeof maintOrderSchema>): Promise<z.output<typeof maintOrderSchema>> {
  if (data.scheduleId) {
    const s = await db.query(`SELECT 1 FROM gps.maint_schedules WHERE id = $1 AND org_id = $2 AND vehicle_id = $3`, [data.scheduleId, actor.orgId, data.vehicleId]);
    if (!s.rowCount) throw badRequest(say("maintenance.errors.scheduleOtherVehicle"));
  }
  if (data.workshopId) {
    const w = await db.query(`SELECT 1 FROM gps.maint_workshops WHERE id = $1 AND org_id = $2`, [data.workshopId, actor.orgId]);
    if (!w.rowCount) throw badRequest(say("maintenance.errors.workshopNotFound"));
  }
  const partIds = [...new Set(data.parts.map((p) => p.partId).filter((id): id is string => id !== null))];
  if (partIds.length > 0) {
    const known = await db.query(`SELECT 1 FROM gps.maint_parts WHERE org_id = $1 AND id = ANY($2::uuid[])`, [actor.orgId, partIds]);
    if (known.rowCount !== partIds.length) throw badRequest(say("maintenance.errors.partGone"));
  }
  if (data.status !== "done") return { ...data, doneOn: null };
  // Completed with no further data: today, with the odometer and hours the vehicle has now.
  const meters = (await metersOf(db, [data.vehicleId])).get(data.vehicleId);
  const day = todayOf((await settingsOf(db, actor.orgId)).zone);
  return {
    ...data,
    // Never before it was opened: whoever records it may be a day ahead of the account's clock.
    doneOn: data.doneOn ?? (day < data.openedOn ? data.openedOn : day),
    odometerKm: data.odometerKm ?? (meters ? Math.round(meters.odometerKm) : null),
    engineHours: data.engineHours ?? (meters ? Math.round(meters.engineHours * 10) / 10 : null),
  };
}

async function writeParts(db: Queryable, orderId: string, parts: z.output<typeof maintOrderSchema>["parts"]): Promise<void> {
  await db.query(`DELETE FROM gps.maint_order_parts WHERE order_id = $1`, [orderId]);
  for (const p of parts) await db.query(`INSERT INTO gps.maint_order_parts (order_id, part_id, name, quantity, unit_cost) VALUES ($1, $2, $3, $4, $5)`, [orderId, p.partId, p.name, p.quantity, p.unitCost]);
}

/** When an order for a scheduled service is completed, that service's count starts over from there. */
async function restart(db: Queryable, data: z.output<typeof maintOrderSchema>): Promise<void> {
  if (data.status !== "done" || !data.scheduleId || !data.doneOn) return;
  await db.query(`UPDATE gps.maint_schedules SET last_on = $2, last_km = COALESCE($3, last_km), last_hours = COALESCE($4, last_hours) WHERE id = $1`, [data.scheduleId, data.doneOn, data.odometerKm, data.engineHours]);
}

export async function createOrder(deps: Deps, actor: Actor, input: z.output<typeof maintOrderSchema>): Promise<MaintOrder> {
  const vehicle = await getVehicle(deps.db.core, actor, input.vehicleId);
  const data = await prepare(deps.db.core, actor, input);
  const create = () =>
    withTransaction(deps.db.core, async (client) => {
      const r = await client.query<{ id: string; number: number }>(
        `INSERT INTO gps.maint_orders (org_id, vehicle_id, number, kind, status, title, description, schedule_id, workshop_id, opened_on, done_on, odometer_km, engine_hours, labor_cost, currency, created_by)
         VALUES ($1, $2, (SELECT COALESCE(max(number), 0) + 1 FROM gps.maint_orders WHERE org_id = $1), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id, number`,
        [actor.orgId, data.vehicleId, data.kind, data.status, data.title, data.description, data.scheduleId, data.workshopId, data.openedOn, data.doneOn, data.odometerKm, data.engineHours, data.laborCost, data.currency, actor.userId],
      );
      const created = r.rows[0] as { id: string; number: number };
      await writeParts(client, created.id, data.parts);
      if (data.status === "done") await moveStock(client, created.id, -1);
      await restart(client, data);
      await audit(client, actor, "maintenance.order.create", "vehicle", data.vehicleId, { name: vehicle.name, number: created.number, title: data.title, status: data.status });
      return created.id;
    });
  // Two orders created at the same time may ask for the same number: the second tries again.
  const id = await create().catch((err: unknown) => {
    if (isUniqueViolation(err)) return create();
    throw err;
  });
  return getOrder(deps.db.core, actor, id);
}

export async function updateOrder(deps: Deps, actor: Actor, id: string, input: z.output<typeof maintOrderSchema>): Promise<MaintOrder> {
  const before = await rowOf(deps.db.core, actor, id);
  const vehicle = await getVehicle(deps.db.core, actor, input.vehicleId);
  const data = await prepare(deps.db.core, actor, input);
  await withTransaction(deps.db.core, async (client) => {
    if (before.status === "done") await moveStock(client, id, 1);
    await client.query(
      `UPDATE gps.maint_orders SET vehicle_id = $2, kind = $3, status = $4, title = $5, description = $6, schedule_id = $7, workshop_id = $8, opened_on = $9, done_on = $10, odometer_km = $11, engine_hours = $12, labor_cost = $13, currency = $14 WHERE id = $1`,
      [id, data.vehicleId, data.kind, data.status, data.title, data.description, data.scheduleId, data.workshopId, data.openedOn, data.doneOn, data.odometerKm, data.engineHours, data.laborCost, data.currency],
    );
    await writeParts(client, id, data.parts);
    if (data.status === "done") await moveStock(client, id, -1);
    // Only on moving to completed: correcting an already completed order later does not move the service's count.
    if (before.status !== "done") await restart(client, data);
    await audit(client, actor, "maintenance.order.update", "vehicle", data.vehicleId, { name: vehicle.name, number: before.number, status: data.status });
  });
  return getOrder(deps.db.core, actor, id);
}

const folderOf = (deps: Pick<ModuleDeps, "config">, orgId: string, orderId: string) => filesFolder(deps.config, "maintenance", orgId, orderId);

export async function deleteOrder(deps: Deps, actor: Actor, id: string): Promise<void> {
  const row = await rowOf(deps.db.core, actor, id);
  await withTransaction(deps.db.core, async (client) => {
    if (row.status === "done") await moveStock(client, id, 1);
    await client.query(`DELETE FROM gps.maint_orders WHERE id = $1`, [id]);
    await audit(client, actor, "maintenance.order.delete", "vehicle", row.vehicle_id, { number: row.number, title: row.title });
  });
  await rm(folderOf(deps, actor.orgId, id), { recursive: true, force: true });
}

// ─── Attachments ─────────────────────────────────────────────────────────────

/** `fallback`: the name it gets when its own has nothing usable. */
const cleanName = (name: string, fallback: string) =>
  name
    .replace(/[/\\]/g, " ")
    // oxlint-disable-next-line no-control-regex -- removed on purpose
    .replace(/[\u0000-\u001F<>:"|?*]/g, "")
    .trim()
    .slice(0, 200) || fallback;

export async function addFile(deps: Deps, actor: Actor, orderId: string, meta: z.output<typeof maintFileSchema>, file: { mime: string; data: Buffer }): Promise<MaintOrder> {
  const db = deps.db.core;
  const order = await rowOf(db, actor, orderId);
  if (!(MAINT_FILE_TYPES as readonly string[]).includes(file.mime)) throw badRequest(say("maintenance.errors.fileType"));
  if (file.data.length === 0) throw badRequest(say("shared.validation.fileEmpty"));
  if (file.data.length > deps.config.maxUploadMb * 1024 * 1024) throw badRequest(say("maintenance.errors.fileTooBig", { mb: deps.config.maxUploadMb }));
  const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.maint_order_files WHERE order_id = $1`, [orderId]);
  if ((count.rows[0]?.n ?? 0) >= MAINT_FILES_MAX) throw badRequest(say("maintenance.errors.tooManyFiles", { max: MAINT_FILES_MAX }));
  // i18n: stored text
  const name = cleanName(meta.name, tr(deps.config.defaultLanguage, "maintenance.files.defaultName"));
  const created = await db.query<{ id: string }>(`INSERT INTO gps.maint_order_files (org_id, order_id, name, mime, size, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [actor.orgId, orderId, name, file.mime, file.data.length, actor.userId]);
  const id = (created.rows[0] as { id: string }).id;
  try {
    await mkdir(folderOf(deps, actor.orgId, orderId), { recursive: true });
    await writeFile(join(folderOf(deps, actor.orgId, orderId), id), file.data);
  } catch (err) {
    // Without the file on disk, the note is useless.
    await db.query(`DELETE FROM gps.maint_order_files WHERE id = $1`, [id]);
    throw err;
  }
  await audit(db, actor, "maintenance.order.file", "vehicle", order.vehicle_id, { number: order.number, file: name });
  return getOrder(db, actor, orderId);
}

async function fileOf(db: Queryable, tenant: Tenant, id: string): Promise<{ id: string; order_id: string; name: string; mime: string }> {
  if (!isUuid(id)) throw notFound(say("maintenance.errors.fileNotFound"));
  const r = await db.query<{ id: string; order_id: string; name: string; mime: string }>(`SELECT id, order_id, name, mime FROM gps.maint_order_files WHERE id = $1 AND org_id = $2`, [id, tenant.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("maintenance.errors.fileNotFound"));
  await rowOf(db, tenant, row.order_id);
  return row;
}

export async function readOrderFile(deps: Deps, tenant: Tenant, id: string): Promise<{ name: string; mime: string; data: Buffer }> {
  const row = await fileOf(deps.db.core, tenant, id);
  const data = await readFile(join(folderOf(deps, tenant.orgId, row.order_id), row.id)).catch(() => null);
  if (!data) throw notFound(say("maintenance.errors.fileMissing"));
  return { name: row.name, mime: row.mime, data };
}

export async function deleteFile(deps: Deps, actor: Actor, id: string): Promise<MaintOrder> {
  const row = await fileOf(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.maint_order_files WHERE id = $1`, [id]);
  await rm(join(folderOf(deps, actor.orgId, row.order_id), row.id), { force: true });
  return getOrder(deps.db.core, actor, row.order_id);
}

/** When an account is deleted, its files are removed from disk. */
export async function dropAccountFiles(deps: Pick<ModuleDeps, "config">, orgId: string): Promise<void> {
  await rm(filesFolder(deps.config, "maintenance", orgId), { recursive: true, force: true });
}

// ─── Workshops and suppliers ─────────────────────────────────────────────────

export async function listWorkshops(db: Queryable, orgId: string): Promise<MaintWorkshop[]> {
  const r = await db.query<{ id: string; name: string; kind: MaintWorkshopKind; contact: string | null; phone: string | null; email: string | null; address: string | null; notes: string | null; orders: number }>(
    `SELECT w.id, w.name, w.kind, w.contact, w.phone, w.email, w.address, w.notes, (SELECT count(*)::int FROM gps.maint_orders o WHERE o.workshop_id = w.id) AS orders
       FROM gps.maint_workshops w WHERE w.org_id = $1 ORDER BY lower(w.name)`,
    [orgId],
  );
  return r.rows;
}

export async function saveWorkshop(deps: Deps, actor: Actor, id: string | null, data: z.output<typeof maintWorkshopSchema>): Promise<MaintWorkshop[]> {
  const db = deps.db.core;
  const values = [data.name, data.kind, data.contact, data.phone, data.email, data.address, data.notes];
  try {
    if (id === null) {
      await db.query(`INSERT INTO gps.maint_workshops (org_id, name, kind, contact, phone, email, address, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [actor.orgId, ...values]);
    } else {
      if (!isUuid(id)) throw notFound(say("maintenance.errors.workshopNotFound"));
      const r = await db.query(`UPDATE gps.maint_workshops SET name = $3, kind = $4, contact = $5, phone = $6, email = $7, address = $8, notes = $9 WHERE id = $1 AND org_id = $2`, [id, actor.orgId, ...values]);
      if (!r.rowCount) throw notFound(say("maintenance.errors.workshopNotFound"));
    }
  } catch (err) {
    throw isUniqueViolation(err) ? conflict("workshop_exists", say("maintenance.errors.workshopExists")) : err;
  }
  await audit(db, actor, id === null ? "maintenance.workshop.create" : "maintenance.workshop.update", "account", actor.orgId, { name: data.name });
  return listWorkshops(db, actor.orgId);
}

export async function deleteWorkshop(deps: Deps, actor: Actor, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound(say("maintenance.errors.workshopNotFound"));
  const r = await deps.db.core.query<{ name: string }>(`DELETE FROM gps.maint_workshops WHERE id = $1 AND org_id = $2 RETURNING name`, [id, actor.orgId]);
  if (!r.rows[0]) throw notFound(say("maintenance.errors.workshopNotFound"));
  await audit(deps.db.core, actor, "maintenance.workshop.delete", "account", actor.orgId, { name: r.rows[0].name });
}

// ─── Parts ───────────────────────────────────────────────────────────────────

export async function listParts(db: Queryable, orgId: string): Promise<MaintPart[]> {
  const r = await db.query<{ id: string; name: string; code: string | null; unit: string; unit_cost: string | null; stock: string | null; notes: string | null; used: string }>(
    `SELECT p.id, p.name, p.code, p.unit, p.unit_cost, p.stock, p.notes,
            COALESCE((SELECT sum(l.quantity) FROM gps.maint_order_parts l JOIN gps.maint_orders o ON o.id = l.order_id WHERE l.part_id = p.id AND o.status = 'done'), 0) AS used
       FROM gps.maint_parts p WHERE p.org_id = $1 ORDER BY lower(p.name)`,
    [orgId],
  );
  return r.rows.map((p) => ({ id: p.id, name: p.name, code: p.code, unit: p.unit, unitCost: p.unit_cost === null ? null : Number(p.unit_cost), stock: p.stock === null ? null : Number(p.stock), notes: p.notes, used: Number(p.used) }));
}

export async function savePart(deps: Deps, actor: Actor, id: string | null, data: z.output<typeof maintPartSchema>): Promise<MaintPart[]> {
  const db = deps.db.core;
  const values = [data.name, data.code, data.unit, data.unitCost, data.stock, data.notes];
  try {
    if (id === null) {
      await db.query(`INSERT INTO gps.maint_parts (org_id, name, code, unit, unit_cost, stock, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [actor.orgId, ...values]);
    } else {
      if (!isUuid(id)) throw notFound(say("maintenance.errors.partNotFound"));
      const r = await db.query(`UPDATE gps.maint_parts SET name = $3, code = $4, unit = $5, unit_cost = $6, stock = $7, notes = $8 WHERE id = $1 AND org_id = $2`, [id, actor.orgId, ...values]);
      if (!r.rowCount) throw notFound(say("maintenance.errors.partNotFound"));
    }
  } catch (err) {
    throw isUniqueViolation(err) ? conflict("part_exists", say("maintenance.errors.partExists")) : err;
  }
  await audit(db, actor, id === null ? "maintenance.part.create" : "maintenance.part.update", "account", actor.orgId, { name: data.name });
  return listParts(db, actor.orgId);
}

export async function deletePart(deps: Deps, actor: Actor, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound(say("maintenance.errors.partNotFound"));
  const r = await deps.db.core.query<{ name: string }>(`DELETE FROM gps.maint_parts WHERE id = $1 AND org_id = $2 RETURNING name`, [id, actor.orgId]);
  if (!r.rows[0]) throw notFound(say("maintenance.errors.partNotFound"));
  await audit(deps.db.core, actor, "maintenance.part.delete", "account", actor.orgId, { name: r.rows[0].name });
}
