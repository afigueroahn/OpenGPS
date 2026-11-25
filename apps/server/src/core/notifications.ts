// An account's notifications: whom it tells, about what and through which
// channel. When an event that calls for attention happens, each notification
// that covers it puts a message in the outbox for every person and address it
// names. A person only receives what is about vehicles they can see.
import {
  ALERT_EVENTS,
  type AccountNotification,
  type Delivery,
  type DeliveryStatus,
  type EventType,
  GEOFENCE_EVENTS,
  type Language,
  NOTIFICATIONS_MAX,
  NOTIFY_CHANNELS,
  type NotificationOptions,
  type NotifyChannel,
  PAID_CHANNELS,
  type VehicleEvent,
  WRITTEN_CHANNELS,
  type WeekSchedule,
  type accountNotificationSchema,
  activeSince,
  addressLabel,
} from "@opengps/shared";
import type { z } from "zod";
import type { Bus, CoreEvents } from "../bus";
import type { Config } from "../config";
import type { Db, Queryable } from "../db";
import { badRequest, forbidden, notFound } from "../errors";
import { type Say, knownLanguage, render, say, tr } from "../i18n";
import { isUuid, listRoles, scopeParam, scopeSql } from "./access";
import { audit } from "./audit";
import { type Message, channelProblem, customAudience, recipientTarget } from "./channels";
import { createClock } from "./export/format";
import { describeEvent, eventPayload } from "./notify";
import { type Outbox, type OutboxItem, listDeliveries, sentSince } from "./outbox";
import { createVault } from "./secrets";
import type { Actor } from "./vehicles";

export interface NotifyDeps {
  db: Db;
  bus: Bus;
  config: Config;
  outbox: Outbox;
}
type Input = z.output<typeof accountNotificationSchema>;

export interface Notifier {
  start(): void;
  stop(): void;
  /** Ends when there is nothing left to queue or send. */
  idle(): Promise<void>;
}

interface Row {
  id: string;
  name: string;
  channel: NotifyChannel;
  active: boolean;
  everyone: boolean;
  roles: string[];
  user_ids: string[];
  addresses: string | null;
  events: EventType[] | null;
  rule_ids: string[] | null;
  group_ids: string[] | null;
  vehicle_ids: string[] | null;
  zone: string;
  last_status: DeliveryStatus | null;
  last_at: Date | null;
}

const SELECT = `SELECT n.id, n.name, n.channel, n.active, n.everyone, n.roles, n.user_ids, n.addresses, n.events, n.rule_ids, n.group_ids, n.vehicle_ids, n.zone,
         d.status AS last_status, COALESCE(d.done_at, d.created_at) AS last_at
    FROM gps.notifications n
    LEFT JOIN LATERAL (SELECT status, done_at, created_at FROM gps.outbox WHERE source = 'notification' AND source_id = n.id ORDER BY id DESC LIMIT 1) d ON true`;

/**
 * Scope over table `n`, with `scopeParam` in parameter 2: someone who sees
 * everything manages all of them; someone with a narrower scope, those that
 * cover nothing beyond what they see.
 */
const OWN = `($2::uuid[] IS NULL
  OR (n.vehicle_ids IS NULL AND n.group_ids IS NOT NULL AND n.group_ids <@ $2::uuid[])
  OR (n.vehicle_ids IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM unnest(n.vehicle_ids) AS x(id)
         WHERE NOT EXISTS (SELECT 1 FROM gps.vehicles v WHERE v.id = x.id AND v.org_id = n.org_id AND ${scopeSql(2)}))))`;

/** A member's role as the platform reads it, from what the two tables store. Mirrors `effectiveRole`. */
const ROLE_SQL = `CASE WHEN m.role = 'owner' THEN 'owner' WHEN m.role = 'admin' THEN 'admin' WHEN a.role IS NULL OR a.role = 'admin' THEN 'viewer' ELSE a.role END`;

const vaultOf = (config: Pick<Config, "authSecret">) => createVault(config.authSecret);

