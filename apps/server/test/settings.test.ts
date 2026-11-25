// Platform console: settings, password policy, email,
// external storage and backups.
//
// Storage is tested with the real rclone (the one in RCLONE_BIN or whatever
// is on the machine) against a real S3 service, if there is one at
// TEST_S3_ENDPOINT (by default, the tunnel to the test one); without either
// of the two, those tests are skipped. pg_dump is replaced by a fake
// program: what is tested here is what the platform does around it.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { buffer, text } from "node:stream/consumers";
import {
  type Backup,
  type BackupFile,
  type BackupSettings,
  type BackupsInfo,
  type Cron,
  LEGAL_VERSION,
  type PlatformSettings,
  type PublicConfig,
  cronNext,
  parseCron,
  parseStorageFlag,
  type PasswordPolicy,
  type SharedSay,
  passwordHint as passwordHintSaid,
  passwordProblem as passwordProblemSaid,
  sharedText,
  storageFlagArgs,
  storageFlagProblem as storageFlagProblemSaid,
} from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S3Target, loadConfig } from "../src/config";
import { RESTORE_REQUEST, RESTORE_RESULT, RESTORE_RUNNING } from "../src/core/backups";
import { S3Error, deleteObject, getObject, keyOf, listObjects, putObject, rcloneVersion, removeEmptyFolder, testStorage, uploadFile } from "../src/core/s3";
import { createVault } from "../src/core/secrets";
import { createRouting } from "../src/simulator/routing";
import { type Harness, type TestUser, createHarness } from "./harness";

/** What the shared helpers say, in Spanish. */
const es = (text: SharedSay | null) => text && sharedText("es")(text.key, text.params);
const passwordProblem = (password: string, policy: PasswordPolicy) => es(passwordProblemSaid(password, policy));
const passwordHint = (policy: PasswordPolicy) => es(passwordHintSaid(policy));
const storageFlagProblem = (text: string) => es(storageFlagProblemSaid(text));

let h: Harness;
let boss: TestUser; // administers the platform
let customer: TestUser; // any account

const as = (user: TestUser) => ({ cookie: user.cookie });
const admin = (method: string, url: string, body?: unknown) => h.request(method, url, body === undefined ? as(boss) : { ...as(boss), body });
const view = async () => (await admin("GET", "/api/admin/settings")).json.settings as PlatformSettings;
const save = (section: string, body: unknown) => admin("PUT", `/api/admin/settings/${section}`, body);
const publicConfig = async () => (await h.request("GET", "/api/config", {})).json as PublicConfig;
const stored = async (section: string) => JSON.stringify((await h.db.core.query(`SELECT value FROM gps.platform_settings WHERE section = $1`, [section])).rows[0]?.value ?? null);

const S3: S3Target = {
  provider: "Other",
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:17070",
  region: "us-east-1",
  bucket: process.env.TEST_S3_BUCKET ?? "backups-test",
  prefix: `tests/${randomBytes(4).toString("hex")}`,
  accessKeyId: process.env.TEST_S3_KEY ?? "pruebas-s3",
  secretAccessKey: process.env.TEST_S3_SECRET ?? "clave-de-pruebas-s3",
  flags: [],
};
let hasRclone = false;
let hasS3 = false;

/** Plain rclone against the test service, to prepare and inspect what the platform's client does not do: empty folders. */
function rcloneDirect(...args: string[]): string {
  const remote = { TYPE: "s3", PROVIDER: "Other", ACCESS_KEY_ID: S3.accessKeyId, SECRET_ACCESS_KEY: S3.secretAccessKey, ENDPOINT: S3.endpoint, REGION: S3.region, NO_CHECK_BUCKET: "true" };
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, RCLONE_CONFIG: "/dev/null", ...Object.fromEntries(Object.entries(remote).map(([k, v]) => [`RCLONE_CONFIG_T_${k}`, v])) };
  return execFileSync(process.env.RCLONE_BIN || "rclone", args, { env, encoding: "utf8" });
}
const remoteFolder = (name: string) => `t:${S3.bucket}/${keyOf(S3, name)}`;
/** Everything under a folder of the test service, empty folders included. */
const everythingIn = (name: string) => (JSON.parse(rcloneDirect("lsjson", "--recursive", remoteFolder(name))) as { Path: string }[]).map((e) => e.Path).sort();

/** A fake service on this machine, to see what is asked of it and what happens depending on how it answers. */
async function fakeService(answer: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => answer(req, res));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
const TMP = `${process.env.TMPDIR ?? "/tmp"}/opengps-test-platform-${randomBytes(4).toString("hex")}`;

beforeAll(async () => {
  hasRclone = (await rcloneVersion()) !== null;
  hasS3 =
    hasRclone &&
    (await testStorage(S3).then(
      () => true,
      () => false,
    ));
  if (!hasRclone) console.warn("[pruebas] sin rclone en esta máquina: se saltan las pruebas del almacenamiento");
  else if (!hasS3) console.warn("[pruebas] sin servicio S3 de pruebas: se saltan las pruebas que lo usan");
  h = await createHarness();
  // The recorded backups are database-wide: we start with none.
  await h.db.core.query(`DELETE FROM gps.backups`);
  boss = await h.signUp("Jefa de Plataforma");
  customer = await h.signUp("Cliente Común");
  await h.makeOwner(boss);

  // A fake pg_dump, ahead of the real one if there is one.
  mkdirSync(join(TMP, "bin"), { recursive: true });
  writeFileSync(
    join(TMP, "bin", "pg_dump"),
    `#!/bin/sh
for a in "$@"; do case "$a" in --file=*) out="\${a#--file=}";; esac; done
if [ "$PGDATABASE" = "broken" ]; then echo "pg_dump: error: could not connect" >&2; exit 1; fi
printf 'copia de prueba de %s por %s' "$PGDATABASE" "$PGUSER" > "$out"
`,
  );
  chmodSync(join(TMP, "bin", "pg_dump"), 0o755);
  process.env.PATH = `${join(TMP, "bin")}:${process.env.PATH}`;
  rmSync(h.config.backup.dir, { recursive: true, force: true });
  mkdirSync(h.config.filesDir, { recursive: true });
  writeFileSync(join(h.config.filesDir, "prueba-de-copias.txt"), "un archivo de un usuario");
}, 120_000);
afterAll(async () => {
  rmSync(TMP, { recursive: true, force: true });
  if (h) {
    rmSync(h.config.backup.dir, { recursive: true, force: true });
    await h.backups.idle();
    await h.db.core.query(`DELETE FROM gps.backups`);
  }
  await h?.close();
});

