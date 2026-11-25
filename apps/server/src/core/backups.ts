// Backups made by the platform itself: both databases (with pg_dump) and the
// files users upload. They stay in a folder on the server and, if requested,
// also in the external storage. Scheduling and retention come from the
// settings.
//
// Restoring a backup is not done by the backend: it would have to delete the
// database it lives on and stop the device gateway. Here the request is only
// left in the backups folder; a helper service handles it (deploy/helper.sh),
// which restores aside, stops the platform, swaps the databases and brings it
// back up. Before requesting it, a backup of the current state of everything is made.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Backup, type BackupFile, type BackupPart, type BackupsInfo, type Language, type RestoreInfo, type TextParams, type UpdateFailure, type UpdateInstall, cronNext, isCron, parseCron } from "@opengps/shared";
import type { Bus } from "../bus";
import type { Config } from "../config";
import { type Db, withTransaction } from "../db";
import { AppError, badRequest, conflict, notFound } from "../errors";
import { type ServerKey, render, say, tr } from "../i18n";
import { audit } from "./audit";
import { S3Error, deleteObject, getObject, keyOf, listObjects, removeEmptyFolder, uploadFile } from "./s3";
import type { KeptKeys, Settings, SettingsActor } from "./settings";
import type { SystemNotifier } from "./system";

const TICK_MS = 60_000;
const DUMP_TIMEOUT_MS = 2 * 60 * 60_000;
/** Backups shown by the console. */
const LIST_MAX = 60;
/** Files a backup leaves. */
const BACKUP_FILE = /^(gps|traccar)_\d{8}_\d{6}\.dump$|^files_\d{8}_\d{6}\.tar\.gz$/;
const UUID = /^[0-9a-f-]{36}$/i;
/** Folder in the external storage where each backup goes, in its own subfolder. */
const REMOTE_ROOT = "backups";
/** From a backup file: which part it is and when it is from. */
const FILE_STAMP = /^(gps|traccar|files)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\./;

// Files the backend and the restore helper use to talk to each other, in the
// backups folder. They are "key=value" lines, easy to read from bash.
/** The helper touches it every 30 seconds: if it is recent, someone is there to handle a request. */
export const HELPER_ALIVE = "helper.alive";
/** The restore request, written by the backend. */
export const RESTORE_REQUEST = "restore.request";
/** The same request, while the helper handles it. */
export const RESTORE_RUNNING = "restore.running";
/** How the last restore ended, written by the helper. */
export const RESTORE_RESULT = "restore.result";
/** The request to install a version, written by the backend (ADR-0004). */
export const UPDATE_REQUEST = "update.request";
/** The same request, while the helper handles it. */
export const UPDATE_RUNNING = "update.running";
/** How the last install ended, written by the helper. */
export const UPDATE_RESULT = "update.result";
const UPDATE_FAILURES: readonly UpdateFailure[] = ["backup", "invalid", "unsupported", "pull", "files", "env", "start", "rolled_back", "restored", "broken", "cut"];
/**
 * The list of backups, which is also saved in the folder on every change. A
 * restored database comes back with the list from when its backup was made;
 * the backups that really exist are those in the folder, and at startup it takes precedence.
 */
const INDEX = "backups.json";
/**
 * The mail, storage, channel and sign-in keys of this server, encrypted, saved
 * when a restore is requested. A backup from another server brings that
 * server's keys, which cannot be read here: this file preserves the local ones.
 */
const RESTORE_KEYS = "restore.settings";
const RUNNER_FRESH_MS = 3 * 60_000;
/** Why the helper could not restore: the codes it writes, and what they say. */
const RESTORE_REASONS = {
  invalid: "core.backups.reason.invalid",
  unreadable: "core.backups.reason.unreadable",
  incomplete: "core.backups.reason.incomplete",
  files: "core.backups.reason.files",
  swap: "core.backups.reason.swap",
  start: "core.backups.reason.start",
  cut: "core.backups.reason.cut",
  broken: "core.backups.reason.broken",
} as const satisfies Record<string, ServerKey>;

