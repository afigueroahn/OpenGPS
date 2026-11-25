// An account's alerts: the rules that watch the vehicles. Someone who only sees
// some groups only sees the alerts that affect their vehicles, and only changes the
// ones that do not go beyond their groups.
import type { AlertRule, AlertRuleData, Language } from "@opengps/shared";
import type { Bus } from "../bus";
import { type Db, type Queryable, withTransaction } from "../db";
import { badRequest, forbidden, notFound } from "../errors";
import { say, tr } from "../i18n";
import { type Tenant, isUuid, scopeParam, scopeSql } from "./access";
import { audit } from "./audit";
import type { Actor } from "./vehicles";

export interface AlertDeps {
  db: Db;
  bus: Bus;
}

/** Alerts an account can have. */
export const MAX_ALERTS = 200;

interface Row {
  id: string;
  name: string;
  type: AlertRule["type"];
  params: AlertRule["params"];
  schedule: AlertRule["schedule"];
  vehicle_ids: string[] | null;
  group_ids: string[] | null;
  zone: string;
  active: boolean;
  created_at: Date;
}

const toRule = (r: Row): AlertRule =>
  ({
    id: r.id,
    name: r.name,
    type: r.type,
    params: r.params,
    schedule: r.schedule,
    vehicleIds: r.vehicle_ids,
    groupIds: r.group_ids,
    zone: r.zone,
    active: r.active,
    createdAt: r.created_at.toISOString(),
  }) as AlertRule;

/**
 * The basic alerts are created automatically the first time the account
 * needs them. They notify within the platform; who else is told is up to the account's notifications.
 * Their names are stored, written in `language`.
 */
export async function ensureDefaultAlerts(db: Queryable, orgId: string, language: Language): Promise<void> {
  const first = await db.query(
    `INSERT INTO gps.account_settings (org_id, alerts_seeded) VALUES ($1, true)
     ON CONFLICT (org_id) DO UPDATE SET alerts_seeded = true WHERE NOT gps.account_settings.alerts_seeded
     RETURNING 1`,
    [orgId],
  );
  if (first.rowCount === 0) return;
  const defaults: [AlertRule["type"], object][] = [
    ["sos", {}],
    ["power_cut", {}],
    ["tow", {}],
    ["parked_movement", { meters: 150 }],
  ];
  await db.query(
    `INSERT INTO gps.alert_rules (org_id, name, type, params)
     SELECT $1, n, t, p FROM unnest($2::text[], $3::text[], $4::jsonb[]) AS d(n, t, p)`,
    [orgId, defaults.map(([type]) => tr(language, `shared.alertType.${type}`)), defaults.map(([type]) => type), defaults.map(([, params]) => JSON.stringify(params))],
  );
}

/**
 * Scope over table `r`: someone who sees everything sees all of them; someone with a narrower scope sees
 * the account-wide ones, those of their groups and those that watch a vehicle they see.
 */
const VISIBLE = `($2::uuid[] IS NULL
  OR (r.vehicle_ids IS NULL AND (r.group_ids IS NULL OR r.group_ids && $2::uuid[]))
  OR EXISTS (SELECT 1 FROM gps.vehicles v
              WHERE v.org_id = r.org_id AND ${scopeSql(2)}
                AND (v.id = ANY(r.vehicle_ids) OR (r.vehicle_ids IS NULL AND v.group_id = ANY(gps.groups_with_children(r.group_ids))))))`;
const SELECT = `SELECT r.id, r.name, r.type, r.params, r.schedule, r.vehicle_ids, r.group_ids, r.zone, r.active, r.created_at
  FROM gps.alert_rules r WHERE r.org_id = $1 AND ${VISIBLE}`;

