// Looking for a new version (ADR-0003): the latest release of the platform's
// GitHub repository against the version running, only for the platform's
// owner; and installing it from the console (ADR-0004), up to the request the
// helper takes. GitHub and pg_dump are simulated: no test reaches GitHub, and
// the helper is tested with Docker in .github/scripts/update-e2e.sh.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HELPER_ALIVE, UPDATE_REQUEST, UPDATE_RESULT, UPDATE_RUNNING } from "../src/core/backups";
import { createUpdates } from "../src/core/updates";
import { type Harness, type TestUser, createHarness } from "./harness";

const release = (tag: string) => ({
  status: 200,
  etag: `"${tag}"`,
  body: { tag_name: tag, name: `OpenGPS ${tag}`, body: "### Añadido\n\n- Algo nuevo.", html_url: `https://github.com/example/opengps/releases/tag/${tag}`, published_at: "2026-11-25T12:00:00Z" },
});
const HOUR = 60 * 60_000;

describe("comparing versions", () => {
  it("orders X.Y.Z, with or without v, and puts a pre-release before its version", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("0.1.0", "0.1.0-dev")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.2")).toBe(-1);
    expect(compareVersions("x.x.x", "1.0.0")).toBeNull();
    expect(compareVersions("1.0", "1.0.0")).toBeNull();
  });
});

describe("the checker", () => {
  type Reply = { status: number; body?: unknown; etag?: string } | "down";
  function checker(appVersion: string, updateRepository = "example/opengps") {
    const github = { reply: { status: 404 } as Reply, looks: [] as Record<string, string>[], clock: 0 };
    const updates = createUpdates({
      config: { appVersion, updateRepository },
      now: () => github.clock,
      async fetch(_url, init) {
        github.looks.push(init.headers);
        const reply = github.reply;
        if (reply === "down") throw new Error("down");
        return { status: reply.status, headers: { get: (n: string) => (n === "etag" ? (reply.etag ?? null) : null) }, json: async () => reply.body };
      },
    });
    return { github, updates };
  }

  it("offers a newer release, but not the same one, an older one or a pre-release", async () => {
    const { github, updates } = checker("1.2.3");
    github.reply = release("v1.3.0");
    expect(await updates.check()).toMatchObject({ current: "1.2.3", available: true, latest: { version: "1.3.0", name: "OpenGPS v1.3.0" }, error: null });
    for (const tag of ["v1.2.3", "v1.2.0", "v1.4.0-beta.1"]) {
      github.reply = release(tag);
      expect((await updates.check()).available, tag).toBe(false);
    }
  });

  it("with no release published yet there is nothing newer and nothing wrong", async () => {
    const { updates } = checker("1.2.3");
    expect(await updates.check()).toMatchObject({ latest: null, available: false, error: null });
    expect((await updates.check()).checkedAt).not.toBeNull();
  });

  it("a failed look says why and keeps what was known, instead of passing for up to date", async () => {
    const { github, updates } = checker("1.2.3");
    github.reply = release("v1.3.0");
    await updates.check();
    github.reply = "down";
    expect(await updates.check()).toMatchObject({ available: true, latest: { version: "1.3.0" }, error: "unreachable" });
    github.reply = { status: 403 };
    expect((await updates.check()).error).toBe("rate_limited");
    github.reply = { status: 200, body: { tag_name: "latest" } };
    expect((await updates.check()).error).toBe("unexpected");
  });

  it("a recent look is reused, and the next one asks only for what changed", async () => {
    const { github, updates } = checker("1.2.3");
    github.reply = release("v1.3.0");
    await updates.check({ maxAgeMs: HOUR });
    github.clock += HOUR - 1;
    await updates.check({ maxAgeMs: HOUR });
    expect(github.looks).toHaveLength(1);
    github.clock += 2;
    github.reply = { status: 304 };
    expect(await updates.check({ maxAgeMs: HOUR })).toMatchObject({ latest: { version: "1.3.0" }, error: null });
    expect(github.looks).toHaveLength(2);
    expect(github.looks[1]?.["If-None-Match"]).toBe('"v1.3.0"');
  });

  it("simultaneous checks share one look", async () => {
    const { github, updates } = checker("1.2.3");
    await Promise.all([updates.check(), updates.check(), updates.check()]);
    expect(github.looks).toHaveLength(1);
  });

  it("with no repository it never looks", async () => {
    const { github, updates } = checker("1.2.3", "");
    expect(await updates.check()).toMatchObject({ repository: null, latest: null, available: false });
    expect(github.looks).toHaveLength(0);
  });
});

