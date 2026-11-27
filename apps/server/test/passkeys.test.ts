// Passkeys (#123, ADR-0020): where the platform has them, registering them,
// signing in with them, and each person managing their own.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { passkeyParty } from "../src/core/passkeys";
import { type Harness, ORIGIN, type TestUser, createHarness } from "./harness";
import { type SoftPasskey, softPasskey } from "./webauthn";

let h: Harness;
let ana: TestUser;
let beto: TestUser;
let boss: TestUser;

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Passkey");
  beto = await h.signUp("Beto Passkey");
  boss = await h.signUp("Jefa de Passkeys");
  await h.makeOwner(boss);
});
afterAll(async () => {
  await h?.close();
});

const as = (user: TestUser) => ({ cookie: user.cookie });
const cookiesOf = (setCookie: string | string[] | undefined): string =>
  (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).map((c) => c.split(";")[0]).join("; ");
const join = (...cookies: string[]) => cookies.filter(Boolean).join("; ");

/** Registers a passkey for someone with a session, as the browser would after Face ID. */
async function register(user: TestUser, key: SoftPasskey, name?: string) {
  const options = await h.request("GET", "/api/auth/passkey/generate-register-options", as(user));
  if (options.status !== 200) return options;
  const challenge = cookiesOf(options.headers["set-cookie"] as string | string[] | undefined);
  return h.request("POST", "/api/auth/passkey/verify-registration", {
    cookie: join(user.cookie, challenge),
    body: { response: key.register(options.json, ORIGIN), ...(name ? { name } : {}) },
  });
}

/** Signs in with a passkey, without a session or an email. Returns the session it opens, if any. */
async function signIn(key: SoftPasskey, opts: { verified?: boolean } = {}) {
  const options = await h.request("GET", "/api/auth/passkey/generate-authenticate-options");
  if (options.status !== 200) return { status: options.status, cookie: "", json: options.json };
  const challenge = cookiesOf(options.headers["set-cookie"] as string | string[] | undefined);
  const res = await h.request("POST", "/api/auth/passkey/verify-authentication", { cookie: challenge, body: { response: key.authenticate(options.json, ORIGIN, opts) } });
  return { status: res.status, cookie: cookiesOf(res.headers["set-cookie"] as string | string[] | undefined), json: res.json };
}

const meOf = (cookie: string) => h.request("GET", "/api/me", { cookie });
const listOf = async (user: TestUser) => (await h.request("GET", "/api/auth/passkey/list-user-passkeys", as(user))).json as { id: string; name?: string; publicKey: string }[];

describe("where a platform can have passkeys", () => {
  it("only with HTTPS and a domain name, or localhost to develop", () => {
    expect(passkeyParty("https://gps.example.com")).toEqual({ rpID: "gps.example.com", origin: "https://gps.example.com" });
    expect(passkeyParty("https://gps.example.com:8443")).toEqual({ rpID: "gps.example.com", origin: "https://gps.example.com:8443" });
    expect(passkeyParty("http://localhost:5173")).toEqual({ rpID: "localhost", origin: "http://localhost:5173" });
    expect(passkeyParty("http://gps.example.com")).toBeNull();
    expect(passkeyParty("https://203.0.113.10")).toBeNull();
    expect(passkeyParty("https://[2001:db8::1]")).toBeNull();
    expect(passkeyParty("http://192.168.1.118:3000")).toBeNull();
    expect(passkeyParty("https://opengps")).toBeNull();
  });
});

