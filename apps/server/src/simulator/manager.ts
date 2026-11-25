// The simulator: runs the simulated devices of every simulation with a single
// clock, keeps their progress so they resume after a restart, and tells the
// console how each one is doing and whether the platform is receiving it.
import type { Socket } from "node:net";
import {
  type Language,
  type LonLat,
  SIM_LIMITS,
  type SimDeviceView,
  type SimInject,
  type SimLogCode,
  type SimLogEntry,
  type SimRoute,
  type SimRouteSummary,
  type SimStatus,
  type SimTrace,
  simActionNeeds,
  simInjectNeeds,
  type SimulationDetail,
  type SimulationSummary,
  type SimulatorMeta,
  simIdProblem,
} from "@opengps/shared";
import type { Bus } from "../bus";
import type { Config } from "../config";
import { audit } from "../core/audit";
import { deviceCatalog, findModel } from "../core/catalog";
import type { Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { say, shared } from "../i18n";
import { type DeviceEvent, type DeviceMemory, type SimDevice, createDevice, reportOf } from "./device";
import { type Plan, alarmsBetween, compile, placeOn, stateAt } from "./plan";
import { PROTOCOLS, type Protocol, type Report } from "./protocols";
import { type Routing, createRouting } from "./routing";
import {
  type RouteData,
  type SimulationData,
  type SimulationRow,
  deleteRoute,
  deleteSimulation,
  getRoute,
  getSimulation,
  identifiersInUse,
  insertRoute,
  insertSimulation,
  listRoutes,
  listSimulations,
  registeredDevices,
  saveProgress,
  setDesired,
  updateRoute,
  updateSimulation,
} from "./store";

export interface SimulatorActor {
  userId: string;
  ip?: string | null;
}

export interface Simulator {
  /** What it can do here; whether places can be searched is the address service's to say. */
  meta(language: Language): Omit<SimulatorMeta, "placeSearch">;
  routes(): Promise<SimRouteSummary[]>;
  /** A route with its points and its path, to edit it. */
  route(id: string): Promise<SimRoute>;
  createRoute(data: RouteData, actor: SimulatorActor): Promise<SimRoute>;
  /** The simulations that travel it start their trip over on the new path. */
  updateRoute(id: string, data: RouteData, actor: SimulatorActor): Promise<SimRoute>;
  /** A route some simulation travels is not deleted. */
  removeRoute(id: string, actor: SimulatorActor): Promise<void>;
  /** The path along streets through those points. */
  trace(points: LonLat[]): Promise<SimTrace>;
  list(): Promise<SimulationSummary[]>;
  get(id: string): Promise<SimulationDetail>;
  create(data: SimulationData, actor: SimulatorActor): Promise<SimulationDetail>;
  /** If it was running, it starts over with what changed. */
  update(id: string, data: SimulationData, actor: SimulatorActor): Promise<SimulationDetail>;
  remove(id: string, actor: SimulatorActor): Promise<void>;
  run(id: string, on: boolean, actor: SimulatorActor): Promise<SimulationDetail>;
  /** Does something by hand to the devices of a running simulation. */
  inject(id: string, action: SimInject): Promise<SimulationDetail>;
  /** Sends a whole lap of its route as a trip that ended that many hours ago. Returns how many reports went out. */
  backfill(id: string, hoursAgo: number): Promise<{ simulation: SimulationDetail; reports: number }>;
  runAll(on: boolean, actor: SimulatorActor): Promise<SimulationSummary[]>;
  /** Resumes what was running when the server stopped. */
  start(): Promise<void>;
  /** Disconnects every device, keeping what should resume. */
  stop(): void;
  idle(): Promise<void>;
  /** One turn of the clock. The timer calls it; a test does it by hand. */
  tick(now?: number): void;
}

export interface SimulatorDeps {
  db: Db;
  bus: Bus;
  config: Pick<Config, "traccar" | "gatewayHost" | "gatewayIp" | "simulator" | "routing" | "geocoder">;
  /** Who traces routes along streets; a test puts its own there. */
  routing?: Routing | undefined;
  /** How a device opens its connection; a test puts its own gateway there. */
  connect?: ((host: string, port: number) => Socket) | undefined;
  now?: (() => number) | undefined;
  /** Milliseconds between turns of the clock; null = only by hand. */
  tickMs?: number | null | undefined;
}

interface Running {
  row: SimulationRow;
  plan: Plan;
  host: string;
  port: number;
  devices: Map<string, SimDevice>;
  /** Seconds on the trip clock, and when it was last advanced. */
  tripS: number;
  tickedAt: number;
  startedAt: number;
  savedAt: number;
  /** What the platform stored of each device: when, and how long after it was sent. */
  received: Map<string, { at: number; latencyMs: number | null }>;
  /** When each device sent its latest reports, to time the platform. */
  sends: Map<string, number[]>;
  latencies: { at: number; ms: number }[];
  /** The last thing written to the log about each device, so a retry every few seconds is not a line each time. */
  lastLogged: Map<string, SimLogCode>;
}

const SAVE_EVERY_MS = 30_000;
const INDEX_EVERY_MS = 15_000;
/** Reports going out with nothing arriving for this long: the gateway is swallowing them. */
const SILENT_AFTER_MS = 20_000;
const LATENCY_WINDOW_MS = 5 * 60_000;
/** At most this many devices open their connection per second. */
const CONNECTS_PER_SECOND = 50;
/** What needs attention first. */
const SEVERITY: SimStatus[] = ["rejected", "silent", "unreachable", "offline", "connecting", "noSignal", "online", "stopped"];

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export function createSimulator(deps: SimulatorDeps): Simulator {
  const { db, bus, config } = deps;
  const clock = deps.now ?? Date.now;
  const routing = deps.routing ?? createRouting({ config });
  const tickMs = deps.tickMs === undefined ? 100 : deps.tickMs;
  const running = new Map<string, Running>();
  /** What happened to each simulation; it outlives a stop so it can still be read. */
  const logs = new Map<string, SimLogEntry[]>();
  /** Which simulated device each platform device is, to recognize its positions when they arrive. */
  let index = new Map<number, { simulationId: string; identifier: string }>();
  let indexedAt = 0;
  let timer: NodeJS.Timeout | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  const later = (work: Promise<unknown>) => {
    pending = Promise.allSettled([pending, work.catch((err: Error) => console.error("[simulator]", err.message))]);
  };

  /** The names this platform's own gateway goes by: the address and the IP real devices are given, and its name inside the server. */
  const ownHosts = () => [config.gatewayHost, config.gatewayIp, new URL(config.traccar.apiUrl).hostname].filter((host): host is string => Boolean(host)).map((host) => host.toLowerCase());
  /** Whether a server is this platform: then what a device sends there is expected to arrive here. */
  const toPlatform = (host: string) => ownHosts().includes(host.toLowerCase());
  const protocolOf = (modelId: string): { protocol: Protocol; port: number } | null => {
    const model = findModel(modelId);
    const protocol = model ? PROTOCOLS[model.protocol] : undefined;
    return model && protocol ? { protocol, port: model.port } : null;
  };
  const targetOf = (row: Pick<SimulationRow, "host" | "port" | "modelId">): { host: string; port: number } => ({
    // One saved before its server was written by hand goes where real devices are sent.
    host: row.host ?? config.gatewayHost,
    port: row.port ?? protocolOf(row.modelId)?.port ?? 0,
  });
  const devicesRunning = () => [...running.values()].reduce((sum, r) => sum + r.devices.size, 0);

  function log(simulationId: string, identifier: string | null, code: SimLogCode, params: Record<string, string | number> = {}): void {
    const entries = logs.get(simulationId) ?? [];
    entries.push({ at: new Date(clock()).toISOString(), identifier, code, params });
    if (entries.length > SIM_LIMITS.logEntries) entries.splice(0, entries.length - SIM_LIMITS.logEntries);
    logs.set(simulationId, entries);
  }

  function onDeviceEvent(live: Running, identifier: string, event: DeviceEvent): void {
    if (event.type === "report") {
      const sends = live.sends.get(identifier) ?? [];
      sends.push(event.at);
      if (sends.length > 30) sends.shift();
      live.sends.set(identifier, sends);
      return;
    }
    if (event.type === "alarm") return log(live.row.id, identifier, "alarm", { alarm: event.alarm });
    if (event.type === "signalLost") return log(live.row.id, identifier, "signalLost");
    if (event.type === "signalBack") return log(live.row.id, identifier, "signalBack", { count: event.stored });
    if (event.type === "lock") return log(live.row.id, identifier, event.on ? "engineCut" : "engineResume");
    if (event.type === "command") {
      log(live.row.id, identifier, "command", { text: event.text });
      if (event.effect === "engineCut") log(live.row.id, identifier, "engineCut");
      if (event.effect === "engineResume") log(live.row.id, identifier, "engineResume");
      if (event.effect === "interval") log(live.row.id, identifier, "interval", { seconds: event.intervalS ?? 0 });
      return;
    }
    // A device that keeps failing the same way says so once.
    if (live.lastLogged.get(identifier) === event.type) return;
    live.lastLogged.set(identifier, event.type);
    log(live.row.id, identifier, event.type, event.type === "unreachable" ? { host: live.host, port: live.port, reason: event.reason } : {});
  }

  async function reindex(): Promise<void> {
    indexedAt = clock();
    const owners = new Map<string, string>();
    for (const live of running.values()) for (const identifier of live.devices.keys()) owners.set(identifier, live.row.id);
    const registered = await registeredDevices(db.core, [...owners.keys()]);
    index = new Map([...registered].map(([identifier, deviceId]) => [deviceId, { simulationId: owners.get(identifier) as string, identifier }]));
  }

  const memoryOf = (live: Running): Record<string, DeviceMemory> => Object.fromEntries([...live.devices].map(([identifier, device]) => [identifier, device.memory()]));

  function ensureTimer(): void {
    if (tickMs === null) return;
    if (running.size > 0 && !timer) {
      timer = setInterval(() => tick(), tickMs);
      timer.unref();
    } else if (running.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function tick(now: number = clock()): void {
    for (const live of running.values()) {
      live.tripS += Math.max(0, now - live.tickedAt) / 1000;
      live.tickedAt = now;
      for (const device of live.devices.values()) device.tick(now, live.tripS);
      if (now - live.savedAt >= SAVE_EVERY_MS) {
        live.savedAt = now;
        later(saveProgress(db.core, live.row.id, live.tripS, memoryOf(live)));
      }
    }
    if (running.size > 0 && now - indexedAt >= INDEX_EVERY_MS) later(reindex());
  }

  /** Starts the devices of a simulation. */
  async function launch(row: SimulationRow, code: "started" | "resumed"): Promise<void> {
    const brand = protocolOf(row.modelId);
    if (!brand) throw badRequest(say("simulator.errors.brandNotYet"));
    const max = config.simulator.maxDevices;
    if (devicesRunning() + row.identifiers.length > max) throw badRequest(say("simulator.errors.tooManyDevices", { max }));
    const route = await getRoute(db.core, row.routeId);
    if (!route) throw badRequest(say("simulator.errors.routeNotFound"));
    const plan = compile(row.scenario, route);
    const now = clock();
    const { host, port } = targetOf(row);
    const live: Running = {
      row,
      plan,
      host,
      port,
      devices: new Map(),
      tripS: row.tripS,
      tickedAt: now,
      startedAt: now,
      savedAt: now,
      received: new Map(),
      sends: new Map(),
      latencies: [],
      lastLogged: new Map(),
    };
    const count = row.identifiers.length;
    row.identifiers.forEach((identifier, i) => {
      // Several devices share the route: evenly spread around it, or one after another.
      const offsetS = count === 1 ? 0 : row.spread === "convoy" || !plan.repeats ? -row.gapS * i : (plan.lapS * i) / count;
      live.devices.set(
        identifier,
        createDevice({
          id: identifier,
          protocol: brand.protocol,
          host,
          port,
          intervalS: row.intervalS,
          offsetS,
          stateAt: (tripS) => stateAt(plan, tripS),
          alarmsBetween: (fromS, toS) => alarmsBetween(plan, fromS, toS),
          reportIgnition: row.scenario.reportIgnition,
          extraIo: row.scenario.extraIo.length > 0 ? new Map(row.scenario.extraIo.map((io) => [io.id, BigInt(io.value)])) : undefined,
          faults: plan.faults.length > 1,
          memory: row.state[identifier],
          startAt: now + Math.floor(i / CONNECTS_PER_SECOND) * 1000,
          connect: deps.connect,
          now: clock,
          onEvent: (event) => onDeviceEvent(live, identifier, event),
        }),
      );
    });
    running.set(row.id, live);
    log(row.id, null, code, { host, port });
    ensureTimer();
    await reindex();
  }

  /** Disconnects its devices and keeps where they were. */
  async function halt(id: string): Promise<void> {
    const live = running.get(id);
    if (!live) return;
    running.delete(id);
    for (const device of live.devices.values()) device.stop();
    ensureTimer();
    await saveProgress(db.core, id, live.tripS, memoryOf(live));
    await reindex();
  }

  async function check(data: SimulationData, exceptId: string | null): Promise<void> {
    const brand = protocolOf(data.modelId);
    if (!brand) throw badRequest(say("simulator.errors.brandNotYet"));
    for (const identifier of data.identifiers) {
      const problem = simIdProblem(brand.protocol.idFormat, identifier);
      if (problem) throw badRequest(shared(problem));
    }
    // What the route asks of the device has to be something its brand carries: otherwise it would never reach the platform.
    const { scenario } = data;
    const needed = [
      ...scenario.actions.map((action) => simActionNeeds(action)),
      scenario.fuel ? "fuel" : null,
      scenario.driverKey ? "driverKey" : null,
      scenario.extraIo.length > 0 ? "extraIo" : null,
      scenario.reportIgnition ? null : "voltage",
    ] as const;
    const missing = needed.find((capability) => capability !== null && !brand.protocol.capabilities.has(capability));
    if (missing) throw badRequest(say(`simulator.notCarried.${missing}`), "not_carried");
    if (!(await getRoute(db.core, data.routeId))) throw badRequest(say("simulator.errors.routeNotFound"));
    const taken = await identifiersInUse(db.core, data.identifiers, exceptId);
    if (taken[0]) throw conflict("identifier_in_use", say("simulator.errors.identifierInUse", { identifier: taken[0] }));
  }

  function statusOf(live: Running, identifier: string, device: SimDevice, now: number): SimStatus {
    const snapshot = device.snapshot();
    if (snapshot.status !== "online") return snapshot.status;
    // Sending to another server, the platform is not expected to receive anything.
    if (!toPlatform(live.host)) return "online";
    // Reports that went out after the last thing the platform stored: several of them, over a while, with nothing arriving.
    const heardAt = live.received.get(identifier)?.at ?? 0;
    const unanswered = (live.sends.get(identifier) ?? []).filter((at) => at > heardAt);
    const first = unanswered[0];
    return unanswered.length >= 3 && first !== undefined && now - first >= SILENT_AFTER_MS ? "silent" : "online";
  }

  function deviceViews(row: SimulationRow, registered: Map<string, number>): SimDeviceView[] {
    const live = running.get(row.id);
    const now = clock();
    return row.identifiers.map((identifier): SimDeviceView => {
      const device = live?.devices.get(identifier);
      const snapshot = device?.snapshot();
      const got = live?.received.get(identifier);
      return {
        identifier,
        status: live && device ? statusOf(live, identifier, device, now) : "stopped",
        registered: registered.has(identifier),
        lat: snapshot?.state?.lat ?? null,
        lon: snapshot?.state?.lon ?? null,
        course: snapshot?.state?.course ?? null,
        speedKmh: snapshot?.state ? Math.round(snapshot.state.speedKmh) : null,
        ignition: snapshot?.state?.ignition ?? null,
        engineCut: snapshot?.engineCut ?? row.state[identifier]?.cut ?? false,
        fuelPct: snapshot?.state?.fuelPct == null ? null : Math.round(snapshot.state.fuelPct),
        stored: snapshot?.stored ?? 0,
        sent: snapshot?.sent ?? 0,
        lastSentAt: iso(snapshot?.lastSentAt),
        lastReceivedAt: iso(got?.at),
        latencyMs: got?.latencyMs ?? null,
      };
    });
  }

  function summaryOf(row: SimulationRow, devices: SimDeviceView[]): SimulationSummary {
    const live = running.get(row.id);
    const latest = (pick: (d: SimDeviceView) => string | null) => devices.map(pick).filter((v): v is string => v !== null).sort().at(-1) ?? null;
    const { tripS: _tripS, state: _state, desired: _desired, host: _host, port: _port, ...config } = row;
    const target = targetOf(row);
    return {
      ...config,
      ...target,
      toPlatform: toPlatform(target.host),
      running: Boolean(live),
      status: SEVERITY.find((status) => devices.some((d) => d.status === status)) ?? "stopped",
      online: devices.filter((d) => d.status === "online").length,
      problems: devices.filter((d) => d.status === "rejected" || d.status === "silent" || d.status === "unreachable").length,
      unregistered: devices.filter((d) => !d.registered).length,
      lastSentAt: latest((d) => d.lastSentAt),
      lastReceivedAt: latest((d) => d.lastReceivedAt),
    };
  }

  function latencyOf(live: Running | undefined): SimulationDetail["latency"] {
    if (!live) return null;
    const since = clock() - LATENCY_WINDOW_MS;
    const sorted = live.latencies.filter((l) => l.at >= since).map((l) => l.ms).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] as number;
    return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] as number, samples: sorted.length };
  }

  async function detail(id: string): Promise<SimulationDetail> {
    const row = running.get(id)?.row ?? (await getSimulation(db.core, id));
    if (!row) throw notFound(say("simulator.errors.notFound"));
    const [route, registered] = await Promise.all([getRoute(db.core, row.routeId), registeredDevices(db.core, row.identifiers)]);
    const devices = deviceViews(row, registered);
    // With many devices, the ones that need attention go first.
    const shown = [...devices].sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status)).slice(0, SIM_LIMITS.devicesShown);
    return {
      ...summaryOf(row, devices),
      route: {
        line: route?.line ?? [],
        lengthM: route?.lengthM ?? 0,
        closed: route?.closed ?? false,
        // Where each thing of its route happens, to see it on the map.
        marks: route ? row.scenario.actions.map((action) => ({ kind: action.kind, ...placeOn(route.line, action.atM) })) : [],
      },
      devices: shown,
      log: [...(logs.get(id) ?? [])].reverse(),
      latency: latencyOf(running.get(id)),
    };
  }

  // What the platform stores of a simulated device shows it arrived, and how long it took.
  bus.on("position", ({ deviceId, state }) => {
    const owner = index.get(deviceId);
    const live = owner ? running.get(owner.simulationId) : undefined;
    if (!owner || !live) return;
    const now = clock();
    const fixMs = state.fixTime ? Date.parse(state.fixTime) : Number.NaN;
    // Some protocols write the time to the second: the report it came from is the one sent in that second.
    const sentAt = live.sends.get(owner.identifier)?.findLast((at) => Math.abs(at - fixMs) < 1000);
    const latencyMs = sentAt === undefined ? null : Math.max(0, now - sentAt);
    live.received.set(owner.identifier, { at: now, latencyMs });
    if (latencyMs !== null) {
      live.latencies.push({ at: now, ms: latencyMs });
      if (live.latencies.length > 2000) live.latencies.splice(0, live.latencies.length - 2000);
    }
  });
  // A GPS added while its simulation runs is recognized right away.
  bus.on("devices_changed", () => {
    if (running.size > 0) later(reindex());
  });

  async function list(): Promise<SimulationSummary[]> {
    const rows = await listSimulations(db.core);
    const registered = await registeredDevices(db.core, rows.flatMap((row) => row.identifiers));
    return rows.map((row) => summaryOf(row, deviceViews(row, registered)));
  }

  const auditAs = (actor: SimulatorActor, action: string, id: string, name: string, kind: "simulation" | "sim_route" = "simulation") =>
    audit(db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, action, kind, id, { name });

  async function routeOf(id: string): Promise<SimRoute> {
    const route = await getRoute(db.core, id);
    if (!route) throw notFound(say("simulator.errors.routeGone"));
    return route;
  }

  return {
    meta(language) {
      const brands = deviceCatalog(language).flatMap((model) => {
        const protocol = PROTOCOLS[model.protocol];
        if (!protocol) return [];
        return [{ modelId: model.id, brand: model.brand, name: model.name, protocol: model.protocol, port: model.port, idLabel: model.idLabel, idFormat: protocol.idFormat, capabilities: [...protocol.capabilities] }];
      });
      return { brands, host: config.gatewayHost, maxDevices: config.simulator.maxDevices, running: devicesRunning(), routing: routing.enabled };
    },
    routes: () => listRoutes(db.core),
    route: routeOf,
    async createRoute(data, actor) {
      const id = await insertRoute(db.core, data, actor.userId);
      await auditAs(actor, "admin.simulator.route.create", id, data.name, "sim_route");
      return routeOf(id);
    },
    async updateRoute(id, data, actor) {
      await routeOf(id);
      // The ones traveling it stop, and start over on the new path.
      const traveling = [...running.values()].filter((live) => live.row.routeId === id).map((live) => live.row.id);
      for (const simulationId of traveling) await halt(simulationId);
      await updateRoute(db.core, id, data);
      await auditAs(actor, "admin.simulator.route.update", id, data.name, "sim_route");
      for (const simulationId of traveling) {
        const row = await getSimulation(db.core, simulationId);
        if (!row) continue;
        try {
          await launch(row, "started");
        } catch (err) {
          console.warn(`[simulator] "${row.name}" did not start on its changed route: ${(err as Error).message}`);
          await setDesired(db.core, simulationId, "stopped");
        }
      }
      return routeOf(id);
    },
    async removeRoute(id, actor) {
      const route = await routeOf(id);
      if (route.inUse > 0) throw conflict("route_in_use", say("simulator.errors.routeInUse", { count: route.inUse }));
      await deleteRoute(db.core, id);
      await auditAs(actor, "admin.simulator.route.delete", id, route.name, "sim_route");
    },
    trace: (points) => routing.trace(points),
    list,
    get: detail,
    async create(data, actor) {
      await check(data, null);
      const id = await insertSimulation(db.core, data, actor.userId);
      await auditAs(actor, "admin.simulator.create", id, data.name);
      return detail(id);
    },
    async update(id, data, actor) {
      const before = await getSimulation(db.core, id);
      if (!before) throw notFound(say("simulator.errors.notFound"));
      await check(data, id);
      const wasRunning = running.has(id);
      await halt(id);
      await updateSimulation(db.core, id, data);
      await auditAs(actor, "admin.simulator.update", id, data.name);
      if (wasRunning) {
        const row = await getSimulation(db.core, id);
        if (row) {
          try {
            await launch(row, "started");
          } catch (err) {
            // What changed no longer lets it run: it stays stopped and says why.
            await setDesired(db.core, id, "stopped");
            throw err;
          }
        }
      }
      return detail(id);
    },
    async remove(id, actor) {
      const row = await getSimulation(db.core, id);
      if (!row) throw notFound(say("simulator.errors.notFound"));
      await halt(id);
      await deleteSimulation(db.core, id);
      logs.delete(id);
      await auditAs(actor, "admin.simulator.delete", id, row.name);
    },
    async run(id, on, actor) {
      const row = await getSimulation(db.core, id);
      if (!row) throw notFound(say("simulator.errors.notFound"));
      if (on && !running.has(id)) {
        await launch(row, "started");
        await setDesired(db.core, id, "running");
        await auditAs(actor, "admin.simulator.start", id, row.name);
      } else if (!on && running.has(id)) {
        await halt(id);
        await setDesired(db.core, id, "stopped");
        log(id, null, "stopped");
        await auditAs(actor, "admin.simulator.stop", id, row.name);
      }
      return detail(id);
    },
    async inject(id, action) {
      const live = running.get(id);
      if (!live) throw conflict("not_running", say("simulator.errors.notRunning"));
      const brand = protocolOf(live.row.modelId);
      const needs = simInjectNeeds(action);
      if (brand && needs && !brand.protocol.capabilities.has(needs)) throw badRequest(say(`simulator.notCarried.${needs}`), "not_carried");
      // The tank only moves if the device is reporting one.
      if (action.kind === "fuel" && !live.row.scenario.fuel) throw badRequest(say("simulator.errors.noTank"), "no_tank");
      for (const device of live.devices.values()) device.inject(action);
      if (action.kind === "theft") log(id, null, "theft", { seconds: action.seconds });
      if (action.kind === "fuel") log(id, null, "fuelChange", { pct: action.pct, seconds: action.seconds });
      if (action.kind === "disconnect") log(id, null, "disconnect", { seconds: action.seconds });
      tick();
      return detail(id);
    },
    async backfill(id, hoursAgo) {
      const live = running.get(id);
      if (!live) throw conflict("not_running", say("simulator.errors.notRunning"));
      const brand = protocolOf(live.row.modelId);
      if (!brand) throw badRequest(say("simulator.errors.brandNotYet"));
      const { plan, row } = live;
      const intervalS = row.intervalS;
      const count = Math.floor(plan.lapS / intervalS) + 1;
      if (count * live.devices.size > SIM_LIMITS.backfillReports) throw badRequest(say("simulator.errors.backfillTooLong", { max: SIM_LIMITS.backfillReports }), "backfill_too_long");
      const online = [...live.devices.values()].filter((device) => device.snapshot().status === "online");
      if (online.length === 0) throw conflict("not_connected", say("simulator.errors.notConnected"));
      // One lap from its start, a report every interval, ending when asked: each one with the time it would have had.
      const endAt = clock() - hoursAgo * 3_600_000;
      const options = {
        reportIgnition: row.scenario.reportIgnition,
        extraIo: row.scenario.extraIo.length > 0 ? new Map(row.scenario.extraIo.map((io) => [io.id, BigInt(io.value)])) : undefined,
        faults: plan.faults.length > 1,
      };
      const reports: Report[] = [];
      for (let i = 0; i < count; i++) {
        const tripS = i * intervalS;
        const at = new Date(endAt - (plan.lapS - tripS) * 1000);
        const state = stateAt(plan, tripS);
        const alarms = i === 0 ? [] : alarmsBetween(plan, tripS - intervalS, tripS).filter((alarm) => brand.protocol.capabilities.has(alarm));
        // An alarm goes in a report of its own, a second before the one of its place.
        alarms.forEach((alarm, n) => reports.push({ ...reportOf(state, new Date(at.getTime() - (alarms.length - n) * 1000), options), alarm }));
        reports.push(reportOf(state, at, options));
      }
      for (const device of online) device.upload(reports);
      log(id, null, "backfill", { count: reports.length, hours: hoursAgo });
      return { simulation: await detail(id), reports: reports.length * online.length };
    },
    async runAll(on, actor) {
      for (const row of await listSimulations(db.core)) {
        if (on === running.has(row.id)) continue;
        if (on) {
          // What does not fit under the limit stays stopped; the rest starts.
          try {
            await launch(row, "started");
          } catch {
            continue;
          }
          await setDesired(db.core, row.id, "running");
        } else {
          await halt(row.id);
          await setDesired(db.core, row.id, "stopped");
          log(row.id, null, "stopped");
        }
        await auditAs(actor, on ? "admin.simulator.start" : "admin.simulator.stop", row.id, row.name);
      }
      return list();
    },
    async start() {
      for (const row of await listSimulations(db.core)) {
        if (row.desired !== "running" || running.has(row.id)) continue;
        try {
          // One that was sending to another server waits to be started by hand: a restored backup must not start sending there by itself.
          if (!toPlatform(targetOf(row).host)) throw new Error("it sends to another server");
          await launch(row, "resumed");
        } catch (err) {
          console.warn(`[simulator] "${row.name}" was not resumed: ${(err as Error).message}`);
          await setDesired(db.core, row.id, "stopped");
        }
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const [id, live] of running) {
        for (const device of live.devices.values()) device.stop();
        later(saveProgress(db.core, id, live.tripS, memoryOf(live)));
      }
      running.clear();
    },
    idle: async () => {
      await pending;
    },
    tick,
  };
}
