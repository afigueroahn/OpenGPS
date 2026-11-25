// Device simulator of the admin console: simulated GPS devices that connect to
// the gateway like real ones. Only for those who administer the platform.
import {
  type Language,
  type LonLat,
  SIM_LIMITS,
  type SimPlace,
  type SimRoute,
  type SimRouteSummary,
  type SimTrace,
  type SimulationDetail,
  type SimulationSummary,
  type SimulatorMeta,
  simBackfillSchema,
  simInjectSchema,
  simPlacesQuery,
  simRouteSchema,
  simRunSchema,
  simTraceSchema,
  simulationSchema,
} from "@opengps/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionContext } from "../auth";
import type { Geocoder } from "../core/geocode";
import type { Db } from "../db";
import { AppError, badRequest, notFound } from "../errors";
import { say } from "../i18n";
import { lineFromHistory } from "../modules/routes/plans";
import type { Simulator } from "../simulator/manager";

export interface SimulatorRoutes {
  app: FastifyInstance;
  simulator: Simulator;
  geocoder: Geocoder;
  db: Db;
  platformAdmin(request: FastifyRequest): Promise<SessionContext>;
  clientIp(request: FastifyRequest): string;
  /** The language a request is answered in. */
  language(request: FastifyRequest): Language;
  parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T>;
}

type ById = { Params: { id: string } };

const tripQuery = z.object({ vehicleId: z.uuid(), from: z.coerce.date("api.validation.fromNeeded"), to: z.coerce.date("api.validation.toNeeded") });

