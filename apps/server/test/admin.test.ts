// Platform console: accounts, suspension, quotas, modules and user suspension.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { claimPlatformOwner, firstAccountWithoutMail } from "../src/core/access";
import { type Harness, ORIGIN, type TestUser, createHarness } from "./harness";

let h: Harness;
let boss: TestUser; // administers the platform
let customer: TestUser; // any account

beforeAll(async () => {
  h = await createHarness();
  boss = await h.signUp("Jefa de Plataforma");
  customer = await h.signUp("Cliente Común");
  await h.makeOwner(boss);
});
afterAll(async () => {
  await h?.close();
});

const as = (user: TestUser) => ({ cookie: user.cookie });
const admin = (method: string, url: string, body?: unknown) => h.request(method, url, body === undefined ? as(boss) : { ...as(boss), body });
const addVehicle = (user: TestUser, name: string) =>
  h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId: h.uniqueId(), modelId: "h02" } });

describe("console access", () => {
  it("only exists for whoever administers the platform", async () => {
    expect((await h.request("GET", "/api/me", as(boss))).json.user.platformAdmin).toBe(true);
    expect((await h.request("GET", "/api/me", as(customer))).json.user.platformAdmin).toBe(false);
    for (const [method, url] of [
      ["GET", "/api/admin/stats"],
      ["GET", "/api/admin/audit"],
      ["GET", "/api/admin/accounts"],
      ["GET", `/api/admin/accounts/${customer.orgId}`],
      ["PATCH", `/api/admin/accounts/${boss.orgId}`],
      ["POST", `/api/admin/users/${boss.userId}/ban`],
    ] as const) {
      const body = method === "GET" ? {} : { body: { suspended: true, banned: true } };
      expect((await h.request(method, url, { ...as(customer), ...body })).status, `${method} ${url}`).toBe(404);
      expect((await h.request(method, url, body)).status, `${method} ${url} sin sesión`).toBe(401);
    }
    // The customer's attempt changed nothing.
    expect((await h.request("GET", "/api/me", as(boss))).json.account.suspended).toBe(false);
  });

  it("lists accounts with their owner and their numbers, and searches by email", async () => {
    await addVehicle(customer, "Del cliente");
    const found = await admin("GET", `/api/admin/accounts?search=${encodeURIComponent(customer.email)}`);
    expect(found.json.accounts).toHaveLength(1);
    expect(found.json.accounts[0]).toMatchObject({
      id: customer.orgId,
      ownerEmail: customer.email,
      users: 1,
      vehicles: 1,
      suspended: false,
      limits: { maxVehicles: null, maxUsers: null },
      modules: [],
    });
    const detail = await admin("GET", `/api/admin/accounts/${customer.orgId}`);
    expect(detail.json.account.members).toEqual([
      { id: customer.userId, name: "Cliente Común", email: customer.email, role: "owner", banned: false, platformOwner: false, signInMethod: "email", lastAccessAt: expect.any(String) },
    ]);
    expect((await admin("GET", "/api/admin/accounts/no-existe")).status).toBe(404);

    // How the owner signs in and when they last came in.
    expect(found.json.accounts[0].ownerSignInMethod).toBe("email");
    expect(Date.now() - Date.parse(found.json.accounts[0].ownerLastAccessAt)).toBeLessThan(60_000);

    const stats = (await admin("GET", "/api/admin/stats")).json.stats;
    expect(stats.accounts).toBeGreaterThanOrEqual(2);
    expect(stats.vehicles).toBeGreaterThanOrEqual(1);
    expect(stats.users).toBeGreaterThanOrEqual(2);
  });

  it("shows the last way each person came in", async () => {
    // As if they had come in with Google days ago; then they sign in with their email again.
    await h.db.core.query(`UPDATE gps.user_settings SET sign_in_method = 'google', last_seen_at = now() - interval '3 days' WHERE user_id = $1`, [customer.userId]);
    expect((await admin("GET", `/api/admin/accounts/${customer.orgId}`)).json.account).toMatchObject({ ownerSignInMethod: "google", members: [{ signInMethod: "google" }] });
    const login = await h.request("POST", "/api/auth/sign-in/email", { body: { email: customer.email, password: customer.password } });
    expect(login.status).toBe(200);
    const account = (await admin("GET", `/api/admin/accounts/${customer.orgId}`)).json.account;
    expect(account.members[0].signInMethod).toBe("email");
    expect(Date.now() - Date.parse(account.members[0].lastAccessAt)).toBeLessThan(60_000);
    expect(account.ownerLastAccessAt).toBe(account.members[0].lastAccessAt);
  });
});

