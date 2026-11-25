// Privacy: acceptance of the terms, account deletion and leaving an account.
import { LEGAL_VERSION } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const as = (user: TestUser) => ({ cookie: user.cookie });
const count = async (sql: string, params: unknown[]) => (await h.db.core.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]?.n;

describe("acceptance of terms and policy", () => {
  it("nobody registers without accepting them", async () => {
    const email = `t-sinaceptar-${Date.now()}@prueba.test`;
    const body = { name: "Sin aceptar", email, password: "clave-de-prueba-9" };
    const refused = await h.request("POST", "/api/auth/sign-up/email", { body });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe("LEGAL_NOT_ACCEPTED");
    const old = await h.request("POST", "/api/auth/sign-up/email", { body: { ...body, legalVersion: "2020-01-01" } });
    expect(old.status).toBe(400);
    expect(await count(`auth."user" WHERE email = $1`, [email])).toBe(0);
  });

  it("on registration, a record of the accepted version is kept", async () => {
    const user = await h.signUp("Acepta Todo");
    expect((await h.request("GET", "/api/me", as(user))).json.needsConsent).toBe(false);
    const rows = await h.db.core.query<{ version: string }>(`SELECT version FROM gps.consents WHERE user_id = $1`, [user.userId]);
    expect(rows.rows).toEqual([{ version: LEGAL_VERSION }]);
  });

  it("whoever lacks the current version is asked for it, and can accept it", async () => {
    const user = await h.signUp("Cuenta Antigua");
    await h.db.core.query(`DELETE FROM gps.consents WHERE user_id = $1`, [user.userId]); // like an account from before the terms
    expect((await h.request("GET", "/api/me", as(user))).json.needsConsent).toBe(true);
    expect((await h.request("POST", "/api/consent", { ...as(user), body: { version: "2020-01-01" } })).status).toBe(400);
    expect((await h.request("POST", "/api/consent", { ...as(user), body: { version: LEGAL_VERSION } })).status).toBe(204);
    expect((await h.request("POST", "/api/consent", { ...as(user), body: { version: LEGAL_VERSION } })).status).toBe(204); // repeating does not fail
    expect((await h.request("GET", "/api/me", as(user))).json.needsConsent).toBe(false);
    expect((await h.request("POST", "/api/consent", { body: { version: LEGAL_VERSION } })).status).toBe(401);
  });

  it("the web app receives the legal data and the current version", async () => {
    const config = (await h.request("GET", "/api/config", {})).json;
    expect(config.legal).toMatchObject({ version: LEGAL_VERSION, entity: "Operador de Prueba" });
  });
});

describe("deleting the account", () => {
  it("asks for the password and deletes everything that belonged to that person", async () => {
    const leavingOwner = await h.signUp("Dueño que se va");
    const guest = await h.signUp("Invitado que se queda");

    // The account has a vehicle with history, a group and an invited user.
    const uniqueId = h.uniqueId();
    const created = await h.request("POST", "/api/vehicles", { ...as(leavingOwner), body: { name: "Se borrará", uniqueId, modelId: "h02" } });
    const vehicleId = created.json.vehicle.id as string;
    await h.ingestFrom([traccarRow(h.traccar.devices.get(uniqueId) as number, { fix: new Date(Date.now() - 60_000) })]).tick();
    await h.request("POST", "/api/groups", { ...as(leavingOwner), body: { name: "Grupo que se borrará" } });
    const invited = await h.request("POST", "/api/members/invitations", { ...as(leavingOwner), body: { email: guest.email, role: "viewer" } });
    await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(guest));
    const deviceId = (await h.db.core.query<{ id: number }>(`SELECT id FROM gps.devices WHERE unique_id = $1`, [uniqueId])).rows[0]?.id;
    expect(await count(`gps.positions WHERE device_id = $1`, [deviceId])).toBe(1);
    expect(await count(`gps.audit_log WHERE org_id = $1`, [leavingOwner.orgId])).toBeGreaterThan(0);

    // With the wrong password nothing happens.
    const wrong = await h.request("POST", "/api/auth/delete-user", { ...as(leavingOwner), body: { password: "no-es-la-clave" } });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect((await h.request("GET", `/api/vehicles/${vehicleId}`, as(leavingOwner))).status).toBe(200);

    const deleted = await h.request("POST", "/api/auth/delete-user", { ...as(leavingOwner), body: { password: leavingOwner.password } });
    expect(deleted.status).toBe(200);

    // Nothing of the account is left.
    expect(await count(`auth."user" WHERE id = $1`, [leavingOwner.userId])).toBe(0);
    expect(await count(`auth.organization WHERE id = $1`, [leavingOwner.orgId])).toBe(0);
    expect(await count(`gps.vehicles WHERE org_id = $1`, [leavingOwner.orgId])).toBe(0);
    expect(await count(`gps.devices WHERE org_id = $1`, [leavingOwner.orgId])).toBe(0);
    expect(await count(`gps.positions WHERE device_id = $1`, [deviceId])).toBe(0);
    expect(await count(`gps.vehicle_groups WHERE org_id = $1`, [leavingOwner.orgId])).toBe(0);
    expect(await count(`gps.audit_log WHERE org_id = $1`, [leavingOwner.orgId])).toBe(0);
    expect(await count(`gps.consents WHERE user_id = $1`, [leavingOwner.userId])).toBe(0);
    expect(await count(`auth.session WHERE "userId" = $1`, [leavingOwner.userId])).toBe(0);
    expect(h.traccar.devices.has(uniqueId)).toBe(false); // the device is no longer authorised on the gateway

    // Their session no longer works and they cannot sign in again.
    expect((await h.request("GET", "/api/me", as(leavingOwner))).status).toBe(401);
    expect((await h.request("POST", "/api/auth/sign-in/email", { body: { email: leavingOwner.email, password: leavingOwner.password } })).status).toBeGreaterThanOrEqual(400);

    // The invited user keeps their own account and only loses access to the one that was deleted.
    const me = (await h.request("GET", "/api/me", as(guest))).json;
    expect(me.accounts.map((a: { id: string }) => a.id)).toEqual([guest.orgId]);
    expect(me.account.id).toBe(guest.orgId);

    // Released, the same GPS can be registered in another account.
    const again = await h.request("POST", "/api/vehicles", { ...as(guest), body: { name: "Ahora mío", uniqueId, modelId: "h02" } });
    expect(again.status).toBe(201);
  });

  it("without a session nothing is deleted", async () => {
    expect((await h.request("POST", "/api/auth/delete-user", { body: { password: "x" } })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("leaving an account", () => {
  it("an invited user can leave; the owner cannot", async () => {
    const leavingOwner = await h.signUp("Dueña Anfitriona");
    const guest = await h.signUp("Invitado Fugaz");
    const invited = await h.request("POST", "/api/members/invitations", { ...as(leavingOwner), body: { email: guest.email, role: "operator" } });
    await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(guest));
    expect((await h.request("GET", "/api/me", as(guest))).json.account.id).toBe(leavingOwner.orgId);

    expect((await h.request("POST", "/api/accounts/leave", { ...as(leavingOwner), body: {} })).status).toBe(403);
    expect((await h.request("POST", "/api/accounts/leave", { ...as(guest), body: {} })).status).toBe(204);
    const me = (await h.request("GET", "/api/me", as(guest))).json;
    expect(me.account.id).toBe(guest.orgId);
    expect(me.accounts).toHaveLength(1);
    const members = (await h.request("GET", "/api/members", as(leavingOwner))).json.members;
    expect(members.map((m: { userId: string }) => m.userId)).toEqual([leavingOwner.userId]);
  });
});
