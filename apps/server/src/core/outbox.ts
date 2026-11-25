// The platform's outbox. Every message that leaves through a channel is
// queued here, tried right away, retried with growing spacing if it fails,
// and kept as the log of what was sent and how it went.
import { type Delivery, type DeliveryStatus, type NotifyChannel, WEBHOOK_MAX_ATTEMPTS, addressLabel } from "@opengps/shared";
import type { Config } from "../config";
import type { Db, Queryable } from "../db";
import { type Say, render, say } from "../i18n";
import type { Mailer } from "../mail";
import { type Message, type SendResult, sendThrough } from "./channels";
import type { OutboundOptions } from "./outbound";
import { createVault } from "./secrets";

/** What produced a message: it decides which log it shows in. */
export type OutboxSource = "notification" | "system" | "automation" | "webhook" | "test";

/** Minutes to wait after each failed attempt before the next one. */
const BACKOFF_MIN = [1, 5, 30, 120, 360];
/** Days a delivered or failed message stays in the log. */
const KEEP_DAYS = 45;
/** Messages kept in the log of each thing that sends them. */
const KEEP_PER_SOURCE = 200;

export interface OutboxItem {
  /** null: a message of the platform itself. */
  orgId: string | null;
  source: OutboxSource;
  sourceId: string | null;
  channel: NotifyChannel;
  /** Where it goes: an email, a phone or, in the custom channel, whoever receives it (see `recipientTarget`). */
  target: string;
  /** How the log names where it went; by default, the address without what is a secret. */
  label?: string;
  topic: string;
  message: Message;
  /** A test is not retried: its result is wanted now. */
  once?: boolean;
  /** It is not sent: it goes straight to the log as refused, with this reason (a cap reached, for example). */
  refused?: Say | string;
}

/** A queued row, for a source that delivers its own way (module I's signed webhooks). */
export interface OutboxRow {
  id: number;
  orgId: string | null;
  sourceId: string | null;
  topic: string;
  payload: Record<string, unknown>;
}
export type OutboxHandler = (row: OutboxRow, now: number) => Promise<SendResult & { /** Not worth trying again. */ final?: boolean }>;

export interface Outbox {
  /** Queues messages. They go out on the next `deliverDue`. Returns their ids. */
  enqueue(items: OutboxItem[], now?: number): Promise<number[]>;
  /** Queues a row a source delivers its own way. */
  enqueueRaw(row: { orgId: string | null; source: OutboxSource; sourceId: string; label: string; topic: string; payload: Record<string, unknown> }, now?: number): Promise<number>;
  /** Tries what is pending and due. Returns how many it attempted. */
  deliverDue(now?: number): Promise<number>;
  /** A source that delivers its rows itself instead of through a channel. */
  handle(source: OutboxSource, handler: OutboxHandler): void;
  /** Called when a message runs out of attempts. */
  onFailed(listener: (failure: { channel: NotifyChannel; source: OutboxSource; orgId: string | null; error: string }) => void): void;
  /** Trims the log. */
  prune(now?: number): Promise<void>;
  /** Ends when nothing is being delivered. */
  idle(): Promise<void>;
}

