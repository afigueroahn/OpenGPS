// Sets up the platform for the tests: a real local database, a simulated Traccar and
// email captured in memory.
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/api/server";
import { createAuth } from "../src/auth";
import { Bus } from "../src/bus";
import { loadConfig } from "../src/config";
import { LEGAL_VERSION, type LonLat, type SimTrace, metersBetween } from "@opengps/shared";
import { syncCatalog } from "../src/core/catalog";
import { deleteOwnedAccounts } from "../src/core/privacy";
import { createDb } from "../src/db";
import { createEngines } from "../src/engines";
import { type TraccarRow, createIngest } from "../src/ingest/poller";
import type { Mailer } from "../src/mail";
import { findMigrationsDir, migrate } from "../src/migrate";
import type { Traccar } from "../src/traccar";

export const ORIGIN = "http://localhost:5173";
/** The IP the DNS of the tests answers for the gateway's name. */
export const GATEWAY_IP = "203.0.113.10";
/** The owner the platform has in every test: nobody signs in as them. */
export const TEST_OWNER_ID = "test-platform-owner";
const rand = (bytes = 4) => randomBytes(bytes).toString("hex");

export interface TestUser {
  cookie: string;
  email: string;
  password: string;
  userId: string;
  orgId: string;
}

export function fakeTraccar() {
  let next = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  const devices = new Map<string, number>();
  /** Orders the platform sent to the devices, and whether the devices are connected. */
  const sent: { id: number; type: string; attributes: Record<string, unknown> }[] = [];
  const state = { online: true, types: ["engineStop", "engineResume", "positionPeriodic", "custom"] };
  const api: Traccar = {
    async bootstrap() {},
    async signIn() {
      return "JSESSIONID=fake";
    },
    async reboot() {},
    async ready() {
      return true;
    },
    async createDevice(uniqueId, name) {
      const id = devices.get(uniqueId) ?? next++;
      devices.set(uniqueId, id);
      return { id, uniqueId, name };
    },
    async deleteDevice(id) {
      for (const [uniqueId, deviceId] of devices) if (deviceId === id) devices.delete(uniqueId);
    },
    async commandTypes() {
      return state.types;
    },
    async sendCommand(id, type, attributes = {}) {
      if (!state.online) throw new Error("El equipo no está conectado en este momento");
      sent.push({ id, type, attributes });
    },
  };
  return { api, devices, sent, state };
}

