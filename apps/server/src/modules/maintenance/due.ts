// Maintenance: service plans, what each vehicle has left until its own
// and the expiries that are monitored.
import {
  type MaintExpiry,
  type MaintExpiryKind,
  type MaintOverview,
  type MaintPlan,
  type MaintSchedule,
  type MaintSettings,
  type MaintTriggers,
  maintDue,
  maintReason,
  type maintBaselineSchema,
  type maintExpirySchema,
  type maintPlanSchema,
  type maintSettingsSchema,
  type Language,
} from "@opengps/shared";
import { render, say, shared } from "../../i18n";
import type { z } from "zod";
import { type Tenant, isUuid } from "../../core/access";
import { audit } from "../../core/audit";
import { numberClock } from "../../core/export/format";
import { metersOf } from "../../core/meters";
import { type Actor, getVehicle, listVehicles } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { notFound } from "../../errors";
import type { ModuleDeps } from "../context";

type Deps = Pick<ModuleDeps, "db" | "gate">;

// ─── Settings ────────────────────────────────────────────────────────────────

export interface StoredSettings extends MaintSettings {
  zone: string;
}
export async function settingsOf(db: Queryable, orgId: string): Promise<StoredSettings> {
  const r = await db.query<{ currency: string; zone: string }>(`SELECT currency, zone FROM gps.maint_settings WHERE org_id = $1`, [orgId]);
  if (r.rows[0]) return r.rows[0];
  // With no settings of its own yet, the time zone the account uses for fuel or diagnostics applies.
  const other = await db.query<{ zone: string; currency: string | null }>(
    `SELECT zone, currency FROM gps.fuel_settings WHERE org_id = $1 UNION ALL SELECT zone, NULL FROM gps.diag_settings WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  return { currency: other.rows[0]?.currency ?? "HNL", zone: other.rows[0]?.zone ?? "UTC" };
}
export async function getSettings(db: Queryable, orgId: string): Promise<MaintSettings> {
  const { currency } = await settingsOf(db, orgId);
  return { currency };
}
export async function saveSettings(deps: Deps, actor: Actor, data: z.output<typeof maintSettingsSchema>): Promise<MaintSettings> {
  await deps.db.core.query(
    `INSERT INTO gps.maint_settings (org_id, currency, zone) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET currency = EXCLUDED.currency, zone = EXCLUDED.zone`,
    [actor.orgId, data.currency, data.zone],
  );
  await audit(deps.db.core, actor, "maintenance.settings", "account", actor.orgId, { currency: data.currency });
  return { currency: data.currency };
}

/** Today's date on the account's clock. */
export const todayOf = (zone: string, now = Date.now()) => numberClock(zone).date(now);

// ─── Plans ───────────────────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  name: string;
  every_km: number | null;
  every_hours: number | null;
  every_days: number | null;
  warn_km: number | null;
  warn_hours: number | null;
  warn_days: number | null;
  notes: string | null;
}
const PLAN_COLUMNS = `id, name, every_km, every_hours, every_days, warn_km, warn_hours, warn_days, notes`;
const triggersOf = (r: PlanRow): MaintTriggers => ({ everyKm: r.every_km, everyHours: r.every_hours, everyDays: r.every_days, warnKm: r.warn_km, warnHours: r.warn_hours, warnDays: r.warn_days });

export async function listPlans(db: Queryable, tenant: Tenant): Promise<MaintPlan[]> {
  const plans = await db.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM gps.maint_plans WHERE org_id = $1 ORDER BY lower(name)`, [tenant.orgId]);
  // Whoever sees only some groups sees only the vehicles of each plan.
  const visible = new Set((await listVehicles(db, tenant)).map((v) => v.id));
  const applied = await db.query<{ plan_id: string; vehicle_id: string }>(`SELECT plan_id, vehicle_id FROM gps.maint_schedules WHERE org_id = $1`, [tenant.orgId]);
  return plans.rows.map((p) => ({ id: p.id, name: p.name, ...triggersOf(p), notes: p.notes, vehicleIds: applied.rows.filter((a) => a.plan_id === p.id && visible.has(a.vehicle_id)).map((a) => a.vehicle_id) }));
}

async function planOf(db: Queryable, orgId: string, id: string): Promise<PlanRow> {
  if (!isUuid(id)) throw notFound(say("maintenance.errors.planNotFound"));
  const r = await db.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM gps.maint_plans WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!r.rows[0]) throw notFound(say("maintenance.errors.planNotFound"));
  return r.rows[0];
}

