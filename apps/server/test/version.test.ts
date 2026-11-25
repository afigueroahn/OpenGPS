// The platform's version (ADR-0003): a release image reports the release it
// is, a build from the code reports the repository's marked as development,
// and the public config and the health check say which.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import rootPackage from "../../../package.json" with { type: "json" };
import { loadConfig } from "../src/config";
import { type Harness, createHarness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("platform version", () => {
  it("is the release's when the image sets APP_VERSION", () => {
    expect(loadConfig({ ...process.env, APP_VERSION: "1.2.3" }).appVersion).toBe("1.2.3");
  });

  it("is the repository's, marked as development, when built from the code", () => {
    const { APP_VERSION: _unset, ...bare } = process.env;
    expect(loadConfig(bare).appVersion).toBe(`${rootPackage.version}-dev`);
    expect(loadConfig({ ...bare, APP_VERSION: "" }).appVersion).toBe(`${rootPackage.version}-dev`);
  });

  it("the public config and the health check report it, without a session", async () => {
    const config = await h.request("GET", "/api/config");
    expect(config.status).toBe(200);
    expect(config.json.version).toBe(h.config.appVersion);
    const health = await h.request("GET", "/api/health");
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ ok: true, version: h.config.appVersion });
  });
});
