// OpenGPS backend startup: goes on with a restore under way, migrates the
// database, prepares Traccar, brings up the API and starts ingest and the
// periodic tasks.
import { buildApp } from "./api/server";
import { createAuth } from "./auth";
import { Bus } from "./bus";
import { loadConfig } from "./config";
import { syncCatalog } from "./core/catalog";
import { deleteOwnedAccounts } from "./core/privacy";
import { createRestore } from "./core/restore";
import { createTasks, syncRetention } from "./core/tasks";
import { createDb } from "./db";
import { createEngines } from "./engines";
import { createIngest } from "./ingest/poller";
import { say } from "./i18n";
import { createMailer } from "./mail";
import { findMigrationsDir, migrate } from "./migrate";
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
  const ingest = createIngest({ db, bus });
  // A restore ready to swap in ends the process, as a stop would: Docker brings it back and it swaps on starting.
  const engines = await createEngines({ config, db, bus, traccar, mailer, restore, restart: () => process.kill(process.pid, "SIGTERM") });
  const { settings, outbox, system, gate, backups, simulator, updates } = engines;

  // When deleting their account, the person takes with them everything that was theirs.
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
  const tasks = createTasks({ db, bus, traccar, config, system, outbox, ingest });
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
    engines.start();
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
    await engines.stop();
    await outbox.idle();
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
