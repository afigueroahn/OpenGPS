// Module G · Reports and dashboards: routes, and what the module does on its own
// (sending the scheduled reports and keeping the saved trips up to date).
import { REPORT_FORMATS, REPORT_PARAMS_DEFAULT, REPORT_TYPES, dashboardSchema, isValidZone, reportParamsSchema, reportScheduleSchema } from "@opengps/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionContext } from "../../auth";
import { audit } from "../../core/audit";
import { dayOf, loadDays } from "../../core/days";
import { notFound } from "../../errors";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import { buildReport } from "./build";
import { createDashboard, dashboardData, deleteDashboard, listDashboards, updateDashboard } from "./dashboards";
import { renderReport } from "./render";
import { createSchedule, deleteSchedule, listSchedules, people, sendDue, sendNow, updateSchedule } from "./schedules";

/** Days back that the module keeps analyzed, so the first report of a month is not slow. */
const WARM_DAYS = 31;
const WARM_EVERY_MS = 60 * 60_000;
const TICK_MS = 60_000;
/** Reports calculated at the same time; the rest wait their turn. */
const AT_ONCE = 2;

export interface ReportsEngine {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
  /** Sends the reports whose time has come. Returns how many it attempted. */
  tick(now?: number): Promise<number>;
  /** Analyzes and saves the missing days of the accounts with the module. */
  warm(now?: number): Promise<void>;
}

/** With `tickEveryMs` null there is no clock: whoever creates it calls `tick` when they want (tests). */
export function createReportsEngine(deps: ModuleDeps & { tickEveryMs?: number | null }): ReportsEngine {
  let queue: Promise<unknown> = Promise.resolve();
  const timers: NodeJS.Timeout[] = [];
  const enqueue = <T>(what: string, job: () => Promise<T>): Promise<T | undefined> => {
    const run = queue.then(job).catch((err: Error) => {
      console.error(`[reports] ${what}:`, err.message);
      return undefined;
    });
    queue = run;
    return run;
  };

  async function warm(now = Date.now()): Promise<void> {
    const orgs = await deps.db.core.query<{ org_id: string }>(`SELECT org_id FROM gps.account_settings WHERE 'G' = ANY(modules) AND NOT suspended`);
    const last = dayOf(now) - 1;
    for (const { org_id } of orgs.rows) {
      const vehicles = await deps.db.core.query<{ id: string }>(`SELECT id FROM gps.vehicles WHERE org_id = $1`, [org_id]);
      const ids = vehicles.rows.map((v) => v.id);
      for (let i = 0; i < ids.length; i += 25) await loadDays(deps.db.core, org_id, ids.slice(i, i + 25), last - WARM_DAYS + 1, last, { now, fillOnly: true });
    }
  }

  return {
    start() {
      const every = deps.tickEveryMs === undefined ? TICK_MS : deps.tickEveryMs;
      if (every === null) return;
      timers.push(
        setInterval(() => void enqueue("could not send the scheduled reports", () => sendDue(deps)), every),
        setInterval(() => void enqueue("could not prepare the days", () => warm()), WARM_EVERY_MS),
        setTimeout(() => void enqueue("could not prepare the days", () => warm()), 90_000),
      );
    },
    stop() {
      for (const t of timers.splice(0)) clearTimeout(t);
    },
    idle: () => queue.then(() => undefined),
    tick: async (now) => (await enqueue("could not send the scheduled reports", () => sendDue(deps, now))) ?? 0,
    warm: async (now) => {
      await enqueue("could not prepare the days", () => warm(now));
    },
  };
}

const zone = z.string().trim().min(1).max(64).refine(isValidZone, "validation.zone").default("UTC");
const rangeQuery = z.object({
  from: z.coerce.date("api.validation.fromNeeded"),
  to: z.coerce.date("api.validation.toNeeded"),
  zone,
});
const reportQuery = rangeQuery.extend({
  groupId: z.uuid().optional(),
  /** Comma-separated identifiers. */
  vehicleIds: z.string().max(12_000).optional(),
  speedLimitKmh: z.coerce.number().default(REPORT_PARAMS_DEFAULT.speedLimitKmh),
  minStopMin: z.coerce.number().default(REPORT_PARAMS_DEFAULT.minStopMin),
});
const exportQuery = reportQuery.extend({ format: z.enum(REPORT_FORMATS, "api.validation.formatUnavailable") });
const dataQuery = rangeQuery.extend({ groupId: z.uuid().optional(), vehicleIds: z.string().max(12_000).optional() });
const typeSchema = z.enum(REPORT_TYPES);

type TypeParams = { Params: { type: string } };

