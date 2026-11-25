// Event engine: with each new position it decides whether the vehicle entered or
// left a geofence and whether any alert is met (speeding,
// device alarm, movement while parked…). Every so often it
// also checks what does not depend on a position: dwell times, schedules that
// start and vehicles that stopped reporting.
import {
  type AlertCondition,
  type AlertRuleData,
  type Bounds,
  type EventType,
  type GeofenceGeometry,
  type GeofenceKind,
  type LonLat,
  type VehicleEvent,
  type WeekSchedule,
  activeSince,
  metersBetween,
  signedDistanceM,
} from "@opengps/shared";
import type { Bus, CoreEvents, Fix } from "../bus";
import type { Config } from "../config";
import { type Db, type Queryable, withTransaction } from "../db";
import { type Tenant, isUuid, scopeParam, scopeSql } from "./access";
import { ensureDefaultAlerts } from "./alerts";

/**
 * To consider a vehicle as having left, it must move this far from the edge. Without this
 * margin, GPS inaccuracy would make a vehicle parked next to
 * the boundary enter and leave repeatedly.
 */
export const EXIT_MARGIN_M = 15;
const RELOAD_MS = 60_000;
const SWEEP_MS = 30_000;

interface Fence {
  id: string;
  name: string;
  geometry: GeofenceGeometry;
  bounds: Bounds;
  kind: GeofenceKind;
  schedule: WeekSchedule | null;
  minStayS: number | null;
  maxStayS: number | null;
  vehicleIds: string[] | null;
  groupIds: string[] | null;
}

interface State {
  inside: boolean;
  since: number;
  /** Last notification of each type (milliseconds) and whether the entry was seen happening. */
  alerted: { forbidden?: number; left?: number; stayLong?: number; entered?: boolean };
}

/** Alert as the engine uses it. */
type Rule = AlertRuleData & { id: string };

/** What an alert remembers about a device. */
interface RuleState {
  /** Since when the condition has held without interruption. */
  since: number | null;
  alertedAt: number | null;
  data: { fired?: boolean; max?: number; lost?: boolean; session?: number };
}

/** A device alarm is not repeated as a notification before this time. */
const ALARM_COOLDOWN_MS = 5 * 60_000;
/** Movement with the engine off: from this speed and sustained for this time, it is a tow. */
const TOW_KMH = 10;
const TOW_SECONDS = 20;
const HARSH_ALARMS = ["hardAcceleration", "hardBraking", "hardCornering", "accident"];

interface NewEvent {
  type: EventType;
  at: number;
  fence?: Pick<Fence, "id" | "name"> | undefined;
  rule?: Pick<Rule, "id" | "name"> | undefined;
  lat: number | null;
  lon: number | null;
  speedKmh: number | null;
  detail: Record<string, unknown>;
}

export interface EventEngine {
  start(): void;
  stop(): void;
  /** Ends when no positions are left to process. */
  idle(): Promise<void>;
  /** Checks dwell times, schedules and signal losses. Returns how many events it generated. With `orgId`, only that account. */
  sweep(now?: number, orgId?: string): Promise<number>;
}

const isCorridor = (fence: Pick<Fence, "geometry">) => fence.geometry.shape === "corridor";

/**
 * With `sweepEveryMs` null there is no periodic check: whoever creates it calls it when it wants (tests).
 * `config` gives the language the basic alerts are named in when an account gets them.
 */
