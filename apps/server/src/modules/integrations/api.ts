// Integrations: the public API, /api/v1. It is used by another system (an ERP, a CRM,
// an automation tool) with an account key, without a session.
// What it returns has its own stable shape, which does not change even if
// the web changes.
import { ALERT_EVENTS, API_RATE_PER_MINUTE, EVENT_TYPES, type EventType, type Language, MAINT_ORDER_STATUSES, type ModuleKey, type Vehicle, fuelFillSchema, routeTripSchema, sensorPushSchema, vehicleStatus } from "@opengps/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type Tenant, wholeAccount } from "../../core/access";
import { listGeofences } from "../../core/geofences";
import { listGroups } from "../../core/groups";
import { loadHistory } from "../../core/history";
import { metersOf } from "../../core/meters";
import { eventFacts } from "../../core/notify";
import { type Actor, getVehicle, listVehicles } from "../../core/vehicles";
import { AppError, badRequest, forbidden, notFound, tooMany } from "../../errors";
import { type ServerKey, say, tr } from "../../i18n";
import { createFill } from "../fuel/fills";
import { listDrivers } from "../drivers/drivers";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import { listOrders } from "../maintenance/orders";
import { createTrip, listTrips } from "../routes/trips";
import { authenticate, createLimiter } from "./keys";
import { ingest } from "./sensors";

