// Changing the password from inside, with the current one: the web app's profile
// and the mobile app's (ADR-0028).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, type TestUser, createHarness } from "./harness";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const cookiesOf = (setCookie: unknown): string =>
  (Array.isArray(setCookie) ? setCookie : typeof setCookie === "string" ? [setCookie] : []).map((c: string) => c.split(";")[0]).join("; ");
const signIn = (user: TestUser, password: string) => h.request("POST", "/api/auth/sign-in/email", { body: { email: user.email, password } });
const meOf = (cookie: string) => h.request("GET", "/api/me", { cookie });
const change = (cookie: string, body: Record<string, unknown>) => h.request("POST", "/api/auth/change-password", { cookie, body });

describe("changing the password", () => {
  it("changes it with the current one, and the session it was changed from stays open", async () => {
    const ana = await h.signUp("Ana Cambia");
    const res = await change(ana.cookie, { currentPassword: ana.password, newPassword: "otra-clave-nueva", revokeOtherSessions: false });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await meOf(ana.cookie)).status).toBe(200);
    expect((await signIn(ana, ana.password)).status).toBe(401);
    expect((await signIn(ana, "otra-clave-nueva")).status).toBe(200);
  });

  it("with a wrong current one, nothing changes", async () => {
    const beto = await h.signUp("Beto se Equivoca");
    const res = await change(beto.cookie, { currentPassword: "no-es-esta", newPassword: "otra-clave-nueva", revokeOtherSessions: false });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("INVALID_PASSWORD");
    expect((await signIn(beto, beto.password)).status).toBe(200);
    expect((await signIn(beto, "otra-clave-nueva")).status).toBe(401);
  });

  it("the new one must meet the platform's policy", async () => {
    const carla = await h.signUp("Carla Débil");
    const res = await change(carla.cookie, { currentPassword: carla.password, newPassword: "corta", revokeOtherSessions: false });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: "password_policy" });
    expect((await signIn(carla, carla.password)).status).toBe(200);
  });

  it("needs a session", async () => {
    const res = await h.request("POST", "/api/auth/change-password", { body: { currentPassword: "cualquiera", newPassword: "otra-clave-nueva" } });
    expect(res.status).toBe(401);
  });

  it("closing the other sessions ends them, and the one it was changed from goes on", async () => {
    const dora = await h.signUp("Dora Cierra");
    const phone = cookiesOf((await signIn(dora, dora.password)).headers["set-cookie"]);
    expect((await meOf(phone)).status).toBe(200);
    const res = await change(dora.cookie, { currentPassword: dora.password, newPassword: "otra-clave-nueva", revokeOtherSessions: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await meOf(phone)).status).toBe(401);
    // The browser it was changed from receives its new session, in the same account.
    const here = await meOf(cookiesOf(res.headers["set-cookie"]));
    expect(here.status).toBe(200);
    expect(here.json.account.id).toBe(dora.orgId);
  });

  it("without closing them, the other sessions go on", async () => {
    const eva = await h.signUp("Eva Deja");
    const phone = cookiesOf((await signIn(eva, eva.password)).headers["set-cookie"]);
    const res = await change(eva.cookie, { currentPassword: eva.password, newPassword: "otra-clave-nueva", revokeOtherSessions: false });
    expect(res.status).toBe(200);
    expect((await meOf(phone)).status).toBe(200);
    expect((await meOf(eva.cookie)).status).toBe(200);
  });
});