export function registerSimulator(ctx: SimulatorRoutes): void {
  const { app, simulator, geocoder, db, platformAdmin, clientIp, parse } = ctx;
  const actorOf = (admin: SessionContext, request: FastifyRequest) => ({ userId: admin.userId, ip: clientIp(request) });
  /** An address that is not an identifier names nothing. */
  const idOf = (request: FastifyRequest<ById>, missing: "notFound" | "routeGone" = "notFound"): string => {
    const id = z.uuid().safeParse(request.params.id);
    if (!id.success) throw notFound(say(`simulator.errors.${missing}`));
    return id.data;
  };

  /** What the simulator can do here: the brands it speaks, where devices connect and how many fit. */
  app.get("/api/admin/simulator/meta", async (request): Promise<{ meta: SimulatorMeta }> => {
    await platformAdmin(request);
    return { meta: { ...simulator.meta(ctx.language(request)), placeSearch: geocoder.canSearch } };
  });

  // ─── Routes ────────────────────────────────────────────────────────────────

  app.get("/api/admin/simulator/routes", async (request): Promise<{ routes: SimRouteSummary[] }> => {
    await platformAdmin(request);
    return { routes: await simulator.routes() };
  });

  app.post("/api/admin/simulator/routes", async (request, reply): Promise<{ route: SimRoute }> => {
    const admin = await platformAdmin(request);
    const route = await simulator.createRoute(parse(simRouteSchema, request.body), actorOf(admin, request));
    reply.status(201);
    return { route };
  });

  /** A route with its points and its path, to edit it. */
  app.get<ById>("/api/admin/simulator/routes/:id", async (request): Promise<{ route: SimRoute }> => {
    await platformAdmin(request);
    return { route: await simulator.route(idOf(request, "routeGone")) };
  });

  /** The simulations that travel it start their trip over on the new path. */
  app.put<ById>("/api/admin/simulator/routes/:id", async (request): Promise<{ route: SimRoute }> => {
    const admin = await platformAdmin(request);
    return { route: await simulator.updateRoute(idOf(request, "routeGone"), parse(simRouteSchema, request.body), actorOf(admin, request)) };
  });

  app.delete<ById>("/api/admin/simulator/routes/:id", async (request, reply) => {
    const admin = await platformAdmin(request);
    await simulator.removeRoute(idOf(request, "routeGone"), actorOf(admin, request));
    return reply.status(204).send();
  });

  /** The path along streets through some points, from the routing service. It saves nothing. */
  app.post("/api/admin/simulator/route-line", async (request): Promise<{ trace: SimTrace }> => {
    await platformAdmin(request);
    const { points } = parse(simTraceSchema, request.body);
    return { trace: await simulator.trace(points.map((p): LonLat => [p.lon, p.lat])) };
  });

  /** The path one of the owner's own vehicles took over a period, to use as a route. */
  app.get("/api/admin/simulator/trip-line", async (request): Promise<{ line: LonLat[]; lengthM: number }> => {
    const admin = await platformAdmin(request);
    const { vehicleId, from, to } = parse(tripQuery, request.query);
    return await lineFromHistory(db.core, admin, vehicleId, { from, to });
  });

  /** Places that match a written address. Asked on purpose, never while typing: the address service forbids it. */
  app.get("/api/admin/simulator/places", async (request): Promise<{ places: SimPlace[] }> => {
    await platformAdmin(request);
    const { q } = parse(simPlacesQuery, request.query);
    if (!geocoder.canSearch) throw badRequest(say("simulator.errors.placesOff"), "places_off");
    try {
      return { places: await geocoder.search(q, ctx.language(request), SIM_LIMITS.places) };
    } catch (err) {
      console.warn("[simulator] address search:", (err as Error).message);
      throw new AppError(502, "places_failed", say("simulator.errors.placesFailed"));
    }
  });

  // ─── Simulations ───────────────────────────────────────────────────────────

  app.get("/api/admin/simulator/simulations", async (request): Promise<{ simulations: SimulationSummary[] }> => {
    await platformAdmin(request);
    return { simulations: await simulator.list() };
  });

  app.post("/api/admin/simulator/simulations", async (request, reply): Promise<{ simulation: SimulationDetail }> => {
    const admin = await platformAdmin(request);
    const simulation = await simulator.create(parse(simulationSchema, request.body), actorOf(admin, request));
    reply.status(201);
    return { simulation };
  });

  /** A simulation with its devices as they are right now, its route and its log. */
  app.get<ById>("/api/admin/simulator/simulations/:id", async (request): Promise<{ simulation: SimulationDetail }> => {
    await platformAdmin(request);
    return { simulation: await simulator.get(idOf(request)) };
  });

  app.put<ById>("/api/admin/simulator/simulations/:id", async (request): Promise<{ simulation: SimulationDetail }> => {
    const admin = await platformAdmin(request);
    return { simulation: await simulator.update(idOf(request), parse(simulationSchema, request.body), actorOf(admin, request)) };
  });

  app.delete<ById>("/api/admin/simulator/simulations/:id", async (request, reply) => {
    const admin = await platformAdmin(request);
    await simulator.remove(idOf(request), actorOf(admin, request));
    return reply.status(204).send();
  });

  /** Starts or stops a simulation. */
  app.post<ById>("/api/admin/simulator/simulations/:id/run", async (request): Promise<{ simulation: SimulationDetail }> => {
    const admin = await platformAdmin(request);
    const { run } = parse(simRunSchema, request.body);
    return { simulation: await simulator.run(idOf(request), run, actorOf(admin, request)) };
  });

  /** Does something by hand to a running simulation's devices: an alarm, a theft, a change of fuel, a disconnection. */
  app.post<ById>("/api/admin/simulator/simulations/:id/inject", async (request): Promise<{ simulation: SimulationDetail }> => {
    await platformAdmin(request);
    return { simulation: await simulator.inject(idOf(request), parse(simInjectSchema, request.body)) };
  });

  /** Sends its whole route as a trip of the past, as a device uploads what it stored. */
  app.post<ById>("/api/admin/simulator/simulations/:id/backfill", async (request): Promise<{ simulation: SimulationDetail; reports: number }> => {
    await platformAdmin(request);
    const { hoursAgo } = parse(simBackfillSchema, request.body ?? {});
    return await simulator.backfill(idOf(request), hoursAgo);
  });

  /** Starts or stops all of them. */
  app.post("/api/admin/simulator/run", async (request): Promise<{ simulations: SimulationSummary[] }> => {
    const admin = await platformAdmin(request);
    const { run } = parse(simRunSchema, request.body);
    return { simulations: await simulator.runAll(run, actorOf(admin, request)) };
  });
}
