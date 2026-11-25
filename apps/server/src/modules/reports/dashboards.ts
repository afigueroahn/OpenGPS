// Indicator dashboards: each person chooses which indicators they see, in what
// order, for what period and for which group. The data comes from the same calculations
// as the reports.
import { ALERT_EVENTS, DASHBOARDS_MAX, type Dashboard, type DashboardData, type DashboardPeriod, type DashboardTotals, type DashboardWidget, type EventType, type Language, type dashboardSchema } from "@opengps/shared";
import type { z } from "zod";
import type { Tenant } from "../../core/access";
import { type VehicleBlocks, loadBlocks } from "../../core/days";
import { createClock } from "../../core/export/format";
import { type HistoryRange, assertRange } from "../../core/history";
import type { Queryable } from "../../db";
import { conflict, notFound } from "../../errors";
import { say } from "../../i18n";
import { ranking } from "../drivers/driving";
import type { ModuleDeps } from "../context";
import { carsOf, dayKeys, nameOrder } from "./build";

type DashboardInput = z.output<typeof dashboardSchema>;
type Owner = Tenant & { userId: string };

interface Row {
  id: string;
  name: string;
  period: DashboardPeriod;
  group_id: string | null;
  vehicle_ids: string[] | null;
  widgets: DashboardWidget[];
}
const toDashboard = (row: Row): Dashboard => ({ id: row.id, name: row.name, period: row.period, groupId: row.group_id, vehicleIds: row.vehicle_ids, widgets: row.widgets });
const UUID = /^[0-9a-f-]{36}$/i;

export async function listDashboards(db: Queryable, who: Owner): Promise<Dashboard[]> {
  const r = await db.query<Row>(`SELECT id, name, period, group_id, vehicle_ids, widgets FROM gps.dashboards WHERE org_id = $1 AND user_id = $2 ORDER BY created_at, id`, [who.orgId, who.userId]);
  return r.rows.map(toDashboard);
}