/**
 * Applies the plan to the given vehicles and removes it from the others the
 * person can see. A vehicle new to the plan is counted from today,
 * with the odometer and hours it has now; it can be corrected afterwards.
 */
async function applyTo(deps: Deps, actor: Actor, planId: string, vehicleIds: string[], zone?: string): Promise<void> {
  const db = deps.db.core;
  const visible = new Set((await listVehicles(db, actor)).map((v) => v.id));
  const wanted = [...new Set(vehicleIds)];
  for (const id of wanted) if (!visible.has(id)) throw notFound(say("maintenance.errors.vehicleNotFound"));
  await db.query(`DELETE FROM gps.maint_schedules WHERE plan_id = $1 AND vehicle_id = ANY($2::uuid[]) AND NOT (vehicle_id = ANY($3::uuid[]))`, [planId, [...visible], wanted]);
  if (wanted.length === 0) return;
  const meters = await metersOf(db, wanted);
  const today = todayOf(zone ?? (await settingsOf(db, actor.orgId)).zone);
  for (const vehicleId of wanted) {
    const m = meters.get(vehicleId);
    await db.query(`INSERT INTO gps.maint_schedules (org_id, plan_id, vehicle_id, last_on, last_km, last_hours) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (plan_id, vehicle_id) DO NOTHING`, [
      actor.orgId,
      planId,
      vehicleId,
      today,
      m?.odometerKm ?? 0,
      m?.engineHours ?? 0,
    ]);
  }
}

const planValues = (data: z.output<typeof maintPlanSchema>) => [data.name, data.everyKm, data.everyHours, data.everyDays, data.warnKm, data.warnHours, data.warnDays, data.notes];

