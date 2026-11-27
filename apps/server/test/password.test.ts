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

describe("the email that says the password changed", () => {
  /** The notices that reached someone. They go out without the change waiting for them: a moment is given. */
  const notices = async (email: string, wait = 1000) => {
    const of = () => h.mails.filter((m) => m.to === email && m.url?.endsWith("/forgot-password"));
    for (let waited = 0; of().length === 0 && waited < wait; waited += 20) await new Promise((done) => setTimeout(done, 20));
    return of();
  };
  const newPassword = (user: TestUser) => change(user.cookie, { currentPassword: user.password, newPassword: "otra-clave-nueva", revokeOtherSessions: false });

  it("tells the person when it changed, in UTC, and how to choose another one", async () => {
    const fede = await h.signUp("Fede Recibe");
    expect((await newPassword(fede)).status).toBe(200);
    const [mail, ...more] = await notices(fede.email);
    expect(more).toHaveLength(0);
    expect(mail?.subject).toBe(`Tu contraseña de ${h.config.appName} cambió`);
    expect(mail?.body).toContain(`${new Date().getUTCFullYear()}`);
    expect(mail?.body).toContain("UTC");
    expect(mail?.body).toContain("«Olvidé mi contraseña»");
    expect(mail?.url).toBe(`${h.config.publicUrl}/forgot-password`);
  });

  it("a wrong current password sends nothing", async () => {
    const gabi = await h.signUp("Gabi Falla");
    expect((await change(gabi.cookie, { currentPassword: "no-es-esta", newPassword: "otra-clave-nueva" })).status).toBe(400);
    expect(await notices(gabi.email, 200)).toHaveLength(0);
  });

  it("choosing it again with the link of the email sends it too", async () => {
    const hugo = await h.signUp("Hugo Restablece");
    await h.request("POST", "/api/auth/request-password-reset", { body: { email: hugo.email, redirectTo: "/reset-password" } });
    await h.settle();
    const link = new URL(h.mails.findLast((m) => m.to === hugo.email)?.url as string);
    const token = link.pathname.split("/").at(-1) as string;
    expect((await h.request("POST", "/api/auth/reset-password", { body: { token, newPassword: "otra-clave-nueva" } })).status).toBe(200);
    expect(await notices(hugo.email)).toHaveLength(1);
  });

  it("goes in the language the person chose", async () => {
    const ines = await h.signUp("Ines Ingles");
    expect((await h.request("PUT", "/api/me/settings", { cookie: ines.cookie, body: { language: "en" } })).status).toBeLessThan(300);
    expect((await newPassword(ines)).status).toBe(200);
    const [mail] = await notices(ines.email);
    expect(mail?.subject).toBe(`Your ${h.config.appName} password changed`);
  });

  it("if the mail does not go out, the password changes anyway", async () => {
    const juan = await h.signUp("Juan Sin Correo");
    h.mailServer.down = true;
    try {
      expect((await newPassword(juan)).status).toBe(200);
    } finally {
      await new Promise((done) => setTimeout(done, 100));
      h.mailServer.down = false;
    }
    expect((await signIn(juan, "otra-clave-nueva")).status).toBe(200);
    expect(await notices(juan.email, 200)).toHaveLength(0);
  });
});
