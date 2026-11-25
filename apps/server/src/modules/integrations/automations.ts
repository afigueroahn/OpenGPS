// Integrations: automations. When something happens (trigger) on certain
// vehicles and at certain times (condition), the platform does something on its
// own account's behalf (action): notifies some addresses through a channel, notifies
// one of its webhooks or opens a work order.
import {
  AUTOMATIONS_MAX,
  type Automation,
  type AutomationAction,
  type AutomationRun,
  type EventType,
  type Language,
  type NotifyChannel,
  type VehicleEvent,
  type WeekSchedule,
  activeSince,
  addressLabel,
  type automationSchema,
  maintOrderSchema,
} from "@opengps/shared";
import type { z } from "zod";
import { isUuid, wholeAccount } from "../../core/access";
import { audit } from "../../core/audit";
import { channelProblem, customAudience, recipientTarget, writtenRecipient } from "../../core/channels";
import { capProblem, eventMessage } from "../../core/notifications";
import { describeEvent, eventPayload } from "../../core/notify";
import type { Actor } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { AppError, badRequest, notFound } from "../../errors";
import { type Say, render, say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";
import { settingsOf, todayOf } from "../maintenance/due";
import { createOrder } from "../maintenance/orders";
import { enqueueFor } from "./webhooks";

type Deps = Pick<ModuleDeps, "db" | "gate" | "config" | "outbox">;
/** Runs kept for each automation. */
const RUNS_KEEP = 100;

interface Row {
  id: string;
  name: string;
  active: boolean;
  triggers: EventType[];
  group_id: string | null;
  vehicle_ids: string[] | null;
  schedule: WeekSchedule | null;
  cooldown_min: number;
  action: AutomationAction;
  created_by: string | null;
  runs: number;
  last_run_at: Date | null;
}
const SELECT = `SELECT a.id, a.name, a.active, a.triggers, a.group_id, a.vehicle_ids, a.schedule, a.cooldown_min, a.action, a.created_by,
         (SELECT count(*)::int FROM gps.automation_runs r WHERE r.automation_id = a.id) AS runs,
         (SELECT max(r.at) FROM gps.automation_runs r WHERE r.automation_id = a.id) AS last_run_at
    FROM gps.automations a`;
/**
 * What a run did or why it failed, for its log. It is stored as the key of its
 * text, so the log says it in the language of whoever reads it. Errors nobody
 * foresaw come already written.
 */
interface RunDetail extends Say {
  /** The channel whose name the text says, in the reader's language too. */
  channel?: NotifyChannel;
}
/** Why a run could not be completed. */
class RunFailure extends Error {
  constructor(readonly detail: Say | string) {
    super(render("es", detail));
  }
}
const storedDetail = (detail: RunDetail | string) => (typeof detail === "string" ? detail : JSON.stringify(detail));
function readDetail(language: Language, stored: string | null): string | null {
  if (!stored?.startsWith("{")) return stored;
  try {
    const detail = JSON.parse(stored) as Partial<RunDetail>;
    if (typeof detail.key !== "string") return stored;
    return tr(language, detail.key, detail.channel ? { ...detail.params, channel: tr(language, `shared.channel.${detail.channel}`) } : detail.params);
  } catch {
    return stored;
  }
}

const toAutomation = (r: Row): Automation => ({
  id: r.id,
  name: r.name,
  active: r.active,
  triggers: r.triggers,
  groupId: r.group_id,
  vehicleIds: r.vehicle_ids,
  schedule: r.schedule,
  cooldownMin: r.cooldown_min,
  action: r.action,
  runs: r.runs,
  lastRunAt: r.last_run_at?.toISOString() ?? null,
});

export async function listAutomations(db: Queryable, orgId: string): Promise<Automation[]> {
  const r = await db.query<Row>(`${SELECT} WHERE a.org_id = $1 ORDER BY a.created_at`, [orgId]);
  return r.rows.map(toAutomation);
}

/** What the automation points to must belong to the account, and its action must be possible with its modules. */
async function check(deps: Deps, actor: Actor, data: z.output<typeof automationSchema>): Promise<void> {
  const db = deps.db.core;
  if (data.groupId) {
    const g = await db.query(`SELECT 1 FROM gps.vehicle_groups WHERE id = $1 AND org_id = $2`, [data.groupId, actor.orgId]);
    if (!g.rowCount) throw badRequest(say("integrations.errors.groupNotFound"));
  }
  if (data.vehicleIds) {
    const v = await db.query(`SELECT 1 FROM gps.vehicles WHERE org_id = $1 AND id = ANY($2::uuid[])`, [actor.orgId, data.vehicleIds]);
    if (v.rowCount !== new Set(data.vehicleIds).size) throw badRequest(say("integrations.errors.vehicleNotFound"));
  }
  if (data.action.type === "webhook") {
    const w = await db.query(`SELECT 1 FROM gps.webhooks WHERE id = $1 AND org_id = $2`, [data.action.webhookId, actor.orgId]);
    if (!w.rowCount) throw badRequest(say("integrations.errors.webhookNotFound"));
  }
  if (data.action.type === "notify") {
    const problem = channelProblem(deps.config, data.action.channel, "chooseOther");
    if (problem) throw badRequest(problem);
  }
  if (data.action.type === "order" && !(await deps.gate.enabled(actor.orgId, "E"))) throw badRequest(say("integrations.errors.ordersNeedMaintenance"));
}

export async function saveAutomation(deps: Deps, actor: Actor, id: string | null, data: z.output<typeof automationSchema>): Promise<Automation[]> {
  const db = deps.db.core;
  await check(deps, actor, data);
  const values = [data.name, data.active, data.triggers, data.groupId, data.vehicleIds, data.schedule ? JSON.stringify(data.schedule) : null, data.cooldownMin, JSON.stringify(data.action)];
  if (id === null) {
    const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.automations WHERE org_id = $1`, [actor.orgId]);
    if ((count.rows[0]?.n ?? 0) >= AUTOMATIONS_MAX) throw badRequest(say("integrations.errors.tooManyAutomations", { max: AUTOMATIONS_MAX }));
    await db.query(`INSERT INTO gps.automations (org_id, name, active, triggers, group_id, vehicle_ids, schedule, cooldown_min, action, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)`, [actor.orgId, ...values, actor.userId]);
  } else {
    if (!isUuid(id)) throw notFound(say("integrations.errors.automationNotFound"));
    const r = await db.query(`UPDATE gps.automations SET name = $3, active = $4, triggers = $5, group_id = $6, vehicle_ids = $7, schedule = $8::jsonb, cooldown_min = $9, action = $10::jsonb WHERE id = $1 AND org_id = $2`, [id, actor.orgId, ...values]);
    if (!r.rowCount) throw notFound(say("integrations.errors.automationNotFound"));
  }
  await audit(db, actor, id === null ? "integrations.automation.create" : "integrations.automation.update", "account", actor.orgId, { name: data.name, action: data.action.type });
  return listAutomations(db, actor.orgId);
}

export async function deleteAutomation(deps: Deps, actor: Actor, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound(say("integrations.errors.automationNotFound"));
  const r = await deps.db.core.query<{ name: string }>(`DELETE FROM gps.automations WHERE id = $1 AND org_id = $2 RETURNING name`, [id, actor.orgId]);
  if (!r.rows[0]) throw notFound(say("integrations.errors.automationNotFound"));
  await audit(deps.db.core, actor, "integrations.automation.delete", "account", actor.orgId, { name: r.rows[0].name });
}

/** The latest runs of an automation; what each one did, in `language`. */
export async function listRuns(db: Queryable, orgId: string, id: string, language: Language): Promise<AutomationRun[]> {
  if (!isUuid(id)) throw notFound(say("integrations.errors.automationNotFound"));
  const r = await db.query<{ id: string; at: Date; vehicle_name: string | null; event_type: EventType; ok: boolean; detail: string | null }>(
    `SELECT id, at, vehicle_name, event_type, ok, detail FROM gps.automation_runs WHERE automation_id = $1 AND org_id = $2 ORDER BY id DESC LIMIT 50`,
    [id, orgId],
  );
  return r.rows.map((x) => ({ id: Number(x.id), at: x.at.toISOString(), vehicleName: x.vehicle_name, eventType: x.event_type, ok: x.ok, detail: readDetail(language, x.detail) }));
}

// ─── Execution ───────────────────────────────────────────────────────────────

/** Does what the automation says. Returns what it did, for the log. */
async function act(deps: Deps, orgId: string, a: Row, event: VehicleEvent): Promise<RunDetail> {
  const db = deps.db.core;
  if (a.action.type === "notify") {
    const { channel, to } = a.action;
    const problem = channelProblem(deps.config, channel) ?? (await capProblem(db, deps.config, orgId, channel, to.length));
    if (problem) throw new RunFailure(problem);
    const settings = await settingsOf(db, orgId);
    const message = eventMessage(deps.config, event, settings.zone, say("integrations.automations.sender", { name: a.name }), deps.config.defaultLanguage); // Addresses written by hand and other systems: the platform's language.
    // In the custom channel what was written only fills its variables; without anything, it is called once.
    const destinations = channel === "webhook" ? (to.length > 0 ? to : [""]).map((written) => ({ target: recipientTarget(writtenRecipient(written)), label: written ? addressLabel(channel, written) : customAudience(deps.config.channels.webhook).label })) : to.map((target) => ({ target }));
    // They go out with what the module queues for this event; what fails is retried by the outbox.
    await deps.outbox.enqueue(destinations.map((d) => ({ orgId, source: "automation" as const, sourceId: a.id, channel, ...d, topic: event.type, message })));
    return { ...say("integrations.runs.notified", { count: destinations.length }), channel };
  }
  if (a.action.type === "webhook") {
    const w = await db.query<{ name: string }>(`SELECT name FROM gps.webhooks WHERE id = $1 AND org_id = $2`, [a.action.webhookId, orgId]);
    if (!w.rows[0]) throw new RunFailure(say("integrations.runs.webhookGone"));
    await enqueueFor(db, orgId, a.action.webhookId, event.type, { ...eventPayload(event, deps.config.defaultLanguage), automation: a.name }); // Addresses written by hand and other systems: the platform's language.
    return say("integrations.runs.webhookSent", { name: w.rows[0].name });
  }
  if (!(await deps.gate.enabled(orgId, "E"))) throw new RunFailure(say("integrations.runs.noMaintenance"));
  if (!a.created_by) throw new RunFailure(say("integrations.runs.noOwner"));
  const settings = await settingsOf(db, orgId);
  // The order keeps its title and description as they are written now.
  const language = deps.config.defaultLanguage; // i18n: stored text
  const order = await createOrder(
    deps,
    { ...wholeAccount(orgId), userId: a.created_by },
    maintOrderSchema.parse({
      vehicleId: event.vehicleId,
      kind: "corrective",
      status: "open",
      title: (a.action.title || tr(language, `shared.event.${event.type}`)).slice(0, 120),
      description: tr(language, "integrations.automations.orderDescription", { event: describeEvent(event, language), name: a.name }),
      openedOn: todayOf(settings.zone, Date.parse(event.at)),
      currency: settings.currency,
    }),
  );
  return say("integrations.runs.orderOpened", { number: order.number });
}

/** Checks which of the account's automations fire on an event, and runs them. */
export async function runFor(deps: Deps, payload: { orgId: string; groupId: string | null; event: VehicleEvent }): Promise<number> {
  const db = deps.db.core;
  const { orgId, event } = payload;
  const at = Date.parse(event.at);
  const r = await db.query<Row>(
    `${SELECT}
      WHERE a.org_id = $1 AND a.active AND $2 = ANY(a.triggers)
        AND (a.vehicle_ids IS NULL OR $3::uuid = ANY(a.vehicle_ids))
        AND (a.group_id IS NULL OR $4::uuid = ANY(gps.groups_with_children(ARRAY[a.group_id])))`,
    [orgId, event.type, event.vehicleId, payload.groupId],
  );
  let ran = 0;
  for (const a of r.rows) {
    if (activeSince(a.schedule, at) === null) continue;
    if (a.cooldown_min > 0) {
      const recent = await db.query(`SELECT 1 FROM gps.automation_runs WHERE automation_id = $1 AND vehicle_id = $2 AND ok AND at > $3 LIMIT 1`, [a.id, event.vehicleId, new Date(at - a.cooldown_min * 60_000)]);
      if (recent.rowCount) continue;
    }
    let ok = true;
    let detail: RunDetail | string;
    try {
      detail = await act(deps, orgId, a, event);
    } catch (err) {
      ok = false;
      const said = err instanceof RunFailure ? err.detail : err instanceof AppError ? err.text : (err as Error).message;
      detail = typeof said === "string" ? said.slice(0, 300) || say("integrations.runs.failed") : said;
    }
    await db.query(`INSERT INTO gps.automation_runs (org_id, automation_id, at, vehicle_id, vehicle_name, event_type, ok, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [orgId, a.id, new Date(at), event.vehicleId, event.vehicleName, event.type, ok, storedDetail(detail)]);
    await db.query(`DELETE FROM gps.automation_runs WHERE automation_id = $1 AND id <= (SELECT id FROM gps.automation_runs WHERE automation_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`, [a.id, RUNS_KEEP]);
    ran++;
  }
  return ran;
}
