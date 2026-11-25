// Fleet: operating expenses, who each vehicle was assigned to, how much each
// one is used and the group tree.
import {
  FLEET_EXPENSE_CATEGORIES,
  type FleetAssignments,
  type FleetExpense,
  type FleetExpenseCategory,
  type FleetExpenses,
  type FleetUsage,
  type FleetUtilization,
  type Language,
  type VehicleGroup,
  type fleetAssignmentSchema,
  type fleetExpenseSchema,
} from "@opengps/shared";
import type { z } from "zod";
import { type Tenant, isUuid, requireUnrestricted } from "../../core/access";
import { audit } from "../../core/audit";
import { loadBlocks } from "../../core/days";
import { decimalMark, numberClock } from "../../core/export/format";
import { listGroups } from "../../core/groups";
import { type HistoryRange, assertRange } from "../../core/history";
import { type Actor, getVehicle, listVehicles } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { badRequest, notFound } from "../../errors";
import { say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";

type Deps = Pick<ModuleDeps, "db" | "gate" | "bus">;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Expenses ────────────────────────────────────────────────────────────────

interface ExpenseRow {
  id: string;
  vehicle_id: string;
  on_date: string;
  category: FleetExpenseCategory;
  amount: string;
  currency: string;
  note: string | null;
}
const EXPENSE_COLUMNS = `id, vehicle_id, on_date::text AS on_date, category, amount, currency, note`;

/**
 * The expenses of a period, from most recent to oldest, with their totals
 * by currency and category. If the account tracks fuel in its module, the
 * fills recorded with their total come in on their own, so they are not entered twice.
 * veces. The notes of what comes from other modules are written in `language`.
 */
export async function listExpenses(
  deps: Deps,
  tenant: Tenant,
  filter: { from: string; to: string; vehicleId?: string | undefined; zone?: string | undefined },
  language: Language,
): Promise<FleetExpenses> {
  const db = deps.db.core;
  if (filter.to < filter.from) throw badRequest(say("shared.validation.endBeforeStart"));
  const vehicles = filter.vehicleId ? [await getVehicle(db, tenant, filter.vehicleId)] : await listVehicles(db, tenant);
  const names = new Map(vehicles.map((v) => [v.id, v.name]));
  const ids = [...names.keys()];
  const own = await db.query<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM gps.fleet_expenses WHERE vehicle_id = ANY($1::uuid[]) AND on_date >= $2 AND on_date <= $3`, [ids, filter.from, filter.to]);
  const items: FleetExpense[] = own.rows.map((r) => ({ id: r.id, vehicleId: r.vehicle_id, vehicleName: names.get(r.vehicle_id) ?? "", date: r.on_date, category: r.category, amount: Number(r.amount), currency: r.currency, note: r.note }));
  if (await deps.gate.enabled(tenant.orgId, "F")) {
    // Each fill's date is that of the requester's clock, so it falls on the same day they see in fuel.
    const fills = await db.query<{ vehicle_id: string; on_date: string; total: string; currency: string; station: string | null; liters: number }>(
      `SELECT vehicle_id, (at AT TIME ZONE $4)::date::text AS on_date, total, currency, station, liters
         FROM gps.fuel_fills
        WHERE vehicle_id = ANY($1::uuid[]) AND total > 0 AND (at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`,
      [ids, filter.from, filter.to, filter.zone ?? "UTC"],
    );
    for (const f of fills.rows) {
      const liters = decimalMark(language, Math.round(f.liters * 10) / 10);
      const note = f.station ? tr(language, "fleet.expenses.fillAt", { liters, station: f.station }) : tr(language, "fleet.expenses.fill", { liters });
      items.push({ id: null, vehicleId: f.vehicle_id, vehicleName: names.get(f.vehicle_id) ?? "", date: f.on_date, category: "fuel", amount: Number(f.total), currency: f.currency, note });
    }
  }
  // And if it tracks maintenance in its module, what each completed work order cost.
  if (await deps.gate.enabled(tenant.orgId, "E")) {
    const orders = await db.query<{ vehicle_id: string; on_date: string; total: string; currency: string; number: number; title: string }>(
      `SELECT o.vehicle_id, o.done_on::text AS on_date, o.currency, o.number, o.title,
              o.labor_cost + COALESCE((SELECT sum(l.quantity * l.unit_cost) FROM gps.maint_order_parts l WHERE l.order_id = o.id), 0) AS total
         FROM gps.maint_orders o
        WHERE o.vehicle_id = ANY($1::uuid[]) AND o.status = 'done' AND o.done_on BETWEEN $2::date AND $3::date`,
      [ids, filter.from, filter.to],
    );
    for (const o of orders.rows) {
      if (Number(o.total) <= 0) continue;
      items.push({ id: null, vehicleId: o.vehicle_id, vehicleName: names.get(o.vehicle_id) ?? "", date: o.on_date, category: "maintenance", amount: round2(Number(o.total)), currency: o.currency, note: tr(language, "fleet.expenses.workOrder", { number: o.number, title: o.title }) });
    }
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.vehicleName.localeCompare(b.vehicleName)));
  const byCurrency = new Map<string, Map<FleetExpenseCategory, number>>();
  for (const item of items) {
    const sums = byCurrency.get(item.currency) ?? new Map<FleetExpenseCategory, number>();
    sums.set(item.category, (sums.get(item.category) ?? 0) + item.amount);
    byCurrency.set(item.currency, sums);
  }
  const totals = [...byCurrency].map(([currency, sums]) => ({
    currency,
    total: round2([...sums.values()].reduce((n, v) => n + v, 0)),
    byCategory: FLEET_EXPENSE_CATEGORIES.filter((c) => sums.has(c)).map((category) => ({ category, total: round2(sums.get(category) as number) })),
  }));
  totals.sort((a, b) => b.total - a.total);
  return { items, totals };
}

const toExpense = (r: ExpenseRow, vehicleName: string): FleetExpense => ({ id: r.id, vehicleId: r.vehicle_id, vehicleName, date: r.on_date, category: r.category, amount: Number(r.amount), currency: r.currency, note: r.note });

export async function createExpense(deps: Deps, actor: Actor, data: z.output<typeof fleetExpenseSchema>): Promise<FleetExpense> {
  const vehicle = await getVehicle(deps.db.core, actor, data.vehicleId);
  const r = await deps.db.core.query<ExpenseRow>(
    `INSERT INTO gps.fleet_expenses (org_id, vehicle_id, on_date, category, amount, currency, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${EXPENSE_COLUMNS}`,
    [actor.orgId, data.vehicleId, data.date, data.category, data.amount, data.currency, data.note, actor.userId],
  );
  await audit(deps.db.core, actor, "fleet.expense.create", "vehicle", data.vehicleId, { name: vehicle.name, category: data.category, amount: data.amount, currency: data.currency });
  return toExpense(r.rows[0] as ExpenseRow, vehicle.name);
}

async function expenseOf(db: Queryable, tenant: Tenant, id: string): Promise<ExpenseRow> {
  if (!isUuid(id)) throw notFound(say("fleet.errors.expenseNotFound"));
  const r = await db.query<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM gps.fleet_expenses WHERE id = $1 AND org_id = $2`, [id, tenant.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("fleet.errors.expenseNotFound"));
  await getVehicle(db, tenant, row.vehicle_id);
  return row;
}

export async function updateExpense(deps: Deps, actor: Actor, id: string, data: z.output<typeof fleetExpenseSchema>): Promise<FleetExpense> {
  await expenseOf(deps.db.core, actor, id);
  const vehicle = await getVehicle(deps.db.core, actor, data.vehicleId);
  const r = await deps.db.core.query<ExpenseRow>(`UPDATE gps.fleet_expenses SET vehicle_id = $2, on_date = $3, category = $4, amount = $5, currency = $6, note = $7 WHERE id = $1 RETURNING ${EXPENSE_COLUMNS}`, [
    id,
    data.vehicleId,
    data.date,
    data.category,
    data.amount,
    data.currency,
    data.note,
  ]);
  await audit(deps.db.core, actor, "fleet.expense.update", "vehicle", data.vehicleId, { name: vehicle.name, category: data.category, amount: data.amount });
  return toExpense(r.rows[0] as ExpenseRow, vehicle.name);
}

export async function deleteExpense(deps: Deps, actor: Actor, id: string): Promise<void> {
  const row = await expenseOf(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.fleet_expenses WHERE id = $1`, [id]);
  await audit(deps.db.core, actor, "fleet.expense.delete", "vehicle", row.vehicle_id, { category: row.category, amount: Number(row.amount), date: row.on_date });
}

// ─── Assignments ─────────────────────────────────────────────────────────────

/**
 * Who the vehicle was assigned to and when, from most recent to
 * oldest. With the drivers module, the history is its own (who actually
 * drove it, by assignment or by their key) and it is changed from there.
 * Its notes are written in `language`.
 */
export async function listAssignments(deps: Deps, tenant: Tenant, vehicleId: string, language: Language): Promise<FleetAssignments> {
  const db = deps.db.core;
  await getVehicle(db, tenant, vehicleId);
  if (await deps.gate.enabled(tenant.orgId, "B")) {
    const r = await db.query<{ id: string; name: string; starts_at: Date; ends_at: Date | null; source: string }>(
      `SELECT a.id::text, d.name, a.starts_at, a.ends_at, a.source FROM gps.driver_assignments a JOIN gps.drivers d ON d.id = a.driver_id WHERE a.vehicle_id = $1 ORDER BY a.starts_at DESC LIMIT 200`,
      [vehicleId],
    );
    return {
      source: "drivers",
      items: r.rows.map((a) => ({ id: a.id, person: a.name, from: a.starts_at.toISOString(), to: a.ends_at?.toISOString() ?? null, note: a.source === "key" ? tr(language, "fleet.assignments.byKey") : null })),
    };
  }
  const r = await db.query<{ id: string; person: string; starts_on: string; ends_on: string | null; note: string | null }>(
    `SELECT id, person, starts_on::text AS starts_on, ends_on::text AS ends_on, note FROM gps.fleet_assignments WHERE vehicle_id = $1 ORDER BY starts_on DESC, ends_on DESC NULLS FIRST LIMIT 200`,
    [vehicleId],
  );
  return { source: "fleet", items: r.rows.map((a) => ({ id: a.id, person: a.person, from: a.starts_on, to: a.ends_on, note: a.note })) };
}

const notWithDrivers = async (deps: Deps, orgId: string) => {
  if (await deps.gate.enabled(orgId, "B")) throw badRequest(say("fleet.errors.assignedInDrivers"));
};

export async function addAssignment(deps: Deps, actor: Actor, vehicleId: string, data: z.output<typeof fleetAssignmentSchema>, language: Language): Promise<FleetAssignments> {
  const db = deps.db.core;
  const vehicle = await getVehicle(db, actor, vehicleId);
  await notWithDrivers(deps, actor.orgId);
  // A vehicle is held by one person at a time: the previous open assignment ends the day before the new one.
  await db.query(`UPDATE gps.fleet_assignments SET ends_on = GREATEST(starts_on, $2::date - 1) WHERE vehicle_id = $1 AND ends_on IS NULL AND starts_on < $2::date`, [vehicleId, data.from]);
  const clash = await db.query(`SELECT 1 FROM gps.fleet_assignments WHERE vehicle_id = $1 AND starts_on <= COALESCE($3::date, 'infinity') AND COALESCE(ends_on, 'infinity') >= $2::date LIMIT 1`, [vehicleId, data.from, data.to]);
  if (clash.rowCount) throw badRequest(say("fleet.errors.alreadyAssigned"));
  await db.query(`INSERT INTO gps.fleet_assignments (org_id, vehicle_id, person, starts_on, ends_on, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [actor.orgId, vehicleId, data.person, data.from, data.to, data.note, actor.userId]);
  await audit(db, actor, "fleet.assign", "vehicle", vehicleId, { name: vehicle.name, person: data.person, from: data.from, to: data.to });
  return listAssignments(deps, actor, vehicleId, language);
}

export async function removeAssignment(deps: Deps, actor: Actor, id: string, language: Language): Promise<FleetAssignments> {
  const db = deps.db.core;
  await notWithDrivers(deps, actor.orgId);
  if (!isUuid(id)) throw notFound(say("fleet.errors.assignmentNotFound"));
  const r = await db.query<{ vehicle_id: string; person: string }>(`SELECT vehicle_id, person FROM gps.fleet_assignments WHERE id = $1 AND org_id = $2`, [id, actor.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("fleet.errors.assignmentNotFound"));
  await getVehicle(db, actor, row.vehicle_id);
  await db.query(`DELETE FROM gps.fleet_assignments WHERE id = $1`, [id]);
  await audit(db, actor, "fleet.unassign", "vehicle", row.vehicle_id, { person: row.person });
  return listAssignments(deps, actor, row.vehicle_id, language);
}

// ─── Utilization ─────────────────────────────────────────────────────────────

/** How much each vehicle was used in the period: distance covered, trip and idle time, and the days it did not go out. */
export async function utilization(deps: Deps, tenant: Tenant, range: HistoryRange, zone: string, now = Date.now()): Promise<FleetUtilization> {
  assertRange(range);
  const db = deps.db.core;
  const vehicles = await listVehicles(db, tenant);
  const blocks = await loadBlocks(db, tenant.orgId, vehicles.map((v) => v.id), range, now);
  const clock = numberClock(zone);
  const until = Math.min(range.to.getTime(), now);
  const days = Math.max(1, Math.ceil((until - range.from.getTime()) / 86_400_000));
  const rows: FleetUsage[] = vehicles.map((v) => {
    const own = blocks.get(v.id);
    const active = new Set<string>();
    let distanceM = 0;
    let tripS = 0;
    let idleS = 0;
    for (const t of own?.trips ?? []) {
      distanceM += t.distanceM;
      tripS += t.durationS;
      idleS += t.idleS;
      active.add(clock.date(Date.parse(t.start)));
    }
    // Engine on during a stop also counts as idling.
    for (const s of own?.stops ?? []) idleS += s.idleS;
    const activeDays = Math.min(days, active.size);
    return { vehicleId: v.id, name: v.name, groupId: v.groupId, distanceM: Math.round(distanceM), tripS: Math.round(tripS), idleS: Math.round(idleS), trips: own?.trips.length ?? 0, activeDays, unusedPercent: Math.round(((days - activeDays) / days) * 100) };
  });
  rows.sort((a, b) => b.tripS - a.tripS || a.name.localeCompare(b.name));
  const sum = (pick: (r: FleetUsage) => number) => rows.reduce((n, r) => n + pick(r), 0);
  return {
    from: range.from.toISOString(),
    to: new Date(until).toISOString(),
    days,
    vehicles: rows,
    totals: {
      distanceM: sum((r) => r.distanceM),
      tripS: sum((r) => r.tripS),
      idleS: sum((r) => r.idleS),
      trips: sum((r) => r.trips),
      unusedPercent: rows.length ? Math.round(sum((r) => r.unusedPercent) / rows.length) : 0,
      withoutUse: rows.filter((r) => r.trips === 0).length,
    },
  };
}

// ─── Group tree ──────────────────────────────────────────────────────────────

/**
 * Hangs a group from another, or leaves it loose. What applies to a group (a
 * person's permission, an alert, a geofence) comes to apply also to
 * those that hang from it.
 */
export async function setGroupParent(deps: Deps, actor: Actor, groupId: string, parentId: string | null): Promise<VehicleGroup[]> {
  const db = deps.db.core;
  // Moving groups changes what each person sees: only whoever sees the whole account.
  requireUnrestricted(actor);
  const groups = await listGroups(db, actor.orgId);
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw notFound(say("fleet.errors.groupNotFound"));
  if (parentId !== null) {
    if (!groups.some((g) => g.id === parentId)) throw notFound(say("fleet.errors.parentNotFound"));
    // A group cannot hang from itself or from one that hangs from it.
    for (let at: string | null = parentId; at !== null; at = groups.find((g) => g.id === at)?.parentId ?? null) {
      if (at === groupId) throw badRequest(say("fleet.errors.groupLoop"));
    }
  }
  await db.query(`UPDATE gps.vehicle_groups SET parent_id = $3 WHERE org_id = $1 AND id = $2`, [actor.orgId, groupId, parentId]);
  await audit(db, actor, "group.move", "group", groupId, { name: group.name, parent: groups.find((g) => g.id === parentId)?.name ?? null });
  // Whoever had permission over a group now sees something else, and the alerts and geofences by group cover other vehicles.
  const scoped = await db.query<{ user_id: string }>(`SELECT user_id FROM gps.member_access WHERE org_id = $1 AND group_scope IS NOT NULL`, [actor.orgId]);
  for (const member of scoped.rows) deps.bus.emit("access_changed", { orgId: actor.orgId, userId: member.user_id });
  deps.bus.emit("alerts_changed", { orgId: actor.orgId });
  deps.bus.emit("geofences_changed", { orgId: actor.orgId });
  return listGroups(db, actor.orgId);
}