/** `seedLanguage` names the basic alerts if this is the first time the account needs them. */
export async function listAlerts(db: Queryable, tenant: Tenant, seedLanguage: Language): Promise<AlertRule[]> {
  await ensureDefaultAlerts(db, tenant.orgId, seedLanguage);
  const r = await db.query<Row>(`${SELECT} ORDER BY r.created_at, r.id`, [tenant.orgId, scopeParam(tenant)]);
  return r.rows.map(toRule);
}

async function getAlert(db: Queryable, tenant: Tenant, id: string): Promise<AlertRule> {
  if (!isUuid(id)) throw notFound(say("core.alerts.notFound"));
  const r = await db.query<Row>(`${SELECT} AND r.id = $3`, [tenant.orgId, scopeParam(tenant), id]);
  const row = r.rows[0];
  if (!row) throw notFound(say("core.alerts.notFound"));
  return toRule(row);
}

/**
 * Checks which vehicles the alert points to. Returns the vehicles and groups
 * as they are stored. Someone who only sees some groups cannot create an alert
 * for the whole account or for vehicles or groups they do not see.
 */
async function resolveScope(db: Queryable, actor: Actor, input: AlertRuleData): Promise<{ vehicleIds: string[] | null; groupIds: string[] | null }> {
  if (input.vehicleIds !== null) {
    const ids = [...new Set(input.vehicleIds)];
    const r = await db.query(
      `SELECT 1 FROM gps.vehicles v WHERE v.org_id = $1 AND v.id = ANY($2::uuid[]) AND ${scopeSql(3)}`,
      [actor.orgId, ids, scopeParam(actor)],
    );
    if (r.rowCount !== ids.length) throw badRequest(say("core.scope.vehiclesGone"));
    return { vehicleIds: ids, groupIds: null };
  }
  if (actor.groups !== null) {
    // Someone who only sees single vehicles gets the alert for those.
    if (input.groupIds === null && actor.groups.length === 0 && actor.vehicles.length > 0) return { vehicleIds: [...actor.vehicles], groupIds: null };
    const chosen = input.groupIds ?? actor.groups;
    if (chosen.length === 0 || chosen.some((g) => !actor.groups?.includes(g))) throw forbidden(say("core.alerts.ownGroupsOnly"));
    return { vehicleIds: null, groupIds: [...new Set(chosen)] };
  }
  if (input.groupIds === null) return { vehicleIds: null, groupIds: null };
  const ids = [...new Set(input.groupIds)];
  const r = await db.query(`SELECT 1 FROM gps.vehicle_groups WHERE org_id = $1 AND id = ANY($2::uuid[])`, [actor.orgId, ids]);
  if (r.rowCount !== ids.length) throw badRequest(say("core.scope.groupsGone"));
  return { vehicleIds: null, groupIds: ids };
}

/** The geofences the alert names must belong to the account. */
async function assertGeofences(db: Queryable, actor: Actor, input: AlertRuleData): Promise<void> {
  const ids =
    input.type === "speeding"
      ? [input.params.geofenceId]
      : input.type === "geofence"
        ? (input.params.geofenceIds ?? [])
        : input.type === "custom"
          ? input.params.conditions.map((c) => (c.field === "geofence" ? c.geofenceId : null))
          : [];
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return;
  const r = await db.query(`SELECT 1 FROM gps.geofences WHERE org_id = $1 AND id = ANY($2::uuid[])`, [actor.orgId, wanted]);
  if (r.rowCount !== wanted.length) throw badRequest(say("core.alerts.geofencesGone"));
}

/** Someone who only sees some groups can see a broader alert, but cannot change or delete it. */
async function assertOwnScope(db: Queryable, actor: Actor, rule: AlertRule): Promise<void> {
  if (actor.groups === null) return;
  const wide = new Error("wide");
  try {
    if (rule.vehicleIds !== null) {
      const r = await db.query(`SELECT 1 FROM gps.vehicles v WHERE v.org_id = $1 AND v.id = ANY($2::uuid[]) AND ${scopeSql(3)}`, [actor.orgId, rule.vehicleIds, scopeParam(actor)]);
      if (r.rowCount !== rule.vehicleIds.length) throw wide;
    } else if (rule.groupIds === null || rule.groupIds.some((g) => !actor.groups?.includes(g))) {
      throw wide;
    }
  } catch (err) {
    if (err !== wide) throw err;
    throw forbidden(say("core.alerts.wider"));
  }
}

