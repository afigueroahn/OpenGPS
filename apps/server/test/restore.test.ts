// Restoring a backup (ADR-0009), on the test database but with databases of
// its own, opengps_rt and traccar_rt: the ones the other tests use are not
// touched. Each one holds a table with a word that says which it is: "in use"
// or "backup". pg_restore is replaced by a fake that cannot read anything; a
// real restore, with Docker and Traccar, is covered by update-e2e.sh.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { RESTORE_REQUEST, RESTORE_RESULT, RESTORE_RUNNING } from "../src/core/backups";
import { createRestore } from "../src/core/restore";
import type { Traccar } from "../src/traccar";

const TMP = join(process.env.TMPDIR ?? "/tmp", "opengps-test-restore");
const DIR = join(TMP, "backups");
const FILES = join(TMP, "files");
const base = loadConfig();
const urlOf = (db: string) => {
  const url = new URL(base.databaseUrl);
  url.pathname = `/${db}`;
  return url.toString();
};
const config = { ...base, filesDir: FILES, backup: { databaseUrl: urlOf("opengps_rt"), traccarDatabaseUrl: urlOf("traccar_rt"), dir: DIR } };
const ID = "019ab000-0000-7000-8000-000000000001";

async function on<T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlOf(db) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
const ours = async () => (await on("postgres", (c) => c.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE '%\\_rt%' ORDER BY datname`))).rows.map((r) => r.datname);
const dropOurs = async () => {
  for (const db of await ours()) await on("postgres", (c) => c.query(`DROP DATABASE "${db}" WITH (FORCE)`));
};
/** A database that says which one it is. */
async function make(db: string, word: string): Promise<void> {
  await on("postgres", (c) => c.query(`CREATE DATABASE "${db}"`));
  await on(db, (c) => c.query(`CREATE TABLE word (v text); INSERT INTO word VALUES ('${word}')`));
}
const wordOf = async (db: string) => (await on(db, (c) => c.query<{ v: string }>(`SELECT v FROM word`))).rows[0]?.v;
const note = (name: string) => Object.fromEntries(readFileSync(join(DIR, name), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const running = (phase: string) => writeFileSync(join(DIR, RESTORE_RUNNING), `id=${ID}\nbackup=2026-11-20T08:00:00.000Z\nrequested=2026-11-25T10:00:00.000Z\nphase=${phase}\n`);

function traccar(signIn: () => Promise<string | null> = async () => "JSESSIONID=t") {
  const fake = { signIn: vi.fn(signIn), reboot: vi.fn(async () => {}), ready: vi.fn(async () => true) };
  return { fake, restore: createRestore({ config, traccar: fake as unknown as Traccar }) };
}

/** What a restore leaves after restoring aside: the databases and files in use, and the backup's next to them. */
async function restoredAside(): Promise<void> {
  await make("opengps_rt", "in use");
  await make("traccar_rt", "in use");
  await make("opengps_rt_new", "backup");
  await make("traccar_rt_new", "backup");
  mkdirSync(join(FILES, ".restore-new"), { recursive: true });
  writeFileSync(join(FILES, "in-use.txt"), "");
  writeFileSync(join(FILES, ".restore-new", "backup.txt"), "");
  running("ready");
}

beforeEach(async () => {
  await dropOurs();
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  mkdirSync(FILES, { recursive: true });
});
afterAll(async () => {
  await dropOurs();
  rmSync(TMP, { recursive: true, force: true });
});

describe("restore", () => {
  it("does not take a request whose files are not a backup's", async () => {
    writeFileSync(join(DIR, RESTORE_REQUEST), `id=${ID}\nrequested=2026-11-25T10:00:00.000Z\ngps=../../etc/passwd\ntraccar=traccar_20261120_080000.dump\n`);
    const { restore } = traccar();
    expect(await restore.pickUp()).toBe(false);
    expect(note(RESTORE_RESULT)).toMatchObject({ id: ID, status: "failed", reason: "invalid" });
    expect(existsSync(join(DIR, RESTORE_REQUEST)) || existsSync(join(DIR, RESTORE_RUNNING))).toBe(false);
    expect(await ours()).toEqual([]);
  });

  it("changes nothing if the backup cannot be read", async () => {
    await make("opengps_rt", "in use");
    await make("traccar_rt", "in use");
    for (const name of ["gps_20261120_080000.dump", "traccar_20261120_080000.dump"]) writeFileSync(join(DIR, name), "not a dump");
    writeFileSync(join(DIR, RESTORE_REQUEST), `id=${ID}\nrequested=2026-11-25T10:00:00.000Z\ngps=gps_20261120_080000.dump\ntraccar=traccar_20261120_080000.dump\nfiles=\n`);
    // A pg_restore that cannot read the backup, ahead of the real one if there is one.
    mkdirSync(join(TMP, "bin"));
    writeFileSync(join(TMP, "bin", "pg_restore"), `#!/bin/sh\necho "pg_restore: error: input file does not appear to be a valid archive" >&2\nexit 1\n`);
    chmodSync(join(TMP, "bin", "pg_restore"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${join(TMP, "bin")}:${path}`;
    try {
      const { restore } = traccar();
      expect(await restore.pickUp()).toBe(false);
    } finally {
      process.env.PATH = path;
    }
    expect(note(RESTORE_RESULT)).toMatchObject({ id: ID, status: "failed", reason: "unreadable" });
    expect(await ours()).toEqual(["opengps_rt", "traccar_rt"]);
    expect(await wordOf("opengps_rt")).toBe("in use");
  });

  it("at startup swaps in what was restored aside, restarts Traccar and, once up, deletes what there was", async () => {
    await restoredAside();
    const { fake, restore } = traccar();
    expect(await restore.atStartup()).toBe(true);
    expect(await wordOf("opengps_rt")).toBe("backup");
    expect(await wordOf("traccar_rt")).toBe("backup");
    // What there was waits aside, closed, until the platform is up.
    expect(await ours()).toEqual(["opengps_rt", "opengps_rt_previous", "traccar_rt", "traccar_rt_previous"]);
    expect(existsSync(join(FILES, "backup.txt")) && !existsSync(join(FILES, "in-use.txt"))).toBe(true);
    // The session is opened before the swap: with it, Traccar restarts on the restored database.
    expect(fake.signIn.mock.invocationCallOrder[0]).toBeLessThan(fake.reboot.mock.invocationCallOrder[0] ?? 0);
    expect(fake.reboot).toHaveBeenCalledWith("JSESSIONID=t");
    expect(note(RESTORE_RUNNING).phase).toBe("swapped");

    await restore.confirm();
    expect(await ours()).toEqual(["opengps_rt", "traccar_rt"]);
    expect(existsSync(join(FILES, ".restore-previous"))).toBe(false);
    expect(note(RESTORE_RESULT)).toMatchObject({ id: ID, backup: "2026-11-20T08:00:00.000Z", status: "ok", reason: "" });
    expect(existsSync(join(DIR, RESTORE_RUNNING))).toBe(false);
  });

  it("goes back to what there was if the platform does not start on what was restored", async () => {
    await restoredAside();
    const { fake, restore } = traccar();
    expect(await restore.atStartup()).toBe(true);
    await restore.undo();
    expect(await ours()).toEqual(["opengps_rt", "traccar_rt"]);
    expect(await wordOf("opengps_rt")).toBe("in use");
    expect(await wordOf("traccar_rt")).toBe("in use");
    expect(existsSync(join(FILES, "in-use.txt")) && !existsSync(join(FILES, "backup.txt"))).toBe(true);
    // Traccar saw the restored database: it restarts again, on what there was.
    expect(fake.reboot).toHaveBeenCalledTimes(2);
    expect(note(RESTORE_RESULT)).toMatchObject({ id: ID, status: "failed", reason: "start" });
  });

  it("a start that finds a swap left halfway undoes it", async () => {
    // The platform's database was swapped, Traccar's not yet; some files were set aside, others not.
    await make("opengps_rt_previous", "in use");
    await make("opengps_rt", "backup");
    await make("traccar_rt", "in use");
    await make("traccar_rt_new", "backup");
    mkdirSync(join(FILES, ".restore-previous"), { recursive: true });
    writeFileSync(join(FILES, ".restore-previous", "in-use.txt"), "");
    writeFileSync(join(FILES, "not-yet-aside.txt"), "");
    running("swapping");
    const { restore } = traccar();
    expect(await restore.atStartup()).toBe(false);
    expect(await ours()).toEqual(["opengps_rt", "traccar_rt"]);
    expect(await wordOf("opengps_rt")).toBe("in use");
    expect(await wordOf("traccar_rt")).toBe("in use");
    expect(existsSync(join(FILES, "in-use.txt")) && existsSync(join(FILES, "not-yet-aside.txt"))).toBe(true);
    expect(note(RESTORE_RESULT)).toMatchObject({ id: ID, status: "failed", reason: "cut" });
  });

  it("changes nothing if Traccar does not let the platform in", async () => {
    await restoredAside();
    const { fake, restore } = traccar(async () => {
      throw new Error("401");
    });
    expect(await restore.atStartup()).toBe(false);
    expect(await ours()).toEqual(["opengps_rt", "traccar_rt"]);
    expect(await wordOf("opengps_rt")).toBe("in use");
    expect(existsSync(join(FILES, "in-use.txt")) && !existsSync(join(FILES, ".restore-new"))).toBe(true);
    expect(fake.reboot).not.toHaveBeenCalled();
    expect(note(RESTORE_RESULT)).toMatchObject({ id: ID, status: "failed", reason: "gateway" });
  });
});