export function createEventEngine(deps: { db: Db; bus: Bus; config: Pick<Config, "defaultLanguage">; sweepEveryMs?: number | null }): EventEngine {
  const { db, bus } = deps;
  const fences = new Map<string, { loadedAt: number; list: Fence[] }>();
  const rules = new Map<string, { loadedAt: number; list: Rule[] }>();

  async function rulesOf(orgId: string): Promise<Rule[]> {
    const cached = rules.get(orgId);
    if (cached && Date.now() - cached.loadedAt < RELOAD_MS) return cached.list;
    await ensureDefaultAlerts(db.core, orgId, deps.config.defaultLanguage); // i18n: stored text
    const r = await db.core.query<{
      id: string;
      name: string;
      type: Rule["type"];
      params: Rule["params"];
      schedule: WeekSchedule | null;
      vehicle_ids: string[] | null;
      group_ids: string[] | null;
      zone: string;
    }>(`SELECT id, name, type, params, schedule, vehicle_ids, gps.groups_with_children(group_ids) AS group_ids, zone FROM gps.alert_rules WHERE org_id = $1 AND active`, [orgId]);
    const list = r.rows.map(
      (x) => ({ id: x.id, name: x.name, type: x.type, params: x.params, schedule: x.schedule, vehicleIds: x.vehicle_ids, groupIds: x.group_ids, zone: x.zone, active: true }) as Rule,
    );
    rules.set(orgId, { loadedAt: Date.now(), list });
    return list;
  }
  let queue: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  const subscriptions: (() => void)[] = [];

  async function fencesOf(orgId: string): Promise<Fence[]> {
    const cached = fences.get(orgId);
    if (cached && Date.now() - cached.loadedAt < RELOAD_MS) return cached.list;
    const r = await db.core.query<{
      id: string;
      name: string;
      geometry: GeofenceGeometry;
      kind: GeofenceKind;
      schedule: WeekSchedule | null;
      min_stay_s: number | null;
      max_stay_s: number | null;
      vehicle_ids: string[] | null;
      group_ids: string[] | null;
      min_lat: number;
      max_lat: number;
      min_lon: number;
      max_lon: number;
    }>(
      `SELECT id, name, geometry, kind, schedule, min_stay_s, max_stay_s, vehicle_ids, gps.groups_with_children(group_ids) AS group_ids, min_lat, max_lat, min_lon, max_lon
         FROM gps.geofences WHERE org_id = $1 AND active`,
      [orgId],
    );
    const list = r.rows.map((g) => ({
      id: g.id,
      name: g.name,
      geometry: g.geometry,
      bounds: { minLat: g.min_lat, maxLat: g.max_lat, minLon: g.min_lon, maxLon: g.max_lon },
      kind: g.kind,
      schedule: g.schedule,
      minStayS: g.min_stay_s,
      maxStayS: g.max_stay_s,
      vehicleIds: g.vehicle_ids,
      groupIds: g.group_ids,
    }));
    fences.set(orgId, { loadedAt: Date.now(), list });
    return list;
  }

  /** What happens when crossing a geofence's edge. */
  function crossing(fence: Fence, prev: State, fix: Fix): { state: State; events: NewEvent[] } {
    const entering = !prev.inside;
    const active = activeSince(fence.schedule, fix.t) !== null;
    const base = { at: fix.t, fence, lat: fix.lat, lon: fix.lon, speedKmh: fix.speedKmh };
    if (entering) {
      const forbidden = fence.kind === "forbidden" && active && !isCorridor(fence);
      const type: EventType = isCorridor(fence) ? "route_return" : forbidden ? "zone_forbidden" : "geofence_enter";
      return {
        state: { inside: true, since: fix.t, alerted: { entered: true, ...(forbidden ? { forbidden: fix.t } : {}) } },
        events: [{ ...base, type, detail: {} }],
      };
    }
    const stayedS = Math.round((fix.t - prev.since) / 1000);
    // Dwell time is only known if the vehicle was seen entering.
    const stayed = prev.alerted.entered ? { stayedMin: Math.round(stayedS / 60) } : {};
    const alert = fence.kind === "authorized" && active;
    const type: EventType = alert ? (isCorridor(fence) ? "route_deviation" : "zone_left") : "geofence_exit";
    const events: NewEvent[] = [{ ...base, type, detail: stayed }];
    if (prev.alerted.entered && fence.minStayS !== null && stayedS < fence.minStayS) {
      events.push({ ...base, type: "stay_short", detail: { ...stayed, minimumMin: Math.round(fence.minStayS / 60) } });
    }
    return { state: { inside: false, since: fix.t, alerted: alert ? { left: fix.t } : {} }, events };
  }

  /** Does the alert or the geofence apply to this vehicle? Certain vehicles, certain groups or, with neither, all. */
  const appliesTo = (rule: Pick<Rule, "vehicleIds" | "groupIds">, vehicleId: string, groupId: string | null) =>
    rule.vehicleIds !== null ? rule.vehicleIds.includes(vehicleId) : rule.groupIds === null || (groupId !== null && rule.groupIds.includes(groupId));

  /**
   * Checks an alert against a position. Changes `st` (what the alert remembers
   * about the device) and returns the event if a notification is due.
   */
  function check(
    rule: Rule,
    st: RuleState,
    fix: Fix,
    ctx: { fenceById: Map<string, Fence>; parked: { since: number; lat: number; lon: number } | null },
  ): NewEvent | null {
    const active = activeSince(rule.schedule, fix.t) !== null;
    const speed = fix.speedKmh ?? 0;
    const at: LonLat = [fix.lon, fix.lat];
    const base = { at: fix.t, rule, lat: fix.lat, lon: fix.lon, speedKmh: fix.speedKmh };
    const insideFence = (id: string) => {
      const fence = ctx.fenceById.get(id);
      return fence ? signedDistanceM(fence.geometry, at) <= 0 : null;
    };
    // Notifies once when the condition has been met for `seconds`; when it stops being met, it re-arms.
    const sustained = (holds: boolean, seconds: number, type: EventType, detail: () => Record<string, unknown>): NewEvent | null => {
      if (!holds) {
        st.since = null;
        st.data = {};
        return null;
      }
      st.since ??= fix.t;
      st.data.max = Math.max(st.data.max ?? 0, speed);
      if (st.data.fired || fix.t - st.since < seconds * 1000) return null;
      st.data.fired = true;
      st.alertedAt = fix.t;
      return { ...base, type, detail: detail() };
    };
    // Notifies immediately, without repeating while the device keeps sending the same alarm.
    const instant = (holds: boolean, type: EventType, detail: Record<string, unknown> = {}): NewEvent | null => {
      if (!holds || !active || (st.alertedAt !== null && fix.t - st.alertedAt < ALARM_COOLDOWN_MS)) return null;
      st.alertedAt = fix.t;
      return { ...base, type, detail };
    };

    switch (rule.type) {
      case "speeding": {
        const p = rule.params;
        const zone = p.geofenceId ? ctx.fenceById.get(p.geofenceId) : undefined;
        const where = p.geofenceId ? insideFence(p.geofenceId) === true : true;
        return sustained(active && where && speed > p.limitKmh, p.seconds, "speeding", () => ({
          speedKmh: Math.round(st.data.max ?? speed),
          limitKmh: p.limitKmh,
          ...(zone ? { geofenceName: zone.name } : {}),
        }));
      }
      case "ignition_off_hours":
        // With no ignition data in this position, it does not change its mind.
        if (fix.ignition === null) return null;
        return sustained(active && fix.ignition && activeSince(rule.params.allowed, fix.t) === null, 0, "ignition_off_hours", () => ({}));
      case "tow":
        if (fix.alarms.includes("tow")) return instant(true, "tow", { byDevice: true });
        return sustained(active && fix.ignition === false && speed >= TOW_KMH, TOW_SECONDS, "tow", () => ({ speedKmh: Math.round(st.data.max ?? speed) }));
      case "sos":
        return instant(fix.alarms.includes("sos"), "sos");
      case "power_cut":
        return instant(fix.alarms.includes("powerCut"), "power_cut");
      case "harsh_driving": {
        const kind = fix.alarms.find((a) => HARSH_ALARMS.includes(a));
        return instant(kind !== undefined, "harsh_driving", { kind });
      }
      case "parked_movement": {
        const parked = ctx.parked;
        // Only what happens after leaving it parked counts, and one notification each time it is parked.
        if (!parked || fix.t <= parked.since || (st.data.session === parked.since && st.data.fired)) return null;
        const moved = metersBetween([parked.lon, parked.lat], at);
        if (!active || moved <= rule.params.meters) return null;
        st.data = { fired: true, session: parked.since };
        st.alertedAt = fix.t;
        return { ...base, type: "unauthorized_movement", detail: { meters: Math.round(moved) } };
      }
      case "custom": {
        const holds = (c: AlertCondition): boolean => {
          if (c.field === "speed") return c.op === "gt" ? speed > c.value : speed < c.value;
          if (c.field === "ignition") return fix.ignition === c.value;
          if (c.field === "geofence") return insideFence(c.geofenceId) === c.inside;
          if (c.field === "power") return fix.powerV !== null && (c.op === "gt" ? fix.powerV > c.value : fix.powerV < c.value);
          return fix.batteryPct !== null && fix.batteryPct < c.value;
        };
        return sustained(active && rule.params.conditions.every(holds), rule.params.seconds, "custom", () => ({}));
      }
      default:
        return null;
    }
  }

  async function handle(payload: CoreEvents["fixes"]): Promise<void> {
    const allFences = await fencesOf(payload.orgId);
    const allRules = await rulesOf(payload.orgId);
    // An account with no geofences or enabled alerts has nothing to check or remember.
    if (allFences.length === 0 && allRules.length === 0) return;
    const list = allFences.filter((f) => appliesTo(f, payload.vehicleId, payload.groupId));
    // Geofence ones only say which geofence events an account's notifications tell about; the rest is checked with each position.
    const ruleList = allRules.filter((r) => r.type !== "geofence" && appliesTo(r, payload.vehicleId, payload.groupId));

    const loaded = await db.core.query<{ geofence_id: string; inside: boolean; since: Date; alerted: State["alerted"] }>(
      `SELECT geofence_id, inside, since, alerted FROM gps.geofence_state WHERE device_id = $1`,
      [payload.deviceId],
    );
    const states = new Map<string, State>(loaded.rows.map((s) => [s.geofence_id, { inside: s.inside, since: s.since.getTime(), alerted: s.alerted }]));
    // Geofences that no longer apply to this vehicle (it changed group, or they were deactivated).
    const applicable = new Set(list.map((f) => f.id));
    const stale = [...states.keys()].filter((id) => !applicable.has(id));
    if (list.length === 0 && stale.length === 0 && ruleList.length === 0) return;

    const watch = await db.core.query<{ last_fix: Date }>(`SELECT last_fix FROM gps.event_watch WHERE device_id = $1`, [payload.deviceId]);
    const lastFix = watch.rows[0]?.last_fix.getTime() ?? 0;
    // Data that arrives late does not trigger past notifications.
    const fixes = payload.fixes.filter((f) => f.t > lastFix);
    if (fixes.length === 0 && stale.length === 0) return;

    const ruleStates = new Map<string, RuleState>();
    let parked: { since: number; lat: number; lon: number } | null = null;
    if (ruleList.length > 0) {
      const saved = await db.core.query<{ rule_id: string; since: Date | null; alerted_at: Date | null; data: RuleState["data"] }>(
        `SELECT rule_id, since, alerted_at, data FROM gps.alert_state WHERE device_id = $1`,
        [payload.deviceId],
      );
      for (const row of saved.rows) ruleStates.set(row.rule_id, { since: row.since?.getTime() ?? null, alertedAt: row.alerted_at?.getTime() ?? null, data: row.data });
      if (ruleList.some((r) => r.type === "parked_movement")) {
        const v = await db.core.query<{ parked_since: Date | null; parked_lat: number | null; parked_lon: number | null }>(
          `SELECT parked_since, parked_lat, parked_lon FROM gps.vehicles WHERE id = $1`,
          [payload.vehicleId],
        );
        const row = v.rows[0];
        if (row?.parked_since && row.parked_lat !== null && row.parked_lon !== null) parked = { since: row.parked_since.getTime(), lat: row.parked_lat, lon: row.parked_lon };
      }
    }
    const fenceById = new Map(allFences.map((f) => [f.id, f]));

    const dirty = new Set<string>();
    const dirtyRules = new Set<string>();
    const events: NewEvent[] = [];
    for (const fix of fixes) {
      for (const fence of list) {
        const b = fence.bounds;
        const far = fix.lat < b.minLat || fix.lat > b.maxLat || fix.lon < b.minLon || fix.lon > b.maxLon;
        const distance = far ? Number.POSITIVE_INFINITY : signedDistanceM(fence.geometry, [fix.lon, fix.lat]);
        const prev = states.get(fence.id);
        if (!prev) {
          // First time this vehicle is seen with this geofence: its location is noted, without an event.
          states.set(fence.id, { inside: distance <= 0, since: fix.t, alerted: {} });
          dirty.add(fence.id);
          continue;
        }
        const inside = prev.inside ? distance <= EXIT_MARGIN_M : distance <= 0;
        if (inside === prev.inside) continue;
        const result = crossing(fence, prev, fix);
        states.set(fence.id, result.state);
        dirty.add(fence.id);
        events.push(...result.events);
      }
      for (const rule of ruleList) {
        const st = ruleStates.get(rule.id) ?? { since: null, alertedAt: null, data: {} };
        const before = JSON.stringify(st);
        if (rule.type === "signal_lost") {
          // It reported again after a signal-loss notification.
          if (st.data.lost) {
            st.data = {};
            events.push({ type: "signal_back", at: fix.t, rule, lat: fix.lat, lon: fix.lon, speedKmh: fix.speedKmh, detail: {} });
          }
        } else {
          const event = check(rule, st, fix, { fenceById, parked });
          if (event) events.push(event);
        }
        if (JSON.stringify(st) !== before) {
          ruleStates.set(rule.id, st);
          dirtyRules.add(rule.id);
        }
      }
    }

    const saved = await withTransaction(db.core, async (client) => {
      if (stale.length > 0) await client.query(`DELETE FROM gps.geofence_state WHERE device_id = $1 AND geofence_id = ANY($2::uuid[])`, [payload.deviceId, stale]);
      const changed = [...dirty].map((id) => ({ id, state: states.get(id) as State }));
      if (changed.length > 0) {
        await client.query(
          `INSERT INTO gps.geofence_state (geofence_id, device_id, inside, since, alerted)
           SELECT g, $2, i, s, a FROM unnest($1::uuid[], $3::boolean[], $4::timestamptz[], $5::jsonb[]) AS t(g, i, s, a)
           ON CONFLICT (geofence_id, device_id) DO UPDATE SET inside = EXCLUDED.inside, since = EXCLUDED.since, alerted = EXCLUDED.alerted`,
          [
            changed.map((c) => c.id),
            payload.deviceId,
            changed.map((c) => c.state.inside),
            changed.map((c) => new Date(c.state.since)),
            changed.map((c) => JSON.stringify(c.state.alerted)),
          ],
        );
      }
      const changedRules = [...dirtyRules].map((id) => ({ id, state: ruleStates.get(id) as RuleState }));
      if (changedRules.length > 0) {
        await client.query(
          `INSERT INTO gps.alert_state (rule_id, device_id, since, alerted_at, data)
           SELECT r, $2, s, a, d FROM unnest($1::uuid[], $3::timestamptz[], $4::timestamptz[], $5::jsonb[]) AS t(r, s, a, d)
           ON CONFLICT (rule_id, device_id) DO UPDATE SET since = EXCLUDED.since, alerted_at = EXCLUDED.alerted_at, data = EXCLUDED.data`,
          [
            changedRules.map((c) => c.id),
            payload.deviceId,
            changedRules.map((c) => (c.state.since === null ? null : new Date(c.state.since))),
            changedRules.map((c) => (c.state.alertedAt === null ? null : new Date(c.state.alertedAt))),
            changedRules.map((c) => JSON.stringify(c.state.data)),
          ],
        );
      }
      const newest = fixes[fixes.length - 1];
      if (newest) {
        await client.query(
          `INSERT INTO gps.event_watch (device_id, last_fix) VALUES ($1, $2)
           ON CONFLICT (device_id) DO UPDATE SET last_fix = GREATEST(gps.event_watch.last_fix, EXCLUDED.last_fix)`,
          [payload.deviceId, new Date(newest.t)],
        );
      }
      return insertEvents(client, payload, events);
    });
    for (const { event, ruleId } of saved) bus.emit("event", { orgId: payload.orgId, groupId: payload.groupId, event, ruleId });
  }

  async function sweep(now = Date.now(), orgId: string | null = null): Promise<number> {
    const r = await db.core.query<{
      geofence_id: string;
      device_id: number;
      inside: boolean;
      since: Date;
      alerted: State["alerted"];
      org_id: string;
      name: string;
      kind: GeofenceKind;
      shape: string;
      schedule: WeekSchedule | null;
      max_stay_s: number | null;
      vehicle_id: string;
      group_id: string | null;
      lat: number | null;
      lon: number | null;
      speed_kmh: number | null;
    }>(
      `SELECT s.geofence_id, s.device_id, s.inside, s.since, s.alerted,
              g.org_id, g.name, g.kind, g.shape, g.schedule, g.max_stay_s,
              d.vehicle_id, v.group_id, st.lat, st.lon, st.speed_kmh
         FROM gps.geofence_state s
         JOIN gps.geofences g ON g.id = s.geofence_id
         JOIN gps.devices d ON d.id = s.device_id
         JOIN gps.vehicles v ON v.id = d.vehicle_id
         LEFT JOIN gps.device_state st ON st.device_id = d.id
        WHERE g.active AND ($1::text IS NULL OR g.org_id = $1)
          AND ((s.inside AND (g.max_stay_s IS NOT NULL OR (g.kind = 'forbidden' AND g.schedule IS NOT NULL)))
            OR (NOT s.inside AND g.kind = 'authorized' AND g.schedule IS NOT NULL))`,
      [orgId],
    );
    let count = 0;
    for (const row of r.rows) {
      const since = row.since.getTime();
      const alerted = { ...row.alerted };
      const found: { type: EventType; detail: Record<string, unknown> }[] = [];
      if (row.inside && row.max_stay_s !== null && now - since > row.max_stay_s * 1000 && !alerted.stayLong) {
        alerted.stayLong = now;
        found.push({ type: "stay_long", detail: { stayedMin: Math.round((now - since) / 60_000), maximumMin: Math.round(row.max_stay_s / 60) } });
      }
      // Schedules that start with the vehicle already where it should not be.
      const opened = row.schedule ? activeSince(row.schedule, now) : null;
      if (opened !== null && since < opened) {
        if (row.inside && row.kind === "forbidden" && row.shape !== "corridor" && (alerted.forbidden ?? 0) < opened) {
          alerted.forbidden = now;
          found.push({ type: "zone_forbidden", detail: { bySchedule: true } });
        }
        if (!row.inside && row.kind === "authorized" && (alerted.left ?? 0) < opened) {
          alerted.left = now;
          found.push({ type: row.shape === "corridor" ? "route_deviation" : "zone_left", detail: { bySchedule: true } });
        }
      }
      if (found.length === 0) continue;
      const context = { orgId: row.org_id, vehicleId: row.vehicle_id, groupId: row.group_id, deviceId: row.device_id };
      const saved = await withTransaction(db.core, async (client) => {
        // If the vehicle crossed the edge in the meantime, this notification no longer applies.
        const still = await client.query(
          `UPDATE gps.geofence_state SET alerted = $3::jsonb WHERE geofence_id = $1 AND device_id = $2 AND inside = $4 AND since = $5`,
          [row.geofence_id, row.device_id, JSON.stringify(alerted), row.inside, row.since],
        );
        if (still.rowCount === 0) return [];
        return insertEvents(
          client,
          context,
          found.map((f) => ({ ...f, at: now, fence: { id: row.geofence_id, name: row.name }, lat: row.lat, lon: row.lon, speedKmh: row.speed_kmh })),
        );
      });
      for (const { event, ruleId } of saved) bus.emit("event", { orgId: row.org_id, groupId: row.group_id, event, ruleId });
      count += saved.length;
    }
    return count + (await sweepSignal(now, orgId));
  }

  /** Vehicles that stopped reporting: one notification each time they lose signal. */
  async function sweepSignal(now: number, orgId: string | null): Promise<number> {
    const r = await db.core.query<{
      rule_id: string;
      name: string;
      org_id: string;
      schedule: WeekSchedule | null;
      device_id: number;
      vehicle_id: string;
      group_id: string | null;
      last_seen_at: Date;
      lat: number | null;
      lon: number | null;
    }>(
      `SELECT r.id AS rule_id, r.name, r.org_id, r.schedule, d.id AS device_id, d.vehicle_id, v.group_id, s.last_seen_at, s.lat, s.lon
         FROM gps.alert_rules r
         JOIN gps.vehicles v ON v.org_id = r.org_id
         JOIN gps.devices d ON d.vehicle_id = v.id AND d.status = 'active'
         JOIN gps.device_state s ON s.device_id = d.id
         LEFT JOIN gps.alert_state a ON a.rule_id = r.id AND a.device_id = d.id
        WHERE r.active AND r.type = 'signal_lost' AND ($2::text IS NULL OR r.org_id = $2)
          AND s.last_seen_at < $1::timestamptz - make_interval(mins => (r.params->>'minutes')::int)
          AND NOT COALESCE((a.data->>'lost')::boolean, false)
          AND (CASE WHEN r.vehicle_ids IS NOT NULL THEN v.id = ANY(r.vehicle_ids)
                    ELSE r.group_ids IS NULL OR v.group_id = ANY(gps.groups_with_children(r.group_ids)) END)`,
      [new Date(now), orgId],
    );
    let count = 0;
    for (const row of r.rows) {
      if (activeSince(row.schedule, now) === null) continue;
      const context = { orgId: row.org_id, vehicleId: row.vehicle_id, groupId: row.group_id, deviceId: row.device_id };
      const saved = await withTransaction(db.core, async (client) => {
        await client.query(
          `INSERT INTO gps.alert_state (rule_id, device_id, alerted_at, data) VALUES ($1, $2, $3, '{"lost": true}')
           ON CONFLICT (rule_id, device_id) DO UPDATE SET alerted_at = EXCLUDED.alerted_at, data = EXCLUDED.data`,
          [row.rule_id, row.device_id, new Date(now)],
        );
        return insertEvents(client, context, [
          {
            type: "signal_lost",
            at: now,
            rule: { id: row.rule_id, name: row.name },
            lat: row.lat,
            lon: row.lon,
            speedKmh: null,
            detail: { silentMin: Math.round((now - row.last_seen_at.getTime()) / 60_000) },
          },
        ]);
      });
      for (const { event, ruleId } of saved) bus.emit("event", { orgId: row.org_id, groupId: row.group_id, event, ruleId });
      count += saved.length;
    }
    return count;
  }

  return {
    start() {
      subscriptions.push(
        bus.on("fixes", (payload) => {
          // One at a time: two batches from the same device must not overwrite each other.
          queue = queue.then(() => handle(payload)).catch((err: Error) => console.error("[events] could not check a position:", err.message));
        }),
        bus.on("geofences_changed", (e) => {
          fences.delete(e.orgId);
        }),
        bus.on("alerts_changed", (e) => {
          rules.delete(e.orgId);
        }),
      );
      const every = deps.sweepEveryMs === undefined ? SWEEP_MS : deps.sweepEveryMs;
      if (every !== null) {
        timer = setInterval(() => {
          queue = queue.then(() => sweep()).catch((err: Error) => console.error("[events] the periodic check failed:", err.message));
        }, every);
      }
    },
    stop() {
      for (const off of subscriptions.splice(0)) off();
      if (timer) clearInterval(timer);
      timer = null;
    },
    idle: () => queue.then(() => undefined),
    sweep,
  };
}

