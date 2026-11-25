// Module H · Routes and logistics: routes. What the module does with each position
// is in watch.ts.
import { ROUTE_PROOF_KINDS, ROUTE_PROOF_TYPES, UPLOAD_MAX_MB, poiSchema, routeDriverStatusSchema, routeDriverStopSchema, routePlanSchema, routeStopUpdateSchema, routeTokenSchema, routeTripSchema } from "@opengps/shared";
import { z } from "zod";
import { badRequest, notFound } from "../../errors";
import { type ServerKey, say } from "../../i18n";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import { deletePlan, deletePoi, lineFromHistory, listPlans, listPois, savePlan, savePoi } from "./plans";
import { createTrip, deleteTrip, driverLink, driverProof, driverStatus, driverStop, getTrip, listTrips, nearest, readProof, setTripStatus, trackLink, updateStop, viewDelivery, viewDriver } from "./trips";

export { type RoutesEngine, createRoutesEngine } from "./watch";

const MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;
const DAY = 86_400_000;
const rangeQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
// These schemas write the key of their text; `parse` only says the shared ones, so these are said here.
const FROM_NEEDED: ServerKey = "routes.errors.fromNeeded";
const TO_NEEDED: ServerKey = "routes.errors.toNeeded";
const historyQuery = z.object({ vehicleId: z.uuid(), from: z.coerce.date(FROM_NEEDED), to: z.coerce.date(TO_NEEDED) });
const pointQuery = z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) });
const tripStatusSchema = z.object({ status: z.enum(["in_progress", "done", "cancelled"]) });
const proofQuery = z.object({ stopId: z.uuid(), kind: z.enum(ROUTE_PROOF_KINDS) });
const GONE = say("routes.errors.linkGone");

