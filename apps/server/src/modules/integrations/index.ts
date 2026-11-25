// Module I · Integrations: what the module does on its own (notify the
// webhooks and run the automations when something happens) and the routes
// the account uses to administer it. The public API is in api.ts.
import { TRANSFER_FORMATS, TRANSFER_KINDS, type TransferKind, apiKeySchema, automationSchema, importSchema, sensorSchema, webhookSchema } from "@opengps/shared";
import { z } from "zod";
import type { CoreEvents } from "../../bus";
import { notFound } from "../../errors";
import type { ServerKey } from "../../i18n";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import { parseOwn, registerApiV1 } from "./api";
import { deleteAutomation, listAutomations, listRuns, runFor, saveAutomation } from "./automations";
import { createKey, listKeys, revokeKey } from "./keys";
import { createSensor, deleteSensor, listSensors, pruneReadings, rotateSensorKey, sensorSeries, updateSensor } from "./sensors";
import { exportData, importData } from "./transfer";
import { createWebhook, deleteWebhook, enqueueEvent, listDeliveries, listWebhooks, rotateSecret, sendTest, updateWebhook, webhookHandler } from "./webhooks";

/** How often what could not be delivered is retried. */
const TICK_MS = 30_000;
const HOUR = 3_600_000;

export interface IntegrationsEngine {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
  /** Tries now the pending deliveries that are due. */
  deliver(now?: number): Promise<void>;
}

export function createIntegrationsEngine(deps: ModuleDeps & { tickMs?: number | null }): IntegrationsEngine {
  const db = deps.db.core;
  // The outbox delivers the webhooks' rows the way they need: signed, with their headers.
  deps.outbox.handle("webhook", webhookHandler(deps));
  let queue: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let cleaned = 0;
  const off: (() => void)[] = [];
  const enqueue = (what: string, job: () => Promise<unknown>) => {
    queue = queue.then(job).catch((err: Error) => console.error(`[integrations] ${what}:`, err.message));
  };

  async function onEvent(payload: CoreEvents["event"]): Promise<void> {
    if (!(await deps.gate.enabled(payload.orgId, "I"))) return;
    const queued = await enqueueEvent(db, payload.orgId, payload.event, deps.config.defaultLanguage); // Addresses written by hand and other systems: the platform's language.
    const ran = await runFor(deps, payload);
    // What was just enqueued goes out right away; retries, on the clock.
    if (queued + ran > 0) await deps.outbox.deliverDue();
  }

  async function tick(now = Date.now()): Promise<void> {
    await deps.outbox.deliverDue(now);
    if (now - cleaned > HOUR) {
      cleaned = now;
      await deps.outbox.prune(now);
      await pruneReadings(db, now);
    }
  }

  return {
    start() {
      off.push(deps.bus.on("event", (payload) => enqueue("could not notify an event", () => onEvent(payload))));
      const every = deps.tickMs === undefined ? TICK_MS : deps.tickMs;
      if (every !== null) timer = setInterval(() => enqueue("retrying deliveries failed", () => tick()), every);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const stop of off.splice(0)) stop();
    },
    idle: () => queue.then(() => undefined),
    deliver: (now) => {
      enqueue("delivery failed", () => tick(now));
      return queue.then(() => undefined);
    },
  };
}

const kindParam = (value: string): TransferKind => {
  const kind = TRANSFER_KINDS.find((k) => k === value);
  if (!kind) throw notFound();
  return kind;
};
const exportQuery = z.object({ format: z.enum(TRANSFER_FORMATS).default("xlsx") });
// These schemas write the key of their text; `parse` only says the shared ones, so these are said by `parseOwn`.
const FROM_NEEDED: ServerKey = "integrations.errors.fromNeeded";
const TO_NEEDED: ServerKey = "integrations.errors.toNeeded";
const seriesQuery = z.object({ from: z.coerce.date(FROM_NEEDED), to: z.coerce.date(TO_NEEDED) });

