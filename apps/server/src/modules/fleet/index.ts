// Module D · Fleet: routes, and cleanup of the files of what is deleted.
import { FLEET_DOCUMENT_TYPES, type Language, UPLOAD_MAX_MB, fleetAssignmentSchema, fleetDocumentSchema, fleetExpenseSchema, fleetGroupParentSchema, fleetProfileSchema, fleetStateSchema, fleetStatusSchema, isValidZone } from "@opengps/shared";
import { z } from "zod";
import { listGroups } from "../../core/groups";
import { badRequest } from "../../errors";
import { say, tr } from "../../i18n";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import { addDocument, deleteDocument, dropAccountFiles, getFleetVehicle, listFleet, pruneFiles, readDocument, saveProfile, setState, setStatus } from "./fleet";
import { addAssignment, createExpense, deleteExpense, listAssignments, listExpenses, removeAssignment, setGroupParent, updateExpense, utilization } from "./usage";

const MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validation.dateFormat");
const zoneParam = z.string().trim().min(1).max(64).refine(isValidZone, "validation.zone").default("UTC");
const expensesQuery = z.object({ from: dateOnly, to: dateOnly, vehicleId: z.uuid().optional(), zone: zoneParam });
/** zod gives its messages as they are: they are written in the language of the request. */
const usageQuery = (language: Language) =>
  z.object({
    from: z.coerce.date(tr(language, "fleet.errors.fromNeeded")),
    to: z.coerce.date(tr(language, "fleet.errors.toNeeded")),
    zone: zoneParam,
  });

export interface FleetEngine {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
}

/** The module does not watch positions: it only removes from disk the files of accounts and vehicles that are deleted. */
export function createFleetEngine(deps: ModuleDeps): FleetEngine {
  let queue: Promise<unknown> = Promise.resolve();
  const off: (() => void)[] = [];
  const enqueue = (what: string, job: () => Promise<unknown>) => {
    queue = queue.then(job).catch((err: Error) => console.error(`[fleet] ${what}:`, err.message));
  };
  return {
    start() {
      off.push(
        deps.bus.on("account_deleted", (e) => enqueue("could not delete the files of an account", () => dropAccountFiles(deps, e.orgId))),
        deps.bus.on("vehicles_changed", (e) => enqueue("could not clean up the files of a deleted vehicle", () => pruneFiles(deps, e.orgId))),
      );
    },
    stop() {
      for (const stop of off.splice(0)) stop();
    },
    idle: () => queue.then(() => undefined),
  };
}

