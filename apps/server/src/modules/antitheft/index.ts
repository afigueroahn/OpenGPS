// Module A · Anti-theft and commands: routes and what the module does on its own
// when positions and events arrive from the core.
import { type IncidentKind, incidentCloseSchema, incidentCreateSchema, incidentNoteSchema, lockPrepareSchema, lockSchema, recoverySchema } from "@opengps/shared";
import { z } from "zod";
import type { CoreEvents } from "../../bus";
import { recordEvent } from "../../core/events";
import { badRequest } from "../../errors";
import { say } from "../../i18n";
import type { IdParams, ModuleContext, ModuleDeps } from "../context";
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_TYPES,
  addEvidence,
  addNote,
  attendIncident,
  closeIncident,
  dropEvidence,
  escalate,
  getIncident,
  listIncidents,
  pruneEvidence,
  raise,
  readEvidence,
  reportIncident,
} from "./incidents";
import { cancelCommand, getSecurity, onPosition, prepareLock, requestLock, setRecovery, sweepCommands } from "./security";

/** Device alarms that open an incident. */
const ALARM_INCIDENT: Record<string, IncidentKind> = {
  sos: "sos",
  tow: "tow",
  tampering: "tampering",
  removing: "tampering",
  gpsAntennaCut: "tampering",
  jamming: "jamming",
  powerCut: "power_cut",
};
/** Of those, the ones the core does not record on its own and this module adds to the event list. */
const ALARM_EVENT = { tampering: "tampering", jamming: "jamming" } as const;
const EVENT_COOLDOWN_MS = 5 * 60_000;
const SWEEP_MS = 30_000;

export interface AntitheftEngine {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
  /** Periodic check: orders that are waiting or expiring and unattended panic buttons. */
  sweep(now?: number, orgId?: string): Promise<void>;
}

export function createAntitheftEngine(deps: ModuleDeps & { sweepEveryMs?: number | null }): AntitheftEngine {
  let queue: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let cleaner: NodeJS.Timeout | null = null;
  const off: (() => void)[] = [];
  const lastEvent = new Map<string, number>();
  const enqueue = (what: string, job: () => Promise<unknown>) => {
    queue = queue.then(job).catch((err: Error) => console.error(`[antitheft] ${what}:`, err.message));
  };

  async function onFixes(payload: CoreEvents["fixes"]): Promise<void> {
    if (!(await deps.gate.enabled(payload.orgId, "A"))) return;
    for (const fix of payload.fixes) {
      for (const alarm of fix.alarms) {
        const kind = ALARM_INCIDENT[alarm];
        if (!kind) continue;
        await raise(deps, payload, kind, { at: fix.t, lat: fix.lat, lon: fix.lon });
        const type = ALARM_EVENT[kind as keyof typeof ALARM_EVENT];
        const key = `${payload.deviceId}:${type}`;
        if (type && fix.t - (lastEvent.get(key) ?? 0) >= EVENT_COOLDOWN_MS) {
          lastEvent.set(key, fix.t);
          await recordEvent(deps, payload, { type, at: fix.t, lat: fix.lat, lon: fix.lon, speedKmh: fix.speedKmh, detail: { alarm } });
        }
      }
    }
    const newest = payload.fixes[payload.fixes.length - 1];
    if (newest) await onPosition(deps, payload.vehicleId, newest.attributes);
  }

  /** Core notifications that are also an incident: the parked vehicle that moves, or towed with the engine off. */
  async function onEvent(payload: CoreEvents["event"]): Promise<void> {
    const { event } = payload;
    const kind: IncidentKind | null = event.type === "unauthorized_movement" ? "movement" : event.type === "tow" && !event.detail.byDevice ? "tow" : null;
    if (!kind || !(await deps.gate.enabled(payload.orgId, "A"))) return;
    await raise(deps, { orgId: payload.orgId, vehicleId: event.vehicleId, groupId: payload.groupId }, kind, { at: Date.parse(event.at), lat: event.lat, lon: event.lon });
  }

  const sweep = async (now = Date.now(), orgId: string | null = null) => {
    await sweepCommands(deps, now, orgId);
    await escalate(deps, now, orgId);
  };

  return {
    start() {
      off.push(
        deps.bus.on("fixes", (payload) => enqueue("could not check a position", () => onFixes(payload))),
        deps.bus.on("event", (payload) => enqueue("could not check an event", () => onEvent(payload))),
        deps.bus.on("account_deleted", (e) => enqueue("could not delete the evidence of an account", () => dropEvidence(deps, e.orgId))),
      );
      const every = deps.sweepEveryMs === undefined ? SWEEP_MS : deps.sweepEveryMs;
      if (every !== null) {
        timer = setInterval(() => enqueue("the periodic check failed", () => sweep()), every);
        cleaner = setInterval(() => enqueue("the evidence cleanup failed", () => pruneEvidence(deps)), 60 * 60_000);
      }
    },
    stop() {
      for (const stop of off.splice(0)) stop();
      if (timer) clearInterval(timer);
      if (cleaner) clearInterval(cleaner);
      timer = cleaner = null;
    },
    idle: () => queue.then(() => undefined),
    sweep: (now, orgId) => sweep(now, orgId ?? null),
  };
}