function addressesOf(config: Pick<Config, "authSecret">, sealed: string | null): string[] {
  try {
    const list: unknown = JSON.parse(vaultOf(config).open(sealed) ?? "[]");
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

const toNotification = (config: Pick<Config, "authSecret">, r: Row): AccountNotification => ({
  id: r.id,
  name: r.name,
  channel: r.channel,
  active: r.active,
  everyone: r.everyone,
  roles: r.roles,
  userIds: r.user_ids,
  addresses: addressesOf(config, r.addresses),
  events: r.events,
  ruleIds: r.rule_ids,
  groupIds: r.group_ids,
  vehicleIds: r.vehicle_ids,
  zone: r.zone,
  last: r.last_status && r.last_at ? { status: r.last_status, at: r.last_at.toISOString() } : null,
});

// ─── Reading ─────────────────────────────────────────────────────────────────

export async function listNotifications(deps: Pick<NotifyDeps, "db" | "config">, actor: Actor): Promise<AccountNotification[]> {
  const r = await deps.db.core.query<Row>(`${SELECT} WHERE n.org_id = $1 AND ${OWN} ORDER BY n.created_at, n.id`, [actor.orgId, scopeParam(actor)]);
  return r.rows.map((row) => toNotification(deps.config, row));
}

async function rowOf(db: Queryable, actor: Actor, id: string): Promise<Row> {
  if (!isUuid(id)) throw notFound(say("api.notifications.notFound"));
  const r = await db.query<Row>(`${SELECT} WHERE n.org_id = $1 AND ${OWN} AND n.id = $3`, [actor.orgId, scopeParam(actor), id]);
  if (!r.rows[0]) throw notFound(say("api.notifications.notFound"));
  return r.rows[0];
}

/** Start of the month, in UTC: the caps of the paid channels count from there. */
const monthStart = (now: number) => new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1));

/** What the notifications screen needs besides the list, with its names in `language`: the channels there are, the people, the alerts. */
export async function notificationOptions(deps: Pick<NotifyDeps, "db" | "config">, actor: Actor, language: Language, now = Date.now()): Promise<NotificationOptions> {
  const db = deps.db.core;
  const people = await db.query<{ id: string; name: string; role: string; phone: string | null }>(
    `SELECT u.id, u.name, ${ROLE_SQL} AS role, us.phone
       FROM auth.member m
       JOIN auth."user" u ON u.id = m."userId"
       LEFT JOIN gps.member_access a ON a.org_id = m."organizationId" AND a.user_id = u.id
       LEFT JOIN gps.user_settings us ON us.user_id = u.id
      WHERE m."organizationId" = $1 AND NOT COALESCE(a.disabled, false)
      ORDER BY (m.role = 'owner') DESC, m."createdAt", u.id`,
    [actor.orgId],
  );
  const roles = [{ id: "owner", name: tr(language, "shared.role.owner") }, ...(await listRoles(db, actor.orgId, language)).map((r) => ({ id: r.id, name: r.name }))];
  const rules = await db.query<{ id: string; name: string }>(`SELECT id, name FROM gps.alert_rules WHERE org_id = $1 ORDER BY created_at, id`, [actor.orgId]);
  const usage = [];
  for (const channel of PAID_CHANNELS) {
    if (deps.config.channels[channel].enabled) usage.push({ channel, sent: await sentSince(db, actor.orgId, channel, monthStart(now)), cap: capOf(deps.config, channel) });
  }
  return {
    channels: NOTIFY_CHANNELS.filter((channel) => channelProblem(deps.config, channel) === null),
    people: people.rows.map((p) => ({ userId: p.id, name: p.name, role: p.role, roleName: roles.find((r) => r.id === p.role)?.name ?? tr(language, "shared.role.viewer"), hasPhone: p.phone !== null })),
    roles,
    rules: rules.rows,
    canAddress: actor.groups === null,
    customPerPerson: customAudience(deps.config.channels.webhook).perPerson,
    usage,
  };
}