const DAY = 86_400_000;
// These schemas write the key of their text; `parse` only says the shared ones, so these are said by `parseOwn`.
const FROM_NEEDED: ServerKey = "integrations.api.fromNeeded";
const TO_NEEDED: ServerKey = "integrations.api.toNeeded";
const rangeQuery = z.object({ from: z.coerce.date(FROM_NEEDED), to: z.coerce.date(TO_NEEDED) });
const eventsQuery = z.object({
  /** Only the events after this one: to request them in small batches, without repeats. */
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  vehicleId: z.uuid().optional(),
  type: z.enum(EVENT_TYPES).optional(),
  alerts: z.enum(["0", "1"]).default("0"),
});
const ordersQuery = z.object({ status: z.enum([...MAINT_ORDER_STATUSES, "pending"]).optional(), vehicleId: z.uuid().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const tripsQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

const bearerOf = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? header.match(/^Bearer\s+(\S+)$/i) : null;
  return match?.[1] ?? null;
};
const noKey = () => new AppError(401, "unauthorized", say("integrations.api.noKey"));

/**
 * `parse`, which also says in the reader's language the problems this module's
 * schemas word themselves: those whose message is one of `keys`.
 */
export function parseOwn<T extends z.ZodType>(parse: ModuleContext["parse"], keys: readonly ServerKey[], schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  const message = result.success ? null : result.error.issues[0]?.message;
  const own = keys.find((key) => key === message);
  if (own) throw badRequest(say(own));
  return parse(schema, data);
}

export function registerApiV1(ctx: ModuleContext): void {
  const { app, parse } = ctx;
  const deps: ModuleDeps = ctx;
  const db = deps.db.core;
  const limiter = createLimiter();

  /** The account of the key the request arrives with, with its query limit already counted. */
  async function withKey(request: FastifyRequest, reply: FastifyReply, opts: { write?: boolean; module?: ModuleKey } = {}): Promise<{ tenant: Tenant; actor: Actor }> {
    const token = bearerOf(request);
    const key = token ? await authenticate(db, token) : null;
    if (!key || !(await deps.gate.enabled(key.orgId, "I"))) throw noKey();
    const use = limiter.hit(key.keyId);
    void reply.header("X-RateLimit-Limit", limiter.limit).header("X-RateLimit-Remaining", Math.max(0, use.remaining)).header("X-RateLimit-Reset", use.resetS);
    if (use.remaining < 0) {
      void reply.header("Retry-After", use.resetS);
      throw tooMany(say("integrations.api.rateLimited", { limit: limiter.limit, seconds: use.resetS }));
    }
    if (opts.write && !key.canWrite) throw forbidden(say("integrations.api.readOnly"));
    // What belongs to a module the account does not have does not exist for it.
    if (opts.module && !(await deps.gate.enabled(key.orgId, opts.module))) throw notFound();
    const tenant: Tenant = wholeAccount(key.orgId);
    return { tenant, actor: { ...tenant, userId: key.userId } };
  }

  const vehicleOf = (v: Vehicle, meters: Awaited<ReturnType<typeof metersOf>>) => {
    const m = meters.get(v.id);
    const s = v.state;
    return {
      id: v.id,
      name: v.name,
      plate: v.plate,
      groupId: v.groupId,
      device: v.device ? { uniqueId: v.device.uniqueId, model: v.device.modelId } : null,
      status: vehicleStatus(v),
      position: s && s.lat !== null && s.lon !== null ? { at: s.fixTime, lat: s.lat, lon: s.lon, speedKmh: s.speedKmh, course: s.course, ignition: s.ignition } : null,
      lastSeenAt: s?.lastSeenAt ?? null,
      odometerKm: m ? Math.round(m.odometerKm * 10) / 10 : null,
      engineHours: m ? Math.round(m.engineHours * 10) / 10 : null,
    };
  };

  app.get("/api/v1", async () => ({ name: `${deps.config.appName} API`, version: "1", documentation: `${deps.config.publicUrl}/api/v1/openapi.json` }));

  /** The description of the API, in the format tools read (OpenAPI), in the language of the request. It does not require a key. */
  app.get("/api/v1/openapi.json", async (request, reply) =>
    reply.header("Cache-Control", "public, max-age=300").header("Vary", "Accept-Language, X-Language").send(openApi(deps.config.appName, deps.config.publicUrl, ctx.language(request))),
  );

  app.get("/api/v1/vehicles", async (request, reply) => {
    const { tenant } = await withKey(request, reply);
    const vehicles = await listVehicles(db, tenant);
    const meters = await metersOf(db, vehicles.map((v) => v.id));
    return { vehicles: vehicles.map((v) => vehicleOf(v, meters)) };
  });

  app.get<IdParams>("/api/v1/vehicles/:id", async (request, reply) => {
    const { tenant } = await withKey(request, reply);
    const vehicle = await getVehicle(db, tenant, request.params.id);
    return { vehicle: vehicleOf(vehicle, await metersOf(db, [vehicle.id])) };
  });

  /** A vehicle's positions over a period, from oldest to most recent. */
  app.get<IdParams>("/api/v1/vehicles/:id/positions", async (request, reply) => {
    const { tenant } = await withKey(request, reply);
    const range = parseOwn(parse, [FROM_NEEDED, TO_NEEDED], rangeQuery, request.query);
    const history = await loadHistory(db, tenant, request.params.id, range, { addresses: false });
    return { positions: history.samples.map((p) => ({ at: new Date(p.t).toISOString(), lat: p.lat, lon: p.lon, speedKmh: p.speedKmh, course: p.course, ignition: p.ignition })) };
  });

  /** A vehicle's trips over a period, with their summary. */
  app.get<IdParams>("/api/v1/vehicles/:id/trips", async (request, reply) => {
    const { tenant } = await withKey(request, reply);
    const range = parseOwn(parse, [FROM_NEEDED, TO_NEEDED], rangeQuery, request.query);
    const history = await loadHistory(db, tenant, request.params.id, range, { addresses: true });
    return {
      summary: { distanceM: history.summary.distanceM, trips: history.trips.length },
      trips: history.trips.map((t) => ({
        start: t.start,
        end: t.end,
        durationS: t.durationS,
        distanceM: t.distanceM,
        maxSpeedKmh: t.maxSpeedKmh,
        avgSpeedKmh: t.avgSpeedKmh,
        idleS: t.idleS,
        from: { lat: t.startLat, lon: t.startLon, address: t.startAddress },
        to: { lat: t.endLat, lon: t.endLon, address: t.endAddress },
      })),
    };
  });

  /** The account's events, from oldest to most recent. With `after` only the new ones are requested. */
  app.get("/api/v1/events", async (request, reply) => {
    const { tenant } = await withKey(request, reply);
    const q = parse(eventsQuery, request.query);
    const language = ctx.language(request);
    const types: readonly EventType[] | null = q.type ? [q.type] : q.alerts === "1" ? ALERT_EVENTS : null;
    const r = await db.query<{ id: string; type: EventType; at: Date; vehicle_id: string; vehicle_name: string; lat: number | null; lon: number | null; speed_kmh: number | null; detail: Record<string, unknown> }>(
      `SELECT e.id, e.type, e.at, e.vehicle_id, v.name AS vehicle_name, e.lat, e.lon, e.speed_kmh, e.detail
         FROM gps.events e JOIN gps.vehicles v ON v.id = e.vehicle_id
        WHERE e.org_id = $1 AND e.id > $2 AND ($3::uuid IS NULL OR e.vehicle_id = $3) AND ($4::text[] IS NULL OR e.type = ANY($4))
        ORDER BY e.id LIMIT $5`,
      [tenant.orgId, q.after, q.vehicleId ?? null, types, q.limit],
    );
    const events = r.rows.map((e) => ({
      id: Number(e.id),
      type: e.type,
      // A type no longer known goes as it is.
      label: (EVENT_TYPES as readonly string[]).includes(e.type) ? tr(language, `shared.event.${e.type}`) : e.type,
      at: e.at.toISOString(),
      vehicleId: e.vehicle_id,
      vehicleName: e.vehicle_name,
      lat: e.lat,
      lon: e.lon,
      speedKmh: e.speed_kmh,
      summary: eventFacts({ type: e.type, detail: e.detail }, language).join("; ") || null,
      detail: e.detail,
    }));
    return { events, last: events.at(-1)?.id ?? q.after };
  });

  app.get("/api/v1/geofences", async (request, reply) => {
    const { tenant } = await withKey(request, reply);
    return { geofences: (await listGeofences(db, tenant)).map((g) => ({ id: g.id, name: g.name, kind: g.kind, geometry: g.geometry, active: g.active, inside: g.inside })) };
  });

  app.get("/api/v1/groups", async (request, reply) => {
    const { tenant } = await withKey(request, reply);
    return { groups: await listGroups(db, tenant.orgId) };
  });

  // ─── What belongs to the account's modules ─────────────────────────────────

  app.get("/api/v1/drivers", async (request, reply) => {
    const { tenant } = await withKey(request, reply, { module: "B" });
    return { drivers: (await listDrivers(db, tenant)).map((d) => ({ id: d.id, name: d.name, license: d.license, phone: d.phone, keyId: d.keyId, active: d.active, vehicleId: d.vehicleId, since: d.since })) };
  });

  /** Records a fill, for example from the system that handles purchases. */
  app.post<IdParams>("/api/v1/vehicles/:id/fuel/fills", async (request, reply) => {
    const { actor } = await withKey(request, reply, { write: true, module: "F" });
    return reply.status(201).send({ fill: await createFill(deps, actor, request.params.id, parse(fuelFillSchema, request.body)) });
  });

  app.get("/api/v1/maintenance/orders", async (request, reply) => {
    const { tenant } = await withKey(request, reply, { module: "E" });
    return { orders: await listOrders(db, tenant, parse(ordersQuery, request.query)) };
  });

  app.get("/api/v1/routes/trips", async (request, reply) => {
    const { tenant } = await withKey(request, reply, { module: "H" });
    const { from, to } = parse(tripsQuery, request.query);
    return { trips: await listTrips(db, tenant, { from: from ?? new Date(Date.now() - 7 * DAY), to: to ?? new Date(Date.now() + 30 * DAY) }) };
  });

  /** Creates a dispatch, for example from the system where orders are taken. */
  app.post("/api/v1/routes/trips", async (request, reply) => {
    const { actor } = await withKey(request, reply, { write: true, module: "H" });
    return reply.status(201).send({ trip: await createTrip(deps, actor, parse(routeTripSchema, request.body)) });
  });

  // ─── Sensors ───────────────────────────────────────────────────────────────

  /** What a sensor sends, with its own key: a reading `{ value, at? }` or a list of them. */
  app.post("/api/v1/sensors/readings", async (request, reply) => {
    ctx.publicLimit(request);
    const token = bearerOf(request) ?? (typeof request.headers["x-sensor-key"] === "string" ? request.headers["x-sensor-key"] : null);
    if (!token) throw new AppError(401, "unauthorized", say("integrations.api.noSensorKey"));
    const body = parse(sensorPushSchema, request.body);
    const stored = await ingest(deps, token, Array.isArray(body) ? body : [body]);
    if (stored === null) throw new AppError(401, "unauthorized", say("integrations.api.unknownSensorKey"));
    return reply.status(201).send({ stored });
  });
}

// ─── Documentation ───────────────────────────────────────────────────────────

/**
 * The API description in OpenAPI 3 format, in `language`: Postman, n8n, Make and
 * client generators read it. The names of its components are identifiers and do not change.
 */
export function openApi(appName: string, publicUrl: string, language: Language): Record<string, unknown> {
  const t = (key: ServerKey, params?: Record<string, string | number>) => tr(language, key, params);
  const tag = { vehicles: t("integrations.api.doc.tags.vehicles"), events: t("integrations.api.doc.tags.events"), modules: t("integrations.api.doc.tags.modules"), sensors: t("integrations.api.doc.tags.sensors") };
  const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
  const range = [
    { name: "from", in: "query", required: true, schema: { type: "string", format: "date-time" }, description: t("integrations.api.doc.from") },
    { name: "to", in: "query", required: true, schema: { type: "string", format: "date-time" }, description: t("integrations.api.doc.to") },
  ];
  const ok = (description: string) => ({ "200": { description }, "401": { $ref: "#/components/responses/SinClave" }, "429": { $ref: "#/components/responses/Limite" } });
  const get = (summary: string, description: string, parameters: unknown[] = [], tagName = tag.vehicles) => ({ get: { tags: [tagName], summary, description, parameters, responses: ok(t("integrations.api.doc.ok")) } });
  return {
    openapi: "3.0.3",
    info: {
      title: `${appName} API`,
      version: "1",
      description: t("integrations.api.doc.description", { rate: API_RATE_PER_MINUTE }),
    },
    servers: [{ url: `${publicUrl}/api/v1` }],
    security: [{ clave: [] }],
    tags: [{ name: tag.vehicles }, { name: tag.events }, { name: tag.modules, description: t("integrations.api.doc.tags.modulesNote") }, { name: tag.sensors }],
    paths: {
      "/vehicles": get(t("integrations.api.doc.vehicles.summary"), t("integrations.api.doc.vehicles.description")),
      "/vehicles/{id}": get(t("integrations.api.doc.vehicle.summary"), t("integrations.api.doc.vehicle.description"), [id]),
      "/vehicles/{id}/positions": get(t("integrations.api.doc.positions.summary"), t("integrations.api.doc.positions.description"), [id, ...range]),
      "/vehicles/{id}/trips": get(t("integrations.api.doc.trips.summary"), t("integrations.api.doc.trips.description"), [id, ...range]),
      "/geofences": get(t("integrations.api.doc.geofences.summary"), t("integrations.api.doc.geofences.description")),
      "/groups": get(t("integrations.api.doc.groups.summary"), t("integrations.api.doc.groups.description")),
      "/events": get(
        t("integrations.api.doc.events.summary"),
        t("integrations.api.doc.events.description"),
        [
          { name: "after", in: "query", schema: { type: "integer", default: 0 }, description: t("integrations.api.doc.events.after") },
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
          { name: "vehicleId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "type", in: "query", schema: { type: "string", enum: [...EVENT_TYPES] } },
          { name: "alerts", in: "query", schema: { type: "string", enum: ["0", "1"] }, description: t("integrations.api.doc.events.alerts") },
        ],
        tag.events,
      ),
      "/drivers": get(t("integrations.api.doc.drivers.summary"), t("integrations.api.doc.drivers.description"), [], tag.modules),
      "/maintenance/orders": get(t("integrations.api.doc.orders.summary"), t("integrations.api.doc.orders.description"), [{ name: "status", in: "query", schema: { type: "string", enum: [...MAINT_ORDER_STATUSES, "pending"] } }], tag.modules),
      "/routes/trips": {
        ...get(t("integrations.api.doc.dispatches.summary"), t("integrations.api.doc.dispatches.description"), [], tag.modules),
        post: {
          tags: [tag.modules],
          summary: t("integrations.api.doc.createDispatch.summary"),
          description: t("integrations.api.doc.createDispatch.description"),
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Despacho" } } } },
          responses: { "201": { description: t("integrations.api.doc.created") }, "401": { $ref: "#/components/responses/SinClave" }, "403": { description: t("integrations.api.doc.readOnlyKey") } },
        },
      },
      "/vehicles/{id}/fuel/fills": {
        post: {
          tags: [tag.modules],
          summary: t("integrations.api.doc.fill.summary"),
          description: t("integrations.api.doc.fill.description"),
          parameters: [id],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Abastecimiento" } } } },
          responses: { "201": { description: t("integrations.api.doc.recorded") }, "401": { $ref: "#/components/responses/SinClave" }, "403": { description: t("integrations.api.doc.readOnlyKey") } },
        },
      },
      "/sensors/readings": {
        post: {
          tags: [tag.sensors],
          summary: t("integrations.api.doc.readings.summary"),
          description: t("integrations.api.doc.readings.description"),
          security: [{ sensor: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/Lectura" }, { type: "array", items: { $ref: "#/components/schemas/Lectura" } }] } } } },
          responses: { "201": { description: t("integrations.api.doc.readings.stored") }, "401": { description: t("integrations.api.unknownSensorKey") } },
        },
      },
    },
    components: {
      securitySchemes: { clave: { type: "http", scheme: "bearer", description: t("integrations.api.doc.apiKey") }, sensor: { type: "http", scheme: "bearer", description: t("integrations.api.doc.sensorKey") } },
      responses: {
        SinClave: { description: t("integrations.api.doc.noKey") },
        Limite: { description: t("integrations.api.doc.limit") },
      },
      schemas: {
        Lectura: { type: "object", required: ["value"], properties: { value: { type: "number" }, at: { type: "string", format: "date-time", description: t("integrations.api.doc.readings.at") } } },
        Abastecimiento: {
          type: "object",
          required: ["at", "liters"],
          properties: { at: { type: "string", format: "date-time" }, liters: { type: "number" }, total: { type: "number", nullable: true }, currency: { type: "string", example: "HNL" }, odometerKm: { type: "number", nullable: true }, station: { type: "string", nullable: true } },
        },
        Despacho: {
          type: "object",
          required: ["name", "vehicleId", "startsAt"],
          properties: {
            name: { type: "string" },
            vehicleId: { type: "string", format: "uuid" },
            planId: { type: "string", format: "uuid", nullable: true },
            driver: { type: "string", nullable: true },
            startsAt: { type: "string", format: "date-time" },
            stops: { type: "array", items: { type: "object", required: ["name", "lat", "lon"], properties: { name: { type: "string" }, lat: { type: "number" }, lon: { type: "number" }, radiusM: { type: "integer", default: 100 }, contact: { type: "string", nullable: true } } } },
          },
        },
      },
    },
  };
}
