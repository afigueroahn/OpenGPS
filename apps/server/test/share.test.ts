// Links to share the location: creation, what whoever opens them sees,
// expiry, revocation, permissions and isolation.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHARE_VIEWS_PER_MINUTE } from "../src/api/server";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser;
let otherAccount: TestUser;
let truck: { id: string; uniqueId: string };

const as = (user: TestUser) => ({ cookie: user.cookie });
/** Each test queries from its own IP, so as not to use up the per-minute quota of the others. */
let lastOctet = 10;
const view = (token: unknown, ip = `203.0.113.${lastOctet++}`) =>
  h.fastify.inject({ method: "POST", url: "/api/share/view", headers: { "content-type": "application/json", origin: "http://localhost:5173", "x-real-ip": ip }, payload: JSON.stringify({ token }) });
const share = async (user: TestUser, vehicleId: string, body: Record<string, unknown> = { hours: 8 }) => h.request("POST", `/api/vehicles/${vehicleId}/shares`, { ...as(user), body });

async function join(name: string, role: string, groups: string[] | null) {
  const person = await h.signUp(name);
  const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role, groups } });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);
  expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
  return person;
}

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Comparte");
  otherAccount = await h.signUp("Otra Cuenta");
  const uniqueId = h.uniqueId();
  const created = await h.request("POST", "/api/vehicles", { ...as(ana), body: { name: "Camión de entregas", plate: "HAA-1234", uniqueId, modelId: "h02" } });
  expect(created.status).toBe(201);
  truck = { id: created.json.vehicle.id, uniqueId };
  const deviceId = h.traccar.devices.get(uniqueId) as number;
  await h.ingestFrom([traccarRow(deviceId, { fix: new Date(Date.now() - 20_000), lat: 14.0818, lon: -87.2068, knots: 40 / 1.852 })]).tick();
});
afterAll(async () => {
  await h?.close();
});

