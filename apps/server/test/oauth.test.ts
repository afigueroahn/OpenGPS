// Signing in and up with another service. The owner connects each one in the
// console; a simulated OpenID Connect service plays "another one" from end
// to end, and Google and Apple are checked up to the trip to their pages.
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { APP_OAUTH_PAGE, APP_OAUTH_RETURN, APP_OAUTH_START, APP_SCHEME, LEGAL_VERSION } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forgetSessionCookies } from "../src/auth";
import { appleClientSecret } from "../src/core/oauth";
import { type Harness, type TestUser, createHarness } from "./harness";

let h: Harness;
let boss: TestUser; // administers the platform
let base = "";
let service: http.Server;
/** What the simulated service says about whoever signs in, by the code it hands out. */
const people = new Map<string, { sub: string; email: string; email_verified: boolean; name: string }>();
/** The people created by signing up through the service, to clean them up. */
const created: string[] = [];

const as = (user: TestUser) => ({ cookie: user.cookie });
const admin = (method: string, url: string, body?: unknown) => h.request(method, url, body === undefined ? as(boss) : { ...as(boss), body });
const cookiesOf = (setCookie: unknown): string =>
  (Array.isArray(setCookie) ? setCookie : typeof setCookie === "string" ? [setCookie] : []).map((c: string) => c.split(";")[0]).join("; ");
const rand = () => randomBytes(4).toString("hex");