export function registerRoutes(ctx: ModuleContext): void {
  const { app, session, actorOf, parse, publicLimit, language } = ctx;
  const deps: ModuleDeps = ctx;
  const db = deps.db.core;
  /** `parse`, which also says in the reader's language the problems this module's schemas word themselves. */
  const parseHere = <T extends z.ZodType>(schema: T, data: unknown): z.output<T> => {
    const result = schema.safeParse(data);
    const message = result.success ? null : result.error.issues[0]?.message;
    const own = [FROM_NEEDED, TO_NEEDED].find((key) => key === message);
    if (own) throw badRequest(say(own));
    return parse(schema, data);
  };

  // ─── Points of interest ────────────────────────────────────────────────────

  app.get("/api/routes/pois", async (request) => {
    const s = await session(request, "H");
    return { pois: await listPois(db, s.orgId) };
  });

  app.post("/api/routes/pois", async (request, reply) => {
    const s = await session(request, "H", "geofences.manage");
    return reply.status(201).send({ pois: await savePoi(deps, actorOf(s, request), null, parse(poiSchema, request.body)) });
  });

  app.put<IdParams>("/api/routes/pois/:id", async (request) => {
    const s = await session(request, "H", "geofences.manage");
    return { pois: await savePoi(deps, actorOf(s, request), request.params.id, parse(poiSchema, request.body)) };
  });

  app.delete<IdParams>("/api/routes/pois/:id", async (request, reply) => {
    const s = await session(request, "H", "geofences.manage");
    await deletePoi(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  // ─── Planned routes ────────────────────────────────────────────────────────

  app.get("/api/routes/plans", async (request) => {
    const s = await session(request, "H");
    return { plans: await listPlans(db, s.orgId) };
  });

  app.post("/api/routes/plans", async (request, reply) => {
    const s = await session(request, "H", "geofences.manage");
    return reply.status(201).send({ plans: await savePlan(deps, actorOf(s, request), null, parse(routePlanSchema, request.body)) });
  });

  app.put<IdParams>("/api/routes/plans/:id", async (request) => {
    const s = await session(request, "H", "geofences.manage");
    return { plans: await savePlan(deps, actorOf(s, request), request.params.id, parse(routePlanSchema, request.body)) };
  });

  app.delete<IdParams>("/api/routes/plans/:id", async (request, reply) => {
    const s = await session(request, "H", "geofences.manage");
    await deletePlan(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  /** The path a vehicle took over a period, to use as a route. */
  app.get("/api/routes/line", async (request) => {
    const s = await session(request, "H");
    const { vehicleId, from, to } = parseHere(historyQuery, request.query);
    return await lineFromHistory(db, s, vehicleId, { from, to });
  });

  // ─── Dispatch ──────────────────────────────────────────────────────────────

  /** Vehicles, from nearest to farthest from a destination; available ones first. */
  app.get("/api/routes/nearest", async (request) => {
    const s = await session(request, "H");
    return { vehicles: await nearest(deps, s, parse(pointQuery, request.query), language(request)) };
  });

  /** Unclosed dispatches and those of a period; without dates, those of the last seven days. */
  app.get("/api/routes/trips", async (request) => {
    const s = await session(request, "H");
    const { from, to } = parse(rangeQuery, request.query);
    return { trips: await listTrips(db, s, { from: from ?? new Date(Date.now() - 7 * DAY), to: to ?? new Date(Date.now() + 30 * DAY) }) };
  });

  app.post("/api/routes/trips", async (request, reply) => {
    const s = await session(request, "H", "geofences.manage");
    return reply.status(201).send({ trip: await createTrip(deps, actorOf(s, request), parse(routeTripSchema, request.body)) });
  });

  app.get<IdParams>("/api/routes/trips/:id", async (request) => {
    const s = await session(request, "H");
    return { trip: await getTrip(db, s, request.params.id) };
  });

  app.put<IdParams>("/api/routes/trips/:id/status", async (request) => {
    const s = await session(request, "H", "geofences.manage");
    return { trip: await setTripStatus(deps, actorOf(s, request), request.params.id, parse(tripStatusSchema, request.body).status) };
  });

  app.delete<IdParams>("/api/routes/trips/:id", async (request, reply) => {
    const s = await session(request, "H", "geofences.manage");
    await deleteTrip(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  /** Creates the driver's link; the previous one stops working. */
  app.post<IdParams>("/api/routes/trips/:id/link", async (request) => {
    const s = await session(request, "H", "geofences.manage");
    return { token: await driverLink(deps, actorOf(s, request), request.params.id) };
  });

  app.put<IdParams>("/api/routes/stops/:id", async (request) => {
    const s = await session(request, "H", "geofences.manage");
    return { trip: await updateStop(deps, actorOf(s, request), request.params.id, parse(routeStopUpdateSchema, request.body)) };
  });

  /** Creates the public tracking link for a delivery; the previous one stops working. */
  app.post<IdParams>("/api/routes/stops/:id/link", async (request) => {
    const s = await session(request, "H", "geofences.manage");
    return { token: await trackLink(deps, actorOf(s, request), request.params.id) };
  });

  app.get<{ Params: { id: string; kind: string } }>("/api/routes/stops/:id/proof/:kind", async (request, reply) => {
    const s = await session(request, "H");
    const kind = ROUTE_PROOF_KINDS.find((k) => k === request.params.kind);
    if (!kind) throw notFound();
    const file = await readProof(deps, s, request.params.id, kind);
    return reply.header("Content-Type", file.mime).header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").send(file.data);
  });

  // ─── With the driver's link, without a session ─────────────────────────────
  // The key goes in the body, or in a header when uploading a file, so that
  // it does not end up in the access logs. A link that does not exist, was changed or
  // expired always responds the same way.

  app.post("/api/routes/driver/view", async (request, reply) => {
    publicLimit(request);
    const parsed = routeTokenSchema.safeParse(request.body);
    const view = parsed.success ? await viewDriver(db, parsed.data.token) : null;
    if (!view) throw notFound(GONE);
    return reply.header("Cache-Control", "no-store").send({ view });
  });

  app.post("/api/routes/driver/status", async (request, reply) => {
    publicLimit(request);
    const data = parse(routeDriverStatusSchema, request.body);
    const view = await driverStatus(deps, data.token, data.status);
    if (!view) throw notFound(GONE);
    return reply.header("Cache-Control", "no-store").send({ view });
  });

  app.post("/api/routes/driver/stop", async (request, reply) => {
    publicLimit(request);
    const data = parse(routeDriverStopSchema, request.body);
    const view = await driverStop(deps, data.token, data.stopId, { status: data.status, recipient: data.recipient, note: data.note });
    if (!view) throw notFound(GONE);
    return reply.header("Cache-Control", "no-store").send({ view });
  });

  for (const type of ROUTE_PROOF_TYPES) {
    if (!app.hasContentTypeParser(type)) app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: MAX_BYTES }, (_request, body, done) => done(null, body));
  }
  /** The photo or signature of a delivery: the image as is, with the link key in the `X-Route-Token` header. */
  app.post("/api/routes/driver/proof", { bodyLimit: MAX_BYTES }, async (request, reply) => {
    publicLimit(request);
    const token = parse(routeTokenSchema, { token: request.headers["x-route-token"] }).token;
    const { stopId, kind } = parse(proofQuery, request.query);
    if (!Buffer.isBuffer(request.body)) throw badRequest(say("routes.errors.proofType"));
    const mime = String(request.headers["content-type"] ?? "").split(";")[0] as string;
    const view = await driverProof(deps, token, stopId, kind, { mime, data: request.body });
    if (!view) throw notFound(GONE);
    return reply.status(201).header("Cache-Control", "no-store").send({ view });
  });

  // ─── Public tracking of a delivery ─────────────────────────────────────────

  app.post("/api/routes/track/view", async (request, reply) => {
    publicLimit(request);
    const parsed = routeTokenSchema.safeParse(request.body);
    const view = parsed.success ? await viewDelivery(db, parsed.data.token) : null;
    if (!view) throw notFound(GONE);
    return reply.header("Cache-Control", "no-store").send({ view });
  });
}