interface Row {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  kind: Backup["kind"];
  status: Backup["status"];
  error: string | null;
  files: BackupFile[];
  bytes: number;
  local: boolean;
  remote: boolean;
  remote_error: string | null;
  remote_prefix: string | null;
  created_by: string | null;
}
const COLUMNS = `id, started_at, finished_at, kind, status, error, files, bytes, local, remote, remote_error, remote_prefix, created_by`;
/** A row as it is left in the folder's list: dates as text. */
type IndexRow = Omit<Row, "started_at" | "finished_at"> & { started_at: string; finished_at: string | null };
const toBackup = (r: Row): Backup => ({
  id: r.id,
  startedAt: r.started_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  kind: r.kind,
  status: r.status,
  error: r.error,
  files: r.files,
  bytes: Number(r.bytes),
  local: r.local,
  remote: r.remote,
  remoteError: r.remote_error,
});

/** Reads a file of "key=value" lines; null if it does not exist. */
async function readNote(path: string): Promise<Record<string, string> | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

const stamp = (ms: number) => {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}_${iso.slice(11, 19).replace(/:/g, "")}`;
};

/** Runs a program and waits for it to finish; if it fails, the error carries the last thing it said, or says why in `language`. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, language: Language): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), DUMP_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      said = (said + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error((err as NodeJS.ErrnoException).code === "ENOENT" ? tr(language, "core.backups.notInstalled", { command }) : err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(said.trim().split("\n").slice(-3).join(" ") || tr(language, "core.backups.exitCode", { command, code: String(code) })));
    });
  });
}

/** Variables pg_dump uses to connect, without leaving the password visible in the process list. */
function pgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  return { PATH: process.env.PATH, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1), PGCONNECT_TIMEOUT: "15" };
}

export interface Backups {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
  /** Makes the scheduled backup if it is due. Returns whether it did. */
  tick(now?: number): Promise<boolean>;
  /** Makes a backup now. Fails if one is already running. */
  run(kind: Backup["kind"], actor?: SettingsActor): Promise<Backup>;
  info(now?: number): Promise<BackupsInfo>;
  remove(id: string, actor: SettingsActor): Promise<void>;
  /** One of a backup's files, from the server or the external storage, to download it. */
  open(id: string, name: string, actor: SettingsActor): Promise<{ name: string; bytes: number; stream: Readable }>;
  /**
   * Requests restoring a backup. First makes a backup of the current state of everything and
   * then leaves the request for the restore helper. Responds as soon as it
   * checks it; the rest happens afterwards.
   */
  restore(id: string, actor: SettingsActor): Promise<void>;
  /**
   * Looks in the external storage for backups that are not in the list and
   * adds them: those from another installation, or from this one that the database no longer remembers.
   * `found` are the complete backups there; `added`, the ones that were new.
   */
  discover(actor: SettingsActor): Promise<{ found: number; added: number }>;
  /**
   * Brings the backup list up to date with the folder: if the database was restored by hand,
   * the list goes back to what it was, with the backups made afterwards. It is called at
   * startup, before serving anyone.
   */
  reconcile(): Promise<void>;
  /** Whether the helper is running, and whether it can install versions (it sees the installation's folder). */
  helper(): Promise<{ alive: boolean; canUpdate: boolean }>;
  /**
   * Requests installing a version. First makes a backup of everything, like
   * before restoring, and then leaves the request for the helper. Responds as
   * soon as it checks it; the rest happens afterwards.
   */
  requestUpdate(version: string, from: string, actor: SettingsActor): Promise<void>;
  /** The last install asked from the console, according to what is in the folder. */
  lastUpdate(): Promise<UpdateInstall["last"]>;
}

/** With `tickEveryMs` null there is no clock: whoever creates it calls `tick` when it wants (tests). */
export function createBackups(deps: { db: Db; bus: Bus; config: Config; settings: Settings; system?: SystemNotifier; tickEveryMs?: number | null }): Backups {
  const { db, config, settings } = deps;
  const dir = () => config.backup.dir;
  const available = () => Boolean(config.backup.databaseUrl);
  const startedAt = Date.now();
  let running: Promise<Backup> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  /** Restore this backend is preparing (making the prior backup), or that it could not prepare. */
  let preparing: RestoreInfo | null = null;
  let discovering = false;
  /**
   * What is kept to be read later, by whoever opens the console: a backup's error, how a restore
   * went. It is written in the platform's language.
   */
  const keep = (key: ServerKey, params?: TextParams): string => tr(config.defaultLanguage, key, params); // i18n: stored text
  /** What went wrong, in words, to keep it. */
  const problemOf = (err: unknown): string => (err instanceof AppError || err instanceof S3Error ? render(config.defaultLanguage, err.text) : (err as Error).message); // i18n: stored text

  /** Saves the backup list in the folder, as well as in the database. */
  async function saveIndex(): Promise<void> {
    const r = await db.core.query<Row>(`SELECT ${COLUMNS} FROM gps.backups ORDER BY started_at`);
    await mkdir(dir(), { recursive: true });
    await writeFile(join(dir(), `${INDEX}.tmp`), JSON.stringify(r.rows), { mode: 0o600 });
    await rename(join(dir(), `${INDEX}.tmp`), join(dir(), INDEX));
  }
  const keepIndex = () => saveIndex().catch((err: Error) => console.error("[backups] could not save the list of backups:", err.message));

  async function dump(part: BackupPart, url: string, name: string): Promise<BackupFile> {
    const path = join(dir(), name);
    await run("pg_dump", ["--format=custom", "--no-password", `--file=${path}.tmp`], pgEnv(url), config.defaultLanguage).catch(async (err: Error) => {
      await rm(`${path}.tmp`, { force: true });
      throw new Error(keep(part === "gps" ? "core.backups.dumpPlatform" : "core.backups.dumpReceiver", { reason: err.message }));
    });
    const { size } = await stat(`${path}.tmp`);
    if (size === 0) throw new Error(keep("core.backups.emptyDump"));
    // A backup holds the data of all accounts: only the backend reads it.
    await chmod(`${path}.tmp`, 0o600);
    await rename(`${path}.tmp`, path);
    return { name, part, bytes: size };
  }

  async function archive(name: string): Promise<BackupFile | null> {
    const exists = await stat(config.filesDir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!exists) return null;
    const path = join(dir(), name);
    await run("tar", ["-czf", `${path}.tmp`, "-C", config.filesDir, "."], { PATH: process.env.PATH }, config.defaultLanguage).catch(async (err: Error) => {
      await rm(`${path}.tmp`, { force: true });
      throw new Error(keep("core.backups.filesFailed", { reason: err.message }));
    });
    await chmod(`${path}.tmp`, 0o600);
    await rename(`${path}.tmp`, path);
    return { name, part: "files", bytes: (await stat(path)).size };
  }

  /** Removes scheduled backups past their retention period, and the loose files from before that nobody has recorded any more. */
  async function prune(now: number): Promise<void> {
    const days = settings.backups().retentionDays;
    const old = await db.core.query<Row>(`SELECT ${COLUMNS} FROM gps.backups WHERE kind = 'scheduled' AND status <> 'running' AND started_at < $1`, [new Date(now - days * 86_400_000)]);
    for (const row of old.rows) await erase(row).catch((err: Error) => console.error(`[backups] could not delete backup ${row.id}:`, err.message));

    const known = await db.core.query<{ name: string }>(`SELECT f->>'name' AS name FROM gps.backups, jsonb_array_elements(files) AS f`);
    const kept = new Set(known.rows.map((r) => r.name));
    for (const name of await readdir(dir()).catch(() => [] as string[])) {
      if (!BACKUP_FILE.test(name) || kept.has(name)) continue;
      const info = await stat(join(dir(), name)).catch(() => null);
      if (info && info.mtimeMs < now - days * 86_400_000) await rm(join(dir(), name), { force: true });
    }
  }

  /** Deletes a backup: its server files, those in the external storage and its record. */
  async function erase(row: Row): Promise<void> {
    for (const file of row.files) await rm(join(dir(), file.name), { force: true });
    if (row.remote && row.remote_prefix && config.storage) {
      for (const file of row.files) await deleteObject(config.storage, keyOf(config.storage, `${row.remote_prefix}/${file.name}`));
      // Some services show the empty folder: it is removed too.
      await removeEmptyFolder(config.storage, keyOf(config.storage, row.remote_prefix));
    }
    await db.core.query(`DELETE FROM gps.backups WHERE id = $1`, [row.id]);
  }

  async function make(kind: Backup["kind"], actor: SettingsActor | undefined, now: number): Promise<Backup> {
    if (!available()) throw badRequest(say("core.backups.unavailable"));
    const created = await db.core.query<{ id: string }>(`INSERT INTO gps.backups (kind, status, started_at, created_by) VALUES ($1, 'running', $2, $3) RETURNING id`, [kind, new Date(now), actor?.userId ?? null]);
    const id = (created.rows[0] as { id: string }).id;
    await keepIndex();
    let mark = stamp(now);
    const files: BackupFile[] = [];
    let error: string | null = null;
    try {
      await mkdir(dir(), { recursive: true });
      // Names carry the time down to the second: if a backup from that second already exists, this one takes the next.
      for (let bump = 1; await stat(join(dir(), `gps_${mark}.dump`)).catch(() => null); bump++) mark = stamp(now + bump * 1000);
      files.push(await dump("gps", config.backup.databaseUrl, `gps_${mark}.dump`));
      files.push(await dump("traccar", config.backup.traccarDatabaseUrl, `traccar_${mark}.dump`));
      const archived = await archive(`files_${mark}.tar.gz`);
      if (archived) files.push(archived);
    } catch (err) {
      error = problemOf(err);
      // A half-done backup is useless: its pieces are not kept.
      for (const file of files.splice(0)) await rm(join(dir(), file.name), { force: true });
    }
    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    await db.core.query(`UPDATE gps.backups SET status = $2, error = $3, files = $4::jsonb, bytes = $5, local = $6, finished_at = now() WHERE id = $1`, [
      id,
      error ? "failed" : "ok",
      error,
      JSON.stringify(files),
      bytes,
      !error,
    ]);

    // The external storage comes afterwards: if it fails, the server's backup remains valid.
    if (!error && settings.backups().upload) {
      const prefix = `${REMOTE_ROOT}/${mark}`;
      let remoteError: string | null = null;
      if (!config.storage) remoteError = keep("core.backups.noStorage");
      else {
        try {
          for (const file of files) await uploadFile(config.storage, keyOf(config.storage, `${prefix}/${file.name}`), join(dir(), file.name));
        } catch (err) {
          remoteError = problemOf(err);
        }
      }
      await db.core.query(`UPDATE gps.backups SET remote = $2, remote_error = $3, remote_prefix = $4 WHERE id = $1`, [id, remoteError === null, remoteError, remoteError === null ? prefix : null]);
      if (remoteError) error = keep("core.backups.notUploaded", { reason: remoteError });
    }

    if (actor) await audit(db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.backup", "backup", id, { ok: error === null });
    const language = config.defaultLanguage; // The platform's own notifications are written in its language.
    if (error) {
      console.error(`[backups] backup ${id} failed:`, error);
      await deps.system?.notify("backup_failed", { title: tr(language, "core.backups.notify.failedTitle"), body: tr(language, "core.backups.notify.failedBody", { error }), path: "/admin/system/backups" });
    } else {
      const body = kind === "manual" ? "core.backups.notify.doneManual" : kind === "pre_restore" ? "core.backups.notify.doneBeforeRestore" : kind === "pre_update" ? "core.backups.notify.doneBeforeUpdate" : "core.backups.notify.doneScheduled";
      await deps.system?.notify("backup_ok", { title: tr(language, "core.backups.notify.doneTitle"), body: tr(language, body), path: "/admin/system/backups" });
    }
    await prune(now).catch((err: Error) => console.error("[backups] could not remove the expired backups:", err.message));
    await keepIndex();
    const saved = await db.core.query<Row>(`SELECT ${COLUMNS} FROM gps.backups WHERE id = $1`, [id]);
    return toBackup(saved.rows[0] as Row);
  }

  function runOnce(kind: Backup["kind"], actor?: SettingsActor, now = Date.now()): Promise<Backup> {
    if (running) throw conflict("backup_running", say("core.backups.running"));
    const job = make(kind, actor, now).finally(() => {
      running = null;
    });
    running = job;
    return job;
  }

  async function rowOf(id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound(say("core.backups.notFound"));
    const r = await db.core.query<Row>(`SELECT ${COLUMNS} FROM gps.backups WHERE id = $1`, [id]);
    if (!r.rows[0]) throw notFound(say("core.backups.notFound"));
    return r.rows[0];
  }

  async function tick(now = Date.now()): Promise<boolean> {
    const s = settings.backups();
    if (!s.scheduled || !available() || running) return false;
    const cron = parseCron(s.cron);
    if (!isCron(cron)) return false;
    const done = await db.core.query<{ at: Date | null }>(`SELECT max(started_at) AS at FROM gps.backups WHERE kind = 'scheduled'`);
    // Due once the first hour of the schedule after the last backup has passed. If there never was one, it counts from when
    // the schedule was saved or from startup: changing it does not trigger a backup right away.
    const since = Math.max(done.rows[0]?.at?.getTime() ?? 0, settings.backupsSavedAt() ?? 0) || startedAt;
    const due = cronNext(cron, since);
    if (due === null || due > now) return false;
    await runOnce("scheduled", undefined, now);
    return true;
  }

  // ─── Restore ───────────────────────────────────────────────────────────────

  const runnerAlive = async (now: number) => {
    const info = await stat(join(dir(), HELPER_ALIVE)).catch(() => null);
    return info !== null && now - info.mtimeMs < RUNNER_FRESH_MS;
  };
  /** The helper is running and says it can install versions (update=yes). */
  const helperState = async (now: number) => {
    const alive = await runnerAlive(now);
    const note = alive ? await readNote(join(dir(), HELPER_ALIVE)) : null;
    return { alive, canUpdate: note?.update === "yes" };
  };

  /** Why a restore failed, in words: from the helper's code, or as it wrote it. */
  const reasonOf = (note: Record<string, string>): string => {
    const key = RESTORE_REASONS[note.reason as keyof typeof RESTORE_REASONS];
    if (key) return keep(key);
    return note.error || keep("core.backups.noReason");
  };

  /** Where the restore stands, according to what is in the folder. */
  async function restoreInfo(): Promise<RestoreInfo | null> {
    const waiting = (await readNote(join(dir(), RESTORE_REQUEST))) ?? null;
    const working = waiting ? null : await readNote(join(dir(), RESTORE_RUNNING));
    const note = waiting ?? working;
    if (note?.id) return { state: waiting ? "requested" : "running", backupId: note.id, backupAt: note.backup || null, at: note.requested || new Date().toISOString(), error: null };
    if (preparing) return preparing;
    const result = await readNote(join(dir(), RESTORE_RESULT));
    if (result?.id) return { state: result.status === "ok" ? "done" : "failed", backupId: result.id, backupAt: result.backup || null, at: result.finished || result.requested || new Date().toISOString(), error: result.status === "ok" ? null : reasonOf(result) };
    return null;
  }

  /** Downloads from the external storage the files of a backup that are no longer on the server. */
  async function fetchRemote(row: Row): Promise<void> {
    for (const file of row.files) {
      const path = join(dir(), file.name);
      if (await stat(path).catch(() => null)) continue;
      if (!row.remote || !row.remote_prefix || !config.storage) throw badRequest(say("core.backups.filesGone"));
      const remote = await getObject(config.storage, keyOf(config.storage, `${row.remote_prefix}/${file.name}`));
      await pipeline(remote.stream, createWriteStream(`${path}.tmp`, { mode: 0o600 })).catch(async (err: Error) => {
        await rm(`${path}.tmp`, { force: true });
        throw err;
      });
      const { size } = await stat(`${path}.tmp`);
      if (size !== file.bytes) {
        await rm(`${path}.tmp`, { force: true });
        throw badRequest(say("core.backups.incompleteDownload"));
      }
      await rename(`${path}.tmp`, path);
    }
    if (!row.local) {
      await db.core.query(`UPDATE gps.backups SET local = true WHERE id = $1`, [row.id]);
      await keepIndex();
    }
  }

  async function prepareRestore(row: Row, actor: SettingsActor, requestedAt: string): Promise<void> {
    await fetchRemote(row);
    // Before going back, the current state of everything is saved: with that backup the restore can be undone.
    const safety = await runOnce("pre_restore", actor);
    if (safety.status !== "ok") throw new Error(keep("core.backups.safetyFailed", { reason: safety.error ?? keep("core.backups.noDetail") }));
    await writeFile(join(dir(), RESTORE_KEYS), JSON.stringify(settings.keys()), { mode: 0o600 });
    const part = (name: BackupPart) => row.files.find((f) => f.part === name)?.name ?? "";
    const note = [`id=${row.id}`, `backup=${row.started_at.toISOString()}`, `requested=${requestedAt}`, `gps=${part("gps")}`, `traccar=${part("traccar")}`, `files=${part("files")}`, ""].join("\n");
    await writeFile(join(dir(), `${RESTORE_REQUEST}.tmp`), note, { mode: 0o600 });
    await rename(join(dir(), `${RESTORE_REQUEST}.tmp`), join(dir(), RESTORE_REQUEST));
  }

  // ─── Updates (ADR-0004) ────────────────────────────────────────────────────

  /** An install this backend is preparing (making the backup before it), or could not prepare. */
  let updatePreparing: UpdateInstall["last"] = null;

  async function lastUpdate(): Promise<UpdateInstall["last"]> {
    if (updatePreparing) return updatePreparing;
    const waiting = await readNote(join(dir(), UPDATE_REQUEST));
    const working = waiting ? null : await readNote(join(dir(), UPDATE_RUNNING));
    const note = waiting ?? working;
    if (note?.version) return { state: waiting ? "requested" : "running", version: note.version, from: note.from || null, at: note.requested || new Date().toISOString(), reason: null };
    const result = await readNote(join(dir(), UPDATE_RESULT));
    if (!result?.version) return null;
    const reason = UPDATE_FAILURES.find((r) => r === result.reason) ?? null;
    return { state: result.status === "ok" ? "ok" : "failed", version: result.version, from: result.from || null, at: result.finished || result.requested || new Date().toISOString(), reason };
  }

  async function prepareUpdate(version: string, actor: SettingsActor, requestedAt: string): Promise<void> {
    // Before installing, the current state of everything is saved: with that backup the update can be undone.
    const safety = await runOnce("pre_update", actor);
    if (safety.status !== "ok") throw new Error(safety.error ?? "the backup before updating failed");
    const part = (name: BackupPart) => safety.files.find((f) => f.part === name)?.name ?? "";
    const note = [`id=${randomUUID()}`, `version=${version}`, `requested=${requestedAt}`, `backup=${safety.id}`, `gps=${part("gps")}`, `traccar=${part("traccar")}`, `files=${part("files")}`, ""].join("\n");
    await writeFile(join(dir(), `${UPDATE_REQUEST}.tmp`), note, { mode: 0o600 });
    await rename(join(dir(), `${UPDATE_REQUEST}.tmp`), join(dir(), UPDATE_REQUEST));
  }

  /**
   * If this database is the one left by a restore requested from the console, it is
   * noted in it: the request's record stayed in the previous database.
   */
  async function noteRestore(): Promise<void> {
    const note = await readNote(join(dir(), RESTORE_RUNNING));
    if (!note?.id || !note.requested) return;
    const seen = await db.core.query(`SELECT 1 FROM gps.audit_log WHERE action IN ('admin.backup_restore', 'admin.backup_restored') AND detail->>'requestedAt' = $1 LIMIT 1`, [note.requested]);
    if (seen.rowCount) return;
    // If the backup came from another server, its keys are not read here: this server's keep applying.
    const text = await readFile(join(dir(), RESTORE_KEYS), "utf8").catch(() => null);
    let mine: Partial<KeptKeys> = {};
    try {
      if (text) mine = JSON.parse(text) as Partial<KeptKeys>;
    } catch {
      // Without the previous ones, the unreadable sections go back to what the server variables provide.
    }
    const keptKeys = await settings.adopt(mine && typeof mine === "object" ? mine : {});
    if (keptKeys.length > 0) console.log(`[backups] the backup brought another server's keys: this one's are kept in ${keptKeys.join(", ")}`);
    await audit(db.core, { orgId: null, userId: null }, "admin.backup_restored", "backup", note.id, { startedAt: note.backup || null, requestedAt: note.requested, keptKeys });
    const language = config.defaultLanguage; // The platform's own notifications are written in its language.
    await deps.system?.notify("restore_done", { title: tr(language, "core.backups.notify.restoredTitle"), body: tr(language, "core.backups.notify.restoredBody"), path: "/admin/system/backups" });
    await rm(join(dir(), RESTORE_KEYS), { force: true });
  }

  async function discover(actor: SettingsActor): Promise<{ found: number; added: number }> {
    const storage = config.storage;
    if (!storage) throw badRequest(say("core.backups.configureStorage"));
    if (discovering) throw conflict("discover_running", say("core.backups.discovering"));
    discovering = true;
    try {
      // Each backup is a folder with its files, whose names carry the time it was made.
      const copies = new Map<string, { folder: string; at: number; modified: number; files: Map<BackupPart, BackupFile> }>();
      const root = keyOf(storage, `${REMOTE_ROOT}/`);
      for (const object of await listObjects(storage, root)) {
        const [folder, name, ...deeper] = object.key.slice(root.length).split("/");
        const m = name?.match(FILE_STAMP);
        if (!folder || !name || deeper.length > 0 || !m || !BACKUP_FILE.test(name) || object.bytes <= 0) continue;
        const id = `${folder}/${m.slice(2).join("")}`;
        const copy = copies.get(id) ?? { folder, at: Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])), modified: 0, files: new Map() };
        copy.files.set(m[1] as BackupPart, { name, part: m[1] as BackupPart, bytes: object.bytes });
        copy.modified = Math.max(copy.modified, object.modifiedAt ? Date.parse(object.modifiedAt) || 0 : 0);
        copies.set(id, copy);
      }
      const complete = [...copies.values()].filter((c) => c.files.has("gps") && c.files.has("traccar") && Number.isFinite(c.at));

      const known = await db.core.query<Row>(`SELECT ${COLUMNS} FROM gps.backups`);
      const byFile = new Map<string, Row>();
      for (const row of known.rows) for (const f of row.files) byFile.set(f.name, row);
      let added = 0;
      for (const copy of complete) {
        const files = (["gps", "traccar", "files"] as const).flatMap((part) => copy.files.get(part) ?? []);
        const prefix = `${REMOTE_ROOT}/${copy.folder}`;
        const first = (copy.files.get("gps") as BackupFile).name;
        const row = byFile.get(first);
        if (row) {
          // It is already in the list. If it was not recorded as being off the server and its same files are there, now it is.
          const same = row.status === "ok" && row.files.length === files.length && row.files.every((f) => copy.files.get(f.part)?.name === f.name && copy.files.get(f.part)?.bytes === f.bytes);
          if (!row.remote && same) await db.core.query(`UPDATE gps.backups SET remote = true, remote_prefix = $2, remote_error = NULL WHERE id = $1`, [row.id, prefix]);
          continue;
        }
        const here = await Promise.all(files.map((f) => stat(join(dir(), f.name)).then((s) => s.size === f.bytes, () => false)));
        await db.core.query(
          `INSERT INTO gps.backups (kind, status, started_at, finished_at, files, bytes, local, remote, remote_prefix, created_by)
           VALUES ('imported', 'ok', $1, $2, $3::jsonb, $4, $5, true, $6, $7)`,
          [new Date(copy.at), new Date(copy.modified || copy.at), JSON.stringify(files), files.reduce((n, f) => n + f.bytes, 0), !here.includes(false), prefix, actor.userId],
        );
        added++;
      }
      await keepIndex();
      await audit(db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.backup_discover", "backup", "", { found: complete.length, added });
      return { found: complete.length, added };
    } finally {
      discovering = false;
    }
  }

  async function reconcile(): Promise<void> {
    const text = await readFile(join(dir(), INDEX), "utf8").catch(() => null);
    let rows: IndexRow[] | null = null;
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) rows = parsed as IndexRow[];
      } catch {
        // The database's list is kept.
      }
      if (!rows) console.error("[backups] the folder's list of backups could not be read; the database's is kept");
    }
    if (rows) {
      const list = rows;
      const had = await db.core.query<{ id: string }>(`SELECT id FROM gps.backups`);
      const same = had.rows.length === list.length && had.rows.every((r) => list.some((i) => i.id === r.id));
      await withTransaction(db.core, async (client) => {
        await client.query(`DELETE FROM gps.backups`);
        for (const r of list) {
          await client.query(
            `INSERT INTO gps.backups (id, started_at, finished_at, kind, status, error, files, bytes, local, remote, remote_error, remote_prefix, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)`,
            [r.id, r.started_at, r.finished_at, r.kind, r.status, r.error, JSON.stringify(r.files), r.bytes, r.local, r.remote, r.remote_error, r.remote_prefix, r.created_by],
          );
        }
      });
      if (!same) console.log(`[backups] the database had another list of backups (it was restored): the folder's was put back, with ${list.length}`);
    }
    // A backup that the restart left half-done did not finish.
    await db.core.query(`UPDATE gps.backups SET status = 'failed', error = $1, finished_at = now() WHERE status = 'running'`, [keep("core.backups.interrupted")]);
    // A backup whose files are no longer on the server stops being counted as local.
    const local = await db.core.query<Row>(`SELECT ${COLUMNS} FROM gps.backups WHERE local AND status = 'ok'`);
    for (const row of local.rows) {
      const present = await Promise.all(row.files.map((f) => stat(join(dir(), f.name)).then(() => true, () => false)));
      if (present.includes(false)) await db.core.query(`UPDATE gps.backups SET local = false WHERE id = $1`, [row.id]);
    }
    await noteRestore().catch((err: Error) => console.error("[backups] could not record the restore:", err.message));
    await keepIndex();
  }

  return {
    start() {
      const every = deps.tickEveryMs === undefined ? TICK_MS : deps.tickEveryMs;
      if (every === null) return;
      timer = setInterval(() => {
        queue = queue.then(() => tick()).catch((err: Error) => console.error("[backups] the scheduled backup failed:", err.message));
      }, every);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    idle: async () => {
      await queue;
      await running?.catch(() => {});
      await queue;
    },
    tick,
    run: (kind, actor) => runOnce(kind, actor),
    async info(now = Date.now()) {
      const r = await db.core.query<Row>(`SELECT ${COLUMNS} FROM gps.backups ORDER BY started_at DESC LIMIT $1`, [LIST_MAX]);
      const s = settings.backups();
      const cron = parseCron(s.cron);
      const next = s.scheduled && available() && isCron(cron) ? cronNext(cron, now) : null;
      return {
        available: available(),
        running: running !== null,
        nextAt: next === null ? null : new Date(next).toISOString(),
        backups: r.rows.map(toBackup),
        canRestore: await runnerAlive(now),
        restore: await restoreInfo(),
      };
    },
    async remove(id, actor) {
      const row = await rowOf(id);
      if (row.status === "running") throw conflict("backup_running", say("core.backups.stillRunning"));
      await erase(row);
      await keepIndex();
      await audit(db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.backup_delete", "backup", id, { startedAt: row.started_at.toISOString() });
    },
    async open(id, name, actor) {
      const row = await rowOf(id);
      const file = row.files.find((f) => f.name === name);
      if (!file || row.status !== "ok") throw notFound(say("core.backups.fileNotFound"));
      // Taking a complete backup of the platform out is logged.
      await audit(db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.backup_download", "backup", id, { name });
      const path = join(dir(), file.name);
      if (row.local && (await stat(path).catch(() => null))) return { name: file.name, bytes: file.bytes, stream: createReadStream(path) };
      if (row.remote && row.remote_prefix && config.storage) {
        const remote = await getObject(config.storage, keyOf(config.storage, `${row.remote_prefix}/${file.name}`));
        return { name: file.name, bytes: file.bytes, stream: remote.stream };
      }
      throw notFound(say("core.backups.fileGone"));
    },
    async restore(id, actor) {
      const row = await rowOf(id);
      if (row.status !== "ok" || !row.files.some((f) => f.part === "gps") || !row.files.some((f) => f.part === "traccar")) throw badRequest(say("core.backups.incomplete"));
      if (!(await runnerAlive(Date.now()))) throw badRequest(say("core.backups.noRunner"));
      const now = await restoreInfo();
      if (now && (now.state === "requested" || now.state === "running")) throw conflict("restore_running", say("core.backups.restoreRunning"));
      if (running) throw conflict("backup_running", say("core.backups.busy"));
      const requestedAt = new Date().toISOString();
      await audit(db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.backup_restore", "backup", id, { startedAt: row.started_at.toISOString(), requestedAt });
      preparing = { state: "requested", backupId: row.id, backupAt: row.started_at.toISOString(), at: requestedAt, error: null };
      // The prior backup may take a while: it is made after responding.
      queue = queue
        .then(() => prepareRestore(row, actor, requestedAt))
        .then(
          () => {
            preparing = null;
          },
          (err: Error) => {
            console.error("[backups] could not prepare the restore:", err.message);
            preparing = { state: "failed", backupId: row.id, backupAt: row.started_at.toISOString(), at: new Date().toISOString(), error: problemOf(err) };
          },
        );
    },
    discover,
    reconcile,
    helper: () => helperState(Date.now()),
    async requestUpdate(version, from, actor) {
      const helper = await helperState(Date.now());
      if (!helper.alive || !helper.canUpdate) throw badRequest(say("core.updates.noHelper"));
      const restoring = await restoreInfo();
      if (restoring && (restoring.state === "requested" || restoring.state === "running")) throw conflict("restore_running", say("core.backups.restoreRunning"));
      const now = await lastUpdate();
      if (now && (now.state === "preparing" || now.state === "requested" || now.state === "running")) throw conflict("update_running", say("core.updates.running"));
      if (running) throw conflict("backup_running", say("core.backups.busy"));
      const requestedAt = new Date().toISOString();
      await audit(db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.update_install", "update", version, { version, from, requestedAt });
      updatePreparing = { state: "preparing", version, from, at: requestedAt, reason: null };
      // The backup before it may take a while: it is made after responding.
      queue = queue
        .then(() => prepareUpdate(version, actor, requestedAt))
        .then(
          () => {
            updatePreparing = null;
          },
          (err: Error) => {
            console.error("[backups] could not prepare the update:", err.message);
            updatePreparing = { state: "failed", version, from, at: new Date().toISOString(), reason: "backup" };
          },
        );
    },
    lastUpdate,
  };
}