describe("platform settings", () => {
  it("only exist for whoever administers the platform", async () => {
    for (const [method, url] of [
      ["GET", "/api/admin/settings"],
      ["PUT", "/api/admin/settings/general"],
      ["POST", "/api/admin/settings/mail/test"],
      ["POST", "/api/admin/settings/storage/test"],
      ["GET", "/api/admin/backups"],
      ["POST", "/api/admin/backups"],
      ["DELETE", "/api/admin/backups/019ab000-0000-7000-8000-000000000000"],
      ["GET", "/api/admin/backups/019ab000-0000-7000-8000-000000000000/files/gps_20261122_000000.dump"],
    ] as const) {
      const body = method === "GET" || method === "DELETE" ? {} : { body: {} };
      expect((await h.request(method, url, { ...as(customer), ...body })).status, `${method} ${url}`).toBe(404);
      expect((await h.request(method, url, body)).status, `${method} ${url} sin sesión`).toBe(401);
    }
    expect((await save("inventada", {})).status).toBe(404);
  });

  it("start from what the server variables provide", async () => {
    const s = await view();
    expect(s.general).toMatchObject({ registrationOpen: true, newAccountMaxVehicles: null, newAccountModules: [], mapStyleUrl: h.config.mapStyleUrl, claimWindowMinutes: h.config.claimWindowMinutes, alertEmailsPerHour: 40, maxUploadMb: 8 });
    expect(s.passwords).toEqual({ minLength: 8, number: false, symbol: false, lowercase: false, uppercase: false });
    expect(s.mail).toMatchObject({ custom: false, hasPassword: false });
    expect(s.storage).toMatchObject({ enabled: false, provider: "Other", hasSecret: false, flags: [] });
    expect(s.backups).toEqual({ scheduled: true, cron: "0 0 * * *", retentionDays: 7, upload: false });
    expect(await publicConfig()).toMatchObject({ registrationOpen: true, maxUploadMb: 8, passwordPolicy: { minLength: 8 } });
  });

  it("what is saved applies from that moment, and what is invalid is rejected", async () => {
    const general = (await view()).general;
    const saved = await save("general", { ...general, mapStyleUrl: "https://mapas.ejemplo.com/estilo.json", claimWindowMinutes: 30, maxUploadMb: 20, legalEntity: "Rastreo de Prueba S.A.", legalCountry: "Honduras", legalContactEmail: "legal@ejemplo.com", alertEmail: "avisos@ejemplo.com" });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(await publicConfig()).toMatchObject({
      mapStyleUrl: "https://mapas.ejemplo.com/estilo.json",
      claimWindowMinutes: 30,
      maxUploadMb: 20,
      legal: { entity: "Rastreo de Prueba S.A.", country: "Honduras", contactEmail: "legal@ejemplo.com" },
    });
    expect(h.config.alertEmail).toBe("avisos@ejemplo.com");
    // The address service and the GPS waiting for their first report are set up here too.
    const tuned = await save("general", { ...general, geocoderUserAgent: "Rastreo de Prueba (soporte@ejemplo.com)", geocoderIntervalMs: 2000, maxPendingDevices: 5 });
    expect(tuned.status, JSON.stringify(tuned.json)).toBe(200);
    expect(h.config.geocoder).toMatchObject({ userAgent: "Rastreo de Prueba (soporte@ejemplo.com)", minIntervalMs: 2000 });
    expect(h.config.maxPendingDevices).toBe(5);
    // Without the holder nor the country, the legal texts read well: neither is asked for.
    expect((await save("general", { ...general, legalEntity: "", legalCountry: "" })).status).toBe(200);
    expect(h.config.geocoder.userAgent).toBe(`${h.config.appName} (${h.config.publicUrl})`);
    // It records who changed it, without the content.
    const log = await h.db.core.query<{ detail: object }>(`SELECT detail FROM gps.audit_log WHERE user_id = $1 AND action = 'admin.settings' ORDER BY id DESC LIMIT 1`, [boss.userId]);
    expect(log.rows[0]?.detail).toEqual({ section: "general" });

    expect((await save("general", { ...general, historyRetentionDays: 10 })).status).toBe(400); // no limit, or at least 30 days
    expect((await save("general", { ...general, mapStyleUrl: "no es una dirección" })).status).toBe(400);
    expect((await save("general", { ...general, maxUploadMb: 500 })).status).toBe(400);
    expect((await save("general", { ...general, alertEmail: "no-es-un-correo" })).status).toBe(400);
    expect((await save("general", general)).status).toBe(200);
    expect((await publicConfig()).mapStyleUrl).toBe(h.config.mapStyleUrl);
  });

  it("the address service starts with OpenStreetMap's public one, and its identification is shown filled in", async () => {
    // A new installation, with nothing about the service in its variables.
    const { GEOCODER_URL: _unset, ...bare } = process.env;
    expect(loadConfig(bare).geocoder.url).toBe("https://nominatim.openstreetmap.org/reverse");
    expect(loadConfig({ ...bare, GEOCODER_URL: "" }).geocoder.url).toBe("");

    const automatic = `${h.config.appName} (${h.config.publicUrl})`;
    const general = (await view()).general;
    expect(general.geocoderUserAgent).toBe(automatic);
    // Saved as shown, it is stored empty: it keeps following the platform's name and address.
    expect((await save("general", general)).status).toBe(200);
    expect(JSON.parse(await stored("general"))).toMatchObject({ geocoderUserAgent: "" });
    expect((await view()).general.geocoderUserAgent).toBe(automatic);
    // One written by hand stays as written.
    expect((await save("general", { ...general, geocoderUserAgent: "Rastreo de Prueba (soporte@ejemplo.com)" })).status).toBe(200);
    expect((await view()).general.geocoderUserAgent).toBe("Rastreo de Prueba (soporte@ejemplo.com)");

    // Whoever had saved the settings while the service started off takes the new starting value…
    const migration = readFileSync(new URL("../../../db/migrations/core/0020_geocoder_default.sql", import.meta.url), "utf8");
    expect((await save("general", { ...general, geocoderUrl: "" })).status).toBe(200);
    expect(JSON.parse(await stored("general"))).toMatchObject({ geocoderUrl: "" });
    await h.db.core.query(migration);
    expect(JSON.parse(await stored("general"))).not.toHaveProperty("geocoderUrl");
    expect(JSON.parse(await stored("general"))).toMatchObject({ mapStyleUrl: general.mapStyleUrl });
    // …and a service somebody wrote is left alone.
    expect((await save("general", { ...general, geocoderUrl: "https://direcciones.ejemplo.com/reverse" })).status).toBe(200);
    await h.db.core.query(migration);
    expect(JSON.parse(await stored("general"))).toMatchObject({ geocoderUrl: "https://direcciones.ejemplo.com/reverse" });
    expect(h.config.geocoder.url).toBe("https://direcciones.ejemplo.com/reverse");
    // Emptied in the console, it is off.
    expect((await save("general", { ...general, geocoderUrl: "" })).status).toBe(200);
    expect(h.config.geocoder.url).toBe("");
    expect((await save("general", general)).status).toBe(200);
  });

  it("the routing service starts with the public one over OpenStreetMap data, and empty turns it off", async () => {
    const { ROUTING_URL: _unset, ...bare } = process.env;
    expect(loadConfig(bare).routing.url).toBe("https://router.project-osrm.org");
    expect(loadConfig({ ...bare, ROUTING_URL: "" }).routing.url).toBe("");

    const general = (await view()).general;
    // Whoever saved the settings before this one existed keeps what the server brings.
    expect(general.routingUrl).toBe(h.config.routing.url);
    const routing = createRouting({ config: h.config });
    expect((await save("general", { ...general, routingUrl: "https://rutas.ejemplo.com/" })).status).toBe(200);
    expect(h.config.routing.url).toBe("https://rutas.ejemplo.com");
    expect((await view()).general.routingUrl).toBe("https://rutas.ejemplo.com/");
    // What the console changes is in use at once, without a restart.
    expect(routing.enabled).toBe(true);
    expect((await save("general", { ...general, routingUrl: "no es una dirección" })).status).toBe(400);
    expect((await save("general", { ...general, routingUrl: "" })).status).toBe(200);
    expect(routing.enabled).toBe(false);
    expect((await save("general", general)).status).toBe(200);
  });

  it("with registration closed, only someone with an invitation registers", async () => {
    const general = (await view()).general;
    expect((await save("general", { ...general, registrationOpen: false })).status).toBe(200);
    expect((await publicConfig()).registrationOpen).toBe(false);
    const signUp = (email: string) => h.request("POST", "/api/auth/sign-up/email", { body: { name: "Nueva Persona", email, password: "clave-larga-123", callbackURL: "/", legalVersion: LEGAL_VERSION } });
    const closed = await signUp(`t-${randomBytes(5).toString("hex")}@prueba.test`);
    expect(closed.status).toBe(403);
    expect(closed.json.error).toMatchObject({ code: "registration_closed" });

    const invited = `t-${randomBytes(5).toString("hex")}@prueba.test`;
    expect((await h.request("POST", "/api/members/invitations", { ...as(boss), body: { email: invited, role: "viewer" } })).status).toBe(201);
    expect((await signUp(invited.toUpperCase())).status).toBe(200);
    await h.db.core.query(`DELETE FROM auth."user" WHERE email = $1`, [invited]);

    expect((await save("general", { ...general, registrationOpen: true })).status).toBe(200);
  });

  it("the password policy applies on registration and when changing the password", async () => {
    expect(passwordProblem("corta", { minLength: 8, number: false, symbol: false, lowercase: false, uppercase: false })).toContain("al menos 8");
    expect(passwordProblem("todoenminusculas", { minLength: 8, number: true, symbol: false, lowercase: true, uppercase: true })).toContain("número");
    expect(passwordProblem("Con1Mayuscula", { minLength: 8, number: true, symbol: true, lowercase: true, uppercase: true })).toContain("símbolo");
    expect(passwordProblem("Con1Mayúscula!", { minLength: 8, number: true, symbol: true, lowercase: true, uppercase: true })).toBeNull();
    expect(passwordHint({ minLength: 10, number: true, symbol: false, lowercase: false, uppercase: true })).toBe("Mínimo 10 caracteres, con un número y una mayúscula.");

    expect((await save("passwords", { minLength: 4, number: false, symbol: false, lowercase: false, uppercase: false })).status).toBe(400);
    expect((await save("passwords", { minLength: 10, number: true, symbol: false, lowercase: false, uppercase: true })).status).toBe(200);
    expect((await publicConfig()).passwordPolicy).toEqual({ minLength: 10, number: true, symbol: false, lowercase: false, uppercase: true });

    const email = `t-${randomBytes(5).toString("hex")}@prueba.test`;
    const signUp = (password: string) => h.request("POST", "/api/auth/sign-up/email", { body: { name: "Con Política", email, password, callbackURL: "/", legalVersion: LEGAL_VERSION } });
    const weak = await signUp("sinmayuscula1");
    expect(weak.status).toBe(400);
    expect(weak.json.error).toMatchObject({ code: "password_policy", message: "La contraseña debe llevar al menos una letra mayúscula." });
    expect((await signUp("Corta1")).json.error.message).toContain("al menos 10");
    expect((await signUp("ConMayuscula1")).status).toBe(200);
    await h.db.core.query(`DELETE FROM auth."user" WHERE email = $1`, [email]);
    // On resetting it, the same: it is rejected before looking at the link.
    const reset = await h.request("POST", "/api/auth/reset-password", { body: { token: "cualquiera", newPassword: "debil" } });
    expect(reset.json.error).toMatchObject({ code: "password_policy" });

    expect((await save("passwords", { minLength: 8, number: false, symbol: false, lowercase: false, uppercase: false })).status).toBe(200);
  });

  it("new accounts are born with the quotas and modules that are set", async () => {
    const general = (await view()).general;
    expect((await save("general", { ...general, newAccountMaxVehicles: 1, newAccountModules: ["G"] })).status).toBe(200);
    const newAccount = await h.signUp("Cuenta con Cuota");
    expect((await h.request("GET", "/api/me", as(newAccount))).json.account.modules).toEqual(["G"]);
    const add = () => h.request("POST", "/api/vehicles", { ...as(newAccount), body: { name: "Vehículo", uniqueId: h.uniqueId(), modelId: "h02" } });
    expect((await add()).status).toBe(201);
    expect((await add()).status).toBe(429);
    // Those that already existed do not change.
    expect((await h.request("GET", "/api/me", as(customer))).json.account.modules).toEqual([]);
    expect((await save("general", general)).status).toBe(200);
  });

  it("the custom email stores its password encrypted and does not return it", async () => {
    const envHost = h.config.smtp.host;
    const mail = { custom: true, host: "smtp.ejemplo.com", port: 465, security: "ssl", user: "avisos@ejemplo.com", password: "clave-del-correo-42", from: "Avisos <avisos@ejemplo.com>" };
    const saved = await save("mail", mail);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.settings.mail).toEqual({ custom: true, host: "smtp.ejemplo.com", port: 465, security: "ssl", user: "avisos@ejemplo.com", hasPassword: true, from: "Avisos <avisos@ejemplo.com>" });
    expect(JSON.stringify(saved.json)).not.toContain("clave-del-correo-42");
    const raw = await stored("mail");
    expect(raw).not.toContain("clave-del-correo-42");
    expect(raw).toContain("v2:");
    expect(h.config.smtp).toMatchObject({ host: "smtp.ejemplo.com", port: 465, security: "ssl", password: "clave-del-correo-42", from: "Avisos <avisos@ejemplo.com>" });

    // Saving again without writing the password keeps it.
    const { password: _omit, ...withoutPassword } = mail;
    expect((await save("mail", { ...withoutPassword, port: 587, security: "starttls" })).status).toBe(200);
    expect(h.config.smtp).toMatchObject({ port: 587, password: "clave-del-correo-42" });
    expect((await save("mail", { custom: true, host: "", from: "" })).status).toBe(400);

    // The test email goes to whoever asks for it.
    h.mails.length = 0;
    const test = await admin("POST", "/api/admin/settings/mail/test", {});
    expect(test.status, JSON.stringify(test.json)).toBe(200);
    expect(test.json.sentTo).toBe(boss.email);
    expect(h.mails.map((m) => m.to)).toEqual([boss.email]);

    // When turned off, the server's returns.
    expect((await save("mail", { ...withoutPassword, custom: false })).status).toBe(200);
    expect(h.config.smtp.host).toBe(envHost);
  });

  it("resetting a section leaves it as it came, and deletes its keys", async () => {
    expect((await save("passwords", { minLength: 12, number: true, symbol: true, lowercase: true, uppercase: true })).status).toBe(200);
    expect((await h.request("DELETE", "/api/admin/settings/passwords", as(customer))).status).toBe(404);
    expect((await admin("DELETE", "/api/admin/settings/inventada")).status).toBe(404);
    const back = await admin("DELETE", "/api/admin/settings/passwords");
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    expect(back.json.settings.passwords).toEqual({ minLength: 8, number: false, symbol: false, lowercase: false, uppercase: false });
    expect((await publicConfig()).passwordPolicy.minLength).toBe(8);
    expect(await stored("passwords")).toBe("null");

    const envHost = h.config.smtp.host;
    expect((await save("mail", { custom: true, host: "smtp.ejemplo.com", port: 587, security: "starttls", user: "u", password: "otra-clave-99", from: "A <a@ejemplo.com>" })).status).toBe(200);
    const mail = await admin("DELETE", "/api/admin/settings/mail");
    expect(mail.json.settings.mail).toMatchObject({ custom: false, hasPassword: false, host: envHost });
    expect(h.config.smtp.host).toBe(envHost);
    expect(await stored("mail")).toBe("null");
    const log = await h.db.core.query<{ detail: object }>(`SELECT detail FROM gps.audit_log WHERE user_id = $1 AND action = 'admin.settings_reset' ORDER BY id DESC LIMIT 1`, [boss.userId]);
    expect(log.rows[0]?.detail).toEqual({ section: "mail" });
  });

  it("a key encrypted with another server secret is not read, and breaks nothing", () => {
    const sealed = createVault("un-secreto-del-servidor-de-32-caracteres!").seal("clave");
    expect(createVault("un-secreto-del-servidor-de-32-caracteres!").open(sealed)).toBe("clave");
    expect(createVault("otro-secreto-distinto-de-32-caracteres!!!").open(sealed)).toBeNull();
    expect(createVault("un-secreto-del-servidor-de-32-caracteres!").open("no-es-una-clave-cifrada")).toBeNull();
    expect(sealed).not.toContain("clave");
  });

});