describe("the owner's routes", () => {
  let h: Harness;
  let boss: TestUser;
  let customer: TestUser;
  beforeAll(async () => {
    h = await createHarness();
    boss = await h.signUp("Dueña de la plataforma");
    customer = await h.signUp("Cliente");
    await h.makeOwner(boss);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("only the platform's owner sees them", async () => {
    for (const [method, url] of [
      ["GET", "/api/admin/updates"],
      ["POST", "/api/admin/updates/check"],
    ] as const) {
      expect((await h.request(method, url, { cookie: customer.cookie })).status, `${method} ${url}`).toBe(404);
      expect((await h.request(method, url)).status, `${method} ${url} without a session`).toBe(401);
    }
  });

  it("opening the platform looks at most once an hour; looking now, at most once a minute", async () => {
    h.github.reply = release("v99.0.0");
    h.github.clock += 2 * HOUR;
    const looks = h.github.looks.length;
    const first = await h.request("GET", "/api/admin/updates", { cookie: boss.cookie });
    expect(first.status).toBe(200);
    expect(first.json.updates).toMatchObject({ current: h.config.appVersion, available: true, latest: { version: "99.0.0" } });
    await h.request("GET", "/api/admin/updates", { cookie: boss.cookie });
    expect(h.github.looks.length).toBe(looks + 1);

    await h.request("POST", "/api/admin/updates/check", { cookie: boss.cookie });
    expect(h.github.looks.length).toBe(looks + 1);
    h.github.clock += 61_000;
    h.github.reply = "down";
    const now = await h.request("POST", "/api/admin/updates/check", { cookie: boss.cookie });
    expect(h.github.looks.length).toBe(looks + 2);
    expect(now.json.updates).toMatchObject({ error: "unreachable", latest: { version: "99.0.0" } });
  });
});

describe("installing from the console", () => {
  let h: Harness;
  let boss: TestUser;
  let customer: TestUser;
  let tmp: string;
  const previous = process.env.APP_VERSION;
  const dir = () => h.config.backup.dir;
  const helperSays = (update: "yes" | "no") => writeFileSync(join(dir(), HELPER_ALIVE), `update=${update}\n`);
  const status = async () => (await h.request("GET", "/api/admin/updates", { cookie: boss.cookie })).json.updates;
  const install = (version: unknown, user: TestUser | null = boss) =>
    h.request("POST", "/api/admin/updates/install", user ? { cookie: user.cookie, body: { version } } : { body: { version } });
  const note = (name: string) =>
    Object.fromEntries(
      readFileSync(join(dir(), name), "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );

  beforeAll(async () => {
    // A release image: the version is the release's.
    process.env.APP_VERSION = "1.0.0";
    tmp = mkdtempSync(join(tmpdir(), "opengps-update-"));
    h = await createHarness();
    boss = await h.signUp("Dueña que actualiza");
    customer = await h.signUp("Cliente");
    await h.makeOwner(boss);
    // A fake pg_dump, ahead of the real one if there is one: the backup before updating is made with it.
    mkdirSync(join(tmp, "bin"));
    writeFileSync(join(tmp, "bin", "pg_dump"), `#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) out="\${a#--file=}";; esac; done\nprintf 'copia de %s' "$PGDATABASE" > "$out"\n`);
    chmodSync(join(tmp, "bin", "pg_dump"), 0o755);
    process.env.PATH = `${join(tmp, "bin")}:${process.env.PATH}`;
    rmSync(dir(), { recursive: true, force: true });
    mkdirSync(dir(), { recursive: true });
    mkdirSync(h.config.filesDir, { recursive: true });
    h.github.reply = release("v1.1.0");
    h.github.clock += 2 * HOUR;
  }, 120_000);
  afterAll(async () => {
    if (previous === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = previous;
    rmSync(tmp, { recursive: true, force: true });
    if (h) {
      await h.backups.idle();
      await h.db.core.query(`DELETE FROM gps.backups WHERE kind = 'pre_update'`);
      rmSync(dir(), { recursive: true, force: true });
    }
    await h?.close();
  });

  it("says how this installation installs a version", async () => {
    // Without a helper, as with Dokploy and Coolify, it is installed by hand.
    expect((await status()).install).toEqual({ mode: "manual", last: null });
    // Nor with one that does not see the installation's folder.
    helperSays("no");
    expect((await status()).install.mode).toBe("manual");
    helperSays("yes");
    expect((await status()).install.mode).toBe("console");
    // A helper that stopped answering long ago does not count.
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(dir(), HELPER_ALIVE), old, old);
    expect((await status()).install.mode).toBe("manual");
  });

  it("installs only the latest version, only for the owner, and only with a helper that can", async () => {
    helperSays("yes");
    expect((await install("1.0.9")).status).toBe(400);
    expect((await install("latest")).status).toBe(400);
    expect((await install("1.1.0", customer)).status).toBe(404);
    expect((await install("1.1.0", null)).status).toBe(401);
    helperSays("no");
    expect((await install("1.1.0")).status).toBe(400);
    expect(existsSync(join(dir(), UPDATE_REQUEST))).toBe(false);
  });

  it("makes a backup first, leaves the request for the helper, and shows how it went", async () => {
    helperSays("yes");
    const asked = await install("1.1.0");
    expect(asked.status, JSON.stringify(asked.json)).toBe(202);
    expect(asked.json.updates.install.last).toMatchObject({ state: "preparing", version: "1.1.0", from: "1.0.0" });
    // While it is being prepared, another is not admitted.
    expect((await install("1.1.0")).status).toBe(409);
    await h.backups.idle();

    const request = note(UPDATE_REQUEST);
    expect(request).toMatchObject({ version: "1.1.0" });
    expect(request.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.gps).toMatch(/^gps_\d{8}_\d{6}\.dump$/);
    expect(request.traccar).toMatch(/^traccar_\d{8}_\d{6}\.dump$/);
    const safety = await h.db.core.query(`SELECT kind, status FROM gps.backups WHERE id = $1`, [request.backup]);
    expect(safety.rows[0]).toEqual({ kind: "pre_update", status: "ok" });
    const audited = await h.db.core.query(`SELECT detail FROM gps.audit_log WHERE action = 'admin.update_install' ORDER BY id DESC LIMIT 1`);
    expect(audited.rows[0]?.detail).toMatchObject({ version: "1.1.0", from: "1.0.0" });
    expect((await status()).install.last).toMatchObject({ state: "requested", version: "1.1.0" });

    // The helper takes it, and then says how it ended.
    renameSync(join(dir(), UPDATE_REQUEST), join(dir(), UPDATE_RUNNING));
    writeFileSync(join(dir(), UPDATE_RUNNING), `${readFileSync(join(dir(), UPDATE_RUNNING), "utf8")}from=1.0.0\n`);
    expect((await status()).install.last).toMatchObject({ state: "running", version: "1.1.0", from: "1.0.0" });
    expect((await install("1.1.0")).status).toBe(409);
    rmSync(join(dir(), UPDATE_RUNNING));
    writeFileSync(join(dir(), UPDATE_RESULT), `id=${request.id}\nversion=1.1.0\nfrom=1.0.0\nfinished=2026-11-25T12:00:00Z\nstatus=failed\nreason=rolled_back\n`);
    expect((await status()).install.last).toEqual({ state: "failed", version: "1.1.0", from: "1.0.0", at: "2026-11-25T12:00:00Z", reason: "rolled_back" });
  });
});
