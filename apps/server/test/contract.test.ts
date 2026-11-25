// API contract for the apps. The document docs/API.md lists the routes
// the apps may use; this test fails if the server and the document
// stop agreeing, or if the contract version changes by accident.
import { readFileSync } from "node:fs";
import { API_VERSION } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, createHarness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const doc = readFileSync(new URL("../../../docs/API.md", import.meta.url), "utf8");
/** Routes in the "Rutas" section of the document: `GET /api/…` at the start of a table row. */
function documented(): string[] {
  const section = doc.slice(doc.indexOf("\n## Rutas"), doc.indexOf("\n## Sesión"));
  return [...section.matchAll(/^\| `(GET|POST|PUT|PATCH|DELETE) (\/api\/[^`]*)` \|/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
}

describe("API contract", () => {
  it("the document and the server have the same routes", () => {
    const served = [...new Set(h.routes)].sort();
    const listed = documented();
    expect(listed.length).toBeGreaterThan(50);
    expect(new Set(listed).size).toBe(listed.length);
    // What the server serves that is not written down, and what is written down that is no longer served.
    expect(served.filter((r) => !listed.includes(r))).toEqual([]);
    expect(listed.filter((r) => !served.includes(r))).toEqual([]);
  });

  it("the server announces the contract version the document describes", async () => {
    const config = await h.request("GET", "/api/config", {});
    expect(config.json.apiVersion).toBe(API_VERSION);
    expect(doc).toContain(`**Versión del contrato:** ${API_VERSION} `);
  });

  it("public routes answer without a session and the rest require one", async () => {
    expect((await h.request("GET", "/api/health", {})).status).toBe(200);
    expect((await h.request("GET", "/api/config", {})).status).toBe(200);
    // All the read routes that need a session: without one, 401.
    const reads = documented().filter((r) => r.startsWith("GET ") && !["/api/health", "/api/config", "/api/auth/*", "/api/invitations/:id", "/api/v1", "/api/v1/openapi.json"].includes(r.slice(4)));
    for (const route of reads) {
      const url = route.slice(4).replace(":id", "0195b8a0-0000-7000-8000-000000000000");
      const res = await h.request("GET", url, {});
      expect(res.status, route).toBe(401);
      expect(res.json.error.code, route).toBe("unauthorized");
    }
  });

  it("all errors arrive in the same format", async () => {
    const missing = await h.request("GET", "/api/no-existe", {});
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: { code: "not_found", message: "No encontrado" } });
    const invalid = await h.request("POST", "/api/share/view", { body: { token: "corto" } });
    expect(Object.keys(invalid.json.error).sort()).toEqual(["code", "message"]);
  });
});