const listQuery = z.object({ open: z.enum(["0", "1"]).default("1"), limit: z.coerce.number().int().min(1).max(200).default(100) });
const fileQuery = z.object({ name: z.string().trim().min(1).max(200) });

export function registerAntitheft(ctx: ModuleContext): void {
  const { app, session, actorOf, parse } = ctx;
  const deps: ModuleDeps = ctx;

  // ─── Lock and recovery ─────────────────────────────────────────────────────

  app.get<IdParams>("/api/vehicles/:id/security", async (request) => {
    const s = await session(request, "A");
    return { security: await getSecurity(deps, s, request.params.id) };
  });

  /** First step of the lock: what is going to be done and the vehicle's condition. */
  app.post<IdParams>("/api/vehicles/:id/lock/prepare", async (request) => {
    const s = await session(request, "A", "commands.send");
    const { action } = parse(lockPrepareSchema, request.body);
    return { check: await prepareLock(deps, actorOf(s, request), request.params.id, action) };
  });

  /** Second step: with the check from the first and the word typed by the person. */
  app.post<IdParams>("/api/vehicles/:id/lock", async (request) => {
    const s = await session(request, "A", "commands.send");
    return { security: await requestLock(deps, actorOf(s, request), request.params.id, parse(lockSchema, request.body)) };
  });

  app.delete<IdParams>("/api/vehicles/:id/lock", async (request) => {
    const s = await session(request, "A", "commands.send");
    return { security: await cancelCommand(deps, actorOf(s, request), request.params.id) };
  });

  app.post<IdParams>("/api/vehicles/:id/recovery", async (request, reply) => {
    const s = await session(request, "A", "commands.send");
    const { on } = parse(recoverySchema, request.body);
    return reply.header("Cache-Control", "no-store").send(await setRecovery(deps, actorOf(s, request), request.params.id, on));
  });

  // ─── Incidents ─────────────────────────────────────────────────────────────

  app.get("/api/incidents", async (request) => {
    const s = await session(request, "A");
    const { open, limit } = parse(listQuery, request.query);
    return { incidents: await listIncidents(deps.db.core, s, { open: open === "1", limit }) };
  });

  app.post("/api/incidents", async (request, reply) => {
    const s = await session(request, "A", "incidents.manage");
    const { vehicleId, note } = parse(incidentCreateSchema, request.body);
    return reply.status(201).send({ incident: await reportIncident(deps, actorOf(s, request), vehicleId, note) });
  });

  app.get<IdParams>("/api/incidents/:id", async (request) => {
    const s = await session(request, "A");
    return { incident: await getIncident(deps.db.core, s, request.params.id) };
  });

  app.post<IdParams>("/api/incidents/:id/attend", async (request) => {
    const s = await session(request, "A", "incidents.manage");
    return { incident: await attendIncident(deps, actorOf(s, request), request.params.id) };
  });

  app.post<IdParams>("/api/incidents/:id/notes", async (request) => {
    const s = await session(request, "A", "incidents.manage");
    return { incident: await addNote(deps, actorOf(s, request), request.params.id, parse(incidentNoteSchema, request.body).text) };
  });

  app.post<IdParams>("/api/incidents/:id/close", async (request) => {
    const s = await session(request, "A", "incidents.manage");
    return { incident: await closeIncident(deps, actorOf(s, request), request.params.id, parse(incidentCloseSchema, request.body)) };
  });

  // Evidence arrives as the file itself, with its type in the header and its name in the address.
  for (const type of EVIDENCE_TYPES) {
    app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: EVIDENCE_MAX_BYTES }, (_request, body, done) => done(null, body));
  }
  app.post<IdParams>("/api/incidents/:id/files", { bodyLimit: EVIDENCE_MAX_BYTES }, async (request, reply) => {
    const s = await session(request, "A", "incidents.manage");
    const { name } = parse(fileQuery, request.query);
    if (!Buffer.isBuffer(request.body)) throw badRequest(say("antitheft.errors.fileType"));
    const mime = String(request.headers["content-type"] ?? "").split(";")[0] as string;
    return reply.status(201).send({ incident: await addEvidence(deps, actorOf(s, request), request.params.id, { name, mime, data: request.body }) });
  });

  app.get<{ Params: { id: string; fileId: string } }>("/api/incidents/:id/files/:fileId", async (request, reply) => {
    const s = await session(request, "A");
    const file = await readEvidence(deps, s, request.params.id, request.params.fileId);
    return reply
      .header("Content-Type", file.mime)
      .header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(file.data);
  });
}