/** The latest messages of the account, or of one of its notifications. */
export async function notificationLog(deps: Pick<NotifyDeps, "db">, actor: Actor, id?: string): Promise<Delivery[]> {
  if (id !== undefined) await rowOf(deps.db.core, actor, id);
  return listDeliveries(deps.db.core, { orgId: actor.orgId, ...(id !== undefined ? { sourceId: id } : {}) });
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/**
 * Which vehicles the notification is about, depending on who saves it. Someone
 * who sees everything chooses freely; someone with a narrower scope cannot
 * create one for the whole account or for groups or vehicles that are not theirs.
 */
async function resolveScope(db: Queryable, actor: Actor, input: Pick<Input, "groupIds" | "vehicleIds">): Promise<{ groupIds: string[] | null; vehicleIds: string[] | null }> {
  if (input.vehicleIds !== null) {
    const ids = [...new Set(input.vehicleIds)];
    const r = await db.query(`SELECT 1 FROM gps.vehicles v WHERE v.org_id = $1 AND v.id = ANY($2::uuid[]) AND ${scopeSql(3)}`, [actor.orgId, ids, scopeParam(actor)]);
    if (r.rowCount !== ids.length) throw badRequest(say("api.notifications.vehiclesGone"));
    return { groupIds: null, vehicleIds: ids };
  }
  if (actor.groups !== null) {
    if (input.groupIds === null && actor.groups.length === 0 && actor.vehicles.length > 0) return { groupIds: null, vehicleIds: [...actor.vehicles] };
    const chosen = input.groupIds ?? actor.groups;
    if (chosen.length === 0 || chosen.some((g) => !actor.groups?.includes(g))) throw forbidden(say("api.notifications.onlyYourVehicles"));
    return { groupIds: [...new Set(chosen)], vehicleIds: null };
  }
  if (input.groupIds === null) return { groupIds: null, vehicleIds: null };
  const ids = [...new Set(input.groupIds)];
  const r = await db.query(`SELECT 1 FROM gps.vehicle_groups WHERE org_id = $1 AND id = ANY($2::uuid[])`, [actor.orgId, ids]);
  if (r.rowCount !== ids.length) throw badRequest(say("api.notifications.groupsGone"));
  return { groupIds: ids, vehicleIds: null };
}

/** What the notification names must exist in the account, and its channel must be one the platform has connected. */
async function check(deps: Pick<NotifyDeps, "db" | "config">, actor: Actor, data: Input, before: string[]): Promise<void> {
  const db = deps.db.core;
  const problem = channelProblem(deps.config, data.channel, "chooseOther");
  if (problem) throw badRequest(problem);
  const roles = new Set(["owner", ...(await listRoles(db, actor.orgId, deps.config.defaultLanguage)).map((r) => r.id)]);
  if (data.roles.some((role) => !roles.has(role))) throw badRequest(say("api.notifications.rolesGone"));
  if (data.userIds.length > 0) {
    const r = await db.query(`SELECT 1 FROM auth.member WHERE "organizationId" = $1 AND "userId" = ANY($2::text[])`, [actor.orgId, [...new Set(data.userIds)]]);
    if (r.rowCount !== new Set(data.userIds).size) throw badRequest(say("api.notifications.peopleGone"));
  }
  if (data.ruleIds) {
    const r = await db.query(`SELECT 1 FROM gps.alert_rules WHERE org_id = $1 AND id = ANY($2::uuid[])`, [actor.orgId, [...new Set(data.ruleIds)]]);
    if (r.rowCount !== new Set(data.ruleIds).size) throw badRequest(say("api.notifications.alertsGone"));
  }
  // An address written by hand takes the notifications out of the account: only whoever sees all of it decides that.
  const changed = JSON.stringify([...data.addresses].sort()) !== JSON.stringify([...before].sort());
  if (actor.groups !== null && changed) throw forbidden(say("api.notifications.addressesWholeAccount"));
}

export async function saveNotification(deps: Pick<NotifyDeps, "db" | "config">, actor: Actor, id: string | null, data: Input): Promise<AccountNotification[]> {
  const db = deps.db.core;
  const before = id === null ? null : await rowOf(db, actor, id);
  await check(deps, actor, data, before ? addressesOf(deps.config, before.addresses) : []);
  const scope = await resolveScope(db, actor, data);
  const written = WRITTEN_CHANNELS.includes(data.channel) ? [...new Set(data.addresses)] : [];
  const values = [
    data.name,
    data.channel,
    data.active,
    data.everyone,
    [...new Set(data.roles)],
    [...new Set(data.userIds)],
    written.length > 0 ? vaultOf(deps.config).seal(JSON.stringify(written)) : null,
    data.events ? [...new Set(data.events)] : null,
    data.ruleIds ? [...new Set(data.ruleIds)] : null,
    scope.groupIds,
    scope.vehicleIds,
    data.zone,
  ];
  if (id === null) {
    const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.notifications WHERE org_id = $1`, [actor.orgId]);
    if ((count.rows[0]?.n ?? 0) >= NOTIFICATIONS_MAX) throw badRequest(say("api.notifications.max", { max: NOTIFICATIONS_MAX }));
    await db.query(
      `INSERT INTO gps.notifications (org_id, name, channel, active, everyone, roles, user_ids, addresses, events, rule_ids, group_ids, vehicle_ids, zone, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11::uuid[], $12::uuid[], $13, $14)`,
      [actor.orgId, ...values, actor.userId],
    );
  } else {
    await db.query(
      `UPDATE gps.notifications SET name = $3, channel = $4, active = $5, everyone = $6, roles = $7, user_ids = $8, addresses = $9, events = $10,
              rule_ids = $11::uuid[], group_ids = $12::uuid[], vehicle_ids = $13::uuid[], zone = $14, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [id, actor.orgId, ...values],
    );
  }
  await audit(db, actor, id === null ? "notification.create" : "notification.update", "account", actor.orgId, { name: data.name, channel: data.channel });
  return listNotifications(deps, actor);
}