describe("S3 storage", () => {
  it("the extra arguments are read as rclone writes them, and only the expected ones are valid", () => {
    expect(parseStorageFlag("--s3-sign-accept-encoding=false")).toEqual({ name: "s3-sign-accept-encoding", value: "false" });
    expect(parseStorageFlag("  --s3-chunk-size 16M ")).toEqual({ name: "s3-chunk-size", value: "16M" });
    expect(parseStorageFlag('--header "X-Uno: dos tres"')).toEqual({ name: "header", value: "X-Uno: dos tres" });
    expect(parseStorageFlag("--no-check-certificate")).toEqual({ name: "no-check-certificate", value: null });
    expect(storageFlagArgs(["--s3-sign-accept-encoding=false", "--s3-chunk-size 16M", '--header "X-Uno: dos tres"', "--no-check-certificate", "--rc"])).toEqual([
      "--s3-sign-accept-encoding=false",
      "--s3-chunk-size=16M",
      "--header=X-Uno: dos tres",
      "--no-check-certificate",
    ]);
    // What is not an argument, what has its own field and what would open the server another way.
    expect(storageFlagProblem("s3-chunk-size=16M")).toMatch(/dos guiones/);
    expect(storageFlagProblem("--S3-Chunk-Size=16M")).toMatch(/minúsculas/);
    expect(storageFlagProblem("--s3-secret-access-key=abc")).toMatch(/su campo/);
    expect(storageFlagProblem("--s3-endpoint=https://otro.test")).toMatch(/su campo/);
    for (const flag of ["--config=/etc/passwd", "--rc", "--rc-addr=:5572", "--password-command=sh", "--log-file=/tmp/x", "--dump=headers", "--s3-env-auth", "--s3-shared-credentials-file=/x", "--s3-sdk-log-mode=Signing"]) {
      expect(storageFlagProblem(flag), flag).toMatch(/no admite/);
    }
    expect(storageFlagProblem("--s3-chunk-size=16M --s3-upload-cutoff=16M")).toMatch(/un solo argumento/);
    expect(storageFlagProblem("--s3-chunk-size=16M\n--rc")).toMatch(/una sola línea/);
    expect(storageFlagProblem("")).toMatch(/vacío/);
  });

  it("uploads, downloads and deletes files on a real service", async (ctx) => {
    if (!hasS3) return ctx.skip();
    const key = keyOf(S3, "carpeta con espacio/archivo ñandú.txt");
    await putObject(S3, key, Buffer.from("hola, almacén"));
    const got = await getObject(S3, key);
    expect(got.bytes).toBe(Buffer.byteLength("hola, almacén"));
    expect(await text(got.stream)).toBe("hola, almacén");
    await deleteObject(S3, key);
    await expect(getObject(S3, key)).rejects.toMatchObject({ status: 404 });
    // Deleting what is no longer there is not an error.
    await deleteObject(S3, key);
  });

  it("lists what is in a folder, even if it comes in several pages", async (ctx) => {
    if (!hasS3) return ctx.skip();
    const names = ["a.txt", "b c.txt", "d&e.txt", "sub/f.txt", "g.txt"];
    for (const [i, name] of names.entries()) await putObject(S3, keyOf(S3, `lista/${name}`), Buffer.from("x".repeat(i + 1)));
    await putObject(S3, keyOf(S3, "otra/z.txt"), Buffer.from("fuera"));
    const expected = names.map((name, i) => ({ key: keyOf(S3, `lista/${name}`), bytes: i + 1 })).sort((a, b) => (a.key < b.key ? -1 : 1));
    const strip = (list: { key: string; bytes: number }[]) => list.map(({ key, bytes }) => ({ key, bytes })).sort((a, b) => (a.key < b.key ? -1 : 1));
    const all = await listObjects(S3, keyOf(S3, "lista/"));
    expect(strip(all)).toEqual(expected);
    expect(all.every((o) => o.modifiedAt !== null && !Number.isNaN(Date.parse(o.modifiedAt)))).toBe(true);
    // Two at a time, as an extra argument asks for: several pages, and the same comes out.
    expect(strip(await listObjects({ ...S3, flags: ["--s3-list-chunk=2"] }, keyOf(S3, "lista/")))).toEqual(expected);
    expect((await listObjects(S3, keyOf(S3, "lista/"), { max: 3 })).length).toBe(3);
    expect(await listObjects(S3, keyOf(S3, "no-hay-nada/"))).toEqual([]);
    for (const name of [...names.map((n) => `lista/${n}`), "otra/z.txt"]) await deleteObject(S3, keyOf(S3, name));
  }, 120_000);

  it("a large file uploads in parts and arrives identical", async (ctx) => {
    if (!hasS3) return ctx.skip();
    const data = randomBytes(11 * 1024 * 1024 + 123);
    const path = join(TMP, "grande.bin");
    writeFileSync(path, data);
    const key = keyOf(S3, "grande.bin");
    // The size of the parts is set by the extra arguments.
    await uploadFile({ ...S3, flags: ["--s3-upload-cutoff=5M", "--s3-chunk-size=5M"] }, key, path);
    const got = await getObject(S3, key);
    expect(got.bytes).toBe(data.length);
    const back = await buffer(got.stream);
    expect(createHash("sha256").update(back).digest("hex")).toBe(createHash("sha256").update(data).digest("hex"));
    // By default, one of this size goes in one go.
    await uploadFile(S3, keyOf(S3, "chico.bin"), path);
    expect((await buffer((await getObject(S3, keyOf(S3, "chico.bin"))).stream)).length).toBe(data.length);
    await deleteObject(S3, key);
    await deleteObject(S3, keyOf(S3, "chico.bin"));
  }, 120_000);

  it("removes the folder that was left empty, and does not touch the one that has something", async (ctx) => {
    if (!hasS3) return ctx.skip();
    // That is how it stays on services that store each folder as such.
    rcloneDirect("mkdir", "--s3-directory-markers", remoteFolder("carpetas/vacia"));
    // On others, the empty folder looks like a file with no content that carries its name.
    await putObject(S3, keyOf(S3, "carpetas/vacia-como-archivo"), Buffer.alloc(0));
    await putObject(S3, keyOf(S3, "carpetas/archivo-con-nombre-de-carpeta"), Buffer.from("no es una carpeta"));
    await putObject(S3, keyOf(S3, "carpetas/llena/queda.txt"), Buffer.from("sigue aquí"));
    expect(everythingIn("carpetas")).toEqual(["archivo-con-nombre-de-carpeta", "llena", "llena/queda.txt", "vacia", "vacia-como-archivo"]);
    for (const name of ["vacia", "vacia-como-archivo", "archivo-con-nombre-de-carpeta", "llena", "no-existe"]) await removeEmptyFolder(S3, keyOf(S3, `carpetas/${name}`));
    expect(everythingIn("carpetas")).toEqual(["archivo-con-nombre-de-carpeta", "llena", "llena/queda.txt"]);
    await deleteObject(S3, keyOf(S3, "carpetas/archivo-con-nombre-de-carpeta"));
    // On the root it does nothing: the bucket is still there.
    await removeEmptyFolder({ ...S3, prefix: "" }, "");
    expect(await text((await getObject(S3, keyOf(S3, "carpetas/llena/queda.txt"))).stream)).toBe("sigue aquí");
    await deleteObject(S3, keyOf(S3, "carpetas/llena/queda.txt"));
  }, 120_000);

  it("explains in words why it does not connect", async (ctx) => {
    if (!hasS3) return ctx.skip();
    await expect(testStorage({ ...S3, secretAccessKey: "otra-clave" })).rejects.toThrow(/firma|clave/i);
    await expect(testStorage({ ...S3, bucket: "bucket-que-no-existe" })).rejects.toBeInstanceOf(S3Error);
    await expect(testStorage({ ...S3, endpoint: "http://127.0.0.1:9" })).rejects.toThrow(/Sin respuesta del almacenamiento/);
    // An argument with a value rclone does not accept.
    await expect(testStorage({ ...S3, flags: ["--s3-chunk-size=mucho"] })).rejects.toThrow(/no vale para el argumento --s3-chunk-size/);
  }, 120_000);

  it("the extra arguments reach the requests, and the key does not travel in sight", async (ctx) => {
    if (!hasRclone) return ctx.skip();
    const seen: { line: string; headers: Record<string, string | string[] | undefined> }[] = [];
    const fake = await fakeService((req, res) => {
      seen.push({ line: `${req.method} ${req.url?.replace(/\?.*/, "")}`, headers: req.headers });
      res.writeHead(403, { "content-type": "application/xml" });
      res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
    });
    try {
      const target: S3Target = { ...S3, endpoint: fake.endpoint, bucket: "mi-bucket", prefix: "", flags: ['--header "X-Paso: abre"', "--user-agent=plataforma-de-pruebas"] };
      await expect(putObject(target, "backups/uno.dump", Buffer.from("x"))).rejects.toThrow(/no tiene permiso/);
      const put = seen.find((r) => r.line.startsWith("PUT")) as (typeof seen)[number];
      // The bucket goes in the address, after the service.
      expect(put.line).toBe("PUT /mi-bucket/backups/uno.dump");
      expect(put.headers["x-paso"]).toBe("abre");
      expect(put.headers["user-agent"]).toBe("plataforma-de-pruebas");
      const signature = String(put.headers.authorization);
      expect(signature).toContain(`Credential=${S3.accessKeyId}/`);
      expect(signature).not.toContain(S3.secretAccessKey);
      // Accept-Encoding never goes into the signature: some services and intermediaries change it along the way.
      expect(signature.match(/SignedHeaders=([^,]+)/)?.[1]).not.toContain("accept-encoding");
    } finally {
      await fake.close();
    }
  }, 60_000);

  it("if what answers is not the storage, it says so instead of blaming the key", async (ctx) => {
    if (!hasRclone) return ctx.skip();
    let reply: { status: number; type: string; body: string; location?: string } = { status: 403, type: "text/html;charset=UTF-8", body: "<!DOCTYPE html><html><head><title>Error ・ Cloudflare Access</title></head><body></body></html>" };
    const fake = await fakeService((_req, res) => {
      res.writeHead(reply.status, { "content-type": reply.type, ...(reply.location ? { location: reply.location } : {}) });
      res.end(reply.body);
    });
    const target: S3Target = { ...S3, endpoint: fake.endpoint };
    try {
      // A Cloudflare Access barrier in front: it rejects with its page, or sends to sign in.
      await expect(testStorage(target)).rejects.toThrow(/Cloudflare Access bloqueó/);
      reply = { status: 302, type: "text/html", body: "", location: `${fake.endpoint}/cdn-cgi/access/login/s3.ejemplo.test` };
      await expect(testStorage(target)).rejects.toThrow(/Cloudflare Access bloqueó/);
      // The address of something else, like the device's admin panel: it answers with an error or with its page to everything.
      reply = { status: 200, type: "text/html", body: "<html><body>Bienvenido</body></html>" };
      await expect(testStorage(target)).rejects.toThrow(/no respondió como un almacenamiento S3/);
      // A short error page gives nothing away: some storages answer like that to whoever arrives without a signature.
      reply = { status: 404, type: "text/html; charset=UTF-8", body: "<html><h1>Not Found</h1></html>" };
      await expect(testStorage(target)).rejects.toThrow(/no existe en el servicio/);
      // When it is the storage that denies the permission, that is what is said.
      reply = { status: 403, type: "application/xml", body: '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>' };
      await expect(testStorage(target)).rejects.toThrow(/no tiene permiso/);
      reply = { status: 403, type: "application/xml", body: "" };
      await expect(testStorage(target)).rejects.toThrow(/no tiene permiso/);
    } finally {
      await fake.close();
    }
  }, 120_000);

  it("the console stores the key and the arguments encrypted, and tests the connection before saving", async (ctx) => {
    const body = { enabled: true, provider: "Other", endpoint: S3.endpoint, region: S3.region, bucket: S3.bucket, prefix: `/${S3.prefix}/`, accessKeyId: S3.accessKeyId };
    // Turning it on without a secret key is not valid, nor testing it.
    expect((await save("storage", body)).status).toBe(400);
    expect((await admin("POST", "/api/admin/settings/storage/test", {})).status).toBe(400);
    expect((await admin("POST", "/api/admin/settings/storage/test", body)).status).toBe(400);
    // Nor with a made-up provider or with arguments that are not accepted.
    expect((await save("storage", { ...body, secretAccessKey: S3.secretAccessKey, provider: "Inventado" })).status).toBe(400);
    const refused = await save("storage", { ...body, secretAccessKey: S3.secretAccessKey, flags: ["--config=/etc/passwd"] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.json)).toMatch(/no admite --config/);

    const flags = ["--s3-sign-accept-encoding=false", '--header "X-Paso: clave-de-la-cabecera"', "  ", "--s3-list-chunk 500"];
    const saved = await save("storage", { ...body, secretAccessKey: S3.secretAccessKey, flags });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    // They come back as written, without the empty lines.
    expect(saved.json.settings.storage).toMatchObject({ enabled: true, provider: "Other", bucket: S3.bucket, prefix: S3.prefix, hasSecret: true, flags: [flags[0], flags[1], flags[3]] });
    expect(JSON.stringify(saved.json)).not.toContain(S3.secretAccessKey);
    // In the database neither the key nor what the arguments carry can be read.
    expect(await stored("storage")).not.toContain(S3.secretAccessKey);
    expect(await stored("storage")).not.toContain("clave-de-la-cabecera");
    expect(await stored("storage")).not.toContain("s3-list-chunk");
    expect(h.config.storage).toMatchObject({ provider: "Other", bucket: S3.bucket, secretAccessKey: S3.secretAccessKey, flags: [flags[0], flags[1], flags[3]] });
    expect((await save("storage", { ...body, bucket: "Con Mayúsculas" })).status).toBe(400);

    if (!hasRclone) return ctx.skip();
    // An argument that rclone does not know is rejected on saving, with what rclone says.
    const unknown = await save("storage", { ...body, flags: ["--s3-esto-no-existe=1"] });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.message).toMatch(/rclone no conoce el argumento --s3-esto-no-existe/);
    // A rejected save changes nothing.
    expect((await view()).storage.flags).toEqual([flags[0], flags[1], flags[3]]);

    if (!hasS3) return ctx.skip();
    // Testing with what is saved…
    expect((await admin("POST", "/api/admin/settings/storage/test", {})).status).toBe(204);
    // …and with what is in the form, without saving it: a wrong key says so and changes nothing.
    const failed = await admin("POST", "/api/admin/settings/storage/test", { ...body, secretAccessKey: "clave-equivocada" });
    expect(failed.status).toBe(400);
    expect(failed.json.error.message).toMatch(/firma|clave/i);
    expect(h.config.storage).toMatchObject({ secretAccessKey: S3.secretAccessKey });
    // Without writing the key, the test uses the saved one.
    expect((await admin("POST", "/api/admin/settings/storage/test", { ...body, flags: ["--s3-list-chunk=100"] })).status).toBe(204);
    // Testing does not save: the saved arguments stay.
    expect((await view()).storage.flags).toEqual([flags[0], flags[1], flags[3]]);
    expect((await save("storage", { ...body, secretAccessKey: S3.secretAccessKey })).status).toBe(200);
  }, 120_000);
});