export function registerFleet(ctx: ModuleContext): void {
  const { app, session, actorOf, parse } = ctx;
  const deps: ModuleDeps = ctx;

  app.get("/api/fleet", async (request) => {
    const s = await session(request, "D");
    return { fleet: await listFleet(deps, s) };
  });

  app.get<IdParams>("/api/vehicles/:id/fleet", async (request) => {
    const s = await session(request, "D");
    return { vehicle: await getFleetVehicle(deps, s, request.params.id) };
  });

  app.put<IdParams>("/api/vehicles/:id/fleet", async (request) => {
    const s = await session(request, "D", "vehicles.manage");
    return { vehicle: await saveProfile(deps, actorOf(s, request), request.params.id, parse(fleetProfileSchema, request.body)) };
  });

  app.put<IdParams>("/api/vehicles/:id/fleet/status", async (request) => {
    const s = await session(request, "D", "vehicles.manage");
    return { vehicle: await setStatus(deps, actorOf(s, request), request.params.id, parse(fleetStatusSchema, request.body)) };
  });

  app.put<IdParams>("/api/vehicles/:id/fleet/state", async (request) => {
    const s = await session(request, "D", "vehicles.manage");
    return { vehicle: await setState(deps, actorOf(s, request), request.params.id, parse(fleetStateSchema, request.body)) };
  });

  // Documents arrive as the file itself, with its type in the header and its data in the address.
  for (const type of FLEET_DOCUMENT_TYPES) {
    if (!app.hasContentTypeParser(type)) app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: MAX_BYTES }, (_request, body, done) => done(null, body));
  }
  app.post<IdParams>("/api/vehicles/:id/fleet/documents", { bodyLimit: MAX_BYTES }, async (request, reply) => {
    const s = await session(request, "D", "vehicles.manage");
    const meta = parse(fleetDocumentSchema, request.query);
    if (!Buffer.isBuffer(request.body)) throw badRequest(say("fleet.errors.fileType"));
    const mime = String(request.headers["content-type"] ?? "").split(";")[0] as string;
    return reply.status(201).send({ vehicle: await addDocument(deps, actorOf(s, request), request.params.id, meta, { mime, data: request.body }) });
  });

  app.get<IdParams>("/api/fleet/documents/:id", async (request, reply) => {
    const s = await session(request, "D");
    const file = await readDocument(deps, s, request.params.id);
    return reply
      .header("Content-Type", file.mime)
      .header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(file.data);
  });

  app.delete<IdParams>("/api/fleet/documents/:id", async (request) => {
    const s = await session(request, "D", "vehicles.manage");
    return { vehicle: await deleteDocument(deps, actorOf(s, request), request.params.id) };
  });

  app.get<IdParams>("/api/vehicles/:id/fleet/assignments", async (request) => {
    const s = await session(request, "D");
    return { assignments: await listAssignments(deps, s, request.params.id, ctx.language(request)) };
  });

  app.post<IdParams>("/api/vehicles/:id/fleet/assignments", async (request, reply) => {
    const s = await session(request, "D", "vehicles.manage");
    return reply.status(201).send({ assignments: await addAssignment(deps, actorOf(s, request), request.params.id, parse(fleetAssignmentSchema, request.body), ctx.language(request)) });
  });

  app.delete<IdParams>("/api/fleet/assignments/:id", async (request) => {
    const s = await session(request, "D", "vehicles.manage");
    return { assignments: await removeAssignment(deps, actorOf(s, request), request.params.id, ctx.language(request)) };
  });

  app.get("/api/fleet/expenses", async (request) => {
    const s = await session(request, "D");
    return { expenses: await listExpenses(deps, s, parse(expensesQuery, request.query), ctx.language(request)) };
  });

  app.post("/api/fleet/expenses", async (request, reply) => {
    const s = await session(request, "D", "vehicles.manage");
    return reply.status(201).send({ expense: await createExpense(deps, actorOf(s, request), parse(fleetExpenseSchema, request.body)) });
  });

  app.put<IdParams>("/api/fleet/expenses/:id", async (request) => {
    const s = await session(request, "D", "vehicles.manage");
    return { expense: await updateExpense(deps, actorOf(s, request), request.params.id, parse(fleetExpenseSchema, request.body)) };
  });

  app.delete<IdParams>("/api/fleet/expenses/:id", async (request, reply) => {
    const s = await session(request, "D", "vehicles.manage");
    await deleteExpense(deps, actorOf(s, request), request.params.id);
    return reply.status(204).send();
  });

  app.get("/api/fleet/utilization", async (request) => {
    const s = await session(request, "D");
    const { zone, ...range } = parse(usageQuery(ctx.language(request)), request.query);
    return { utilization: await utilization(deps, s, range, zone) };
  });

  /** The group tree: each group says which one it hangs from. */
  app.get("/api/fleet/groups", async (request) => {
    const s = await session(request, "D");
    const groups = await listGroups(deps.db.core, s.orgId);
    // Whoever has group scope sees only their own and those that hang from them.
    return { groups: s.groups === null ? groups : groups.filter((g) => s.groups?.includes(g.id)) };
  });

  app.put<IdParams>("/api/fleet/groups/:id/parent", async (request) => {
    const s = await session(request, "D", "vehicles.manage");
    return { groups: await setGroupParent(deps, actorOf(s, request), request.params.id, parse(fleetGroupParentSchema, request.body).parentId) };
  });
}
