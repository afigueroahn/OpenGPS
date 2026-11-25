// Module B · Driver: routes and what the module does on its own when
// positions arrive.
import { type DriverSettings, type Language, assignDriverSchema, driverSchema, driverSettingsSchema, isValidZone } from "@opengps/shared";
import { z } from "zod";
import type { CoreEvents } from "../../bus";
import { tr } from "../../i18n";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import { processFixes } from "./detector";
import { assignDriver, createDriver, deleteDriver, getSettings, listDrivers, saveSettings, updateDriver, vehicleDriver } from "./drivers";
import { driverReport, ranking } from "./driving";

const SETTINGS_TTL_MS = 30_000;

export interface DriversEngine {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
}

export function createDriversEngine(deps: ModuleDeps): DriversEngine {
  let queue: Promise<unknown> = Promise.resolve();
  const off: (() => void)[] = [];
  const settings = new Map<string, { at: number; value: DriverSettings }>();
  /** Last key seen on each vehicle. */
  const keys = new Map<string, string>();
  const enqueue = (what: string, job: () => Promise<unknown>) => {
    queue = queue.then(job).catch((err: Error) => console.error(`[drivers] ${what}:`, err.message));
  };

  async function settingsOf(orgId: string): Promise<DriverSettings> {
    const hit = settings.get(orgId);
    if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
    const value = await getSettings(deps.db.core, orgId);
    settings.set(orgId, { at: Date.now(), value });
    return value;
  }

  async function onFixes(payload: CoreEvents["fixes"]): Promise<void> {
    if (!(await deps.gate.enabled(payload.orgId, "B"))) return;
    await processFixes(deps, payload, await settingsOf(payload.orgId), keys);
  }

  return {
    start() {
      off.push(
        deps.bus.on("fixes", (payload) => enqueue("could not check a position", () => onFixes(payload))),
        deps.bus.on("drivers", (e) => {
          settings.delete(e.orgId);
          // A key nobody had may now belong to a driver: it is looked up again.
          keys.clear();
        }),
      );
    },
    stop() {
      for (const stop of off.splice(0)) stop();
    },
    idle: () => queue.then(() => undefined),
  };
}

/** A period. zod gives its messages as they are: they are written in the language of the request. */
const rangeQuery = (language: Language) =>
  z.object({
    from: z.coerce.date(tr(language, "drivers.errors.fromNeeded")),
    to: z.coerce.date(tr(language, "drivers.errors.toNeeded")),
  });
const rankingQuery = (language: Language) => rangeQuery(language).extend({ groupId: z.uuid().optional() });
const reportQuery = (language: Language) => rangeQuery(language).extend({ zone: z.string().trim().min(1).max(64).refine(isValidZone, "validation.zone").default("UTC") });

export function registerDrivers(ctx: ModuleContext): void {
  const { app, session, actorOf, parse } = ctx;
  const deps: ModuleDeps = ctx;
  const db = deps.db.core;

  app.get("/api/drivers", async (request) => {
    const s = await session(request, "B");
    return { drivers: await listDrivers(db, s) };
  });

  app.post("/api/drivers", async (request, reply) => {
    const s = await session(request, "B", "drivers.manage");
    return reply.status(201).send({ driver: await createDriver(deps, actorOf(s, request), parse(driverSchema, request.body)) });
  });

  app.put<IdParams>("/api/drivers/:id", async (request) => {
    const s = await session(request, "B", "drivers.manage");
    return { driver: await updateDriver(deps, actorOf(s, request), request.params.id, parse(driverSchema, request.body)) };
  });

  app.delete<IdParams>("/api/drivers/:id", async (request, reply) => {
    const s = await session(request, "B", "drivers.manage");
    await deleteDriver(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  app.get("/api/drivers/settings", async (request) => {
    const s = await session(request, "B");
    return { settings: await getSettings(db, s.orgId) };
  });

  app.put("/api/drivers/settings", async (request) => {
    const s = await session(request, "B", "drivers.manage");
    return { settings: await saveSettings(deps, actorOf(s, request), parse(driverSettingsSchema, request.body)) };
  });

  app.get("/api/drivers/ranking", async (request) => {
    const s = await session(request, "B");
    const language = ctx.language(request);
    const { groupId, ...range } = parse(rankingQuery(language), request.query);
    return { ranking: await ranking(db, s, range, groupId ?? null, language) };
  });

  app.get<IdParams>("/api/drivers/:id/report", async (request) => {
    const s = await session(request, "B");
    const { zone, ...range } = parse(reportQuery(ctx.language(request)), request.query);
    return { report: await driverReport(db, s, request.params.id, range, zone) };
  });

  app.get<IdParams>("/api/vehicles/:id/driver", async (request) => {
    const s = await session(request, "B");
    return await vehicleDriver(db, s, request.params.id);
  });

  app.put<IdParams>("/api/vehicles/:id/driver", async (request) => {
    const s = await session(request, "B", "drivers.manage");
    const { driverId } = parse(assignDriverSchema, request.body);
    return await assignDriver(deps, actorOf(s, request), request.params.id, driverId);
  });
}