async function insertEvents(
  client: Queryable,
  context: { orgId: string; vehicleId: string; deviceId: number },
  events: NewEvent[],
): Promise<{ event: VehicleEvent; ruleId: string | null }[]> {
  if (events.length === 0) return [];
  const name = await client.query<{ name: string }>(`SELECT name FROM gps.vehicles WHERE id = $1`, [context.vehicleId]);
  const vehicleName = name.rows[0]?.name ?? "";
  const out: { event: VehicleEvent; ruleId: string | null }[] = [];
  for (const e of events) {
    // Names are stored with the event: they remain understandable if the geofence or alert is deleted.
    const geofenceName = e.fence?.name ?? (typeof e.detail.geofenceName === "string" ? e.detail.geofenceName : null);
    const detail = { ...e.detail, ...(geofenceName ? { geofenceName } : {}), ...(e.rule ? { ruleName: e.rule.name } : {}) };
    const r = await client.query<{ id: number }>(
      `INSERT INTO gps.events (org_id, vehicle_id, device_id, type, at, geofence_id, rule_id, lat, lon, speed_kmh, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) RETURNING id`,
      [context.orgId, context.vehicleId, context.deviceId, e.type, new Date(e.at), e.fence?.id ?? null, e.rule?.id ?? null, e.lat, e.lon, e.speedKmh, JSON.stringify(detail)],
    );
    const { geofenceName: _g, ...shown } = e.detail as { geofenceName?: string };
    out.push({
      ruleId: e.rule?.id ?? null,
      event: {
        id: (r.rows[0] as { id: number }).id,
        type: e.type,
        at: new Date(e.at).toISOString(),
        vehicleId: context.vehicleId,
        vehicleName,
        geofenceId: e.fence?.id ?? null,
        geofenceName,
        ruleName: e.rule?.name ?? null,
        lat: e.lat,
        lon: e.lon,
        speedKmh: e.speedKmh,
        detail: shown,
      },
    });
  }
  return out;
}