export function registerIntegrations(ctx: ModuleContext): void {
  const { app, session, actorOf, parse, language } = ctx;
  const deps: ModuleDeps = ctx;
  const db = deps.db.core;
  const MANAGE = "integrations.manage" as const;

  registerApiV1(ctx);

  // ─── API keys ──────────────────────────────────────────────────────────────

  app.get("/api/integrations/keys", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { keys: await listKeys(db, s.orgId) };
  });

  /** The full key is returned only here, when it is created. */
  app.post("/api/integrations/keys", async (request, reply) => {
    const s = await session(request, "I", MANAGE);
    return reply.status(201).send(await createKey(deps, actorOf(s, request), parse(apiKeySchema, request.body)));
  });

  app.delete<IdParams>("/api/integrations/keys/:id", async (request, reply) => {
    const s = await session(request, "I", MANAGE);
    await revokeKey(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  app.get("/api/integrations/webhooks", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { webhooks: await listWebhooks(deps, s.orgId) };
  });

  /** The signing secret is returned only here, when it is created and when it is changed. */
  app.post("/api/integrations/webhooks", async (request, reply) => {
    const s = await session(request, "I", MANAGE);
    return reply.status(201).send(await createWebhook(deps, actorOf(s, request), parse(webhookSchema, request.body)));
  });

  app.put<IdParams>("/api/integrations/webhooks/:id", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { webhooks: await updateWebhook(deps, actorOf(s, request), request.params.id, parse(webhookSchema, request.body)) };
  });

  app.delete<IdParams>("/api/integrations/webhooks/:id", async (request, reply) => {
    const s = await session(request, "I", MANAGE);
    await deleteWebhook(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  app.post<IdParams>("/api/integrations/webhooks/:id/secret", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { secret: await rotateSecret(deps, actorOf(s, request), request.params.id) };
  });

  app.get<IdParams>("/api/integrations/webhooks/:id/deliveries", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { deliveries: await listDeliveries(db, s.orgId, request.params.id) };
  });

  /** Sends a test notification now and returns the log with its result. */
  app.post<IdParams>("/api/integrations/webhooks/:id/test", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { deliveries: await sendTest(deps, actorOf(s, request), request.params.id, language(request)) };
  });

  // ─── Automations ───────────────────────────────────────────────────────────

  app.get("/api/integrations/automations", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { automations: await listAutomations(db, s.orgId) };
  });

  app.post("/api/integrations/automations", async (request, reply) => {
    const s = await session(request, "I", MANAGE);
    return reply.status(201).send({ automations: await saveAutomation(deps, actorOf(s, request), null, parse(automationSchema, request.body)) });
  });

  app.put<IdParams>("/api/integrations/automations/:id", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { automations: await saveAutomation(deps, actorOf(s, request), request.params.id, parse(automationSchema, request.body)) };
  });

  app.delete<IdParams>("/api/integrations/automations/:id", async (request, reply) => {
    const s = await session(request, "I", MANAGE);
    await deleteAutomation(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  app.get<IdParams>("/api/integrations/automations/:id/runs", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { runs: await listRuns(db, s.orgId, request.params.id, language(request)) };
  });

  // ─── Sensors ───────────────────────────────────────────────────────────────

  app.get("/api/integrations/sensors", async (request) => {
    const s = await session(request, "I");
    return { sensors: await listSensors(db, s) };
  });

  /** The sensor key is returned only here, when it is created and when it is changed. */
  app.post("/api/integrations/sensors", async (request, reply) => {
    const s = await session(request, "I", MANAGE);
    return reply.status(201).send(await createSensor(deps, actorOf(s, request), parse(sensorSchema, request.body)));
  });

  app.put<IdParams>("/api/integrations/sensors/:id", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { sensors: await updateSensor(deps, actorOf(s, request), request.params.id, parse(sensorSchema, request.body)) };
  });

  app.delete<IdParams>("/api/integrations/sensors/:id", async (request, reply) => {
    const s = await session(request, "I", MANAGE);
    await deleteSensor(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  app.post<IdParams>("/api/integrations/sensors/:id/key", async (request) => {
    const s = await session(request, "I", MANAGE);
    return { secret: await rotateSensorKey(deps, actorOf(s, request), request.params.id) };
  });

  app.get<IdParams>("/api/integrations/sensors/:id/readings", async (request) => {
    const s = await session(request, "I");
    return { series: await sensorSeries(db, s, request.params.id, parseOwn(parse, [FROM_NEEDED, TO_NEEDED], seriesQuery, request.query)) };
  });

  // ─── Import and export ─────────────────────────────────────────────────────

  app.get<{ Params: { kind: string } }>("/api/integrations/export/:kind", async (request, reply) => {
    const s = await session(request, "I");
    const file = await exportData(deps, s, kindParam(request.params.kind), parse(exportQuery, request.query).format, language(request));
    return reply.header("Content-Type", file.mime).header("Content-Disposition", `attachment; filename="${file.filename}"`).header("Cache-Control", "private, no-store").send(file.data);
  });

  app.post<{ Params: { kind: string } }>("/api/integrations/import/:kind", { bodyLimit: 3 * 1024 * 1024 }, async (request) => {
    const s = await session(request, "I", MANAGE);
    return { result: await importData(deps, actorOf(s, request), kindParam(request.params.kind), parse(importSchema, request.body).csv, language(request)) };
  });
}