export async function deleteNotification(deps: Pick<NotifyDeps, "db" | "config">, actor: Actor, id: string): Promise<void> {
  const before = await rowOf(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.notifications WHERE id = $1 AND org_id = $2`, [id, actor.orgId]);
  await audit(deps.db.core, actor, "notification.delete", "account", actor.orgId, { name: before.name, channel: before.channel });
}

// ─── Who receives ────────────────────────────────────────────────────────────

interface Target {
  target: string;
  label: string;
  /** The language its message is written in: the person's, or the platform's for an address written by hand. */
  language: Language;
}

/**
 * Where a notification's messages go. With a vehicle, only the people who see
 * it; without one (a test), all the people it names.
 */
async function targetsOf(deps: Pick<NotifyDeps, "db" | "config">, orgId: string, n: Row, vehicle: { id: string; groupId: string | null } | null): Promise<Target[]> {
  const db = deps.db.core;
  const out = new Map<string, Target>();
  if (n.everyone || n.roles.length > 0 || n.user_ids.length > 0) {
    const people = await db.query<{ name: string; email: string; phone: string | null; language: string | null }>(
      `SELECT u.name, u.email, us.phone, us.language
         FROM auth.member m
         JOIN auth."user" u ON u.id = m."userId"
         LEFT JOIN gps.member_access a ON a.org_id = m."organizationId" AND a.user_id = u.id
         LEFT JOIN gps.user_settings us ON us.user_id = u.id
        WHERE m."organizationId" = $1
          AND u."emailVerified" AND NOT COALESCE(u.banned, false) AND NOT COALESCE(a.disabled, false)
          AND ($2 OR u.id = ANY($3::text[]) OR ${ROLE_SQL} = ANY($4::text[]))
          AND ($5::uuid IS NULL OR m.role IN ('owner', 'admin') OR a.group_scope IS NULL
               OR $6::uuid = ANY(gps.groups_with_children(a.group_scope)) OR $5::uuid = ANY(a.vehicle_scope))`,
      [orgId, n.everyone, n.user_ids, n.roles, vehicle?.id ?? null, vehicle?.groupId ?? null],
    );
    // The custom channel speaks of each person only if what its owner wrote uses their details; otherwise one message is enough.
    const custom = n.channel === "webhook" ? customAudience(deps.config.channels.webhook) : null;
    for (const p of people.rows) {
      const language = knownLanguage(p.language) ?? deps.config.defaultLanguage;
      if (n.channel === "email") out.set(p.email, { target: p.email, label: p.email, language });
      else if (n.channel === "sms" && p.phone) out.set(p.phone, { target: p.phone, label: addressLabel(n.channel, p.phone), language });
      else if (custom && !custom.perPerson) {
        out.set("", { target: recipientTarget({}), label: custom.label, language: deps.config.defaultLanguage });
        break;
      } else if (custom && (p.phone || !custom.needsPhone)) {
        out.set(p.email, { target: recipientTarget({ name: p.name, email: p.email, ...(p.phone ? { phone: p.phone } : {}), language }), label: p.name || p.email, language });
      }
      // Push: the mobile app will say where each person receives them. Until it exists, nobody has where.
    }
  }
  if (!WRITTEN_CHANNELS.includes(n.channel)) return [...out.values()];
  for (const address of addressesOf(deps.config, n.addresses)) {
    // Someone who also is a person of the account keeps their own language.
    if (!out.has(address)) out.set(address, { target: address, label: addressLabel(n.channel, address), language: deps.config.defaultLanguage });
  }
  return [...out.values()];
}

/** Messages each account can send per month through a paid channel; null = no cap. */
function capOf(config: Pick<Config, "channels">, channel: NotifyChannel): number | null {
  return channel === "sms" ? config.channels.sms.monthlyCap : null;
}

/** Why an account cannot send that many more messages through a channel right now, or null if it can. */
export async function capProblem(db: Queryable, config: Pick<Config, "channels" | "alertEmailsPerHour">, orgId: string, channel: NotifyChannel, count: number, now = Date.now()): Promise<Say | null> {
  if (channel === "email") {
    const sent = await sentSince(db, orgId, "email", new Date(now - 3_600_000));
    return sent + count > config.alertEmailsPerHour ? say("mail.cap.emailHour") : null;
  }
  const cap = capOf(config, channel);
  if (cap === null) return null;
  const sent = await sentSince(db, orgId, channel, monthStart(now));
  return sent + count > cap ? say("mail.cap.monthly") : null;
}

// ─── Sending ─────────────────────────────────────────────────────────────────

/** A test message to everyone the notification names. Returns its latest messages. */
export async function testNotification(deps: Pick<NotifyDeps, "db" | "config" | "outbox">, actor: Actor, id: string): Promise<Delivery[]> {
  const db = deps.db.core;
  const n = await rowOf(db, actor, id);
  const problem = channelProblem(deps.config, n.channel);
  if (problem) throw badRequest(problem);
  const targets = await targetsOf(deps, actor.orgId, n, null);
  if (targets.length === 0) {
    throw badRequest(
      say(n.channel === "email" ? "api.notifications.noTargets" : n.channel === "push" ? "api.notifications.noPushYet" : "api.notifications.noTargetsOnChannel"),
    );
  }
  const capped = await capProblem(db, deps.config, actor.orgId, n.channel, targets.length);
  if (capped) throw badRequest(capped);
  await deps.outbox.enqueue(
    targets.map((t) => ({ orgId: actor.orgId, source: "test" as const, sourceId: n.id, channel: n.channel, target: t.target, label: t.label, topic: "test", message: notificationTestMessage(deps.config, n.name, t.language), once: true })),
  );
  await deps.outbox.deliverDue();
  return listDeliveries(db, { orgId: actor.orgId, sourceId: n.id, limit: 20 });
}

/** The test message of one of the account's notifications, in a language. */
export function notificationTestMessage(config: Pick<Config, "appName" | "publicUrl">, name: string, language: Language): Message {
  return {
    title: tr(language, "mail.notificationTest.title", { app: config.appName }),
    body: tr(language, "mail.notificationTest.body", { name }),
    action: { label: tr(language, "mail.action.platform"), url: config.publicUrl },
    language,
    data: { type: "test", label: tr(language, "mail.notificationTest.label"), createdAt: new Date().toISOString(), event: null },
  };
}

/** The message that tells an event, as a notification sends it, in a language. `sender` says who sends it. */
export function eventMessage(config: Pick<Config, "publicUrl">, event: VehicleEvent, zone: string, sender: Say | string, language: Language): Message {
  const title = `${event.vehicleName}: ${tr(language, `shared.event.${event.type}`).toLowerCase()}`;
  const clock = createClock(zone, language);
  return {
    title,
    body: tr(language, "mail.event.body", { what: describeEvent(event, language), at: clock.human(Date.parse(event.at)), zone: zone.replace(/_/g, " "), sender: render(language, sender) }),
    action: { label: tr(language, "mail.action.map"), url: config.publicUrl },
    language,
    data: eventPayload(event, language),
  };
}

export function createNotifier(deps: NotifyDeps): Notifier {
  const { db, bus, config, outbox } = deps;
  let queue: Promise<unknown> = Promise.resolve();
  let off: (() => void) | null = null;

  /** The alerts an event belongs to: the one that raised it or, for a geofence event, the geofence alerts that cover it. */
  async function rulesOf(payload: CoreEvents["event"]): Promise<string[]> {
    const { event } = payload;
    if (payload.ruleId) return [payload.ruleId];
    if (!GEOFENCE_EVENTS.includes(event.type)) return [];
    const r = await db.core.query<{ id: string; schedule: WeekSchedule | null }>(
      `SELECT r.id, r.schedule
         FROM gps.alert_rules r
        WHERE r.org_id = $1 AND r.active AND r.type = 'geofence'
          AND (r.params->'geofenceIds' IS NULL OR r.params->'geofenceIds' = 'null'::jsonb OR r.params->'geofenceIds' ? $2)
          AND (CASE WHEN r.vehicle_ids IS NOT NULL THEN $3::uuid = ANY(r.vehicle_ids)
                    ELSE r.group_ids IS NULL OR $4::uuid = ANY(gps.groups_with_children(r.group_ids)) END)`,
      [payload.orgId, event.geofenceId ?? "", event.vehicleId, payload.groupId],
    );
    return r.rows.filter((rule) => activeSince(rule.schedule, Date.parse(event.at)) !== null).map((rule) => rule.id);
  }

  async function handle(payload: CoreEvents["event"]): Promise<void> {
    const { event, orgId } = payload;
    if (!ALERT_EVENTS.includes(event.type)) return;
    const rules = await rulesOf(payload);
    const matching = await db.core.query<Row>(
      `${SELECT}
        WHERE n.org_id = $1 AND n.active
          AND (n.events IS NULL OR $2 = ANY(n.events))
          AND (n.rule_ids IS NULL OR n.rule_ids && $3::uuid[])
          AND (CASE WHEN n.vehicle_ids IS NOT NULL THEN $4::uuid = ANY(n.vehicle_ids)
                    ELSE n.group_ids IS NULL OR $5::uuid = ANY(gps.groups_with_children(n.group_ids)) END)
        ORDER BY n.created_at, n.id`,
      [orgId, event.type, rules, event.vehicleId, payload.groupId],
    );
    if (matching.rows.length === 0) return;
    // Two notifications that name the same person tell them once.
    const told = new Set<string>();
    let queued = 0;
    for (const n of matching.rows) {
      if (channelProblem(config, n.channel)) continue;
      const targets = (await targetsOf(deps, orgId, n, { id: event.vehicleId, groupId: payload.groupId })).filter((t) => !told.has(`${n.channel}:${t.target}`));
      if (targets.length === 0) continue;
      for (const t of targets) told.add(`${n.channel}:${t.target}`);
      // One message per language among those who receive it.
      const sender = say("mail.event.sentByNotification", { name: n.name });
      const messages = new Map<Language, Message>();
      const messageIn = (language: Language) => {
        let message = messages.get(language);
        if (!message) {
          message = eventMessage(config, event, n.zone, sender, language);
          messages.set(language, message);
        }
        return message;
      };
      const items: OutboxItem[] = targets.map((t) => ({ orgId, source: "notification", sourceId: n.id, channel: n.channel, target: t.target, label: t.label, topic: event.type, message: messageIn(t.language) }));
      const capped = await capProblem(db.core, config, orgId, n.channel, targets.length);
      if (capped) {
        console.warn(`[notify] account ${orgId}: ${render("en", capped)}; "${event.type}" is not sent by ${n.channel}`);
        // On a paid channel the account sees in its log what was not sent; a flood of emails is not written down one by one.
        if (PAID_CHANNELS.includes(n.channel)) await outbox.enqueue(items.map((item) => ({ ...item, refused: capped })));
        continue;
      }
      await outbox.enqueue(items);
      queued += items.length;
    }
    if (queued > 0) await outbox.deliverDue();
  }

  return {
    start() {
      off = bus.on("event", (payload) => {
        queue = queue.then(() => handle(payload)).catch((err: Error) => console.error("[notify] a notification failed:", err.message));
      });
    },
    stop() {
      off?.();
      off = null;
    },
    idle: () => queue.then(() => outbox.idle()),
  };
}