/** `zone`: the clock of whoever does it, so that "today" is their today. */
export async function createPlan(deps: Deps, actor: Actor, data: z.output<typeof maintPlanSchema>, zone?: string): Promise<MaintPlan[]> {
  const db = deps.db.core;
  const r = await db.query<{ id: string }>(
    `INSERT INTO gps.maint_plans (org_id, name, every_km, every_hours, every_days, warn_km, warn_hours, warn_days, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [actor.orgId, ...planValues(data)],
  );
  const id = (r.rows[0] as { id: string }).id;
  await applyTo(deps, actor, id, data.vehicleIds, zone);
  await audit(db, actor, "maintenance.plan.create", "plan", id, { name: data.name, vehicles: data.vehicleIds.length });
  return listPlans(db, actor);
}

export async function updatePlan(deps: Deps, actor: Actor, id: string, data: z.output<typeof maintPlanSchema>, zone?: string): Promise<MaintPlan[]> {
  const db = deps.db.core;
  await planOf(db, actor.orgId, id);
  await db.query(`UPDATE gps.maint_plans SET name = $2, every_km = $3, every_hours = $4, every_days = $5, warn_km = $6, warn_hours = $7, warn_days = $8, notes = $9 WHERE id = $1`, [id, ...planValues(data)]);
  await applyTo(deps, actor, id, data.vehicleIds, zone);
  await audit(db, actor, "maintenance.plan.update", "plan", id, { name: data.name, vehicles: data.vehicleIds.length });
  return listPlans(db, actor);
}

export async function deletePlan(deps: Deps, actor: Actor, id: string): Promise<void> {
  const plan = await planOf(deps.db.core, actor.orgId, id);
  await deps.db.core.query(`DELETE FROM gps.maint_plans WHERE id = $1`, [id]);
  await audit(deps.db.core, actor, "maintenance.plan.delete", "plan", id, { name: plan.name });
}

// ─── What each vehicle has left ──────────────────────────────────────────────

interface ScheduleRow extends PlanRow {
  schedule_id: string;
  vehicle_id: string;
  last_on: string;
  last_km: number | null;
  last_hours: number | null;
  open_order: string | null;
}

/** The scheduled services of some vehicles, with what is left for each; most urgent first. `language`: that of whoever reads why each one is due. */
export async function schedulesOf(db: Queryable, vehicles: { id: string; name: string }[], zone: string, now: number, language: Language): Promise<MaintSchedule[]> {
  if (vehicles.length === 0) return [];
  const ids = vehicles.map((v) => v.id);
  const names = new Map(vehicles.map((v) => [v.id, v.name]));
  const r = await db.query<ScheduleRow>(
    `SELECT s.id AS schedule_id, s.vehicle_id, s.last_on::text AS last_on, s.last_km, s.last_hours,
            p.id, p.name, p.every_km, p.every_hours, p.every_days, p.warn_km, p.warn_hours, p.warn_days, p.notes,
            (SELECT o.id FROM gps.maint_orders o WHERE o.schedule_id = s.id AND o.status IN ('open', 'in_progress') ORDER BY o.number DESC LIMIT 1) AS open_order
       FROM gps.maint_schedules s JOIN gps.maint_plans p ON p.id = s.plan_id
      WHERE s.vehicle_id = ANY($1::uuid[])`,
    [ids],
  );
  const meters = await metersOf(db, ids);
  const today = todayOf(zone, now);
  const order = { due: 0, soon: 1, ok: 2 } as const;
  return r.rows
    .map((row): MaintSchedule => {
      const m = meters.get(row.vehicle_id);
      const plan = triggersOf(row);
      const due = maintDue(plan, { on: row.last_on, km: row.last_km, hours: row.last_hours }, { km: m?.odometerKm ?? 0, hours: m?.engineHours ?? 0, today });
      return {
        id: row.schedule_id,
        planId: row.id,
        planName: row.name,
        vehicleId: row.vehicle_id,
        vehicleName: names.get(row.vehicle_id) ?? "",
        lastOn: row.last_on,
        lastKm: row.last_km,
        lastHours: row.last_hours,
        ...due,
        reason: render(language, shared(maintReason(due, plan, language))),
        openOrderId: row.open_order,
      };
    })
    .sort((a, b) => order[a.status] - order[b.status] || a.vehicleName.localeCompare(b.vehicleName) || a.planName.localeCompare(b.planName));
}

async function scheduleOf(db: Queryable, tenant: Tenant, id: string): Promise<{ id: string; vehicle_id: string; plan_name: string }> {
  if (!isUuid(id)) throw notFound(say("maintenance.errors.scheduleNotFound"));
  const r = await db.query<{ id: string; vehicle_id: string; plan_name: string }>(`SELECT s.id, s.vehicle_id, p.name AS plan_name FROM gps.maint_schedules s JOIN gps.maint_plans p ON p.id = s.plan_id WHERE s.id = $1 AND s.org_id = $2`, [id, tenant.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("maintenance.errors.scheduleNotFound"));
  await getVehicle(db, tenant, row.vehicle_id);
  return row;
}

/** Corrects when the service was last done: it is counted from there. */
export async function setBaseline(deps: Deps, actor: Actor, id: string, data: z.output<typeof maintBaselineSchema>, language: Language, zone?: string): Promise<MaintOverview> {
  const db = deps.db.core;
  const row = await scheduleOf(db, actor, id);
  await db.query(`UPDATE gps.maint_schedules SET last_on = $2, last_km = $3, last_hours = $4 WHERE id = $1`, [id, data.lastOn, data.lastKm, data.lastHours]);
  await audit(db, actor, "maintenance.baseline", "vehicle", row.vehicle_id, { plan: row.plan_name, lastOn: data.lastOn, lastKm: data.lastKm, lastHours: data.lastHours });
  return overview(deps, actor, language, zone);
}

// ─── Expiries ────────────────────────────────────────────────────────────────

const FLEET_KIND: Record<string, MaintExpiryKind> = { registration: "registration", insurance: "insurance", inspection: "inspection", permit: "permit" };
/** How many days in advance a fleet module document is notified. */
const FLEET_WARN_DAYS = 30;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * The expiries of some vehicles; whatever expires soonest first. If the account
 * tracks the fleet in its module, its dated documents are included as well.
 */
export async function expiriesOf(deps: Deps, orgId: string, vehicles: { id: string; name: string }[], zone: string, now = Date.now()): Promise<MaintExpiry[]> {
  if (vehicles.length === 0) return [];
  const db = deps.db.core;
  const ids = vehicles.map((v) => v.id);
  const names = new Map(vehicles.map((v) => [v.id, v.name]));
  const today = todayOf(zone, now);
  const build = (row: { id: string; vehicle_id: string; kind: MaintExpiryKind; name: string | null; expires_on: string; warn_days: number; note: string | null }, source: "own" | "fleet"): MaintExpiry => {
    const daysLeft = daysBetween(today, row.expires_on);
    return {
      id: row.id,
      source,
      vehicleId: row.vehicle_id,
      vehicleName: names.get(row.vehicle_id) ?? "",
      kind: row.kind,
      name: row.name,
      expiresOn: row.expires_on,
      warnDays: row.warn_days,
      daysLeft,
      status: daysLeft < 0 ? "due" : daysLeft <= row.warn_days ? "soon" : "ok",
      note: row.note,
    };
  };
  const own = await db.query<{ id: string; vehicle_id: string; kind: MaintExpiryKind; name: string | null; expires_on: string; warn_days: number; note: string | null }>(
    `SELECT id, vehicle_id, kind, name, expires_on::text AS expires_on, warn_days, note FROM gps.maint_expiries WHERE vehicle_id = ANY($1::uuid[])`,
    [ids],
  );
  const out = own.rows.map((row) => build(row, "own"));
  if (await deps.gate.enabled(orgId, "D")) {
    const docs = await db.query<{ id: string; vehicle_id: string; kind: string; name: string; expires_on: string; note: string | null }>(
      `SELECT id, vehicle_id, kind, name, expires_on::text AS expires_on, note FROM gps.fleet_documents WHERE vehicle_id = ANY($1::uuid[]) AND expires_on IS NOT NULL`,
      [ids],
    );
    for (const d of docs.rows) out.push(build({ ...d, kind: FLEET_KIND[d.kind] ?? "other", warn_days: FLEET_WARN_DAYS }, "fleet"));
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.vehicleName.localeCompare(b.vehicleName));
}

async function expiryOf(db: Queryable, tenant: Tenant, id: string): Promise<{ id: string; vehicle_id: string }> {
  if (!isUuid(id)) throw notFound(say("maintenance.errors.expiryNotFound"));
  const r = await db.query<{ id: string; vehicle_id: string }>(`SELECT id, vehicle_id FROM gps.maint_expiries WHERE id = $1 AND org_id = $2`, [id, tenant.orgId]);
  const row = r.rows[0];
  if (!row) throw notFound(say("maintenance.errors.expiryNotFound"));
  await getVehicle(db, tenant, row.vehicle_id);
  return row;
}

export async function saveExpiry(deps: Deps, actor: Actor, id: string | null, data: z.output<typeof maintExpirySchema>, language: Language, zone?: string): Promise<MaintOverview> {
  const db = deps.db.core;
  const vehicle = await getVehicle(db, actor, data.vehicleId);
  if (id === null) {
    await db.query(`INSERT INTO gps.maint_expiries (org_id, vehicle_id, kind, name, expires_on, warn_days, note) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [actor.orgId, data.vehicleId, data.kind, data.name, data.expiresOn, data.warnDays, data.note]);
  } else {
    await expiryOf(db, actor, id);
    await db.query(`UPDATE gps.maint_expiries SET vehicle_id = $2, kind = $3, name = $4, expires_on = $5, warn_days = $6, note = $7 WHERE id = $1`, [id, data.vehicleId, data.kind, data.name, data.expiresOn, data.warnDays, data.note]);
  }
  await audit(db, actor, id === null ? "maintenance.expiry.create" : "maintenance.expiry.update", "vehicle", data.vehicleId, { name: vehicle.name, kind: data.kind, expiresOn: data.expiresOn });
  return overview(deps, actor, language, zone);
}

export async function deleteExpiry(deps: Deps, actor: Actor, id: string, language: Language, zone?: string): Promise<MaintOverview> {
  const row = await expiryOf(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.maint_expiries WHERE id = $1`, [id]);
  await audit(deps.db.core, actor, "maintenance.expiry.delete", "vehicle", row.vehicle_id, {});
  return overview(deps, actor, language, zone);
}

// ─── Overview ────────────────────────────────────────────────────────────────

/** `language` and `at`: the language and the time zone of whoever is looking, so the days remaining are those of their calendar. */
export async function overview(deps: Deps, tenant: Tenant, language: Language, at?: string, now = Date.now()): Promise<MaintOverview> {
  const db = deps.db.core;
  const vehicles = await listVehicles(db, tenant);
  const zone = at ?? (await settingsOf(db, tenant.orgId)).zone;
  const open = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.maint_orders WHERE vehicle_id = ANY($1::uuid[]) AND status IN ('open', 'in_progress')`, [vehicles.map((v) => v.id)]);
  return { schedules: await schedulesOf(db, vehicles, zone, now, language), expiries: await expiriesOf(deps, tenant.orgId, vehicles, zone, now), openOrders: open.rows[0]?.n ?? 0 };
}