describe("backups", () => {
  const info = async () => (await admin("GET", "/api/admin/backups")).json.info as BackupsInfo;
  const HOUR = 3_600_000;
  /** Every day at 02:00 UTC. */
  const plan = (extra: Partial<BackupSettings> = {}): BackupSettings => ({ scheduled: true, cron: "0 2 * * *", retentionDays: 7, upload: false, ...extra });
  const nextOf = (expression: string, after: number) => cronNext(parseCron(expression) as Cron, after) as number;

  it("without access to the databases, the server makes no backups", async () => {
    h.config.backup.databaseUrl = "";
    expect(await info()).toMatchObject({ available: false, nextAt: null, backups: [] });
    expect((await admin("POST", "/api/admin/backups", {})).status).toBe(400);
    expect(await h.backups.tick(Date.now() + 3 * 24 * HOUR)).toBe(false);
  });

  it("makes a backup on request with both databases and the files, and lets it be downloaded", async () => {
    h.config.backup.databaseUrl = "postgres://reader:secret@127.0.0.1:1/gps";
    h.config.backup.traccarDatabaseUrl = "postgres://reader:secret@127.0.0.1:1/traccar";
    const started = await admin("POST", "/api/admin/backups", {});
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    expect(started.json.info.running).toBe(true);
    // While it runs, another does not start.
    expect((await admin("POST", "/api/admin/backups", {})).status).toBe(409);
    await h.backups.idle();

    const now = await info();
    expect(now).toMatchObject({ available: true, running: false });
    const backup = now.backups[0] as Backup;
    expect(backup).toMatchObject({ kind: "manual", status: "ok", error: null, local: true, remote: false });
    expect(backup.files.map((f) => f.part)).toEqual(["gps", "traccar", "files"]);
    expect(backup.bytes).toBe(backup.files.reduce((n, f) => n + f.bytes, 0));
    const [gps] = backup.files;
    expect(gps?.name).toMatch(/^gps_\d{8}_\d{6}\.dump$/);
    expect(readFileSync(join(h.config.backup.dir, gps?.name as string), "utf8")).toBe("copia de prueba de gps por reader");
    expect(readdirSync(h.config.backup.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // A backup carries the data of all the accounts: only the backend reads it.
    for (const f of backup.files) expect(statSync(join(h.config.backup.dir, f.name)).mode & 0o777, f.name).toBe(0o600);

    const file = await h.fastify.inject({ method: "GET", url: `/api/admin/backups/${backup.id}/files/${gps?.name}`, headers: { cookie: boss.cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-disposition"]).toBe(`attachment; filename="${gps?.name}"`);
    expect(file.payload).toBe("copia de prueba de gps por reader");
    expect((await admin("GET", `/api/admin/backups/${backup.id}/files/otro.dump`)).status).toBe(404);
    const log = await h.db.core.query(`SELECT action FROM gps.audit_log WHERE user_id = $1 AND action LIKE 'admin.backup%' ORDER BY id`, [boss.userId]);
    expect(log.rows.map((r) => r.action)).toEqual(["admin.backup", "admin.backup_download"]);
  });

  it("if a database cannot be backed up, the whole backup fails, says so and notifies by email", async () => {
    h.config.backup.traccarDatabaseUrl = "postgres://reader:secret@127.0.0.1:1/broken";
    h.config.alertEmail = "operacion@ejemplo.com";
    h.mails.length = 0;
    const before = readdirSync(h.config.backup.dir).length;
    await h.backups.run("manual").catch(() => {});
    const failed = (await info()).backups[0] as Backup;
    expect(failed).toMatchObject({ status: "failed", local: false, files: [] });
    expect(failed.error).toContain("receptor de equipos");
    expect(failed.error).toContain("could not connect");
    expect(readdirSync(h.config.backup.dir).length).toBe(before);
    expect(h.mails.find((m) => m.to === "operacion@ejemplo.com")?.subject).toContain("una copia de seguridad falló");
    h.config.backup.traccarDatabaseUrl = "postgres://reader:secret@127.0.0.1:1/traccar";
    h.config.alertEmail = "";
    expect((await admin("DELETE", `/api/admin/backups/${failed.id}`)).status).toBe(204);
  });

  it("the scheduled backup goes out at its time, only once, and expired ones are deleted", async () => {
    const saved = await save("backups", plan({ retentionDays: 3 }));
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const day = 24 * HOUR;
    const next = nextOf(plan().cron, Date.now());
    expect((await info()).nextAt).toBe(new Date(next).toISOString());
    // Saving the schedule does not trigger a backup, and before the time it does not go out either.
    expect(await h.backups.tick(Date.now())).toBe(false);
    expect(await h.backups.tick(next - 60_000)).toBe(false);
    expect(await h.backups.tick(next + 60_000)).toBe(true);
    expect(await h.backups.tick(next + 120_000)).toBe(false);
    const first = (await info()).backups.find((b) => b.kind === "scheduled") as Backup;
    expect(first).toMatchObject({ status: "ok", startedAt: new Date(next + 60_000).toISOString() });

    // A loose file from the earlier backup, already old, and another recent one.
    const old = join(h.config.backup.dir, "gps_20200101_081500.dump");
    const recent = join(h.config.backup.dir, "traccar_20200102_081500.dump");
    writeFileSync(old, "viejo");
    writeFileSync(recent, "reciente");
    utimesSync(old, new Date(next - 30 * day), new Date(next - 30 * day));
    utimesSync(recent, new Date(next + 4 * day), new Date(next + 4 * day));

    // Four days later the next one goes out; the first has passed its 3 days and is deleted. The manual one stays.
    expect(await h.backups.tick(next + 4 * day + 60_000)).toBe(true);
    const list = (await info()).backups;
    expect(list.filter((b) => b.kind === "scheduled").map((b) => b.id)).not.toContain(first.id);
    expect(list.filter((b) => b.kind === "scheduled")).toHaveLength(1);
    expect(list.filter((b) => b.kind === "manual")).toHaveLength(1);
    for (const f of first.files) expect(existsSync(join(h.config.backup.dir, f.name)), f.name).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);

    // Turned off, it does not go out.
    expect((await save("backups", plan({ scheduled: false }))).status).toBe(200);
    expect((await info()).nextAt).toBeNull();
    expect(await h.backups.tick(next + 30 * day)).toBe(false);
    // A schedule that is not understood, or more frequent than once an hour, is not saved.
    expect((await save("backups", plan({ cron: "a las dos" }))).status).toBe(400);
    const often = await save("backups", plan({ cron: "*/10 * * * *" }));
    expect(often.status).toBe(400);
    expect(often.json.error.message).toContain("demasiado seguido");
    // Any other valid schedule is: Mondays and Thursdays at 03:30.
    expect((await save("backups", plan({ scheduled: true, cron: "30 3 * * 1,4" }))).status).toBe(200);
    expect(new Date((await info()).nextAt as string).getUTCMinutes()).toBe(30);
    expect([1, 4]).toContain(new Date((await info()).nextAt as string).getUTCDay());
    // Resetting the schedule leaves it as it came.
    expect((await admin("DELETE", "/api/admin/settings/backups")).json.settings.backups).toEqual({ scheduled: true, cron: "0 0 * * *", retentionDays: 7, upload: false });
  });

  it("restoring a backup: prior backup, request to the server and a backup list that survives", async () => {
    const dir = h.config.backup.dir;
    expect((await save("backups", plan({ scheduled: false }))).status).toBe(200);
    const target = (await info()).backups.find((b) => b.kind === "manual" && b.status === "ok") as Backup;
    const restore = (body: unknown, id = target.id) => admin("POST", `/api/admin/backups/${id}/restore`, body);

    // The platform restores by itself, without the helper (ADR-0009). Without the word, it is not requested.
    expect(await info()).toMatchObject({ canRestore: true, restore: null });
    expect((await restore({ word: "restaurar" })).status).toBe(400);
    expect((await restore({})).status).toBe(400);
    expect((await h.request("POST", `/api/admin/backups/${target.id}/restore`, { ...as(customer), body: { word: "RESTAURAR" } })).status).toBe(404);
    expect((await restore({ word: "RESTAURAR" }, "019ab000-0000-7000-8000-000000000000")).status).toBe(404);
    expect(existsSync(join(dir, RESTORE_REQUEST))).toBe(false);

    const known = (await info()).backups.map((b) => b.id);
    const before = known.length;
    const asked = await restore({ word: "RESTAURAR" });
    expect(asked.status, JSON.stringify(asked.json)).toBe(202);
    expect(asked.json.info.restore).toMatchObject({ state: "requested", backupId: target.id, backupAt: target.startedAt });
    // While it is being prepared, another is not admitted.
    expect((await restore({ word: "RESTAURAR" })).status).toBe(409);
    await h.backups.idle();

    // Before requesting it, how everything was is saved: there is one more backup.
    const after = (await info()).backups;
    expect(after.length).toBe(before + 1);
    const safety = after.find((b) => !known.includes(b.id)) as Backup;
    expect(safety).toMatchObject({ kind: "pre_restore", status: "ok", local: true });
    // The request says which backup and which files, with names the server checks.
    const note = Object.fromEntries(readFileSync(join(dir, RESTORE_REQUEST), "utf8").trim().split("\n").map((l) => l.split("=")));
    expect(note).toMatchObject({ id: target.id, backup: target.startedAt, gps: target.files[0]?.name, traccar: target.files[1]?.name, files: target.files[2]?.name });
    expect(statSync(join(dir, RESTORE_REQUEST)).mode & 0o777).toBe(0o600);
    expect((await info()).restore).toMatchObject({ state: "requested", backupId: target.id });
    expect((await restore({ word: "RESTAURAR" })).status).toBe(409);
    const log = await h.db.core.query(`SELECT 1 FROM gps.audit_log WHERE user_id = $1 AND action = 'admin.backup_restore'`, [boss.userId]);
    expect(log.rowCount).toBe(1);

    // The platform takes it and restores: the database goes back to how it was, without the backups made afterwards and without knowing about this
    // request (here, one with another time, because audit records cannot be deleted).
    await h.db.core.query(`DELETE FROM gps.backups WHERE id = $1`, [safety.id]);
    await h.db.core.query(`INSERT INTO gps.backups (kind, status) VALUES ('manual', 'failed')`);
    rmSync(join(dir, RESTORE_REQUEST));
    const unseen = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, RESTORE_RUNNING), `id=${target.id}\nbackup=${target.startedAt}\nrequested=${unseen}\n`);
    expect((await info()).restore).toMatchObject({ state: "running", backupId: target.id });
    // On starting, the platform restores the folder's backup list, with the prior backup, and records in the
    // restored database where it came from. Only once.
    await h.backups.reconcile();
    await h.backups.reconcile();
    const noted = () => h.db.core.query<{ user_id: string | null; entity_id: string; detail: object }>(`SELECT user_id, entity_id, detail FROM gps.audit_log WHERE action = 'admin.backup_restored' AND entity_id = $1`, [target.id]);
    expect((await noted()).rows).toEqual([{ user_id: null, entity_id: target.id, detail: { startedAt: target.startedAt, requestedAt: unseen, keptKeys: [] } }]);
    // The restore finishes and says so.
    rmSync(join(dir, RESTORE_RUNNING));
    writeFileSync(join(dir, RESTORE_RESULT), `id=${target.id}\nbackup=${target.startedAt}\nrequested=${note.requested}\nstarted=2026-11-22T10:00:00Z\nfinished=2026-11-22T10:03:00Z\nstatus=ok\nerror=\n`);
    const now = await info();
    expect(now.backups.map((b) => b.id).sort()).toEqual(after.map((b) => b.id).sort());
    expect(now.restore).toMatchObject({ state: "done", backupId: target.id, backupAt: target.startedAt, at: "2026-11-22T10:03:00Z", error: null });
    // If the database was not changed (the request it knows is this one), nothing more is recorded.
    writeFileSync(join(dir, RESTORE_RUNNING), `id=${target.id}\nbackup=${target.startedAt}\nrequested=${note.requested}\n`);
    await h.backups.reconcile();
    rmSync(join(dir, RESTORE_RUNNING));
    expect((await noted()).rowCount).toBe(1);

    // A backup that the restart cut off halfway is left as failed, and the folder's list remembers it.
    const cut = "019ab000-0000-7000-8000-00000000c0de";
    const list = JSON.parse(readFileSync(join(dir, "backups.json"), "utf8")) as Record<string, unknown>[];
    expect(list.map((r) => r.id).sort()).toEqual(after.map((b) => b.id).sort());
    list.push({ ...list[0], id: cut, kind: "scheduled", status: "running", started_at: new Date().toISOString(), finished_at: null, files: [], bytes: 0, local: false });
    writeFileSync(join(dir, "backups.json"), JSON.stringify(list));
    await h.backups.reconcile();
    expect((await info()).backups.find((b) => b.id === cut)).toMatchObject({ status: "failed", error: "El servidor se reinició mientras se hacía" });
    await h.backups.reconcile();
    expect((await info()).backups.find((b) => b.id === cut)).toMatchObject({ status: "failed" });
    expect((await admin("DELETE", `/api/admin/backups/${cut}`)).status).toBe(204);
    // An unreadable list in the folder does not delete the database's.
    const good = readFileSync(join(dir, "backups.json"), "utf8");
    writeFileSync(join(dir, "backups.json"), "{ esto no es una lista");
    await h.backups.reconcile();
    expect((await info()).backups.map((b) => b.id).sort()).toEqual(after.map((b) => b.id).sort());
    expect(readFileSync(join(dir, "backups.json"), "utf8")).toBe(good);

    // If the server could not, it says so with its reason, and it can be requested again.
    writeFileSync(join(dir, RESTORE_RESULT), `id=${target.id}\nbackup=${target.startedAt}\nfinished=2026-11-22T11:00:00Z\nstatus=failed\nreason=incomplete\n`);
    expect((await info()).restore).toMatchObject({ state: "failed", error: "La copia no trae el historial como debe. No se cambió nada." });
    // A code it does not know, or none, says that the server gave no reason; a written reason shows as it is.
    writeFileSync(join(dir, RESTORE_RESULT), `id=${target.id}\nbackup=${target.startedAt}\nstatus=failed\nreason=\n`);
    expect((await info()).restore?.error).toBe("El servidor no dijo por qué");
    writeFileSync(join(dir, RESTORE_RESULT), `id=${target.id}\nbackup=${target.startedAt}\nstatus=failed\nerror=Algo que el ayudante escribió\n`);
    expect((await info()).restore?.error).toBe("Algo que el ayudante escribió");

    // A backup whose files are no longer on the server stops counting as local, and without external storage it is not restored.
    for (const f of safety.files) rmSync(join(dir, f.name));
    await h.backups.reconcile();
    expect((await info()).backups.find((b) => b.id === safety.id)).toMatchObject({ local: false });
    expect((await restore({ word: "RESTAURAR" }, safety.id)).status).toBe(202);
    await h.backups.idle();
    expect((await info()).restore).toMatchObject({ state: "failed", backupId: safety.id });
    expect((await info()).restore?.error).toContain("ya no están en el servidor");
    expect(existsSync(join(dir, RESTORE_REQUEST))).toBe(false);
    rmSync(join(dir, RESTORE_RESULT));
  });

  it("the backup also reaches the external storage, and from there it is downloaded and deleted", async (ctx) => {
    if (!hasS3) return ctx.skip();
    expect(h.config.storage).not.toBeNull();
    expect((await save("backups", plan({ scheduled: false, upload: true }))).status).toBe(200);
    const backup = await h.backups.run("manual", { userId: boss.userId });
    expect(backup).toMatchObject({ status: "ok", local: true, remote: true, remoteError: null });
    const first = backup.files[0] as BackupFile;
    const mark = first.name.slice(4, 19);
    const key = (name: string) => keyOf(h.config.storage as S3Target, `backups/${mark}/${name}`);
    expect(await text((await getObject(S3, key(backup.files[0]?.name as string))).stream)).toBe("copia de prueba de gps por reader");

    // Even if the file is no longer on the server, it is downloaded from the storage.
    for (const f of backup.files) rmSync(join(h.config.backup.dir, f.name));
    const file = await h.fastify.inject({ method: "GET", url: `/api/admin/backups/${backup.id}/files/${backup.files[1]?.name}`, headers: { cookie: boss.cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.payload).toBe("copia de prueba de traccar por reader");

    // Some services leave the folder visibly empty when the last file is deleted: when the backup is deleted it goes too.
    expect((await admin("DELETE", `/api/admin/backups/${backup.id}`)).status).toBe(204);
    await expect(getObject(S3, key(backup.files[0]?.name as string))).rejects.toMatchObject({ status: 404 });
    rcloneDirect("mkdir", "--s3-directory-markers", remoteFolder(`backups/${mark}`));
    expect(everythingIn("backups")).toContain(mark);
    const again = await h.db.core.query<{ id: string }>(
      `INSERT INTO gps.backups (kind, status, started_at, finished_at, files, bytes, local, remote, remote_prefix)
       VALUES ('manual', 'ok', now(), now(), $1::jsonb, $2, false, true, $3) RETURNING id`,
      [JSON.stringify(backup.files), backup.bytes, `backups/${mark}`],
    );
    expect((await admin("DELETE", `/api/admin/backups/${(again.rows[0] as { id: string }).id}`)).status).toBe(204);
    expect(everythingIn("backups")).not.toContain(mark);

    // If the storage fails, the server's backup remains valid and that is stated.
    (h.config.storage as S3Target).secretAccessKey = "clave-equivocada";
    const partial = await h.backups.run("manual", { userId: boss.userId });
    expect(partial).toMatchObject({ status: "ok", local: true, remote: false });
    expect(partial.remoteError).toMatch(/firma|clave/i);
  }, 120_000);

  it("a new installation finds another's backups in the storage, and restores them", async (ctx) => {
    if (!hasS3) return ctx.skip();
    // The previous test left a wrong key: the saved one applies again.
    await h.settings.load();
    const dir = h.config.backup.dir;
    const storage = h.config.storage as S3Target;
    const envHost = h.config.smtp.host;
    expect((await view()).mail.custom).toBe(false);
    expect((await save("backups", plan({ scheduled: false, upload: true }))).status).toBe(200);

    // Another installation left its backups in the storage: one complete, another missing a database, and something that is not a backup.
    const made = await h.backups.run("manual", { userId: boss.userId });
    expect(made).toMatchObject({ status: "ok", remote: true });
    const mark = (made.files[0] as BackupFile).name.slice(4, 19);
    await putObject(storage, keyOf(storage, "backups/20200101_000000/gps_20200101_000000.dump"), Buffer.from("a medias"));
    await putObject(storage, keyOf(storage, "backups/notas.txt"), Buffer.from("no es una copia"));
    await putObject(storage, keyOf(storage, `backups/${mark}/leeme.txt`), Buffer.from("tampoco"));
    // This installation knows nothing of them: they are not in its database or in its folder.
    await h.db.core.query(`DELETE FROM gps.backups`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    expect((await info()).backups).toEqual([]);

    // Only whoever administers the platform searches.
    expect((await h.request("POST", "/api/admin/backups/discover", { ...as(customer), body: {} })).status).toBe(404);
    const found = await admin("POST", "/api/admin/backups/discover", {});
    expect(found.status, JSON.stringify(found.json)).toBe(200);
    expect(found.json).toMatchObject({ found: 1, added: 1 });
    const listed = found.json.info.backups as Backup[];
    const copy = listed[0] as Backup;
    expect(copy).toMatchObject({ kind: "imported", status: "ok", local: false, remote: true, bytes: made.bytes });
    expect(copy.files).toEqual(made.files);
    // The backup's date comes from the name of its files.
    expect(copy.startedAt).toBe(`${mark.slice(0, 4)}-${mark.slice(4, 6)}-${mark.slice(6, 8)}T${mark.slice(9, 11)}:${mark.slice(11, 13)}:${mark.slice(13, 15)}.000Z`);
    // Searching again does not repeat it, and it is not deleted by itself even if it is old.
    expect((await admin("POST", "/api/admin/backups/discover", {})).json).toMatchObject({ found: 1, added: 0 });
    expect((await info()).backups.length).toBe(1);

    // It is downloaded from the console…
    const file = await h.fastify.inject({ method: "GET", url: `/api/admin/backups/${copy.id}/files/${copy.files[0]?.name}`, headers: { cookie: boss.cookie } });
    expect(file.payload).toBe("copia de prueba de gps por reader");
    // …and on restoring it, the platform downloads its files, makes the prior backup and leaves the request.
    const asked = await admin("POST", `/api/admin/backups/${copy.id}/restore`, { word: "RESTAURAR" });
    expect(asked.status, JSON.stringify(asked.json)).toBe(202);
    await h.backups.idle();
    expect((await info()).restore).toMatchObject({ state: "requested", backupId: copy.id });
    for (const f of copy.files) expect(statSync(join(dir, f.name)).size).toBe(f.bytes);
    expect(readFileSync(join(dir, copy.files[0]?.name as string), "utf8")).toBe("copia de prueba de gps por reader");
    expect((await info()).backups.find((b) => b.id === copy.id)).toMatchObject({ local: true, remote: true });
    expect((await info()).backups.map((b) => b.kind).sort()).toEqual(["imported", "pre_restore"]);
    const note = Object.fromEntries(readFileSync(join(dir, RESTORE_REQUEST), "utf8").trim().split("\n").map((l) => l.split("=")));
    expect(note).toMatchObject({ id: copy.id, gps: copy.files[0]?.name, traccar: copy.files[1]?.name, files: copy.files[2]?.name });

    // Next to the request, this server's keys are left, encrypted, so as not to lose them with the restore.
    const keys = join(dir, "restore.settings");
    expect(statSync(keys).mode & 0o777).toBe(0o600);
    expect(readFileSync(keys, "utf8")).not.toContain(S3.secretAccessKey);

    // The server restores: the database is now the other installation's, with its keys encrypted with that one's secret.
    const theirs = createVault("otro-secreto-distinto-de-32-caracteres!!!").seal("clave-del-otro-servidor");
    await h.db.core.query(`UPDATE gps.platform_settings SET value = jsonb_set(value, '{secret}', to_jsonb($1::text)) WHERE section = 'storage'`, [theirs]);
    await h.db.core.query(
      `INSERT INTO gps.platform_settings (section, value) VALUES ('mail', $1::jsonb) ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ custom: true, host: "smtp.viejo.test", port: 587, security: "starttls", user: "viejo", password: theirs, from: "Viejo <v@viejo.test>" })],
    );
    await h.settings.load();
    // As is, the storage is left with no readable key and the email pointing to the other installation's server.
    expect(h.config.storage).toBeNull();
    expect(h.config.smtp.host).toBe("smtp.viejo.test");
    expect((await view()).storage).toMatchObject({ enabled: true, hasSecret: false });

    rmSync(join(dir, RESTORE_REQUEST));
    const unseen = new Date(Date.now() - 30_000).toISOString();
    writeFileSync(join(dir, RESTORE_RUNNING), `id=${copy.id}\nbackup=${copy.startedAt}\nrequested=${unseen}\n`);
    await h.backups.reconcile();
    // On starting over the restored database, the keys this server had still apply.
    expect(h.config.storage).toMatchObject({ bucket: S3.bucket, accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey });
    expect((await view()).storage).toMatchObject({ enabled: true, hasSecret: true });
    expect(h.config.smtp.host).toBe(envHost);
    expect(await stored("mail")).toBe("null");
    const noted = await h.db.core.query<{ detail: { keptKeys: string[] } }>(`SELECT detail FROM gps.audit_log WHERE action = 'admin.backup_restored' AND detail->>'requestedAt' = $1`, [unseen]);
    expect(noted.rows.map((r) => r.detail.keptKeys)).toEqual([["mail", "storage"]]);
    expect(existsSync(keys)).toBe(false);
    // And with them the storage can still be reached.
    await testStorage(h.config.storage as S3Target);

    rmSync(join(dir, RESTORE_RUNNING));
  }, 120_000);
});
