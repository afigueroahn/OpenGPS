// The platform's engines: everything that listens to the bus or runs on a
// clock, besides the API. They are put together here once, so that main.ts
// and the tests' harness run the same ones: a new engine is added here.
import type { Bus } from "./bus";
import type { Config } from "./config";
import { createBackups } from "./core/backups";
import { createDayKeeper } from "./core/days";
import { createEventEngine } from "./core/events";
import { createMeterKeeper } from "./core/meters";
import { createNotifier } from "./core/notifications";
import { createOutbox } from "./core/outbox";
import type { Restore } from "./core/restore";
import { createSettings } from "./core/settings";
import { createSystemNotifier } from "./core/system";
import { createUpdates } from "./core/updates";
import type { Db } from "./db";
import type { Mailer } from "./mail";
import { createAntitheftEngine } from "./modules/antitheft";
import { createDiagnosticsEngine } from "./modules/diagnostics";
import { createDriversEngine } from "./modules/drivers";
import { createFleetEngine } from "./modules/fleet";
import { createFuelEngine } from "./modules/fuel";
import { createModuleGate } from "./modules/gate";
import { createIntegrationsEngine } from "./modules/integrations";
import { createMaintenanceEngine } from "./modules/maintenance";
import { createReportsEngine } from "./modules/reports";
import { createRoutesEngine } from "./modules/routes";
import { type SimulatorDeps, createSimulator } from "./simulator/manager";
import type { Traccar } from "./traccar";

export interface EnginesDeps {
  config: Config;
  db: Db;
  bus: Bus;
  traccar: Traccar;
  mailer: Mailer;
  /** false leaves every engine without its clock: a test gives each one its turns by hand. */
  clocks?: boolean;
  /** A restore the console asked for, and how the process ends so it is swapped in on starting. Only the platform has them. */
  restore?: Restore;
  restart?: () => void;
  /** What a test puts in place of the services outside: who traces the simulator's routes, and GitHub with its clock. */
  routing?: SimulatorDeps["routing"];
  updates?: Pick<Parameters<typeof createUpdates>[0], "fetch" | "now">;
}

/** Listens to the bus: it starts, stops, and says when it has finished what it received. */
interface Listener {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
}

/** How far what one engine receives can reach: a position raises an event, the event an incident, the incident a notification. */
const HOPS = 3;

export async function createEngines(deps: EnginesDeps) {
  const { config, db, bus, traccar, mailer } = deps;
  const noClock = deps.clocks === false;
  // What the platform's admin console has defined is applied before anything uses it.
  const settings = createSettings({ db, bus, config });
  await settings.load();
  const outbox = createOutbox({ db, config, mailer });
  const system = createSystemNotifier({ db, config, outbox });
  const gate = createModuleGate(db.core, bus);
  const moduleDeps = { db, bus, config, traccar, mailer, gate, outbox };
  const sweep = noClock ? { sweepEveryMs: null } : {};

  const events = createEventEngine({ db, bus, config, ...sweep });
  const days = createDayKeeper({ db, bus });
  const meters = createMeterKeeper({ db, bus });
  const notifier = createNotifier({ db, bus, config, outbox });
  const antitheft = createAntitheftEngine({ ...moduleDeps, ...sweep });
  const drivers = createDriversEngine(moduleDeps);
  const fuel = createFuelEngine({ ...moduleDeps, ...sweep });
  const diagnostics = createDiagnosticsEngine(moduleDeps);
  const fleet = createFleetEngine(moduleDeps);
  const maintenance = createMaintenanceEngine({ ...moduleDeps, ...sweep });
  const routes = createRoutesEngine(moduleDeps);
  const integrations = createIntegrationsEngine({ ...moduleDeps, ...(noClock ? { tickMs: null } : {}) });
  const reports = createReportsEngine({ ...moduleDeps, ...(noClock ? { tickEveryMs: null } : {}) });
  /** The ones that listen to the bus, in the order they start. */
  const listeners: Listener[] = [events, days, meters, notifier, antitheft, drivers, fuel, diagnostics, fleet, maintenance, routes, integrations, reports];

  const backups = createBackups({
    db,
    bus,
    config,
    settings,
    system,
    ...(noClock ? { tickEveryMs: null } : {}),
    ...(deps.restore ? { restore: deps.restore } : {}),
    ...(deps.restart ? { restart: deps.restart } : {}),
  });
  const simulator = createSimulator({ db, bus, config, routing: deps.routing, ...(noClock ? { tickMs: null } : {}) });
  const updates = createUpdates({ config, ...deps.updates });

  return {
    settings,
    outbox,
    system,
    gate,
    events,
    days,
    meters,
    notifier,
    antitheft,
    drivers,
    fuel,
    diagnostics,
    fleet,
    maintenance,
    routes,
    integrations,
    reports,
    backups,
    simulator,
    updates,
    /** Starts the ones that listen to the bus. The backups, the updates and the simulator have a start of their own, which only the platform calls. */
    start() {
      for (const engine of listeners) engine.start();
    },
    /** Stops the ones that listen to the bus, each one once it has finished what it had. */
    async stop() {
      for (const engine of listeners) {
        engine.stop();
        await engine.idle();
      }
    },
    /** Waits until they have finished what they received, and what that set off in the others. */
    async idle() {
      for (let hop = 0; hop < HOPS; hop++) for (const engine of listeners) await engine.idle();
    },
  };
}
