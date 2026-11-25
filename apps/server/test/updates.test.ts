// Looking for a new version (ADR-0003): the latest release of the platform's
// GitHub repository against the version running, only for the platform's
// owner. GitHub is simulated: no test reaches it.
import { compareVersions } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
