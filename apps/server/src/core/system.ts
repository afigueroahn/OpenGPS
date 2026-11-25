// The platform's own notifications, for whoever runs it: a backup that
// failed, a disk filling up, a channel that stopped delivering. Each one is a
// destination plus the things it wants to hear about.
import {
  type AddressChannel,
  type Delivery,
  type DeliveryStatus,
  type Language,
  type NotifyChannel,
  SYSTEM_NOTIFICATIONS_MAX,
  type SystemEvent,
  type SystemNotification,
  addressLabel,
  type systemNotificationSchema,
} from "@opengps/shared";
import type { z } from "zod";
import type { Config } from "../config";
import type { Db } from "../db";
import { badRequest, notFound } from "../errors";
import { type Say, render, say, tr } from "../i18n";
import { isUuid } from "./access";
import { audit } from "./audit";
import { type Message, channelProblem, customAudience, recipientTarget, writtenRecipient } from "./channels";
import { type Outbox, type OutboxItem, listDeliveries } from "./outbox";
import { createVault } from "./secrets";

type Input = z.output<typeof systemNotificationSchema>;
export interface SystemActor {
  userId: string;
  ip?: string | null;
}

/**
 * What is told: a title and what it means, in words. A text of the catalogs is
 * said in the language of whoever receives it; the title follows the platform's
 * name, so it starts in lowercase ("OpenGPS: a new account was created").
 */
export interface SystemMessage {
  title: Say | string;
  body: Say | string;
  /** Where in the console to look at it. */
  path?: string;
}

export interface SystemNotifier {
  /** Tells whoever asked to hear about that. It never throws: a notification that fails must not break what it tells about. */
  notify(event: SystemEvent, message: SystemMessage): Promise<void>;
  list(): Promise<SystemNotification[]>;
  save(id: string | null, data: Input, actor: SystemActor): Promise<SystemNotification[]>;
  remove(id: string, actor: SystemActor): Promise<void>;
  /** Sends a test message to one of them now. Returns the latest messages. */
  test(id: string): Promise<Delivery[]>;
  log(): Promise<Delivery[]>;
}

/** What still reaches the server's operations email while nobody has set up a notification. */
const BOOTSTRAP: readonly SystemEvent[] = ["backup_failed", "disk_high", "ingest_stalled", "channel_failing"];
/** Final failures of a channel within the hour that count as "it is failing". */
const FAILING_AFTER = 3;
const HOUR = 3_600_000;

interface Row {
  id: string;
  name: string;
  channel: AddressChannel;
  target: string;
  events: SystemEvent[];
  active: boolean;
  last_status: DeliveryStatus | null;
  last_at: Date | null;
}
const SELECT = `SELECT s.id, s.name, s.channel, s.target, s.events, s.active, d.status AS last_status, COALESCE(d.done_at, d.created_at) AS last_at
  FROM gps.system_notifications s
  LEFT JOIN LATERAL (SELECT status, done_at, created_at FROM gps.outbox WHERE source = 'system' AND source_id = s.id ORDER BY id DESC LIMIT 1) d ON true`;