interface Due {
  id: string;
  org_id: string | null;
  source: OutboxSource;
  source_id: string | null;
  channel: NotifyChannel;
  target: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export function createOutbox(deps: { db: Db; config: Config; mailer: Mailer }): Outbox {
  const db = deps.db.core;
  const vault = createVault(deps.config.authSecret);
  const handlers = new Map<OutboxSource, OutboxHandler>();
  const failed: ((failure: { channel: NotifyChannel; source: OutboxSource; orgId: string | null; error: string }) => void)[] = [];
  // Only on the real server are internal addresses denied: in development and in tests, the other system is the machine itself.
  const outbound = (): OutboundOptions => ({ allowInternal: !deps.config.isProduction });
  // One delivery pass at a time: two at once would send the same message twice.
  let running: Promise<unknown> = Promise.resolve();

  async function pass(now: number): Promise<number> {
    const due = await db.query<Due>(
      `SELECT id, org_id, source, source_id, channel, target, topic, payload, attempts
         FROM gps.outbox WHERE status = 'pending' AND next_at <= $1 ORDER BY id LIMIT 50`,
      [new Date(now)],
    );
    for (const row of due.rows) {
      const attempts = row.attempts + 1;
      let result: SendResult & { final?: boolean };
      const handler = handlers.get(row.source);
      if (handler) {
        result = await handler({ id: Number(row.id), orgId: row.org_id, sourceId: row.source_id, topic: row.topic, payload: row.payload }, now).catch((err: Error) => ({ code: null, error: err.message.slice(0, 200) || say("mail.delivery.failed") }));
      } else {
        const target = vault.open(row.target);
        result =
          target === null
            ? { code: null, error: say("mail.delivery.unreadableTarget"), final: true }
            : await sendThrough({ config: deps.config, mailer: deps.mailer, outbound: outbound() }, row.channel, target, row.payload as unknown as Message);
      }
      // The log keeps the reason already written.
      const error = result.error === null ? null : render(deps.config.defaultLanguage, result.error); // i18n: stored text
      const wait = BACKOFF_MIN[attempts - 1];
      const once = (row.payload as { once?: boolean }).once === true;
      const status: DeliveryStatus = result.error === null ? "ok" : result.final || once || attempts >= WEBHOOK_MAX_ATTEMPTS || wait === undefined ? "failed" : "pending";
      await db.query(`UPDATE gps.outbox SET status = $2, attempts = $3, last_code = $4, last_error = $5, next_at = $6, done_at = $7 WHERE id = $1`, [
        row.id,
        status,
        attempts,
        result.code,
        error,
        new Date(now + (wait ?? 0) * 60_000),
        status === "pending" ? null : new Date(now),
      ]);
      if (status === "failed") for (const listener of failed) listener({ channel: row.channel, source: row.source, orgId: row.org_id, error: error ?? "" });
    }
    return due.rows.length;
  }

  return {
    async enqueue(items, now = Date.now()) {
      const ids: number[] = [];
      for (const item of items) {
        // The queue time is set by this process, which later decides what is due: so it does not depend on the database clock.
        const r = await db.query<{ id: string }>(
          `INSERT INTO gps.outbox (org_id, source, source_id, channel, target, label, topic, payload, next_at, created_at, status, last_error, done_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, $10, $11, $12) RETURNING id`,
          [
            item.orgId,
            item.source,
            item.sourceId,
            item.channel,
            vault.seal(item.target),
            item.label ?? addressLabel(item.channel, item.target),
            item.topic,
            JSON.stringify(item.once ? { ...item.message, once: true } : item.message),
            new Date(now),
            item.refused ? "failed" : "pending",
            item.refused ? render(deps.config.defaultLanguage, item.refused) : null, // i18n: stored text
            item.refused ? new Date(now) : null,
          ],
        );
        ids.push(Number((r.rows[0] as { id: string }).id));
      }
      return ids;
    },
    async enqueueRaw(row, now = Date.now()) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO gps.outbox (org_id, source, source_id, channel, target, label, topic, payload, next_at, created_at)
         VALUES ($1, $2, $3, 'webhook', '', $4, $5, $6::jsonb, $7, $7) RETURNING id`,
        [row.orgId, row.source, row.sourceId, row.label, row.topic, JSON.stringify(row.payload), new Date(now)],
      );
      return Number((r.rows[0] as { id: string }).id);
    },
    deliverDue(now = Date.now()) {
      const turn = running.then(() => pass(now));
      running = turn.catch((err: Error) => console.error("[outbox] a delivery pass failed:", err.message));
      return turn;
    },
    handle(source, handler) {
      handlers.set(source, handler);
    },
    onFailed(listener) {
      failed.push(listener);
    },
    async prune(now = Date.now()) {
      await db.query(`DELETE FROM gps.outbox WHERE status <> 'pending' AND created_at < $1`, [new Date(now - KEEP_DAYS * 24 * 60 * 60_000)]);
      await db.query(
        `DELETE FROM gps.outbox d USING (
           SELECT id, row_number() OVER (PARTITION BY source, source_id ORDER BY id DESC) AS n FROM gps.outbox WHERE status <> 'pending' AND source_id IS NOT NULL
         ) old WHERE old.id = d.id AND old.n > $1`,
        [KEEP_PER_SOURCE],
      );
    },
    idle: () => running.then(() => undefined),
  };
}

// ─── The log ─────────────────────────────────────────────────────────────────

interface LogRow {
  id: string;
  created_at: Date;
  channel: NotifyChannel;
  label: string;
  title: string | null;
  topic: string;
  source: Delivery["source"];
  name: string | null;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  next_at: Date;
}

/**
 * The latest messages of an account, or of the platform itself with `orgId`
 * null. Module I's webhooks keep their own log and do not show here.
 */
export async function listDeliveries(db: Queryable, filter: { orgId: string | null; sourceId?: string; limit?: number }): Promise<Delivery[]> {
  const r = await db.query<LogRow>(
    `SELECT o.id, o.created_at, o.channel, o.label, o.payload->>'title' AS title, o.topic, o.source, COALESCE(n.name, s.name) AS name, o.status, o.attempts, o.last_error, o.next_at
       FROM gps.outbox o
       LEFT JOIN gps.notifications n ON o.source IN ('notification', 'test') AND n.id = o.source_id
       LEFT JOIN gps.system_notifications s ON o.source IN ('system', 'test') AND s.id = o.source_id
      WHERE o.org_id IS NOT DISTINCT FROM $1 AND o.source <> 'webhook' AND ($2::uuid IS NULL OR o.source_id = $2)
      ORDER BY o.id DESC LIMIT $3`,
    [filter.orgId, filter.sourceId ?? null, Math.min(filter.limit ?? 50, 200)],
  );
  return r.rows.map((d) => ({
    id: Number(d.id),
    at: d.created_at.toISOString(),
    channel: d.channel,
    to: d.label,
    title: d.title ?? d.topic,
    source: d.source,
    name: d.name,
    status: d.status,
    attempts: d.attempts,
    error: d.last_error,
    nextAt: d.status === "pending" ? d.next_at.toISOString() : null,
  }));
}

/** Messages an account has queued or sent through a channel since a moment: what its caps count. Failed ones do not count. */
export async function sentSince(db: Queryable, orgId: string, channel: NotifyChannel, since: Date): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.outbox WHERE org_id = $1 AND channel = $2 AND created_at >= $3 AND status <> 'failed' AND source <> 'webhook'`, [orgId, channel, since]);
  return r.rows[0]?.n ?? 0;
}