export function registerReports(ctx: ModuleContext): void {
  const { app, session, actorOf, parse } = ctx;
  const deps: ModuleDeps = ctx;
  const db = deps.db.core;

  let running = 0;
  const waiting: (() => void)[] = [];
  /** A report reads a lot: they are calculated a few at a time so the rest of the platform is not starved. */
  async function inTurn<T>(job: () => Promise<T>): Promise<T> {
    if (running >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await job();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  /** What the request asks for, to be written in the language of whoever asks. */
  function requestOf(request: FastifyRequest<TypeParams>, query: z.output<typeof reportQuery>) {
    const type = typeSchema.safeParse(request.params.type);
    if (!type.success) throw notFound();
    const params = parse(reportParamsSchema, {
      groupId: query.groupId ?? null,
      vehicleIds: query.vehicleIds ? query.vehicleIds.split(",") : null,
      speedLimitKmh: query.speedLimitKmh,
      minStopMin: query.minStopMin,
    });
    return { type: type.data, range: { from: query.from, to: query.to }, zone: query.zone, params, language: ctx.language(request) };
  }
  const owner = (s: SessionContext) => ({ orgId: s.orgId, groups: s.groups, vehicles: s.vehicles, userId: s.userId });

  // ─── Scheduled reports ─────────────────────────────────────────────────────
  // They go before the per-report-type routes so that "schedules" is not read as a type.

  app.get("/api/reports/schedules", async (request) => {
    const s = await session(request, "G", "reports.schedule");
    return { schedules: await listSchedules(db, owner(s)), people: await people(db, s.orgId) };
  });

  app.post("/api/reports/schedules", async (request, reply) => {
    const s = await session(request, "G", "reports.schedule");
    return reply.status(201).send({ schedule: await createSchedule(deps, actorOf(s, request), parse(reportScheduleSchema, request.body)) });
  });

  app.put<IdParams>("/api/reports/schedules/:id", async (request) => {
    const s = await session(request, "G", "reports.schedule");
    return { schedule: await updateSchedule(deps, actorOf(s, request), request.params.id, parse(reportScheduleSchema, request.body)) };
  });

  app.delete<IdParams>("/api/reports/schedules/:id", async (request, reply) => {
    const s = await session(request, "G", "reports.schedule");
    await deleteSchedule(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  app.post<IdParams>("/api/reports/schedules/:id/send", async (request) => {
    const s = await session(request, "G", "reports.schedule");
    return await inTurn(() => sendNow(deps, actorOf(s, request), request.params.id));
  });

  // ─── Reports ───────────────────────────────────────────────────────────────

  app.get<TypeParams>("/api/reports/:type", async (request) => {
    const s = await session(request, "G");
    const wanted = requestOf(request, parse(reportQuery, request.query));
    return { report: await inTurn(() => buildReport(deps, s, wanted)) };
  });

  app.get<TypeParams>("/api/reports/:type/export", async (request, reply) => {
    const s = await session(request, "G");
    const { format, ...query } = parse(exportQuery, request.query);
    const wanted = requestOf(request, query);
    const file = await inTurn(async () => renderReport(await buildReport(deps, s, wanted), format, deps.config.appName, wanted.language));
    // Extracting data from the platform is logged.
    await audit(db, actorOf(s, request), "report.export", "report", wanted.type, { type: wanted.type, format, from: wanted.range.from.toISOString(), to: wanted.range.to.toISOString() });
    return reply
      .header("Content-Type", file.contentType)
      .header("Content-Disposition", `attachment; filename="${file.filename}"`)
      .header("Cache-Control", "private, no-store")
      .send(file.body);
  });

  // ─── Dashboards ────────────────────────────────────────────────────────────

  app.get("/api/dashboards", async (request) => {
    const s = await session(request, "G");
    return { dashboards: await listDashboards(db, owner(s)) };
  });

  app.post("/api/dashboards", async (request, reply) => {
    const s = await session(request, "G");
    return reply.status(201).send({ dashboard: await createDashboard(db, owner(s), parse(dashboardSchema, request.body)) });
  });

  app.put<IdParams>("/api/dashboards/:id", async (request) => {
    const s = await session(request, "G");
    return { dashboard: await updateDashboard(db, owner(s), request.params.id, parse(dashboardSchema, request.body)) };
  });

  app.delete<IdParams>("/api/dashboards/:id", async (request, reply) => {
    const s = await session(request, "G");
    await deleteDashboard(db, owner(s), request.params.id);
    return reply.status(204).send();
  });

  app.get("/api/dashboards/data", async (request) => {
    const s = await session(request, "G");
    const { groupId, vehicleIds, zone: zoneName, ...range } = parse(dataQuery, request.query);
    // The same two ways of choosing vehicles as in a report: a group, or a list of them.
    const scope = parse(reportParamsSchema.pick({ groupId: true, vehicleIds: true }), { groupId: groupId ?? null, vehicleIds: vehicleIds ? vehicleIds.split(",") : null });
    return { data: await inTurn(() => dashboardData(deps, s, { range, zone: zoneName, ...scope, language: ctx.language(request) })) };
  });
}