describe("links to share the location", () => {
  it("creates a link and whoever opens it sees where the vehicle is, and nothing more", async () => {
    const created = await share(ana, truck.id, { hours: 8, note: "  Para el cliente  " });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const { link, token } = created.json;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link).toMatchObject({ vehicleId: truck.id, note: "Para el cliente", createdBy: "Ana Comparte", views: 0, lastViewedAt: null });
    const hours = (Date.parse(link.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThan(8.1);

    const seen = await view(token);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.headers["cache-control"]).toBe("no-store");
    const body = seen.json().view;
    expect(body).toMatchObject({ name: "Camión de entregas", status: "moving", expiresAt: link.expiresAt });
    expect(body.position).toMatchObject({ lat: 14.0818, lon: -87.2068, speedKmh: 40 });
    // Neither the plate, nor the device identifier, nor anything of the account.
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "lastSeenAt", "name", "position", "status"]);
    expect(seen.body).not.toContain("HAA-1234");
    expect(seen.body).not.toContain(truck.uniqueId);
    expect(seen.body).not.toContain(ana.orgId);

    // The account sees how many times it was opened.
    await view(token);
    const listed = await h.request("GET", `/api/vehicles/${truck.id}/shares`, as(ana));
    expect(listed.json.links).toHaveLength(1);
    expect(listed.json.links[0]).toMatchObject({ id: link.id, views: 2 });
    expect(listed.json.links[0].lastViewedAt).toBeTruthy();
    // The list never returns the key.
    expect(JSON.stringify(listed.json)).not.toContain(token);
  });

  it("only the link's fingerprint remains in the database", async () => {
    const { token, link } = (await share(ana, truck.id)).json;
    const row = await h.db.core.query<{ token_hash: string }>(`SELECT token_hash FROM gps.share_links WHERE id = $1`, [link.id]);
    expect(row.rows[0]?.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    const dump = await h.db.core.query<{ row: string }>(`SELECT l::text AS row FROM gps.share_links l WHERE id = $1`, [link.id]);
    expect(dump.rows[0]?.row).not.toContain(token);
  });

  it("stops working on expiry and on revocation", async () => {
    const first = (await share(ana, truck.id, { hours: 1 })).json;
    expect((await view(first.token)).statusCode).toBe(200);
    await h.db.core.query(`UPDATE gps.share_links SET expires_at = now() - interval '1 second' WHERE id = $1`, [first.link.id]);
    const expired = await view(first.token);
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error.message).toBe("Este enlace ya no está disponible");

    const second = (await share(ana, truck.id)).json;
    expect((await view(second.token)).statusCode).toBe(200);
    expect((await h.request("DELETE", `/api/shares/${second.link.id}`, as(ana))).status).toBe(204);
    expect((await view(second.token)).statusCode).toBe(404);
    // Revoking twice, or something that is not a link, finds nothing.
    expect((await h.request("DELETE", `/api/shares/${second.link.id}`, as(ana))).status).toBe(404);
    expect((await h.request("DELETE", "/api/shares/no-es-un-id", as(ana))).status).toBe(404);
    const ids = (await h.request("GET", `/api/vehicles/${truck.id}/shares`, as(ana))).json.links.map((l: { id: string }) => l.id);
    expect(ids).not.toContain(first.link.id);
    expect(ids).not.toContain(second.link.id);
  });

  it("a made-up or malformed link answers the same as an expired one", async () => {
    for (const token of ["A".repeat(43), "corto", "", 42, null, "x".repeat(500)]) {
      const res = await view(token);
      expect(res.statusCode, String(token)).toBe(404);
      expect(res.json().error.message).toBe("Este enlace ya no está disponible");
    }
    const noBody = await h.fastify.inject({ method: "POST", url: "/api/share/view", headers: { "x-real-ip": "203.0.113.200" } });
    expect(noBody.statusCode).toBe(404);
  });

  it("only whoever has permission shares, and nobody from another account", async () => {
    const { link, token } = (await share(ana, truck.id)).json;
    expect((await share(otherAccount, truck.id)).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${truck.id}/shares`, as(otherAccount))).status).toBe(404);
    expect((await h.request("DELETE", `/api/shares/${link.id}`, as(otherAccount))).status).toBe(404);
    expect((await share(ana, truck.id, { hours: 0 })).status).toBe(400);
    expect((await share(ana, truck.id, { hours: 24 * 365 })).json.error.message).toContain("30 días");
    expect((await h.request("POST", `/api/vehicles/${truck.id}/shares`, { body: { hours: 1 } })).status).toBe(401);

    const reader = await join("Lector sin compartir", "viewer", null);
    expect((await share(reader, truck.id)).status).toBe(403);
    expect((await h.request("GET", `/api/vehicles/${truck.id}/shares`, as(reader))).status).toBe(403);
    expect((await h.request("DELETE", `/api/shares/${link.id}`, as(reader))).status).toBe(403);

    // An operator limited to another group does not see this vehicle: neither shares it nor revokes its links.
    const otherGroup = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: `Otro grupo ${Date.now()}` } })).json.group.id as string;
    const operator = await join("Operador de otro grupo", "operator", [otherGroup]);
    expect((await share(operator, truck.id)).status).toBe(404);
    expect((await h.request("DELETE", `/api/shares/${link.id}`, as(operator))).status).toBe(404);
    expect((await view(token)).statusCode).toBe(200);

    const audit = await h.request("GET", "/api/audit?limit=50", as(ana));
    const actions = audit.json.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["share.create", "share.revoke"]));
  });

  it("it switches off if the account is suspended, if the vehicle is deleted, and says when there is no position", async () => {
    const uniqueId = h.uniqueId();
    const created = await h.request("POST", "/api/vehicles", { ...as(ana), body: { name: "Sin reportar", uniqueId, modelId: "h02" } });
    const silent = created.json.vehicle.id as string;
    const { token } = (await share(ana, silent)).json;
    // The device has not reported yet: the link opens, but without a position.
    expect((await view(token)).json().view).toMatchObject({ name: "Sin reportar", status: "unknown", position: null });

    await h.db.core.query(`INSERT INTO gps.account_settings (org_id, suspended) VALUES ($1, true) ON CONFLICT (org_id) DO UPDATE SET suspended = true`, [ana.orgId]);
    expect((await view(token)).statusCode).toBe(404);
    await h.db.core.query(`UPDATE gps.account_settings SET suspended = false WHERE org_id = $1`, [ana.orgId]);
    expect((await view(token)).statusCode).toBe(200);

    expect((await h.request("DELETE", `/api/vehicles/${silent}`, as(ana))).status).toBe(204);
    expect((await view(token)).statusCode).toBe(404);
  });

  it("throttles whoever queries without restraint from one address", async () => {
    const { token } = (await share(ana, truck.id)).json;
    const ip = "198.51.100.77";
    const results: number[] = [];
    for (let i = 0; i < SHARE_VIEWS_PER_MINUTE + 5; i++) results.push((await view(token, ip)).statusCode);
    expect(results.slice(0, SHARE_VIEWS_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(results.slice(SHARE_VIEWS_PER_MINUTE)).toEqual([429, 429, 429, 429, 429]);
    // From another address it keeps working.
    expect((await view(token, "198.51.100.78")).statusCode).toBe(200);
  });
});