export function createSystemNotifier(deps: { db: Db; config: Config; outbox: Outbox }): SystemNotifier {
  const { config, outbox } = deps;
  const db = deps.db.core;
  const vault = createVault(config.authSecret);
  const failures = new Map<NotifyChannel, number[]>();
  const warned = new Map<NotifyChannel, number>();

  /** Where a message goes and how the log names it. In the custom channel, what was written only fills its variables. */
  const destinationOf = (channel: NotifyChannel, written: string): { target: string; label: string } =>
    channel === "webhook"
      ? { target: recipientTarget(writtenRecipient(written)), label: written ? addressLabel(channel, written) : customAudience(config.channels.webhook).label }
      : { target: written, label: addressLabel(channel, written) };

  const messageOf = (m: SystemMessage, language: Language): Message => ({
    title: `${config.appName}: ${render(language, m.title)}`,
    body: render(language, m.body),
    action: { label: tr(language, "mail.action.console"), url: `${config.publicUrl}${m.path ?? "/admin"}` },
    language,
    data: null,
  });

  /** The test message of one of them, in a language. */
  const testMessageOf = (name: string, language: Language): Message => ({
    ...messageOf({ title: say("mail.systemTest.title"), body: say("mail.systemTest.body", { name }), path: "/admin/system/notifications" }, language),
    data: { type: "test", label: tr(language, "mail.notificationTest.label"), createdAt: new Date().toISOString() },
  });

  async function notify(event: SystemEvent, m: SystemMessage): Promise<void> {
    try {
      const rows = await db.query<{ id: string; channel: NotifyChannel; target: string }>(
        `SELECT s.id, s.channel, s.target FROM gps.system_notifications s WHERE s.active AND $1 = ANY(s.events)`,
        [event],
      );
      const language = config.defaultLanguage; // The platform's own notifications are written in its language.
      const message = { ...messageOf(m, language), data: { type: event, label: tr(language, `shared.systemEvent.${event}`), createdAt: new Date().toISOString() } };
      const items: OutboxItem[] = rows.rows.flatMap((row) => {
        const target = vault.open(row.target);
        return target === null ? [] : [{ orgId: null, source: "system" as const, sourceId: row.id, channel: row.channel, ...destinationOf(row.channel, target), topic: event, message }];
      });
      // With no notification set up yet, problems still reach the operations email the server was installed with.
      if (items.length === 0 && config.alertEmail && BOOTSTRAP.includes(event)) {
        const any = await db.query(`SELECT 1 FROM gps.system_notifications LIMIT 1`);
        if (!any.rowCount) items.push({ orgId: null, source: "system", sourceId: null, channel: "email", target: config.alertEmail, topic: event, message });
      }
      if (items.length === 0) return;
      await outbox.enqueue(items);
      await outbox.deliverDue();
    } catch (err) {
      console.error(`[system] could not notify "${event}":`, (err as Error).message);
    }
  }

  // A channel that keeps failing for the accounts is something the owner wants to know: once a day per channel.
  outbox.onFailed((failure) => {
    if (failure.source === "system" || failure.source === "webhook") return;
    const now = Date.now();
    const recent = [...(failures.get(failure.channel) ?? []).filter((t) => now - t < HOUR), now];
    failures.set(failure.channel, recent);
    if (recent.length < FAILING_AFTER || now - (warned.get(failure.channel) ?? 0) < 24 * HOUR) return;
    warned.set(failure.channel, now);
    const language = config.defaultLanguage; // The platform's own notifications are written in its language.
    const channel = tr(language, `shared.channel.${failure.channel}`);
    void notify("channel_failing", {
      title: tr(language, "mail.system.channelFailing.title", { channel }),
      body: tr(language, "mail.system.channelFailing.body", { n: recent.length, channel, reason: failure.error || tr(language, "mail.system.channelFailing.noDetail") }),
      path: "/admin/system/channels",
    });
  });

  async function list(): Promise<SystemNotification[]> {
    const r = await db.query<Row>(`${SELECT} ORDER BY s.created_at, s.id`);
    return r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      channel: row.channel,
      target: vault.open(row.target) ?? "",
      events: row.events,
      active: row.active,
      last: row.last_status && row.last_at ? { status: row.last_status, at: row.last_at.toISOString() } : null,
    }));
  }

  async function rowOf(id: string): Promise<Row> {
    if (!isUuid(id)) throw notFound(say("api.notifications.notFound"));
    const r = await db.query<Row>(`${SELECT} WHERE s.id = $1`, [id]);
    if (!r.rows[0]) throw notFound(say("api.notifications.notFound"));
    return r.rows[0];
  }

  return {
    notify,
    list,
    async save(id, data, actor) {
      const problem = channelProblem(config, data.channel, "connectFirst");
      if (problem) throw badRequest(problem);
      if (id !== null) await rowOf(id);
      const values = [data.name, data.channel, vault.seal(data.target), data.target ? addressLabel(data.channel, data.target) : "", [...new Set(data.events)], data.active];
      if (id === null) {
        const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.system_notifications`);
        if ((count.rows[0]?.n ?? 0) >= SYSTEM_NOTIFICATIONS_MAX) throw badRequest(say("api.notifications.systemMax", { max: SYSTEM_NOTIFICATIONS_MAX }));
        await db.query(`INSERT INTO gps.system_notifications (name, channel, target, label, events, active, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [...values, actor.userId]);
      } else {
        await db.query(`UPDATE gps.system_notifications SET name = $2, channel = $3, target = $4, label = $5, events = $6, active = $7, updated_at = now() WHERE id = $1`, [id, ...values]);
      }
      await audit(db, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, id === null ? "admin.notification.create" : "admin.notification.update", "platform", "notifications", { name: data.name, channel: data.channel });
      return list();
    },
    async remove(id, actor) {
      const before = await rowOf(id);
      await db.query(`DELETE FROM gps.system_notifications WHERE id = $1`, [id]);
      await audit(db, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.notification.delete", "platform", "notifications", { name: before.name, channel: before.channel });
    },
    async test(id) {
      const row = await rowOf(id);
      const problem = channelProblem(config, row.channel);
      if (problem) throw badRequest(problem);
      const target = vault.open(row.target);
      if (target === null) throw badRequest(say("mail.delivery.unreadableTarget"));
      const message = testMessageOf(row.name, config.defaultLanguage);
      await outbox.enqueue([{ orgId: null, source: "test", sourceId: row.id, channel: row.channel, ...destinationOf(row.channel, target), topic: "test", message, once: true }]);
      await outbox.deliverDue();
      return listDeliveries(db, { orgId: null, sourceId: row.id, limit: 20 });
    },
    log: () => listDeliveries(db, { orgId: null }),
  };
}
