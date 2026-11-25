// Integrations: webhooks. When something happens on the account, the address
// the account specified is notified, with a signature so the other system knows
// the notification is ours. They wait in the platform's outbox, which retries
// what is not delivered with increasing spacing and keeps the log.
import { createHmac } from "node:crypto";
import { type EventType, type Language, WEBHOOKS_MAX, type VehicleEvent, type Webhook, type WebhookDelivery, type WebhookDeliveryStatus, type webhookSchema } from "@opengps/shared";
import type { z } from "zod";
import { isUuid } from "../../core/access";
import { audit } from "../../core/audit";
import { eventPayload } from "../../core/notify";
import { OutboundError, postJson } from "../../core/outbound";
import type { OutboxHandler } from "../../core/outbox";
import { createVault } from "../../core/secrets";
import type { Actor } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { badRequest, notFound } from "../../errors";
import { type Say, say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";
import { newSecret } from "./keys";

type Deps = Pick<ModuleDeps, "db" | "config">;

interface Row {
  id: string;
  name: string;
  url: string;
  headers: string | null;
  events: EventType[] | null;
  active: boolean;
  created_at: Date;
  last_status: WebhookDeliveryStatus | null;
  last_at: Date | null;
  last_code: number | null;
}
const SELECT = `SELECT w.id, w.name, w.url, w.headers, w.events, w.active, w.created_at, d.status AS last_status, COALESCE(d.done_at, d.created_at) AS last_at, d.last_code
  FROM gps.webhooks w
  LEFT JOIN LATERAL (SELECT status, done_at, created_at, last_code FROM gps.outbox WHERE source = 'webhook' AND source_id = w.id ORDER BY id DESC LIMIT 1) d ON true`;

type Header = { name: string; value: string };
const vaultOf = (deps: Pick<ModuleDeps, "config">) => createVault(deps.config.authSecret);
function headersOf(deps: Pick<ModuleDeps, "config">, sealed: string | null): Header[] {
  try {
    const list: unknown = JSON.parse(vaultOf(deps).open(sealed) ?? "[]");
    return Array.isArray(list) ? (list as Header[]) : [];
  } catch {
    return [];
  }
}

export async function listWebhooks(deps: Deps, orgId: string): Promise<Webhook[]> {
  const r = await deps.db.core.query<Row>(`${SELECT} WHERE w.org_id = $1 ORDER BY w.created_at`, [orgId]);
  return r.rows.map((w) => ({
    id: w.id,
    name: w.name,
    url: w.url,
    events: w.events,
    active: w.active,
    headerNames: headersOf(deps, w.headers).map((h) => h.name),
    createdAt: w.created_at.toISOString(),
    last: w.last_status && w.last_at ? { status: w.last_status, at: w.last_at.toISOString(), code: w.last_code } : null,
  }));
}

async function webhookOf(db: Queryable, orgId: string, id: string): Promise<{ id: string; name: string; headers: string | null }> {
  if (!isUuid(id)) throw notFound(say("integrations.errors.webhookNotFound"));
  const r = await db.query<{ id: string; name: string; headers: string | null }>(`SELECT id, name, headers FROM gps.webhooks WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!r.rows[0]) throw notFound(say("integrations.errors.webhookNotFound"));
  return r.rows[0];
}

/** On the real server, delivery is only over an encrypted connection. */
function checkUrl(deps: Pick<ModuleDeps, "config">, url: string): void {
  if (deps.config.isProduction && !/^https:\/\//i.test(url)) throw badRequest(say("integrations.errors.httpsOnly"));
}

/**
 * Creates a webhook. Returns, this one time, the secret used to sign
 * each notification: the other system stores it to verify the signature.
 */
export async function createWebhook(deps: Deps, actor: Actor, data: z.output<typeof webhookSchema>): Promise<{ webhooks: Webhook[]; secret: string }> {
  const db = deps.db.core;
  checkUrl(deps, data.url);
  const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.webhooks WHERE org_id = $1`, [actor.orgId]);
  if ((count.rows[0]?.n ?? 0) >= WEBHOOKS_MAX) throw badRequest(say("integrations.errors.tooManyWebhooks", { max: WEBHOOKS_MAX }));
  const secret = newSecret("whsec");
  const vault = vaultOf(deps);
  await db.query(`INSERT INTO gps.webhooks (org_id, name, url, secret, headers, events, active, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
    actor.orgId,
    data.name,
    data.url,
    vault.seal(secret),
    data.headers?.length ? vault.seal(JSON.stringify(data.headers)) : null,
    data.events,
    data.active,
    actor.userId,
  ]);
  await audit(db, actor, "integrations.webhook.create", "account", actor.orgId, { name: data.name, url: data.url });
  return { webhooks: await listWebhooks(deps, actor.orgId), secret };
}

export async function updateWebhook(deps: Deps, actor: Actor, id: string, data: z.output<typeof webhookSchema>): Promise<Webhook[]> {
  const db = deps.db.core;
  const before = await webhookOf(db, actor.orgId, id);
  checkUrl(deps, data.url);
  // Without the field, the existing headers stay: their values do not go back to the screen.
  const headers = data.headers === undefined ? before.headers : data.headers.length ? vaultOf(deps).seal(JSON.stringify(data.headers)) : null;
  await db.query(`UPDATE gps.webhooks SET name = $2, url = $3, headers = $4, events = $5, active = $6 WHERE id = $1`, [id, data.name, data.url, headers, data.events, data.active]);
  await audit(db, actor, "integrations.webhook.update", "account", actor.orgId, { name: data.name, url: data.url, active: data.active });
  return listWebhooks(deps, actor.orgId);
}

/** Changes the signing secret: the previous one stops working. */
export async function rotateSecret(deps: Deps, actor: Actor, id: string): Promise<string> {
  const before = await webhookOf(deps.db.core, actor.orgId, id);
  const secret = newSecret("whsec");
  await deps.db.core.query(`UPDATE gps.webhooks SET secret = $2 WHERE id = $1`, [id, vaultOf(deps).seal(secret)]);
  await audit(deps.db.core, actor, "integrations.webhook.secret", "account", actor.orgId, { name: before.name });
  return secret;
}

export async function deleteWebhook(deps: Deps, actor: Actor, id: string): Promise<void> {
  const before = await webhookOf(deps.db.core, actor.orgId, id);
  await deps.db.core.query(`DELETE FROM gps.webhooks WHERE id = $1`, [id]);
  // Its log and what it had pending go with it.
  await deps.db.core.query(`DELETE FROM gps.outbox WHERE source = 'webhook' AND source_id = $1`, [id]);
  await audit(deps.db.core, actor, "integrations.webhook.delete", "account", actor.orgId, { name: before.name });
}

export async function listDeliveries(db: Queryable, orgId: string, id: string): Promise<WebhookDelivery[]> {
  await webhookOf(db, orgId, id);
  const r = await db.query<{ id: string; topic: string; status: WebhookDeliveryStatus; attempts: number; last_code: number | null; last_error: string | null; created_at: Date; done_at: Date | null; next_at: Date }>(
    `SELECT id, topic, status, attempts, last_code, last_error, created_at, done_at, next_at FROM gps.outbox WHERE source = 'webhook' AND source_id = $1 ORDER BY id DESC LIMIT 50`,
    [id],
  );
  return r.rows.map((d) => ({
    id: Number(d.id),
    topic: d.topic,
    status: d.status,
    attempts: d.attempts,
    code: d.last_code,
    error: d.last_error,
    createdAt: d.created_at.toISOString(),
    doneAt: d.done_at?.toISOString() ?? null,
    nextAt: d.status === "pending" ? d.next_at.toISOString() : null,
  }));
}

// ─── What is sent ────────────────────────────────────────────────────────────

/** Queues the notification of an event for each of the account's webhooks interested in it. `language`: the one its labels are written in. */
export async function enqueueEvent(db: Queryable, orgId: string, event: VehicleEvent, language: Language, now = Date.now()): Promise<number> {
  // The queue time is set by this process, which later decides what is due: so it does not depend on the database clock.
  const r = await db.query(
    `INSERT INTO gps.outbox (org_id, source, source_id, channel, target, label, topic, payload, next_at, created_at)
     SELECT w.org_id, 'webhook', w.id, 'webhook', '', w.name, $2, $3::jsonb, $4, $4 FROM gps.webhooks w WHERE w.org_id = $1 AND w.active AND (w.events IS NULL OR $2 = ANY(w.events))`,
    [orgId, event.type, JSON.stringify(eventPayload(event, language)), new Date(now)],
  );
  return r.rowCount ?? 0;
}

/** Queues a notification for a specific webhook, whether or not it is interested in that type: used by automations and the test. */
export async function enqueueFor(db: Queryable, orgId: string, webhookId: string, topic: string, payload: Record<string, unknown>, now = Date.now()): Promise<void> {
  await db.query(
    `INSERT INTO gps.outbox (org_id, source, source_id, channel, target, label, topic, payload, next_at, created_at)
     SELECT w.org_id, 'webhook', w.id, 'webhook', '', w.name, $3, $4::jsonb, $5, $5 FROM gps.webhooks w WHERE w.id = $2 AND w.org_id = $1`,
    [orgId, webhookId, topic, JSON.stringify(payload), new Date(now)],
  );
}

/** Sends a test notification now, to check that the other system receives it. `language`: the one its label is written in. */
export async function sendTest(deps: Deps & Pick<ModuleDeps, "outbox">, actor: Actor, id: string, language: Language): Promise<WebhookDelivery[]> {
  const db = deps.db.core;
  await webhookOf(db, actor.orgId, id);
  await enqueueFor(db, actor.orgId, id, "test", { type: "test", label: tr(language, "integrations.webhooks.testLabel"), createdAt: new Date().toISOString(), event: null });
  await deps.outbox.deliverDue();
  return listDeliveries(db, actor.orgId, id);
}

/** A notification's signature: the other system recalculates it with its copy of the secret. */
export const signatureOf = (secret: string, timestamp: number, body: string) => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/**
 * How the outbox delivers a webhook's rows: signed with its secret, with its
 * own headers, to the address the account wrote.
 */
export function webhookHandler(deps: Deps): OutboxHandler {
  const vault = vaultOf(deps);
  return async (row, now) => {
    const found = await deps.db.core.query<{ url: string; secret: string; headers: string | null; active: boolean }>(`SELECT url, secret, headers, active FROM gps.webhooks WHERE id = $1`, [row.sourceId]);
    const w = found.rows[0];
    // The outbox words the reason when its log keeps it.
    if (!w) return { code: null, error: say("integrations.webhooks.gone"), final: true };
    const secret = vault.open(w.secret);
    if (!secret) return { code: null, error: say("integrations.webhooks.secretUnreadable"), final: !w.active };
    const body = JSON.stringify({ id: row.id, ...row.payload });
    const timestamp = Math.floor(now / 1000);
    let code: number | null = null;
    let error: Say | string | null = null;
    try {
      code = await postJson(
        w.url,
        body,
        {
          ...Object.fromEntries(headersOf(deps, w.headers).map((h) => [h.name, h.value])),
          "User-Agent": "OpenGPS-Webhooks/1",
          "X-OpenGPS-Event": row.topic,
          "X-OpenGPS-Delivery": String(row.id),
          "X-OpenGPS-Timestamp": String(timestamp),
          "X-OpenGPS-Signature": `t=${timestamp},v1=${signatureOf(secret, timestamp, body)}`,
        },
        // Only on the real server are internal addresses denied: in development and in tests, the other system is the machine itself.
        { allowInternal: !deps.config.isProduction },
      );
      if (code < 200 || code >= 300) error = say("integrations.webhooks.answered", { code });
    } catch (err) {
      error = err instanceof OutboundError ? err.message : say("integrations.webhooks.sendFailed");
    }
    // A webhook that is off is not retried; one that is on, until attempts run out.
    return { code, error, final: !w.active };
  };
}
