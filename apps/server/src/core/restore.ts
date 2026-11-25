// Restoring a backup (ADR-0009). The platform does it by itself, when a
// request appears in the backups folder (restore.request): the console leaves
// it, and so does the helper when neither a new version nor the previous one
// starts (ADR-0004).
//
// 1. While it keeps serving, it restores both databases and the files aside
//    (<name>_new and files/.restore-new) and checks them. If the backup cannot
//    be read whole, it stops there and nothing changes.
// 2. It ends its own process, and Docker brings it back (restart: unless-stopped).
// 3. On starting, before anything opens the database, it swaps them: the ones
//    in use are set aside as <name>_previous and the restored ones take their
//    names. Traccar is restarted through its API, so it forgets what it kept
//    from the previous database.
// 4. It starts on what was restored. Once it is up and Traccar answers, what
//    was set aside is deleted. If not, everything goes back, and it starts
//    again with what there was.
//
// restore.running says which step it reached ("phase"): a start that finds a
// restore left halfway undoes it. How it ended is left in restore.result, with
// a reason code the console turns into words.
import { lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { Config } from "../config";
import type { Traccar } from "../traccar";
import { RESTORE_REQUEST, RESTORE_RESULT, RESTORE_RUNNING, pgEnv, readNote, run } from "./backups";

/** Why a restore did not end well: the codes restore.result carries. */
type Reason = "invalid" | "unreadable" | "incomplete" | "files" | "gateway" | "swap" | "start" | "cut" | "broken";
type Note = Record<string, string>;

class Failed extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID = /^[0-9a-f-]{36}$/;
const PARTS = { gps: /^gps_\d{8}_\d{6}\.dump$/, traccar: /^traccar_\d{8}_\d{6}\.dump$/, files: /^files_\d{8}_\d{6}\.tar\.gz$/ } as const;
/** How long Traccar has to answer once restarted. */
const GATEWAY_WAIT_MS = 300_000;
/** Left in the folder of what there was once all of it is there: from then on, what is in the files folder came from the backup. */
const MOVED = ".moved";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (name: string) => `"${name}"`;
/** For what is done on the way back: it goes on, and what failed stays in the log. */
const logged = (what: string) => (err: Error) => console.error(`[restore] could not ${what}:`, err.message);

export interface Restore {
  /** While serving: restores aside a request that is waiting. True when it is ready to swap in, and the process must restart. */
  pickUp(): Promise<boolean>;
  /** At startup, before anything opens the database: goes on with a restore under way. True if the platform starts on a restored database still to be confirmed. */
  atStartup(): Promise<boolean>;
  /** The platform is up on what was restored: once Traccar answers too, what was set aside is deleted. */
  confirm(): Promise<void>;
  /** The platform did not start on what was restored: what there was comes back. Its own connections must be closed. */
  undo(): Promise<void>;
}

export function createRestore(deps: { config: Config; traccar: Traccar }): Restore {
  const { config, traccar } = deps;
  const dir = config.backup.dir;
  const files = config.filesDir;
  const filesNew = join(files, ".restore-new");
  const filesOld = join(files, ".restore-previous");
  const nameOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));
  const main = nameOf(config.backup.databaseUrl);
  const gateway = nameOf(config.backup.traccarDatabaseUrl);
  const urlOf = (db: string) => {
    const url = new URL(config.backup.databaseUrl);
    url.pathname = `/${db}`;
    return url.toString();
  };
  let busy = false;

  // ─── Databases ─────────────────────────────────────────────────────────────

  async function on<T>(db: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: urlOf(db), connectionTimeoutMillis: 15_000, application_name: "gps-restore" });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  }
  const admin = (text: string, values?: unknown[]) => on("postgres", (c) => c.query(text, values));
  const exists = async (db: string) => (await admin(`SELECT 1 FROM pg_database WHERE datname = $1`, [db])).rowCount === 1;
  const drop = (db: string) => admin(`DROP DATABASE IF EXISTS ${quote(db)} WITH (FORCE)`);

  /** Loads a dump into a new database. TimescaleDB needs to be told before and after. */
  async function restoreInto(file: string, db: string): Promise<void> {
    await drop(db);
    await admin(`CREATE DATABASE ${quote(db)}`);
    await on(db, (c) => c.query(`CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore()`));
    await run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "--no-password", `--dbname=${db}`, file], pgEnv(urlOf(db)), config.defaultLanguage);
    await on(db, (c) => c.query(`SELECT timescaledb_post_restore()`));
  }

  /**
   * Renames a database. Nobody may be connected: connections are closed and
   * whoever is left is cut off. TimescaleDB stops its own jobs on a rename, but
   * one that starts at that very instant keeps the database busy for a few
   * seconds: that is why it retries, then cutting off the jobs too.
   */
  async function renameDb(from: string, to: string, open: boolean): Promise<void> {
    await admin(`ALTER DATABASE ${quote(from)} WITH ALLOW_CONNECTIONS false`);
    for (let attempt = 1; ; attempt++) {
      const who = attempt === 1 ? ` AND backend_type = 'client backend'` : "";
      await admin(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()${who}`, [from]);
      try {
        await admin(`ALTER DATABASE ${quote(from)} RENAME TO ${quote(to)}`);
        break;
      } catch (err) {
        if (attempt >= 6) throw err;
        console.log(`[restore] database ${from} is still busy: retry ${attempt}`);
        await sleep(2000);
      }
    }
    if (open) await admin(`ALTER DATABASE ${quote(to)} WITH ALLOW_CONNECTIONS true`);
  }

  // ─── Users' files ──────────────────────────────────────────────────────────

  const isDir = (path: string) => lstat(path).then((s) => s.isDirectory(), () => false);
  const inUse = async () => (await readdir(files).catch(() => [] as string[])).filter((n) => n !== ".restore-new" && n !== ".restore-previous");
  async function stageFiles(archive: string): Promise<void> {
    await rm(filesNew, { recursive: true, force: true });
    await mkdir(filesNew, { recursive: true });
    await run("tar", ["-xzf", archive, "-C", filesNew], { PATH: process.env.PATH }, config.defaultLanguage);
  }
  /** What is in the folder goes aside and the backup's takes its place. */
  async function swapFiles(): Promise<void> {
    if (!(await isDir(filesNew))) return;
    await rm(filesOld, { recursive: true, force: true });
    await mkdir(filesOld);
    for (const name of await inUse()) await rename(join(files, name), join(filesOld, name));
    await writeFile(join(filesOld, MOVED), "");
    for (const name of await readdir(filesNew)) await rename(join(filesNew, name), join(files, name));
    await rmdir(filesNew);
  }
  async function revertFiles(): Promise<void> {
    if (await isDir(filesOld)) {
      // Until all of what there was is aside, what is still in the folder is part of it.
      if (await lstat(join(filesOld, MOVED)).then(() => true, () => false)) {
        for (const name of await inUse()) await rm(join(files, name), { recursive: true, force: true });
      }
      for (const name of await readdir(filesOld)) if (name !== MOVED) await rename(join(filesOld, name), join(files, name));
      await rm(filesOld, { recursive: true, force: true });
    }
    await rm(filesNew, { recursive: true, force: true });
  }

  // ─── Traccar ───────────────────────────────────────────────────────────────

  /** Restarts Traccar with a session opened before its database changed. A few tries: its connections are just coming back. */
  async function restartGateway(session: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await traccar.reboot(session);
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(2000);
      }
    }
  }

  // ─── The request ───────────────────────────────────────────────────────────

  async function writeNote(name: string, note: Note): Promise<void> {
    const text = Object.entries(note).map(([key, value]) => `${key}=${value}\n`).join("");
    await writeFile(join(dir, `${name}.tmp`), text, { mode: 0o600 });
    await rename(join(dir, `${name}.tmp`), join(dir, name));
  }
  const phase = (note: Note, step: "ready" | "swapping" | "swapped") => writeNote(RESTORE_RUNNING, { ...note, phase: step });

  async function finish(note: Note, reason: Reason | null): Promise<void> {
    const ok = reason === null;
    await writeNote(RESTORE_RESULT, { id: note.id ?? "", backup: note.backup ?? "", requested: note.requested ?? "", started: note.started ?? "", finished: new Date().toISOString(), status: ok ? "ok" : "failed", reason: reason ?? "" });
    await rm(join(dir, RESTORE_RUNNING), { force: true });
    console.log(`[restore] ended: ${ok ? "ok" : `failed ${reason}`}`);
  }

  /** A backup file of the request: a regular file of the backups folder, with a backup's name. */
  async function partOf(note: Note, part: keyof typeof PARTS): Promise<string | null> {
    const name = note[part] ?? "";
    if (!PARTS[part].test(name)) return null;
    const info = await lstat(join(dir, name)).catch(() => null);
    return info?.isFile() && info.size > 0 ? join(dir, name) : null;
  }

  /** Takes the waiting request. The platform writes it, and so does the helper, but it is not trusted unseen. */
  async function take(): Promise<{ note: Note; gps: string; traccar: string; files: string | null } | null> {
    const info = await lstat(join(dir, RESTORE_REQUEST)).catch(() => null);
    if (!info?.isFile()) return null;
    await rename(join(dir, RESTORE_REQUEST), join(dir, RESTORE_RUNNING));
    const note: Note = { ...(await readNote(join(dir, RESTORE_RUNNING))), started: new Date().toISOString(), phase: "aside" };
    await writeNote(RESTORE_RUNNING, note);
    console.log(`[restore] request for backup ${note.id ?? "?"}`);
    const gps = await partOf(note, "gps");
    const gatewayDump = await partOf(note, "traccar");
    const archive = note.files ? await partOf(note, "files") : null;
    if (!UUID.test(note.id ?? "") || !gps || !gatewayDump || (note.files && !archive) || !NAME.test(main) || !NAME.test(gateway)) {
      await finish(note, "invalid");
      return null;
    }
    return { note, gps, traccar: gatewayDump, files: archive };
  }

  /** Deletes what was restored aside, without touching what is in use. */
  async function discard(): Promise<void> {
    for (const db of [`${main}_new`, `${gateway}_new`]) await drop(db).catch(logged(`delete ${db}`));
    await rm(filesNew, { recursive: true, force: true });
  }

  /** Restores the request aside, without touching what is in use. True if it is ready to swap in. */
  async function aside(request: NonNullable<Awaited<ReturnType<typeof take>>>): Promise<boolean> {
    try {
      console.log("[restore] restoring aside, without stopping anything");
      for (const db of [main, gateway]) await drop(`${db}_previous`);
      try {
        await restoreInto(request.gps, `${main}_new`);
        await restoreInto(request.traccar, `${gateway}_new`);
      } catch (err) {
        console.error("[restore] the backup could not be loaded:", (err as Error).message);
        throw new Failed("unreadable");
      }
      const history = await on(`${main}_new`, (c) => c.query(`SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'positions'`));
      if (history.rowCount !== 1) throw new Failed("incomplete");
      if (request.files) await stageFiles(request.files).catch(() => Promise.reject(new Failed("files")));
      await phase(request.note, "ready");
      return true;
    } catch (err) {
      if (!(err instanceof Failed)) console.error("[restore] could not restore aside:", (err as Error).message);
      await discard();
      await finish(request.note, err instanceof Failed ? err.reason : "unreadable");
      return false;
    }
  }

  /** Leaves the databases and the files as they were before the swap, wherever it stopped. True if something came back. */
  async function revert(): Promise<boolean> {
    let back = false;
    for (const db of [main, gateway]) {
      if (await exists(`${db}_previous`)) {
        if (await exists(db)) await renameDb(db, `${db}_failed`, false).catch(logged(`set ${db} aside`));
        await renameDb(`${db}_previous`, db, true).catch(logged(`put ${db} back`));
        back = true;
      }
      // A rename that never happened leaves the database closed: it is opened.
      if (await exists(db)) await admin(`ALTER DATABASE ${quote(db)} WITH ALLOW_CONNECTIONS true`).catch(logged(`open ${db}`));
    }
    for (const db of [`${main}_failed`, `${gateway}_failed`, `${main}_new`, `${gateway}_new`]) await drop(db).catch(logged(`delete ${db}`));
    await revertFiles();
    return back;
  }

  /** Undoes the restore under way and says why. Traccar, which may have seen what was restored, restarts on what there was. */
  async function giveUp(note: Note, reason: Reason): Promise<void> {
    console.log(`[restore] going back to what there was (${reason})`);
    if (await revert()) {
      const session = await traccar.signIn().catch(() => null);
      if (session) await restartGateway(session).catch(logged("restart Traccar"));
    }
    // Without the databases in use, what was left halfway could not be put back.
    const inPlace = (await exists(main).catch(() => false)) && (await exists(gateway).catch(() => false));
    await finish(note, inPlace ? reason : "broken");
  }

  /** The restored databases and files in place of those in use. True if the platform starts on them. */
  async function swapIn(note: Note): Promise<boolean> {
    // The session is opened before: once the database changes, this server's password may not be in it.
    let session: string | null;
    try {
      session = await traccar.signIn();
    } catch (err) {
      console.error("[restore] Traccar does not let the platform in:", (err as Error).message);
      await discard();
      await finish(note, "gateway");
      return false;
    }
    console.log("[restore] swapping the databases and the files");
    await phase(note, "swapping");
    try {
      await renameDb(main, `${main}_previous`, false);
      await renameDb(gateway, `${gateway}_previous`, false);
      await renameDb(`${main}_new`, main, true);
      await renameDb(`${gateway}_new`, gateway, true);
      await swapFiles();
    } catch (err) {
      console.error("[restore] could not swap:", (err as Error).message);
      await giveUp(note, "swap");
      return false;
    }
    // Without an answer before, Traccar was not running: it will start on the restored database.
    if (session) {
      try {
        await restartGateway(session);
      } catch (err) {
        console.error("[restore] could not restart Traccar:", (err as Error).message);
        await giveUp(note, "gateway");
        return false;
      }
    }
    await phase(note, "swapped");
    return true;
  }

  async function waitForPostgres(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await admin("SELECT 1");
        return;
      } catch (err) {
        if (attempt >= 30) throw err;
        console.warn(`[restore] Postgres is not ready yet (${(err as Error).message}); retry ${attempt}/30`);
        await sleep(2000);
      }
    }
  }

  return {
    async pickUp() {
      if (busy) return false;
      busy = true;
      try {
        // A restore under way belongs to this process, or to the next start.
        if (await lstat(join(dir, RESTORE_RUNNING)).then(() => true, () => false)) return false;
        const request = await take();
        if (!request || !(await aside(request))) return false;
        console.log("[restore] ready: the platform restarts to swap the databases");
        return true;
      } finally {
        busy = false;
      }
    },

    async atStartup() {
      const has = (name: string) => lstat(join(dir, name)).then(() => true, () => false);
      if (!(await has(RESTORE_RUNNING)) && !(await has(RESTORE_REQUEST))) return false;
      await waitForPostgres();
      const note = await readNote(join(dir, RESTORE_RUNNING));
      if (note) {
        if (note.phase === "ready") return swapIn(note);
        if (note.phase === "aside") {
          // Cut while restoring aside: what is in use was not touched.
          await discard();
          await finish(note, "cut");
        } else {
          // Cut while swapping, or while starting on what was restored. Also one the helper of a version before this one left.
          await giveUp(note, note.phase === "swapped" ? "start" : "cut");
        }
        return false;
      }
      const request = await take();
      if (!request || !(await aside(request))) return false;
      return swapIn((await readNote(join(dir, RESTORE_RUNNING))) ?? request.note);
    },

    async confirm() {
      const deadline = Date.now() + GATEWAY_WAIT_MS;
      while (!(await traccar.ready())) {
        if (Date.now() > deadline) throw new Error("Traccar did not answer after the restore");
        await sleep(5000);
      }
      for (const db of [main, gateway]) await drop(`${db}_previous`);
      await rm(filesOld, { recursive: true, force: true });
      const note = await readNote(join(dir, RESTORE_RUNNING));
      if (note) await finish(note, null);
    },

    async undo() {
      const note = await readNote(join(dir, RESTORE_RUNNING));
      if (note) await giveUp(note, "start");
    },
  };
}