describe("passkeys", () => {
  it("a person registers one and signs in with it, with the same session as always", async () => {
    expect((await h.request("GET", "/api/config")).json).toMatchObject({ passkeys: true, passkeysSupported: true });
    const key = softPasskey();
    expect((await register(ana, key, "iPhone de Ana")).status).toBe(200);

    const session = await signIn(key);
    expect(session.status).toBe(200);
    const me = await meOf(session.cookie);
    expect(me.status).toBe(200);
    expect(me.json.user.id).toBe(ana.userId);
    // It lasts 30 days, as any session; and the console notes how the person came in.
    const row = await h.db.core.query<{ days: number; method: string | null }>(
      `SELECT round(extract(epoch FROM s."expiresAt" - s."createdAt") / 86400) AS days, u.sign_in_method AS method
         FROM auth.session s JOIN gps.user_settings u ON u.user_id = s."userId"
        WHERE s."userId" = $1 ORDER BY s."createdAt" DESC LIMIT 1`,
      [ana.userId],
    );
    expect(Number(row.rows[0]?.days)).toBe(30);
    expect(row.rows[0]?.method).toBe("passkey");

    // Signing out closes it for real.
    expect((await h.request("POST", "/api/auth/sign-out", { cookie: session.cookie, body: {} })).status).toBe(200);
    expect((await meOf(session.cookie)).status).toBe(401);
  });

  it("asks for Face ID, a fingerprint or a PIN: a key that did not verify the person does not get in", async () => {
    const key = softPasskey();
    expect((await register(ana, key)).status).toBe(200);
    const unverified = await signIn(key, { verified: false });
    expect(unverified.status).toBeGreaterThanOrEqual(400);
    expect(unverified.cookie).not.toContain("session_token");
  });

  it("a key nobody registered does not get in", async () => {
    expect((await signIn(softPasskey())).status).toBeGreaterThanOrEqual(400);
  });

  it("registering one needs a session", async () => {
    expect((await h.request("GET", "/api/auth/passkey/generate-register-options")).status).toBe(401);
  });

  it("a person has several, renames and deletes them, and only touches their own", async () => {
    const first = softPasskey();
    const second = softPasskey();
    expect((await register(beto, first, "Llave USB")).status).toBe(200);
    expect((await register(beto, second, "Mac")).status).toBe(200);
    const mine = await listOf(beto);
    expect(mine.map((p) => p.name).sort()).toEqual(["Llave USB", "Mac"]);
    // Only the public key is kept.
    expect(mine.every((p) => p.publicKey.length > 0)).toBe(true);
    const usb = mine.find((p) => p.name === "Llave USB")?.id as string;

    // Someone else neither sees them nor changes them.
    expect((await listOf(ana)).some((p) => p.id === usb)).toBe(false);
    expect((await h.request("POST", "/api/auth/passkey/update-passkey", { ...as(ana), body: { id: usb, name: "Mía" } })).status).toBeGreaterThanOrEqual(400);
    expect((await h.request("POST", "/api/auth/passkey/delete-passkey", { ...as(ana), body: { id: usb } })).status).toBeGreaterThanOrEqual(400);

    expect((await h.request("POST", "/api/auth/passkey/update-passkey", { ...as(beto), body: { id: usb, name: "YubiKey" } })).status).toBe(200);
    expect((await listOf(beto)).find((p) => p.id === usb)?.name).toBe("YubiKey");
    expect((await h.request("POST", "/api/auth/passkey/delete-passkey", { ...as(beto), body: { id: usb } })).status).toBe(200);
    expect((await listOf(beto)).map((p) => p.name)).toEqual(["Mac"]);
    // A deleted one no longer gets in; the other still does.
    expect((await signIn(first)).status).toBeGreaterThanOrEqual(400);
    expect((await signIn(second)).status).toBe(200);
  });

  it("deleting the account deletes its passkeys", async () => {
    const leaving = await h.signUp("Se Va");
    const key = softPasskey();
    expect((await register(leaving, key)).status).toBe(200);
    expect((await h.request("POST", "/api/auth/delete-user", { ...as(leaving), body: { password: leaving.password } })).status).toBe(200);
    const left = await h.db.core.query(`SELECT 1 FROM auth.passkey WHERE "userId" = $1`, [leaving.userId]);
    expect(left.rowCount).toBe(0);
    expect((await signIn(key)).status).toBeGreaterThanOrEqual(400);
  });

  it("the console turns them off, and then nobody registers or signs in with them", async () => {
    const key = softPasskey();
    expect((await register(ana, key)).status).toBe(200);
    const admin = (method: string, url: string, body?: unknown) => h.request(method, url, body === undefined ? as(boss) : { ...as(boss), body });
    const general = (await admin("GET", "/api/admin/settings")).json.settings.general;
    expect(general.passkeysEnabled).toBe(true);
    expect((await admin("PUT", "/api/admin/settings/general", { ...general, passkeysEnabled: false })).status).toBe(200);
    try {
      // Off, but the address would allow them: the console can turn them on again.
      expect((await h.request("GET", "/api/config")).json).toMatchObject({ passkeys: false, passkeysSupported: true });
      const off = await h.request("GET", "/api/auth/passkey/generate-register-options", as(ana));
      expect(off.status).toBe(404);
      expect(off.json.error.code).toBe("passkeys_off");
      expect((await signIn(key)).status).toBe(404);
    } finally {
      await admin("PUT", "/api/admin/settings/general", { ...general, passkeysEnabled: true });
    }
    expect((await signIn(key)).status).toBe(200);
  });

  it("without HTTPS and a domain the platform has none, even turned on", async () => {
    const before = h.config.publicUrl;
    h.config.publicUrl = "http://192.168.1.118:3000";
    try {
      expect((await h.request("GET", "/api/config")).json).toMatchObject({ passkeys: false, passkeysSupported: false });
      expect((await h.request("GET", "/api/auth/passkey/generate-authenticate-options")).status).toBe(404);
    } finally {
      h.config.publicUrl = before;
    }
  });
});