export async function createDashboard(db: Queryable, who: Owner, data: DashboardInput): Promise<Dashboard> {
  if (data.groupId || data.vehicleIds) await carsOf(db, who, { groupId: data.groupId, vehicleIds: data.vehicleIds });
  const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.dashboards WHERE org_id = $1 AND user_id = $2`, [who.orgId, who.userId]);
  if ((count.rows[0]?.n ?? 0) >= DASHBOARDS_MAX) throw conflict("dashboards_limit", say("reports.errors.dashboardsLimit", { max: DASHBOARDS_MAX }));
  const r = await db.query<Row>(
    `INSERT INTO gps.dashboards (org_id, user_id, name, period, group_id, vehicle_ids, widgets) VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7) RETURNING id, name, period, group_id, vehicle_ids, widgets`,
    [who.orgId, who.userId, data.name, data.period, data.groupId, data.vehicleIds, data.widgets],
  );
  return toDashboard(r.rows[0] as Row);
}

export async function updateDashboard(db: Queryable, who: Owner, id: string, data: DashboardInput): Promise<Dashboard> {
  if (!UUID.test(id)) throw notFound(say("reports.errors.dashboardNotFound"));
  if (data.groupId || data.vehicleIds) await carsOf(db, who, { groupId: data.groupId, vehicleIds: data.vehicleIds });
  const r = await db.query<Row>(
    `UPDATE gps.dashboards SET name = $4, period = $5, group_id = $6, vehicle_ids = $7::uuid[], widgets = $8, updated_at = now()
      WHERE id = $1 AND org_id = $2 AND user_id = $3 RETURNING id, name, period, group_id, vehicle_ids, widgets`,
    [id, who.orgId, who.userId, data.name, data.period, data.groupId, data.vehicleIds, data.widgets],
  );
  if (!r.rows[0]) throw notFound(say("reports.errors.dashboardNotFound"));
  return toDashboard(r.rows[0]);
}

export async function deleteDashboard(db: Queryable, who: Owner, id: string): Promise<void> {
  if (!UUID.test(id)) throw notFound(say("reports.errors.dashboardNotFound"));
  const r = await db.query(`DELETE FROM gps.dashboards WHERE id = $1 AND org_id = $2 AND user_id = $3`, [id, who.orgId, who.userId]);
  if (r.rowCount === 0) throw notFound(say("reports.errors.dashboardNotFound"));
}

// ─── Data ────────────────────────────────────────────────────────────────────

const none: VehicleBlocks = { trips: [], stops: [] };

function totalsOf(ids: string[], blocks: Map<string, VehicleBlocks>, alerts: number): DashboardTotals {
  const totals: DashboardTotals = { distanceM: 0, trips: 0, drivingS: 0, idleS: 0, alerts, activeVehicles: 0 };
  for (const id of ids) {
    const data = blocks.get(id) ?? none;
    if (data.trips.length > 0) totals.activeVehicles++;
    for (const t of data.trips) {
      totals.distanceM += t.distanceM;
      totals.trips++;
      totals.drivingS += t.durationS;
      totals.idleS += t.idleS;
    }
    for (const s of data.stops) totals.idleS += s.idleS;
  }
  return totals;
}

/** Everything a dashboard's indicators need from a period. The vehicles go in alphabetical order in the language of whoever reads. */
export async function dashboardData(
  deps: Pick<ModuleDeps, "db" | "gate">,
  tenant: Tenant,
  request: { range: HistoryRange; zone: string; groupId: string | null; vehicleIds?: string[] | null; language: Language; now?: number },
): Promise<DashboardData> {
  const { range } = request;
  const now = request.now ?? Date.now();
  assertRange(range);
  const clock = createClock(request.zone, request.language);
  const db = deps.db.core;
  const vehicleIds = request.vehicleIds ?? null;
  const { cars } = await carsOf(db, tenant, { groupId: request.groupId, vehicleIds });
  const byName = nameOrder(request.language);
  cars.sort((a, b) => byName(a.name, b.name));
  const ids = cars.map((car) => car.id);
  const from = range.from.getTime();
  const span = range.to.getTime() - from;
  const before: HistoryRange = { from: new Date(from - span), to: range.from };

  const blocks = await loadBlocks(db, tenant.orgId, ids, range, now);
  const earlier = await loadBlocks(db, tenant.orgId, ids, before, now);
  const alerts = await db.query<{ type: EventType; day: string; previous: boolean; n: number }>(
    `SELECT e.type, to_char(e.at AT TIME ZONE $6, 'YYYY-MM-DD') AS day, e.at < $3 AS previous, count(*)::int AS n
       FROM gps.events e
      WHERE e.org_id = $1 AND e.vehicle_id = ANY($2::uuid[]) AND e.at >= $4 AND e.at < $5 AND e.type = ANY($7::text[])
      GROUP BY 1, 2, 3`,
    [tenant.orgId, ids, range.from, before.from, range.to, clock.zone, ALERT_EVENTS],
  );

  const days = new Map(dayKeys(clock, from, Math.min(range.to.getTime(), now)).map((date) => [date, { date, distanceM: 0, trips: 0, movingS: 0, idleS: 0, alerts: 0 }]));
  const dayOf = (iso: string) => {
    const date = clock.date(Date.parse(iso));
    if (!days.has(date)) days.set(date, { date, distanceM: 0, trips: 0, movingS: 0, idleS: 0, alerts: 0 });
    return days.get(date) as NonNullable<ReturnType<typeof days.get>>;
  };
  const byVehicle: DashboardData["byVehicle"] = [];
  for (const car of cars) {
    const data = blocks.get(car.id) ?? none;
    const own = { id: car.id, name: car.name, distanceM: 0, drivingS: 0, idleS: 0, trips: 0 };
    for (const t of data.trips) {
      own.distanceM += t.distanceM;
      own.drivingS += t.durationS;
      own.idleS += t.idleS;
      own.trips++;
      const day = dayOf(t.start);
      day.distanceM += t.distanceM;
      day.trips++;
      day.movingS += t.movingS;
      day.idleS += t.idleS;
    }
    for (const s of data.stops) {
      own.idleS += s.idleS;
      dayOf(s.start).idleS += s.idleS;
    }
    byVehicle.push(own);
  }
  const types = new Map<EventType, number>();
  let current = 0;
  let previous = 0;
  for (const row of alerts.rows) {
    if (row.previous) {
      previous += row.n;
      continue;
    }
    current += row.n;
    types.set(row.type, (types.get(row.type) ?? 0) + row.n);
    const day = days.get(row.day);
    if (day) day.alerts += row.n;
  }

  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    vehicles: cars.length,
    totals: totalsOf(ids, blocks, current),
    previous: totalsOf(ids, earlier, previous),
    days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    byVehicle,
    alertTypes: [...types].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    drivers: (await deps.gate.enabled(tenant.orgId, "B")) ? await ranking(db, tenant, range, request.groupId, clock.language, vehicleIds) : null,
  };
}