const columns = (input: AlertRuleData, scope: { vehicleIds: string[] | null; groupIds: string[] | null }) => [
  input.name,
  input.type,
  JSON.stringify(input.params),
  input.schedule ? JSON.stringify(input.schedule) : null,
  scope.vehicleIds,
  scope.groupIds,
  input.zone,
  input.active,
];

export async function createAlert(deps: AlertDeps, actor: Actor, input: AlertRuleData): Promise<AlertRule> {
  const id = await withTransaction(deps.db.core, async (client) => {
    const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.alert_rules WHERE org_id = $1`, [actor.orgId]);
    if ((count.rows[0]?.n ?? 0) >= MAX_ALERTS) throw badRequest(say("core.alerts.limit", { max: MAX_ALERTS }), "alert_limit");
    const scope = await resolveScope(client, actor, input);
    await assertGeofences(client, actor, input);
    const r = await client.query<{ id: string }>(
      `INSERT INTO gps.alert_rules (org_id, created_by, name, type, params, schedule, vehicle_ids, group_ids, zone, active)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::uuid[], $8::uuid[], $9, $10) RETURNING id`,
      [actor.orgId, actor.userId, ...columns(input, scope)],
    );
    const created = (r.rows[0] as { id: string }).id;
    await audit(client, actor, "alert.create", "alert", created, { name: input.name, type: input.type });
    return created;
  });
  deps.bus.emit("alerts_changed", { orgId: actor.orgId });
  return getAlert(deps.db.core, actor, id);
}

export async function updateAlert(deps: AlertDeps, actor: Actor, id: string, input: AlertRuleData): Promise<AlertRule> {
  const before = await getAlert(deps.db.core, actor, id);
  await assertOwnScope(deps.db.core, actor, before);
  if (before.type !== input.type) throw badRequest(say("core.alerts.typeFixed"));
  await withTransaction(deps.db.core, async (client) => {
    const scope = await resolveScope(client, actor, input);
    await assertGeofences(client, actor, input);
    await client.query(
      `UPDATE gps.alert_rules SET name = $3, type = $4, params = $5::jsonb, schedule = $6::jsonb, vehicle_ids = $7::uuid[],
              group_ids = $8::uuid[], zone = $9, active = $10, updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [actor.orgId, id, ...columns(input, scope)],
    );
    // What it remembered about each vehicle belonged to the previous alert.
    await client.query(`DELETE FROM gps.alert_state WHERE rule_id = $1`, [id]);
    await audit(client, actor, "alert.update", "alert", id, { name: input.name, type: input.type });
  });
  deps.bus.emit("alerts_changed", { orgId: actor.orgId });
  return getAlert(deps.db.core, actor, id);
}

export async function deleteAlert(deps: AlertDeps, actor: Actor, id: string): Promise<void> {
  const before = await getAlert(deps.db.core, actor, id);
  await assertOwnScope(deps.db.core, actor, before);
  await withTransaction(deps.db.core, async (client) => {
    await client.query(`DELETE FROM gps.alert_rules WHERE org_id = $1 AND id = $2`, [actor.orgId, id]);
    // A notification that told only about this alert is left with none: it does not start telling about every alert.
    await client.query(`UPDATE gps.notifications SET rule_ids = array_remove(rule_ids, $2::uuid), updated_at = now() WHERE org_id = $1 AND rule_ids IS NOT NULL`, [actor.orgId, id]);
    await audit(client, actor, "alert.delete", "alert", id, { name: before.name, type: before.type });
  });
  deps.bus.emit("alerts_changed", { orgId: actor.orgId });
}
