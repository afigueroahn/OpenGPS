// Module C · Diagnostics: routes. What the module does on its own when positions
// arrive is in watch.ts.
import { DIAG_PARAM_KEYS, type DiagParam, type Language, diagLimitsSchema, diagSettingsSchema, vehicleMetersSchema } from "@opengps/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { getMeters, setMeters } from "../../core/meters";
import { AppError } from "../../errors";
import { tr } from "../../i18n";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import { diagSeries, diagStatus, getDiagSettings, listFaults, saveDiagSettings, saveOwnLimits } from "./diag";

export { type DiagnosticsEngine, createDiagnosticsEngine } from "./watch";

/** zod gives its messages as they are: they are written in the language of the request. */
const seriesQuery = (language: Language) =>
  z.object({
    param: z.enum(DIAG_PARAM_KEYS as [DiagParam, ...DiagParam[]], tr(language, "diagnostics.errors.paramUnknown")),
    from: z.coerce.date(tr(language, "diagnostics.errors.fromNeeded")),
    to: z.coerce.date(tr(language, "diagnostics.errors.toNeeded")),
  });

export function registerDiagnostics(ctx: ModuleContext): void {
  const { app, session, actorOf, parse } = ctx;
  const deps: ModuleDeps = ctx;

  app.get<IdParams>("/api/vehicles/:id/diagnostics", async (request) => {
    const s = await session(request, "C");
    return { diagnostics: await diagStatus(deps, s, request.params.id, ctx.language(request)) };
  });

  app.get<IdParams>("/api/vehicles/:id/diagnostics/series", async (request) => {
    const s = await session(request, "C");
    const { param, from, to } = parse(seriesQuery(ctx.language(request)), request.query);
    return { series: await diagSeries(deps, s, request.params.id, param, { from, to }) };
  });

  app.get<IdParams>("/api/vehicles/:id/diagnostics/faults", async (request) => {
    const s = await session(request, "C");
    return { faults: await listFaults(deps.db.core, s, request.params.id, ctx.language(request)) };
  });

  /** The vehicle's own limits: the ones sent. The ones not sent become the account's again. */
  app.put<IdParams>("/api/vehicles/:id/diagnostics/limits", async (request) => {
    const s = await session(request, "C", "vehicles.manage");
    return { diagnostics: await saveOwnLimits(deps, actorOf(s, request), request.params.id, parse(diagLimitsSchema, request.body), ctx.language(request)) };
  });

  app.get("/api/diagnostics/settings", async (request) => {
    const s = await session(request, "C");
    return { settings: await getDiagSettings(deps.db.core, s.orgId) };
  });

  app.put("/api/diagnostics/settings", async (request) => {
    const s = await session(request, "C", "vehicles.manage");
    return { settings: await saveDiagSettings(deps, actorOf(s, request), parse(diagSettingsSchema, request.body)) };
  });

  // Odometer and engine hours belong to the core: this module and the maintenance one show them.
  const withMeters = async (request: FastifyRequest, permission?: "vehicles.manage") => {
    try {
      return await session(request, "C", permission);
    } catch (err) {
      if (err instanceof AppError && err.status === 404) return session(request, "E", permission);
      throw err;
    }
  };

  app.get<IdParams>("/api/vehicles/:id/meters", async (request) => {
    const s = await withMeters(request);
    return { meters: await getMeters(deps.db.core, s, request.params.id) };
  });

  app.put<IdParams>("/api/vehicles/:id/meters", async (request) => {
    const s = await withMeters(request, "vehicles.manage");
    return { meters: await setMeters(deps, actorOf(s, request), request.params.id, parse(vehicleMetersSchema, request.body)) };
  });
}
