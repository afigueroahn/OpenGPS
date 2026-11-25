// Module E · Maintenance: routes. What the module checks on its own is
// in watch.ts.
import {
  MAINT_FILE_TYPES,
  MAINT_ORDER_STATUSES,
  UPLOAD_MAX_MB,
  maintBaselineSchema,
  maintExpirySchema,
  maintFileSchema,
  maintOrderSchema,
  maintPartSchema,
  maintPlanSchema,
  maintSettingsSchema,
  maintWorkshopSchema,
  isValidZone,
  type SharedKey,
} from "@opengps/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest } from "../../errors";
import { say } from "../../i18n";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import { createPlan, deleteExpiry, deletePlan, getSettings, listPlans, overview, saveExpiry, saveSettings, setBaseline, updatePlan } from "./due";
import { addFile, createOrder, deleteFile, deleteOrder, deletePart, deleteWorkshop, getOrder, listOrders, listParts, listWorkshops, readOrderFile, savePart, saveWorkshop, updateOrder } from "./orders";

export { type MaintenanceEngine, createMaintenanceEngine } from "./watch";

const MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;
// The messages are keys of the shared texts: `parse` says them in the reader's language.
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validation.dateFormat" satisfies SharedKey);
/** The clock of whoever queries: "today" is counted with it. Without it, the account's saved time zone applies. */
const zoneQuery = z.object({ zone: z.string().trim().min(1).max(64).refine(isValidZone, "validation.zone" satisfies SharedKey).optional() });
const ordersQuery = z.object({
  /** "pending": open and in progress. */
  status: z.enum([...MAINT_ORDER_STATUSES, "pending"]).optional(),
  vehicleId: z.uuid().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

export function registerMaintenance(ctx: ModuleContext): void {
  const { app, session, actorOf, parse, language } = ctx;
  const deps: ModuleDeps = ctx;
  const db = deps.db.core;
  const zoneOf = (request: FastifyRequest) => parse(zoneQuery, request.query).zone;

  /** What needs attention: scheduled services and expiries. */
  app.get("/api/maintenance", async (request) => {
    const s = await session(request, "E");
    return { overview: await overview(deps, s, language(request), zoneOf(request)) };
  });

  app.get("/api/maintenance/settings", async (request) => {
    const s = await session(request, "E");
    return { settings: await getSettings(db, s.orgId) };
  });

  app.put("/api/maintenance/settings", async (request) => {
    const s = await session(request, "E", "vehicles.manage");
    return { settings: await saveSettings(deps, actorOf(s, request), parse(maintSettingsSchema, request.body)) };
  });

  // ─── Plans ─────────────────────────────────────────────────────────────────

  app.get("/api/maintenance/plans", async (request) => {
    const s = await session(request, "E");
    return { plans: await listPlans(db, s) };
  });

  app.post("/api/maintenance/plans", async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    return reply.status(201).send({ plans: await createPlan(deps, actorOf(s, request), parse(maintPlanSchema, request.body), zoneOf(request)) });
  });

  app.put<IdParams>("/api/maintenance/plans/:id", async (request) => {
    const s = await session(request, "E", "vehicles.manage");
    return { plans: await updatePlan(deps, actorOf(s, request), request.params.id, parse(maintPlanSchema, request.body), zoneOf(request)) };
  });

  app.delete<IdParams>("/api/maintenance/plans/:id", async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    await deletePlan(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  /** When a vehicle's service was last done. */
  app.put<IdParams>("/api/maintenance/schedules/:id", async (request) => {
    const s = await session(request, "E", "vehicles.manage");
    return { overview: await setBaseline(deps, actorOf(s, request), request.params.id, parse(maintBaselineSchema, request.body), language(request), zoneOf(request)) };
  });

  // ─── Expiries ──────────────────────────────────────────────────────────────

  app.post("/api/maintenance/expiries", async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    return reply.status(201).send({ overview: await saveExpiry(deps, actorOf(s, request), null, parse(maintExpirySchema, request.body), language(request), zoneOf(request)) });
  });

  app.put<IdParams>("/api/maintenance/expiries/:id", async (request) => {
    const s = await session(request, "E", "vehicles.manage");
    return { overview: await saveExpiry(deps, actorOf(s, request), request.params.id, parse(maintExpirySchema, request.body), language(request), zoneOf(request)) };
  });

  app.delete<IdParams>("/api/maintenance/expiries/:id", async (request) => {
    const s = await session(request, "E", "vehicles.manage");
    return { overview: await deleteExpiry(deps, actorOf(s, request), request.params.id, language(request), zoneOf(request)) };
  });

  // ─── Work orders ───────────────────────────────────────────────────────────

  app.get("/api/maintenance/orders", async (request) => {
    const s = await session(request, "E");
    return { orders: await listOrders(db, s, parse(ordersQuery, request.query)) };
  });

  app.post("/api/maintenance/orders", async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    return reply.status(201).send({ order: await createOrder(deps, actorOf(s, request), parse(maintOrderSchema, request.body)) });
  });

  app.get<IdParams>("/api/maintenance/orders/:id", async (request) => {
    const s = await session(request, "E");
    return { order: await getOrder(db, s, request.params.id) };
  });

  app.put<IdParams>("/api/maintenance/orders/:id", async (request) => {
    const s = await session(request, "E", "vehicles.manage");
    return { order: await updateOrder(deps, actorOf(s, request), request.params.id, parse(maintOrderSchema, request.body)) };
  });

  app.delete<IdParams>("/api/maintenance/orders/:id", async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    await deleteOrder(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  // Attachments arrive as the file itself, with its type in the header and its name in the address.
  for (const type of MAINT_FILE_TYPES) {
    if (!app.hasContentTypeParser(type)) app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: MAX_BYTES }, (_request, body, done) => done(null, body));
  }
  app.post<IdParams>("/api/maintenance/orders/:id/files", { bodyLimit: MAX_BYTES }, async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    const meta = parse(maintFileSchema, request.query);
    if (!Buffer.isBuffer(request.body)) throw badRequest(say("maintenance.errors.fileType"));
    const mime = String(request.headers["content-type"] ?? "").split(";")[0] as string;
    return reply.status(201).send({ order: await addFile(deps, actorOf(s, request), request.params.id, meta, { mime, data: request.body }) });
  });

  app.get<IdParams>("/api/maintenance/files/:id", async (request, reply) => {
    const s = await session(request, "E");
    const file = await readOrderFile(deps, s, request.params.id);
    return reply
      .header("Content-Type", file.mime)
      .header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(file.data);
  });

  app.delete<IdParams>("/api/maintenance/files/:id", async (request) => {
    const s = await session(request, "E", "vehicles.manage");
    return { order: await deleteFile(deps, actorOf(s, request), request.params.id) };
  });

  // ─── Workshops and parts ───────────────────────────────────────────────────

  app.get("/api/maintenance/workshops", async (request) => {
    const s = await session(request, "E");
    return { workshops: await listWorkshops(db, s.orgId) };
  });

  app.post("/api/maintenance/workshops", async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    return reply.status(201).send({ workshops: await saveWorkshop(deps, actorOf(s, request), null, parse(maintWorkshopSchema, request.body)) });
  });

  app.put<IdParams>("/api/maintenance/workshops/:id", async (request) => {
    const s = await session(request, "E", "vehicles.manage");
    return { workshops: await saveWorkshop(deps, actorOf(s, request), request.params.id, parse(maintWorkshopSchema, request.body)) };
  });

  app.delete<IdParams>("/api/maintenance/workshops/:id", async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    await deleteWorkshop(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  app.get("/api/maintenance/parts", async (request) => {
    const s = await session(request, "E");
    return { parts: await listParts(db, s.orgId) };
  });

  app.post("/api/maintenance/parts", async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    return reply.status(201).send({ parts: await savePart(deps, actorOf(s, request), null, parse(maintPartSchema, request.body)) });
  });

  app.put<IdParams>("/api/maintenance/parts/:id", async (request) => {
    const s = await session(request, "E", "vehicles.manage");
    return { parts: await savePart(deps, actorOf(s, request), request.params.id, parse(maintPartSchema, request.body)) };
  });

  app.delete<IdParams>("/api/maintenance/parts/:id", async (request, reply) => {
    const s = await session(request, "E", "vehicles.manage");
    await deletePart(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });
}