describe("platform owner", () => {
  it("is the first person who signed up and confirmed their email, and nobody else after them", async () => {
    const client = await h.db.core.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM gps.platform_owners");
      // Someone who signed up earlier but never confirmed their email does not count.
      await client.query(
        `INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('sin-confirmar', 'Sin confirmar', 'sin-confirmar@prueba.test', false, '1990-01-01', '1990-01-01')`,
      );
      await client.query(`UPDATE auth."user" SET "createdAt" = '1995-01-01' WHERE id = $1`, [customer.userId]);
      expect(await claimPlatformOwner(client)).toBe(true);
      const owners = async () => (await client.query<{ user_id: string }>(`SELECT user_id FROM gps.platform_owners`)).rows.map((r) => r.user_id);
      expect(await owners()).toEqual([customer.userId]);
      // Once there is one, whoever signed up earlier does not take their place.
      await client.query(`UPDATE auth."user" SET "createdAt" = '1994-01-01' WHERE id = $1`, [boss.userId]);
      expect(await claimPlatformOwner(client)).toBe(true);
      expect(await owners()).toEqual([customer.userId]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("a new installation without mail lets its first account in without confirming it, and nobody after", async () => {
    const client = await h.db.core.connect();
    try {
      await client.query("BEGIN");
      // With mail, never: the confirmation can be sent.
      expect(await firstAccountWithoutMail(client, "smtp.ejemplo.com")).toBe(false);
      // Without mail, while there is an owner or a confirmed account, neither.
      expect(await firstAccountWithoutMail(client, "")).toBe(false);
      await client.query("DELETE FROM gps.platform_owners");
      await client.query(`UPDATE auth."user" SET "emailVerified" = false`);
      expect(await firstAccountWithoutMail(client, "")).toBe(true);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("cannot delete their own account", async () => {
    const tried = await h.request("POST", "/api/auth/delete-user", { ...as(boss), body: { password: boss.password } });
    expect(tried.status).toBe(403);
    expect(tried.json.code).toBe("PLATFORM_OWNER");
    expect((await h.request("GET", "/api/me", as(boss))).status).toBe(200);
  });
});

describe("deleting from the console", () => {
  it("an account goes with everything in it; its people stay", async () => {
    const deletable = await h.signUp("Cuenta Borrable");
    expect((await addVehicle(deletable, "Camión que se va")).status).toBe(201);
    const url = `/api/admin/accounts/${deletable.orgId}/delete`;
    // Only the owner of the platform, and only with the word.
    expect((await h.request("POST", url, { ...as(customer), body: { word: "ELIMINAR" } })).status).toBe(404);
    expect((await admin("POST", url, { word: "borrar" })).status).toBe(400);
    expect((await admin("POST", url, { word: "eliminar" })).status).toBe(204);
    expect((await admin("GET", `/api/admin/accounts/${deletable.orgId}`)).status).toBe(404);
    expect((await h.db.core.query(`SELECT 1 FROM gps.vehicles WHERE org_id = $1`, [deletable.orgId])).rowCount).toBe(0);
    // The person is still there, without that account.
    expect((await h.db.core.query(`SELECT 1 FROM auth."user" WHERE id = $1`, [deletable.userId])).rowCount).toBe(1);
    expect((await h.request("GET", "/api/me", as(deletable))).status).toBe(401);
    // The platform's log says it.
    const log = (await admin("GET", "/api/admin/audit")).json.entries as { action: string; detail: { name?: string } }[];
    expect(log.find((e) => e.action === "admin.account_delete")?.detail.name).toBe("Cuenta Borrable");
    // The owner's own account is not deleted, nor one that does not exist.
    const own = await admin("POST", `/api/admin/accounts/${boss.orgId}/delete`, { word: "ELIMINAR" });
    expect(own.status).toBe(403);
    expect(own.json.error.message).toBe("Es la cuenta del dueño de la plataforma: no se puede eliminar");
    expect((await admin("GET", `/api/admin/accounts/${boss.orgId}`)).json.account.ownedByPlatformOwner).toBe(true);
    expect((await admin("POST", "/api/admin/accounts/no-existe/delete", { word: "ELIMINAR" })).status).toBe(404);
  });

  it("a person goes with the accounts they own; from the others they only leave", async () => {
    const person = await h.signUp("Persona Borrable");
    const invited = await h.request("POST", "/api/members/invitations", { ...as(customer), body: { email: person.email, role: "viewer" } });
    expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
    const url = `/api/admin/users/${person.userId}/delete`;
    expect((await admin("POST", url, {})).status).toBe(400);
    expect((await admin("POST", url, { word: "DELETE" })).status).toBe(204);
    expect((await h.db.core.query(`SELECT 1 FROM auth."user" WHERE id = $1`, [person.userId])).rowCount).toBe(0);
    expect((await h.db.core.query(`SELECT 1 FROM auth.organization WHERE id = $1`, [person.orgId])).rowCount).toBe(0);
    // The account they were invited to is still there, without them.
    const other = (await admin("GET", `/api/admin/accounts/${customer.orgId}`)).json.account;
    expect(other.members.map((m: { id: string }) => m.id)).not.toContain(person.userId);
    // The owner of the platform is not deleted.
    const owner = await admin("POST", `/api/admin/users/${boss.userId}/delete`, { word: "ELIMINAR" });
    expect(owner.status).toBe(403);
    expect((await admin("GET", `/api/admin/accounts/${boss.orgId}`)).json.account.members[0]).toMatchObject({ id: boss.userId, platformOwner: true });
    expect((await admin("POST", "/api/admin/users/no-existe/delete", { word: "ELIMINAR" })).status).toBe(404);
  });
});

describe("account suspension", () => {
  it("a suspended account can no longer be used until it is reactivated", async () => {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/live`, { headers: { cookie: customer.cookie, origin: ORIGIN } });
      ws.on("message", () => resolve(ws));
      ws.on("error", reject);
    });
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));

    const suspended = await admin("PATCH", `/api/admin/accounts/${customer.orgId}`, { suspended: true, suspendedReason: "Uso indebido" });
    expect(suspended.json.account).toMatchObject({ suspended: true, suspendedReason: "Uso indebido" });
    expect(await closed).toBe(4001); // its live connection is cut

    // It can see that it is suspended, and nothing else.
    const me = await h.request("GET", "/api/me", as(customer));
    expect(me.status).toBe(200);
    expect(me.json.account.suspended).toBe(true);
    for (const [method, url] of [
      ["GET", "/api/vehicles"],
      ["POST", "/api/vehicles"],
      ["GET", "/api/groups"],
      ["GET", "/api/members"],
      ["GET", "/api/audit"],
    ] as const) {
      const res = await h.request(method, url, method === "POST" ? { ...as(customer), body: { name: "X", uniqueId: h.uniqueId(), modelId: "h02" } } : as(customer));
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.json.error.code).toBe("account_suspended");
    }
    const live = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/live`, { headers: { cookie: customer.cookie, origin: ORIGIN } });
      ws.on("open", () => resolve("abierto"));
      ws.on("unexpected-response", (_req, res) => resolve(`rechazado ${res.statusCode}`));
      ws.on("error", () => resolve("error"));
    });
    expect(live).toBe("rechazado 403");

    const restored = await admin("PATCH", `/api/admin/accounts/${customer.orgId}`, { suspended: false });
    expect(restored.json.account).toMatchObject({ suspended: false, suspendedReason: null });
    expect((await h.request("GET", "/api/vehicles", as(customer))).status).toBe(200);

    // It is recorded in the account's activity, in the platform's name.
    const audit = (await h.request("GET", "/api/audit", as(customer))).json.entries;
    expect(audit.slice(0, 2).map((e: { action: string; userName: string | null }) => [e.action, e.userName])).toEqual([
      ["admin.account_unsuspend", null],
      ["admin.account_suspend", null],
    ]);
  });
});

describe("quotas and modules", () => {
  it("without a quota there is no limit; with a quota it is enforced", async () => {
    const anotherAccount = await h.signUp("Cuenta con Cuota");
    expect((await addVehicle(anotherAccount, "Uno")).status).toBe(201);
    expect((await addVehicle(anotherAccount, "Dos")).status).toBe(201);

    const limited = await admin("PATCH", `/api/admin/accounts/${anotherAccount.orgId}`, { maxVehicles: 2, maxUsers: 1 });
    expect(limited.json.account.limits).toEqual({ maxVehicles: 2, maxUsers: 1 });
    const blocked = await addVehicle(anotherAccount, "Tres");
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.message).toContain("límite de 2 vehículos");
    const invite = await h.request("POST", "/api/members/invitations", { ...as(anotherAccount), body: { email: "alguien@prueba.test", role: "viewer" } });
    expect(invite.status).toBe(429);
    // The quota does not affect what already exists.
    expect((await h.request("GET", "/api/vehicles", as(anotherAccount))).json.vehicles).toHaveLength(2);

    await admin("PATCH", `/api/admin/accounts/${anotherAccount.orgId}`, { maxVehicles: 3, maxUsers: 2 });
    expect((await addVehicle(anotherAccount, "Tres")).status).toBe(201);
    expect((await h.request("POST", "/api/members/invitations", { ...as(anotherAccount), body: { email: "alguien@prueba.test", role: "viewer" } })).status).toBe(201);
    // The pending invitation counts: with it the account already has its 2 users.
    expect((await h.request("POST", "/api/members/invitations", { ...as(anotherAccount), body: { email: "otra@prueba.test", role: "viewer" } })).status).toBe(429);

    const free = await admin("PATCH", `/api/admin/accounts/${anotherAccount.orgId}`, { maxVehicles: null, maxUsers: null });
    expect(free.json.account.limits).toEqual({ maxVehicles: null, maxUsers: null });
    expect((await addVehicle(anotherAccount, "Cuatro")).status).toBe(201);
    expect((await admin("PATCH", `/api/admin/accounts/${anotherAccount.orgId}`, { maxVehicles: -1 })).status).toBe(400);
  });

  it("enables modules per account", async () => {
    expect((await h.request("GET", "/api/me", as(customer))).json.account.modules).toEqual([]);
    const set = await admin("PATCH", `/api/admin/accounts/${customer.orgId}`, { modules: ["G", "A"] });
    expect(set.json.account.modules).toEqual(["A", "G"]);
    expect((await h.request("GET", "/api/me", as(customer))).json.account.modules).toEqual(["A", "G"]);
    expect((await h.request("GET", "/api/me", as(boss))).json.account.modules).toEqual([]);
    expect((await admin("PATCH", `/api/admin/accounts/${customer.orgId}`, { modules: ["Z"] })).status).toBe(400);
    await admin("PATCH", `/api/admin/accounts/${customer.orgId}`, { modules: [] });
  });
});

describe("user suspension", () => {
  it("a suspended user loses their session and cannot sign in again", async () => {
    const bad = await h.signUp("Usuario Abusivo");
    expect((await admin("POST", `/api/admin/users/${bad.userId}/ban`, { banned: true, reason: "Abuso" })).status).toBe(204);
    expect((await h.request("GET", "/api/me", as(bad))).status).toBe(401);
    const login = await h.request("POST", "/api/auth/sign-in/email", { body: { email: bad.email, password: bad.password } });
    expect(login.status).toBeGreaterThanOrEqual(400);
    expect((await admin("GET", `/api/admin/accounts/${bad.orgId}`)).json.account.members[0].banned).toBe(true);

    expect((await admin("POST", `/api/admin/users/${bad.userId}/ban`, { banned: false })).status).toBe(204);
    const again = await h.request("POST", "/api/auth/sign-in/email", { body: { email: bad.email, password: bad.password } });
    expect(again.status).toBe(200);

    // Nobody suspends themselves, or someone who does not exist.
    expect((await admin("POST", `/api/admin/users/${boss.userId}/ban`, { banned: true })).status).toBe(403);
    expect((await admin("POST", "/api/admin/users/no-existe/ban", { banned: true })).status).toBe(404);
  });
});

describe("administration panel", () => {
  it("each account sees its own numbers, and the platform log lists what its administration did", async () => {
    expect((await h.request("GET", "/api/account/summary", {})).status).toBe(401);
    const before = (await h.request("GET", "/api/account/summary", as(customer))).json.summary;
    expect(before).toMatchObject({ users: 1, reportingNow: 0 });
    const others = (await h.request("GET", "/api/account/summary", as(boss))).json.summary.vehicles;
    expect((await addVehicle(customer, "Camión del resumen")).status).toBe(201);
    const after = (await h.request("GET", "/api/account/summary", as(customer))).json.summary;
    expect(after.vehicles).toBe(before.vehicles + 1);
    // Another account's vehicles are not counted.
    expect((await h.request("GET", "/api/account/summary", as(boss))).json.summary.vehicles).toBe(others);

    // Changing an account from the console is recorded, with who did it.
    expect((await admin("PATCH", `/api/admin/accounts/${customer.orgId}`, { maxVehicles: 50 })).status).toBe(200);
    const log = (await admin("GET", "/api/admin/audit")).json.entries as { action: string; userName: string | null }[];
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]?.action.startsWith("admin.")).toBe(true);
    expect(log[0]?.userName).toBe("Jefa de Plataforma");
    expect(log.every((e) => e.action.startsWith("admin.") || e.userName === null)).toBe(true);
  });
});