export async function createHarness() {
  const config = loadConfig();
  // The platform's own gateway goes by names of its own, so a local test gateway on 127.0.0.1 is "another server".
  config.gatewayHost = "gw.plataforma.prueba";
  config.gatewayIp = GATEWAY_IP;
  // What the tests need different from the factory values (ADR-0010). The address service
  // and the routing one start off: no test reaches the public ones.
  config.geocoder.url = "";
  config.routing.url = "";
  // Who operates the installation under test, shown in the legal texts.
  config.legal.entity = "Operador de Prueba";
  const db = createDb(config);
  await migrate(db.core, findMigrationsDir(config.migrationsDir));
  await syncCatalog(db.core);

  const bus = new Bus();
  // The platform settings are database-wide: each setup starts from the factory ones.
  await db.core.query(`DELETE FROM gps.platform_settings`);
  // Except email: the tests' mail goes to a simulated mailer, with no mail server set up in
  // the console, so the channel is on as an owner who sends email leaves it.
  await db.core.query(`INSERT INTO gps.platform_settings (section, value) VALUES ('channels', '{"email": {"enabled": true}}')`);
  // So are the platform's own notifications and its messages.
  await db.core.query(`DELETE FROM gps.system_notifications`);
  await db.core.query(`DELETE FROM gps.outbox WHERE org_id IS NULL`);
  // The platform has an owner from the start, so that nobody in a test becomes it by signing up first.
  await db.core.query(
    `INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, 'Dueño de pruebas', 'dueno@prueba.test', false, '2000-01-01', '2000-01-01') ON CONFLICT (id) DO NOTHING`,
    [TEST_OWNER_ID],
  );
  await db.core.query(`INSERT INTO gps.platform_owners (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [TEST_OWNER_ID]);
  const mails: { to: string; subject: string; url: string | undefined; body: string; attachments: { filename: string; content: Buffer; contentType: string }[] }[] = [];
  const mailer: Mailer = {
    async send(m) {
      mails.push({ to: m.to, subject: m.subject, url: m.action?.url, body: m.body, attachments: m.attachments ?? [] });
    },
    async verify() {},
  };
  const traccar = fakeTraccar();
  // Simulated address service: records each query it receives.
  const geocoded: [number, number][] = [];
  const geocoder = {
    enabled: true,
    async reverse(lat: number, lon: number) {
      geocoded.push([lat, lon]);
      return "Bulevar de Prueba 123, Centro";
    },
    canSearch: true,
    async search(query: string) {
      return query.includes("nada") ? [] : [{ label: `${query}, Centro`, lat: 14.1, lon: -87.2 }];
    },
  };
  // The device simulator's simulations are platform-wide: each setup starts with none.
  await db.core.query(`DELETE FROM gps.simulations`);
  // Simulated routing service: a path with a point between every two it is asked for, at 36 km/h; it records each query.
  const routed: LonLat[][] = [];
  const routing = {
    enabled: true,
    async trace(points: LonLat[]): Promise<SimTrace> {
      routed.push(points);
      const line = points.flatMap((p, i): LonLat[] => {
        const next = points[i + 1];
        return next ? [p, [(p[0] + next[0]) / 2, (p[1] + next[1]) / 2 + 0.001]] : [p];
      });
      let meters = 0;
      const secs = line.map((p, i) => {
        if (i > 0) meters += metersBetween(line[i - 1] as LonLat, p);
        return Math.round(meters / 10);
      });
      return { line, secs, lengthM: Math.round(meters), seconds: secs[secs.length - 1] as number };
    },
  };
  // Simulated GitHub, for the look for a new version: it answers what a test
  // sets ("down" when it cannot be reached), records each look, and has a
  // clock of its own that a test moves forward.
  const github = {
    reply: { status: 404 } as { status: number; body?: unknown; etag?: string } | "down",
    looks: [] as Record<string, string>[],
    clock: Date.now(),
  };
  // The engines the platform runs, without their clocks: a test gives the
  // simulator its turns by hand and calls each periodic check when it needs it.
  const engines = await createEngines({
    config,
    db,
    bus,
    traccar: traccar.api,
    mailer,
    clocks: false,
    routing,
    updates: {
      now: () => github.clock,
      async fetch(_url, init) {
        github.looks.push(init.headers);
        const reply = github.reply;
        if (reply === "down") throw new Error("GitHub is not reachable");
        return { status: reply.status, headers: { get: (name: string) => (name.toLowerCase() === "etag" ? (reply.etag ?? null) : null) }, json: async () => reply.body };
      },
    },
  });
  const { settings, outbox, system, gate, backups, simulator, updates, events, notifier, antitheft, fuel, maintenance, integrations, reports } = engines;
  const auth = createAuth(
    config,
    db,
    mailer,
    async (userId) => {
      await deleteOwnedAccounts({ db, bus, traccar: traccar.api }, userId);
    },
    { accountCreated: (account) => void system.notify("account_created", { title: "se creó una cuenta nueva", body: `Alguien se registró y creó la cuenta «${account.name}».`, path: "/admin/system/accounts" }) },
  );
  const { fastify, routes } = await buildApp({ config, db, auth, bus, traccar: traccar.api, mailer, geocoder, gate, settings, backups, outbox, system, simulator, updates, gatewayLookup: async () => GATEWAY_IP });
  // They listen to new positions, as in production.
  engines.start();

  /** Enables optional modules on an account, as the platform admin console would. */
  async function enableModules(orgId: string, modules: string[]) {
    await db.core.query(
      `INSERT INTO gps.account_settings (org_id, modules) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET modules = EXCLUDED.modules`,
      [orgId, modules],
    );
    bus.emit("modules_changed", { orgId });
  }
  /** Waits for the core and the modules to finish processing what was received. */
  async function settle() {
    await engines.idle();
  }
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const port = (fastify.server.address() as AddressInfo).port;

  const users: TestUser[] = [];
  const sources: string[] = [];

  async function request(method: string, url: string, opts: { cookie?: string; body?: unknown; origin?: string | null; host?: string } = {}) {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    // The address the request is sent to, when it is not the platform's own.
    if (opts.host) headers.host = opts.host;
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fastify.inject({
      method: method as "GET",
      url,
      headers,
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
    let json: any = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* response without JSON */
    }
    return { status: res.statusCode, json, headers: res.headers };
  }

  const cookiesOf = (setCookie: string | string[] | undefined): string =>
    (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).map((c) => c.split(";")[0]).join("; ");

  /** Registers a user, follows the email link and returns their session. */
  async function signUp(name = "Persona de prueba"): Promise<TestUser> {
    const email = `t-${rand(6)}@prueba.test`;
    const password = `clave-${rand(8)}`;
    const created = await request("POST", "/api/auth/sign-up/email", { body: { name, email, password, callbackURL: "/", legalVersion: LEGAL_VERSION } });
    if (created.status !== 200) throw new Error(`registro falló: ${created.status} ${JSON.stringify(created.json)}`);
    const mail = mails.findLast((m) => m.to === email);
    if (!mail?.url) throw new Error("no llegó el correo de verificación");
    const link = new URL(mail.url);
    const verified = await request("GET", link.pathname + link.search);
    if (verified.status !== 302) throw new Error(`verificación falló: ${verified.status}`);
    const cookie = cookiesOf(verified.headers["set-cookie"] as string | string[] | undefined);
    const me = await request("GET", "/api/me", { cookie });
    if (me.status !== 200) throw new Error(`sesión falló: ${me.status} ${JSON.stringify(me.json)}`);
    const user = { cookie, email, password, userId: me.json.user.id, orgId: me.json.account.id };
    users.push(user);
    return user;
  }

  /** Makes someone an owner of the platform, besides the one every test starts with. */
  async function makeOwner(user: TestUser) {
    await db.core.query(`INSERT INTO gps.platform_owners (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [user.userId]);
  }

  /**
   * A notification of the account that emails everyone about those events
   * (null = every alert). Returns its id and how to turn it off and on.
   */
  async function emailNotification(user: TestUser, events: string[] | null, zone = "UTC") {
    const body = { name: "Correo a todos", channel: "email", everyone: true, events, zone };
    const created = await request("POST", "/api/notifications", { cookie: user.cookie, body });
    if (created.status !== 201) throw new Error(`no se pudo crear el aviso: ${created.status} ${JSON.stringify(created.json)}`);
    const id = (created.json.notifications as { id: string }[]).at(-1)?.id as string;
    return { id, set: (active: boolean) => request("PUT", `/api/notifications/${id}`, { cookie: user.cookie, body: { ...body, active } }) };
  }

  /** Ingestion with positions supplied by the test instead of the Traccar database. */
  function ingestFrom(feed: TraccarRow[]) {
    const source = `test-${rand(6)}`;
    sources.push(source);
    return createIngest({
      db,
      bus,
      source,
      read: async (cursor, limit) => feed.filter((r) => r.id > cursor).slice(0, limit),
    });
  }

  async function close() {
    const orgIds = users.map((u) => u.orgId);
    await db.core.query(`DELETE FROM gps.positions WHERE device_id IN (SELECT id FROM gps.devices WHERE org_id = ANY($1::text[]))`, [orgIds]);
    // The audit log is immutable: its purge is declared inside the transaction.
    const client = await db.core.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL gps.audit_purge = 'on'");
      await client.query(`DELETE FROM gps.audit_log WHERE org_id = ANY($1::text[])`, [orgIds]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await db.core.query(`DELETE FROM auth.organization WHERE id = ANY($1::text[])`, [orgIds]);
    await db.core.query(`DELETE FROM auth."user" WHERE id = ANY($1::text[])`, [users.map((u) => u.userId)]);
    await db.core.query(`DELETE FROM gps.ingest_cursor WHERE source = ANY($1::text[])`, [sources]);
    await engines.stop();
    await backups.idle();
    await outbox.idle();
    simulator.stop();
    await simulator.idle();
    await db.core.query(`DELETE FROM gps.simulations`);
    await db.core.query(`DELETE FROM gps.platform_settings`);
    await fastify.close();
    await db.close();
  }

  return { config, db, bus, auth, fastify, port, mails, traccar, geocoded, routed, github, events, notifier, outbox, system, emailNotification, antitheft, fuel, maintenance, integrations, reports, settings, backups, simulator, enableModules, settle, routes, request, signUp, makeOwner, ingestFrom, close, uniqueId: () => `9${Date.now() % 1e8}${rand(3)}`.slice(0, 15) };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

let nextRowId = 1;
/** Row like those of tc_positions. Speed is in knots, as in Traccar. */
export function traccarRow(
  deviceid: number,
  o: { fix: Date; lat?: number; lon?: number; knots?: number; settled?: boolean; valid?: boolean; attributes?: object; id?: number; protocol?: string },
): TraccarRow {
  return {
    id: o.id ?? nextRowId++,
    deviceid,
    protocol: o.protocol ?? "h02",
    servertime: new Date(),
    fixtime: o.fix,
    valid: o.valid ?? true,
    latitude: o.lat ?? -12.05,
    longitude: o.lon ?? -77.03,
    altitude: 120,
    speed: o.knots ?? 0,
    course: 90,
    accuracy: 0,
    attributes: JSON.stringify(o.attributes ?? {}),
    settled: o.settled ?? true,
  };
}
