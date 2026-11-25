// Module F · Fuel: routes. Level, consumption and fills are calculated
// at query time; what the module does on its own is in watch.ts.
import { type Language, fuelFillSchema, fuelImportSchema, fuelSettingsSchema, fuelTankSchema } from "@opengps/shared";
import { z } from "zod";
import { tr } from "../../i18n";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import { createFill, deleteFill, getFuelSettings, importFills, listFills, saveFuelSettings, updateFill } from "./fills";
import { fuelReport, fuelStatus, removeTank, saveTank } from "./fuel";

export { type FuelEngine, createFuelEngine } from "./watch";

/** A period. zod gives its messages as they are: they are written in the language of the request. */
const rangeQuery = (language: Language) =>
  z.object({
    from: z.coerce.date(tr(language, "fuel.errors.fromNeeded")),
    to: z.coerce.date(tr(language, "fuel.errors.toNeeded")),
  });

export function registerFuel(ctx: ModuleContext): void {
  const { app, session, actorOf, parse } = ctx;
  const deps: ModuleDeps = ctx;

  app.get<IdParams>("/api/vehicles/:id/fuel", async (request) => {
    const s = await session(request, "F");
    return { fuel: await fuelStatus(deps.db.core, s, request.params.id) };
  });

  app.put<IdParams>("/api/vehicles/:id/fuel", async (request) => {
    const s = await session(request, "F", "vehicles.manage");
    return { fuel: await saveTank(deps, actorOf(s, request), request.params.id, parse(fuelTankSchema, request.body)) };
  });

  app.delete<IdParams>("/api/vehicles/:id/fuel", async (request, reply) => {
    const s = await session(request, "F", "vehicles.manage");
    await removeTank(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  app.get<IdParams>("/api/vehicles/:id/fuel/report", async (request) => {
    const s = await session(request, "F");
    return { report: await fuelReport(deps, s, request.params.id, parse(rangeQuery(ctx.language(request)), request.query)) };
  });

  // Fills: the recorded ones and the fills the sensor detected.
  app.get<IdParams>("/api/vehicles/:id/fuel/fills", async (request) => {
    const s = await session(request, "F");
    return { fills: await listFills(deps, s, request.params.id, parse(rangeQuery(ctx.language(request)), request.query)) };
  });

  app.post<IdParams>("/api/vehicles/:id/fuel/fills", async (request, reply) => {
    const s = await session(request, "F", "vehicles.manage");
    const fill = await createFill(deps, actorOf(s, request), request.params.id, parse(fuelFillSchema, request.body));
    return reply.status(201).send({ fill });
  });

  app.put<IdParams>("/api/fuel/fills/:id", async (request) => {
    const s = await session(request, "F", "vehicles.manage");
    return { fill: await updateFill(deps, actorOf(s, request), request.params.id, parse(fuelFillSchema, request.body)) };
  });

  app.delete<IdParams>("/api/fuel/fills/:id", async (request, reply) => {
    const s = await session(request, "F", "vehicles.manage");
    await deleteFill(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  /** Records the fills from a CSV file: vehicle, date, liters and, if present, total, currency, odometer, station and note. */
  app.post("/api/fuel/fills/import", async (request) => {
    const s = await session(request, "F", "vehicles.manage");
    return { result: await importFills(deps, actorOf(s, request), parse(fuelImportSchema, request.body), ctx.language(request)) };
  });

  app.get("/api/fuel/settings", async (request) => {
    const s = await session(request, "F");
    return { settings: await getFuelSettings(deps.db.core, s.orgId) };
  });

  app.put("/api/fuel/settings", async (request) => {
    const s = await session(request, "F", "vehicles.manage");
    return { settings: await saveFuelSettings(deps, actorOf(s, request), parse(fuelSettingsSchema, request.body)) };
  });
}