beforeAll(async () => {
  h = await createHarness();
  boss = await h.signUp("Jefa de Plataforma");
  await h.makeOwner(boss);
  service = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const json = (code: number, answer: unknown) => {
        response.statusCode = code;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(answer));
      };
      const path = new URL(request.url ?? "/", base).pathname;
      if (path === "/.well-known/openid-configuration") {
        return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo` });
      }
      if (path === "/token") return json(200, { access_token: `acceso-${new URLSearchParams(body).get("code")}`, token_type: "Bearer", expires_in: 3600 });
      if (path === "/userinfo") {
        const person = people.get((request.headers.authorization ?? "").replace("Bearer acceso-", ""));
        return person ? json(200, person) : json(401, { error: "invalid_token" });
      }
      json(404, {});
    });
  });
  await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (h && created.length > 0) {
    await h.db.core.query(`DELETE FROM auth.organization WHERE id IN (SELECT "organizationId" FROM auth.member WHERE "userId" = ANY($1::text[]))`, [created]);
    await h.db.core.query(`DELETE FROM auth."user" WHERE id = ANY($1::text[])`, [created]);
  }
  await new Promise((done) => service?.close(done));
  await h?.close();
});

const oauthOf = async () => (await admin("GET", "/api/admin/settings")).json.settings.oauth as Record<string, any>;
const saveOAuth = async (patch: Record<string, unknown>) => {
  const { google, github, facebook, apple, custom } = await oauthOf();
  const plain = ({ hasSecret: _s, ...rest }: Record<string, unknown>) => rest;
  return admin("PUT", "/api/admin/settings/oauth", { google: plain(google), github: plain(github), facebook: plain(facebook), apple: plain(apple), custom: plain(custom), ...patch });
};
const CUSTOM = () => ({ enabled: true, name: "Entrada de la empresa", issuer: base, clientId: "opengps", secret: "secreto-del-oidc", scopes: "openid email profile" });

/** Goes to the service from a sign-in screen and comes back as the person, the way a browser follows it. */
async function through(person: { email: string; name: string; verified?: boolean }, body: Record<string, unknown> = {}) {
  const start = await h.request("POST", "/api/auth/sign-in/social", { body: { provider: "custom", callbackURL: "/", errorCallbackURL: "/login?via=oauth", disableRedirect: true, ...body } });
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  const there = new URL(start.json.url as string);
  expect(there.origin + there.pathname).toBe(`${base}/authorize`);
  const code = rand();
  people.set(code, { sub: `sub-${person.email}`, email: person.email, email_verified: person.verified ?? true, name: person.name });
  const redirect = new URL(there.searchParams.get("redirect_uri") as string);
  const back = await h.request("GET", `${redirect.pathname}?code=${code}&state=${there.searchParams.get("state")}`, { cookie: cookiesOf(start.headers["set-cookie"]) });
  expect(back.status).toBe(302);
  return { location: String(back.headers.location), cookie: cookiesOf(back.headers["set-cookie"]) };
}
/**
 * The app's trip, as the system's browser follows it: from the platform to the service and back. Where the way back
 * leads (the page to confirm on, or the app's address) and the browser's cookie.
 */
async function throughApp(person: { email: string; name: string; verified?: boolean }, query: string): Promise<{ location: string; cookie: string }> {
  const start = await h.request("GET", `${APP_OAUTH_START}?${query}`);
  expect(start.status).toBe(302);
  const there = new URL(String(start.headers.location));
  expect(there.origin + there.pathname).toBe(`${base}/authorize`);
  const code = rand();
  people.set(code, { sub: `sub-${person.email}`, email: person.email, email_verified: person.verified ?? true, name: person.name });
  const redirect = new URL(there.searchParams.get("redirect_uri") as string);
  // The browser brings back the cookie the platform gave it when the trip started.
  const back = await h.request("GET", `${redirect.pathname}?code=${code}&state=${there.searchParams.get("state")}`, { cookie: cookiesOf(start.headers["set-cookie"]) });
  expect(back.status).toBe(302);
  const location = String(back.headers.location);
  expect(location.startsWith(APP_OAUTH_RETURN)).toBe(true);
  const cookie = cookiesOf(back.headers["set-cookie"]);
  const last = await h.request("GET", location, { cookie });
  expect(last.status).toBe(302);
  return { location: String(last.headers.location), cookie };
}
/** The person confirms on the platform's page the account they go back to the app with: the pass the app gets. */
async function confirmForApp(cookie: string): Promise<string> {
  const confirmed = await h.request("POST", APP_OAUTH_RETURN, { cookie, body: {} });
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  const url = new URL(confirmed.json.url as string);
  expect(`${url.protocol}//${url.host}`).toBe(`${APP_SCHEME}://oauth`);
  // The browser forgets the session, which is now the app's (ADR-0025).
  const forgotten = [confirmed.headers["set-cookie"]].flat().filter((c) => typeof c === "string" && /;\s*Max-Age=0/i.test(c));
  expect(forgotten.map((c) => (c as string).split("=")[0])).toContain("gps.session_token");
  return url.searchParams.get("token") as string;
}
/** How many passes the platform has handed out and not used yet. */
const passes = async () => Number((await h.db.core.query(`SELECT count(*) AS n FROM auth.verification WHERE identifier LIKE 'one-time-token:%'`)).rows[0].n);
const signUpThrough = (person: { email: string; name: string; verified?: boolean }) => through(person, { requestSignUp: true, newUserCallbackURL: "/", additionalData: { legalVersion: LEGAL_VERSION } });
async function meOf(cookie: string) {
  const me = await h.request("GET", "/api/me", { cookie });
  if (me.status === 200 && !created.includes(me.json.user.id)) created.push(me.json.user.id);
  return me;
}

describe("services to sign in with", () => {
  it("only the owner connects them; secrets go in and never come back", async () => {
    expect((await h.request("GET", "/api/config")).json.signIn).toEqual([]);
    expect((await h.request("PUT", "/api/admin/settings/oauth", { cookie: (await h.signUp("Alguien")).cookie, body: {} })).status).toBe(404);
    // Turning one on needs everything it asks for.
    const incomplete = await saveOAuth({ google: { enabled: true, clientId: "id-de-google" } });
    expect(incomplete.status).toBe(400);
    expect(incomplete.json.error.message).toBe("Para encender Google escribe todos sus datos y su secreto");
    expect((await saveOAuth({ custom: { ...CUSTOM(), issuer: "no-es-direccion" } })).status).toBe(400);
    expect((await saveOAuth({ apple: { enabled: true, clientId: "com.empresa.web", teamId: "EQUIPO1234", keyId: "LLAVE12345", secret: "no es una llave" } })).json.error.message).toBe(
      "Esa no es la clave de Apple: pega el contenido completo del archivo .p8",
    );

    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const saved = await saveOAuth({
      google: { enabled: true, clientId: "id-de-google", secret: "secreto-de-google" },
      apple: { enabled: true, clientId: "com.empresa.web", teamId: "EQUIPO1234", keyId: "LLAVE12345", secret: privateKey.export({ type: "pkcs8", format: "pem" }) },
      custom: CUSTOM(),
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.settings.oauth.google).toEqual({ enabled: true, clientId: "id-de-google", hasSecret: true });
    expect(saved.json.settings.oauth.custom).toEqual({ ...CUSTOM(), secret: undefined, hasSecret: true });
    expect(JSON.stringify(saved.json)).not.toMatch(/secreto-|PRIVATE KEY/);
    const stored = await h.db.core.query<{ value: unknown }>(`SELECT value FROM gps.platform_settings WHERE section = 'oauth'`);
    expect(JSON.stringify(stored.rows[0]?.value)).not.toMatch(/secreto-|PRIVATE KEY/);
    // Saving again without the secrets keeps them.
    expect((await saveOAuth({})).json.settings.oauth.google.hasSecret).toBe(true);

    // The sign-in screens show their buttons, in order.
    expect((await h.request("GET", "/api/config")).json.signIn).toEqual([
      { id: "google", name: "Google" },
      { id: "apple", name: "Apple" },
      { id: "custom", name: "Entrada de la empresa" },
    ]);
    // Google: to its page, with the key the owner gave and the way back to the platform.
    const google = await h.request("POST", "/api/auth/sign-in/social", { body: { provider: "google", callbackURL: "/", disableRedirect: true } });
    const page = new URL(google.json.url as string);
    expect(page.host).toBe("accounts.google.com");
    expect(page.searchParams.get("client_id")).toBe("id-de-google");
    expect(page.searchParams.get("redirect_uri")).toBe(`${h.config.publicUrl}/api/auth/callback/google`);
    // Apple: its secret is a token the team signs with its key.
    const apple = await h.request("POST", "/api/auth/sign-in/social", { body: { provider: "apple", callbackURL: "/", disableRedirect: true } });
    expect(new URL(apple.json.url as string).host).toBe("appleid.apple.com");
    const secret = appleClientSecret({ ...h.config.oauth.apple });
    const [head, body, signature] = secret.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "ES256", kid: "LLAVE12345" });
    expect(JSON.parse(Buffer.from(body, "base64url").toString())).toMatchObject({ iss: "EQUIPO1234", sub: "com.empresa.web", aud: "https://appleid.apple.com" });
    expect(verify("sha256", Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
    // A service that is off has no button and nobody signs in with it.
    await saveOAuth({ apple: { ...(await oauthOf()).apple, hasSecret: undefined, enabled: false } });
    expect((await h.request("GET", "/api/config")).json.signIn.map((b: { id: string }) => b.id)).toEqual(["google", "custom"]);
    expect((await h.request("POST", "/api/auth/sign-in/social", { body: { provider: "apple", callbackURL: "/", disableRedirect: true } })).status).toBe(404);
  });

  it("signing up through one needs the terms; signing in, an account that already exists", async () => {
    const email = `oidc-${rand()}@prueba.test`;
    // Without asking to sign up (the web always does, with the terms next to its buttons), nobody new comes in.
    const nobody = await through({ email, name: "Nadie Aún" });
    expect(nobody.location).toContain("/login?via=oauth");
    expect(nobody.location).toContain("error=signup_disabled");
    expect((await h.db.core.query(`SELECT 1 FROM auth."user" WHERE email = $1`, [email])).rowCount).toBe(0);
    // From the sign-up screen, without the terms accepted, neither.
    const noTerms = await through({ email, name: "Nadie Aún" }, { requestSignUp: true });
    expect(noTerms.location).toContain("error=LEGAL_NOT_ACCEPTED");

    // With the terms accepted: the account is born, with the name the service gave, and the acceptance is recorded.
    const made = await signUpThrough({ email, name: "Olga de la Empresa" });
    expect(made.location).toBe("/");
    const me = await meOf(made.cookie);
    expect(me.status, JSON.stringify(me.json)).toBe(200);
    expect(me.json.user).toMatchObject({ name: "Olga de la Empresa", email, platformAdmin: false });
    expect(me.json.needsConsent).toBe(false);
    expect(me.json.account.role).toBe("owner");
    // Afterwards they come in, whether asking to sign up again or not.
    const again = await through({ email, name: "Olga de la Empresa" });
    expect(again.location).toBe("/");
    expect((await h.request("GET", "/api/me", { cookie: again.cookie })).json.user.id).toBe(me.json.user.id);
    expect((await h.request("GET", "/api/me", { cookie: (await signUpThrough({ email, name: "Olga" })).cookie })).json.user.id).toBe(me.json.user.id);
  });

  it("whoever only signs in with a service has no password, and deletes their account without one", async () => {
    const made = await signUpThrough({ email: `oidc-${rand()}@prueba.test`, name: "Sin Contraseña" });
    const me = await meOf(made.cookie);
    expect(me.json.user.hasPassword).toBe(false);
    expect((await h.request("GET", "/api/me", as(boss))).json.user.hasPassword).toBe(true);
    const gone = await h.request("POST", "/api/auth/delete-user", { cookie: made.cookie, body: {} });
    expect(gone.status, JSON.stringify(gone.json)).toBe(200);
    expect((await h.db.core.query(`SELECT 1 FROM auth."user" WHERE id = $1`, [me.json.user.id])).rowCount).toBe(0);
  });

  it("someone who already has an account comes in with the same email once the service confirmed it", async () => {
    const ana = await h.signUp("Ana con Contraseña");
    const unconfirmed = await through({ email: ana.email, name: "Ana", verified: false });
    expect(unconfirmed.location).toContain("error=account_not_linked");
    const joined = await through({ email: ana.email, name: "Ana" });
    expect(joined.location).toBe("/");
    expect((await h.request("GET", "/api/me", { cookie: joined.cookie })).json.user.id).toBe(ana.userId);
    const accounts = await h.db.core.query<{ providerId: string }>(`SELECT "providerId" FROM auth.account WHERE "userId" = $1 ORDER BY "providerId"`, [ana.userId]);
    expect(accounts.rows.map((r) => r.providerId)).toEqual(["credential", "custom"]);
  });

  it("the mobile app gets the new session with a pass that works once, after the person confirms (ADR-0013, ADR-0014)", async () => {
    const email = `oidc-${rand()}@prueba.test`;
    const before = await passes();
    // Signing up from the app, with the terms it showed: the system's browser starts the trip at the platform and
    // comes back to the page where the person confirms. Until then there is no pass.
    const trip = await throughApp({ email, name: "Desde la App" }, `provider=custom&legalVersion=${LEGAL_VERSION}`);
    expect(trip.location).toBe(APP_OAUTH_PAGE);
    expect(await passes()).toBe(before);
    const token = await confirmForApp(trip.cookie);
    expect(token.length).toBeGreaterThan(20);
    expect(await passes()).toBe(before + 1);

    // The app exchanges the pass for its own cookie, without the browser's: it is the same person.
    const exchanged = await h.request("POST", "/api/auth/one-time-token/verify", { body: { token } });
    expect(exchanged.status, JSON.stringify(exchanged.json)).toBe(200);
    const me = await meOf(cookiesOf(exchanged.headers["set-cookie"]));
    expect(me.status).toBe(200);
    expect(me.json.user).toMatchObject({ email, name: "Desde la App" });
    expect(me.json.needsConsent).toBe(false);
    // A pass works only once.
    expect((await h.request("POST", "/api/auth/one-time-token/verify", { body: { token } })).status).toBe(400);
    // Afterwards, signing in from the app without the terms finds the same person.
    const again = await throughApp({ email, name: "Desde la App" }, "provider=custom");
    const second = await h.request("POST", "/api/auth/one-time-token/verify", { body: { token: await confirmForApp(again.cookie) } });
    expect((await meOf(cookiesOf(second.headers["set-cookie"]))).json.user.id).toBe(me.json.user.id);
  });

  it("the browser forgets only the platform's cookies, on https too (ADR-0025)", () => {
    expect(forgetSessionCookies("gps.session_token=a.b; theme=dark; gps.dont_remember=x")).toEqual([
      "gps.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
      "gps.dont_remember=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    ]);
    expect(forgetSessionCookies("__Secure-gps.session_token=a.b; __Secure-gps.session_token=a.b")).toEqual([
      "__Secure-gps.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
    ]);
    expect(forgetSessionCookies("gpsx=1; other.gps.session_token=2")).toEqual([]);
    expect(forgetSessionCookies(undefined)).toEqual([]);
  });

  it("the app hears why the service did not let the person in, and nobody else gets a pass", async () => {
    // Someone without an account, signing in without the terms: the reason reaches the app, without the page.
    expect((await throughApp({ email: `oidc-${rand()}@prueba.test`, name: "Nadie" }, "provider=custom")).location).toBe(`${APP_SCHEME}://oauth?error=signup_disabled`);
    // A service the platform does not have.
    expect(String((await h.request("GET", `${APP_OAUTH_START}?provider=github`)).headers.location)).toBe(`${APP_SCHEME}://oauth?error=unknown_provider`);
    // Without a session there is no pass.
    expect(String((await h.request("GET", APP_OAUTH_RETURN)).headers.location)).toBe(`${APP_SCHEME}://oauth?error=no_session`);
    // Nor for a session that was already open: a page that opens the way back in a browser where someone was signed in gets nothing.
    const old = await h.signUp("Sesión Vieja");
    await h.db.core.query(`UPDATE auth.session SET "createdAt" = now() - interval '10 minutes' WHERE "userId" = $1`, [old.userId]);
    expect(String((await h.request("GET", APP_OAUTH_RETURN, as(old))).headers.location)).toBe(`${APP_SCHEME}://oauth?error=no_session`);
    expect((await h.request("POST", APP_OAUTH_RETURN, { ...as(old), body: {} })).status).toBe(401);
    // Confirming without the session gives nothing either.
    expect((await h.request("POST", APP_OAUTH_RETURN, { body: {} })).status).toBe(401);
    // Another website cannot confirm for the person, even with a fresh session from a trip it started (ADR-0014).
    const before = await passes();
    const trip = await throughApp({ email: `oidc-${rand()}@prueba.test`, name: "Sin Confirmar" }, `provider=custom&legalVersion=${LEGAL_VERSION}`);
    expect(trip.location).toBe(APP_OAUTH_PAGE);
    expect((await h.request("POST", APP_OAUTH_RETURN, { cookie: trip.cookie, body: {}, origin: "https://pagina-ajena.example" })).status).toBe(403);
    expect(await passes()).toBe(before);
    expect((await meOf(trip.cookie)).status).toBe(200);
    // Only the platform hands out passes: asking for one from outside does not work.
    const fresh = await h.signUp("Sesión Nueva");
    expect((await h.request("GET", "/api/auth/one-time-token/generate", as(fresh))).status).toBe(400);
  });

  it("with registration closed, only whoever has an invitation signs up", async () => {
    const general = (await admin("GET", "/api/admin/settings")).json.settings.general;
    expect((await admin("PUT", "/api/admin/settings/general", { ...general, registrationOpen: false })).status).toBe(200);
    try {
      const closed = await signUpThrough({ email: `oidc-${rand()}@prueba.test`, name: "Sin Invitación" });
      expect(closed.location).toContain("error=REGISTRATION_CLOSED");
      // Invited to an account, they can.
      const email = `oidc-${rand()}@prueba.test`;
      expect((await h.request("POST", "/api/members/invitations", { ...as(boss), body: { email, role: "viewer" } })).status).toBe(201);
      const invited = await signUpThrough({ email, name: "Con Invitación" });
      expect(invited.location).toBe("/");
      expect((await meOf(invited.cookie)).status).toBe(200);
    } finally {
      await admin("PUT", "/api/admin/settings/general", { ...general, registrationOpen: true });
    }
  });
});
