// The web app served by the backend itself, as in an installation with Docker
// or Dokploy: entry page, assets with their cache and compression, the
// security headers, and the API's own answers for its addresses.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWeb } from "../src/api/web";

const app = Fastify();
const script = `console.log(${JSON.stringify("x".repeat(4000))});`;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "opengps-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>OpenGPS</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-abc123.js"), script);
  writeFileSync(join(dir, "logo.svg"), "<svg/>");
  writeFileSync(join(dirname(dir), "secreto.txt"), "no");
  app.get("/api/health", async () => ({ ok: true }));
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: "not_found" } }));
  registerWeb(app, dir);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

describe("the web app served by the backend", () => {
  it("answers any screen of the app with its entry page, always revalidated", async () => {
    for (const url of ["/", "/login", "/admin/system/accounts?x=1", "/driver"]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain("<title>OpenGPS</title>");
    }
  });

  it("serves the assets for a year, compressed for whoever accepts it", async () => {
    const plain = await app.inject({ url: "/assets/app-abc123.js" });
    expect(plain.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(plain.headers["content-type"]).toContain("text/javascript");
    expect(plain.body).toBe(script);
    const br = await app.inject({ url: "/assets/app-abc123.js", headers: { "accept-encoding": "gzip, br" } });
    expect(br.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(script);
    const gzip = await app.inject({ url: "/assets/app-abc123.js", headers: { "accept-encoding": "gzip" } });
    expect(gunzipSync(gzip.rawPayload).toString()).toBe(script);
    expect((await app.inject({ url: "/logo.svg" })).headers["content-type"]).toBe("image/svg+xml");
  });

  it("a missing asset, an address of the API or a path out of the folder are not the entry page", async () => {
    expect((await app.inject({ url: "/assets/no-existe.js" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/no-existe" })).json()).toEqual({ error: { code: "not_found" } });
    expect((await app.inject({ url: "/api/health" })).json()).toEqual({ ok: true });
    const out = await app.inject({ url: "/..%2fsecreto.txt" });
    expect(out.body).not.toBe("no");
  });

  it("every answer carries the security headers, the API's too", async () => {
    for (const url of ["/", "/api/health"]) {
      const res = await app.inject({ url });
      expect(res.headers["x-frame-options"], url).toBe("DENY");
      expect(res.headers["content-security-policy"], url).toContain("frame-ancestors 'none'");
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
    }
  });
});
