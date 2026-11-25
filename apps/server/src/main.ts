// OpenGPS backend startup: goes on with a restore under way, migrates the
// database, prepares Traccar, brings up the API and starts ingest and the
// periodic tasks.
import { buildApp } from "./api/server";
import { createAuth } from "./auth";
import { Bus } from "./bus";
import { loadConfig } from "./config";
import { syncCatalog } from "./core/catalog";
import { createDayKeeper } from "./core/days";
import { createMeterKeeper } from "./core/meters";
import { createBackups } from "./core/backups";
import { createEventEngine } from "./core/events";
import { createNotifier } from "./core/notifications";
import { createOutbox } from "./core/outbox";
import { createSystemNotifier } from "./core/system";
import { deleteOwnedAccounts } from "./core/privacy";
import { createRestore } from "./core/restore";
import { createSettings } from "./core/settings";
import { createTasks, syncRetention } from "./core/tasks";
import { createUpdates } from "./core/updates";
import { createDb } from "./db";
import { createIngest } from "./ingest/poller";
import { say } from "./i18n";
import { createMailer } from "./mail";
import { createAntitheftEngine } from "./modules/antitheft";
import { createFuelEngine } from "./modules/fuel";
import { createDriversEngine } from "./modules/drivers";
import { createDiagnosticsEngine } from "./modules/diagnostics";
import { createFleetEngine } from "./modules/fleet";
import { createIntegrationsEngine } from "./modules/integrations";
import { createMaintenanceEngine } from "./modules/maintenance";
import { createRoutesEngine } from "./modules/routes";
import { createModuleGate } from "./modules/gate";
import { createReportsEngine } from "./modules/reports";
import { findMigrationsDir, migrate } from "./migrate";
import { createSimulator } from "./simulator/manager";
import { createTraccar } from "./traccar";

async function retry<T>(what: string, fn: () => Promise<T>, attempts = 30, delayMs = 2000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`[startup] ${what} is not ready yet (${(err as Error).message}); retry ${i}/${attempts}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** A restore the platform starts on, until it is confirmed: if the start fails, it is undone (ADR-0009). */
let unconfirmed: (() => Promise<void>) | null = null;

async function main(): Promise<void> {
  const config = loadConfig();
  const traccar = createTraccar(config);
  // Before anything opens the database: a restore under way swaps it now, or undoes what was left halfway.
  const restore = createRestore({ config, traccar });
  const restoring = await restore.atStartup();
  const db = createDb(config);
  if (restoring) unconfirmed = () => db.close().then(() => restore.undo());
  const bus = new Bus();
  const mailer = createMailer(config);

  await retry("Postgres", () => db.core.query("SELECT 1"));
  const applied = await migrate(db.core, findMigrationsDir(config.migrationsDir));
  console.log(applied.length ? `[db] migrations applied: ${applied.join(", ")}` : "[db] up to date");
  await syncCatalog(db.core);
  // What the platform's admin console has defined is applied before anything uses it.
  const settings = createSettings({ db, bus, config });
  await settings.load();

  // When deleting their account, the person takes with them everything that was theirs.
  const outbox = createOutbox({ db, config, mailer });
  const system = createSystemNotifier({ db, config, outbox });
  const auth = createAuth(
    config,
    db,
    mailer,
    async (userId) => {
      await deleteOwnedAccounts({ db, bus, traccar }, userId);
    },
    {
      accountCreated: (account) =>
        void system.notify("account_created", { title: say("mail.system.accountCreated.title"), body: say("mail.system.accountCreated.body", { name: account.name }), path: "/admin/system/accounts" }),
    },
  );
  const ingest = createIngest({ db, bus });
  const tasks = createTasks({ db, bus, traccar, config, system, outbox, ingest });
  const events = createEventEngine({ db, bus, config });
  const days = createDayKeeper({ db, bus });
  const meters = createMeterKeeper({ db, bus });
  const notifier = createNotifier({ db, bus, config, outbox });
  const gate = createModuleGate(db.core, bus);
  const moduleDeps = { db, bus, config, traccar, mailer, gate, outbox };
  const moduleEngines = [createAntitheftEngine(moduleDeps), createDriversEngine(moduleDeps), createFuelEngine(moduleDeps), createDiagnosticsEngine(moduleDeps), createFleetEngine(moduleDeps), createMaintenanceEngine(moduleDeps), createRoutesEngine(moduleDeps), createIntegrationsEngine(moduleDeps), createReportsEngine(moduleDeps)];
  // A restore ready to swap in ends the process, as a stop would: Docker brings it back and it swaps on starting.
  const backups = createBackups({ db, bus, config, settings, system, restore, restart: () => process.kill(process.pid, "SIGTERM") });
  const simulator = createSimulator({ db, bus, config });
  const updates = createUpdates({ config });
  const { fastify } = await buildApp({ config, db, auth, bus, traccar, mailer, ingest, gate, settings, backups, outbox, system, simulator, updates });

  // Before serving anyone: if the database was restored by hand, the backup list goes back to being the folder's.
  await backups.reconcile().catch((err: Error) => console.error("[backups] could not check the list of backups at startup:", err.message));
  await fastify.listen({ port: config.port, host: config.host });
  console.log(`[api] ${config.appName} listening on port ${config.port} · ${config.publicUrl}`);
  if (restoring) {
    await restore.confirm();
    unconfirmed = null;
  }

  if (!config.disableBackground) {
    await retry("Traccar", () => traccar.bootstrap());
    await syncRetention({ db, bus, traccar, config });
    events.start();
    days.start();
    meters.start();
    notifier.start();
    for (const engine of moduleEngines) engine.start();
    ingest.start();
    tasks.start();
    backups.start();
    updates.start();
    console.log("[ingest] reading positions from Traccar");
    // The simulated devices that were running pick up where they were.
    await simulator.start().catch((err: Error) => console.error("[simulator] could not resume:", err.message));
  }
  mailer.verify().then(
    () => console.log("[mail] SMTP server verified"),
    (err: Error) => console.error("[mail] the SMTP server does not respond:", err.message),
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[api] ${signal}: shutting down`);
    tasks.stop();
    simulator.stop();
    await simulator.idle();
    backups.stop();
    updates.stop();
    await backups.idle();
    await ingest.stop();
    events.stop();
    await events.idle();
    days.stop();
    await days.idle();
    meters.stop();
    await meters.idle();
    notifier.stop();
    await notifier.idle();
    await outbox.idle();
    for (const engine of moduleEngines) {
      engine.stop();
      await engine.idle();
    }
    await fastify.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (err) => {
  console.error("[startup] could not start:", err);
  await unconfirmed?.().catch((undoErr: Error) => console.error("[restore] could not undo the restore:", undoErr.message));
  process.exit(1);
});