/**
 * Records an event that does not come from a geofence or an alert: used by the
 * modules (a start lock, a tamper alarm). Saves it and
 * notifies it through the same channel as the others.
 */
export async function recordEvent(
  deps: { db: Db; bus: Bus },
  context: { orgId: string; vehicleId: string; deviceId: number; groupId: string | null },
  event: { type: EventType; at: number; lat: number | null; lon: number | null; speedKmh: number | null; detail?: Record<string, unknown> },
): Promise<VehicleEvent> {
  const [saved] = await insertEvents(deps.db.core, context, [{ ...event, detail: event.detail ?? {} }]);
  const stored = (saved as { event: VehicleEvent }).event;
  deps.bus.emit("event", { orgId: context.orgId, groupId: context.groupId, event: stored, ruleId: null });
  return stored;
}

// ─── Query ───────────────────────────────────────────────────────────────────

export interface EventFilter {
  limit: number;
  /** Only events before this one (to request the next page). */
  before?: number | undefined;
  vehicleId?: string | undefined;
  geofenceId?: string | undefined;
  /** Only those that need attention. */
  types?: readonly EventType[] | undefined;
}

/** Events of the vehicles this person can see, from most recent to oldest. */
export async function listEvents(db: Queryable, tenant: Tenant, filter: EventFilter): Promise<VehicleEvent[]> {
  if ((filter.vehicleId && !isUuid(filter.vehicleId)) || (filter.geofenceId && !isUuid(filter.geofenceId))) return [];
  const r = await db.query<{
    id: number;
    type: EventType;
    at: Date;
    vehicle_id: string;
    vehicle_name: string;
    geofence_id: string | null;
    lat: number | null;
    lon: number | null;
    speed_kmh: number | null;
    detail: Record<string, unknown>;
  }>(
    `SELECT e.id, e.type, e.at, e.vehicle_id, v.name AS vehicle_name, e.geofence_id, e.lat, e.lon, e.speed_kmh, e.detail
       FROM gps.events e
       JOIN gps.vehicles v ON v.id = e.vehicle_id
      WHERE e.org_id = $1 AND ${scopeSql(2)}
        AND ($3::bigint IS NULL OR e.id < $3)
        AND ($4::uuid IS NULL OR e.vehicle_id = $4)
        AND ($5::uuid IS NULL OR e.geofence_id = $5)
        AND ($6::text[] IS NULL OR e.type = ANY($6::text[]))
      ORDER BY e.id DESC
      LIMIT $7`,
    [tenant.orgId, scopeParam(tenant), filter.before ?? null, filter.vehicleId ?? null, filter.geofenceId ?? null, filter.types ?? null, filter.limit],
  );
  return r.rows.map((e) => {
    const { geofenceName, ruleName, ...detail } = e.detail as { geofenceName?: string; ruleName?: string };
    return {
      id: e.id,
      type: e.type,
      at: e.at.toISOString(),
      vehicleId: e.vehicle_id,
      vehicleName: e.vehicle_name,
      geofenceId: e.geofence_id,
      geofenceName: geofenceName ?? null,
      ruleName: ruleName ?? null,
      lat: e.lat,
      lon: e.lon,
      speedKmh: e.speed_kmh,
      detail,
    };
  });
}
