// Platform API: everything hangs under /api.
import websocket from "@fastify/websocket";
import {
  accountAdminSchema,
  accountNotificationSchema,
  ALERT_EVENTS,
  alertRuleSchema,
  API_VERSION,
  type ApiError,
  attachDeviceSchema,
  createVehicleSchema,
  EXPORT_FORMATS,
  geofenceSchema,
  groupSchema,
  inviteSchema,
  type Language,
  LANGUAGES,
  LEGAL_VERSION,
  accountNameSchema,
  isConfirmWord,
  type Me,
  memberUpdateSchema,
  type ModuleKey,
  parkSchema,
  passwordProblem,
  type Permission,
  type PublicConfig,
  roleSchema,
  shareSchema,
  shareViewSchema,
  updateVehicleSchema,
  USER_PHOTO_MAX_BYTES,
  USER_PHOTO_TYPES,
  userSettingsSchema,
  issueSay,
} from "@opengps/shared";
import { fromNodeHeaders } from "better-auth/node";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { type Auth, CLIENT_IP_HEADER, OWN_ORIGIN_HEADER, type SessionContext } from "../auth";
import type { Bus } from "../bus";
import type { Config } from "../config";
import { listAccounts, listRoles, requirePermission, requireUnrestricted } from "../core/access";
import { createAlert, deleteAlert, listAlerts, updateAlert } from "../core/alerts";
import { audit, listAudit, listPlatformAudit } from "../core/audit";
import { deviceCatalog } from "../core/catalog";
import { listEvents } from "../core/events";
import { type HostLookup, createGatewayAddress } from "../core/gateway";
import { exportHistory } from "../core/export";
import { createGeofence, deleteGeofence, listGeofences, updateGeofence } from "../core/geofences";
import { type Geocoder, createGeocoder } from "../core/geocode";
import { createGroup, deleteGroup, listGroups, renameGroup } from "../core/groups";
import { loadHistory, toVehicleHistory } from "../core/history";
import {
  type MemberDeps,
  applyInvitationAccess,
  cancelInvitation,
  createRole,
  deleteRole,
  invite,
  listInvitations,
  listMembers,
  previewInvitation,
  rememberAccount,
  removeMember,
  updateMember,
  updateRole,
} from "../core/members";
import { createShare, listShares, revokeShare, viewShared } from "../core/share";
import { accountSummary } from "../core/summary";
import { type PrivacyDeps, deleteAccountByAdmin, deleteUserByAdmin, hasConsent, leaveAccount, recordConsent } from "../core/privacy";
import { type PlatformDeps, getAccountDetail, listAllAccounts, platformStats, setUserBanned, updateAccount } from "../core/platform";
import { deletePhoto, photoUrlOf, readPhoto, savePhoto } from "../core/photos";
import {
  type Actor,
  type VehicleDeps,
  attachDevice,
  createVehicle,
  deleteVehicle,
  getVehicle,
  listVehicles,
  recentTrack,
  removeDevice,
  setParked,
  updateVehicle,
} from "../core/vehicles";
import type { Db } from "../db";
import { AppError, badRequest, forbidden, notFound, tooMany, unauthorized } from "../errors";
import type { Ingest } from "../ingest/poller";
import { registerAntitheft } from "../modules/antitheft";
import { registerFuel } from "../modules/fuel";
import { registerDrivers } from "../modules/drivers";
import { registerDiagnostics } from "../modules/diagnostics";
import { registerFleet } from "../modules/fleet";
import { registerIntegrations } from "../modules/integrations";
import { registerMaintenance } from "../modules/maintenance";
import { registerRoutes } from "../modules/routes";
import { registerReports } from "../modules/reports";
import type { ModuleContext } from "../modules/context";
import type { ModuleGate } from "../modules/gate";
import type { Mailer } from "../mail";
import type { Traccar } from "../traccar";
import type { Backups } from "../core/backups";
import { signInButtons } from "../core/oauth";
import type { Settings } from "../core/settings";
import type { Updates } from "../core/updates";
import { type LiveHub, createLiveHub } from "./live";
import { deleteNotification, listNotifications, notificationLog, notificationOptions, saveNotification, testNotification } from "../core/notifications";
import type { Outbox } from "../core/outbox";
import type { SystemNotifier } from "../core/system";
import { headerLanguage, isServerKey, knownLanguage, render, say, shared, tr } from "../i18n";
import type { Simulator } from "../simulator/manager";
import { registerPlatformSettings } from "./platform";
import { registerSimulator } from "./simulator";
import { registerUpdates } from "./updates";
import { registerWeb } from "./web";

export interface AppDeps {
  config: Config;
  db: Db;
  auth: Auth;
  bus: Bus;
  traccar: Traccar;
  mailer: Mailer;
  ingest?: Ingest;
  geocoder?: Geocoder;
  /** Modules enabled per account. Shared by the API and each module's engines. */
  gate: ModuleGate;
  /** Platform settings, already loaded, and backups. */
  settings: Settings;
  backups: Backups;
  /** Where every message that leaves the platform waits, and the platform's own notifications. */
  outbox: Outbox;
  system: SystemNotifier;
  /** The device simulator of the admin console. */
  simulator: Simulator;
  /** Looks for a newer version of the platform. */
  updates: Updates;
  /** Where a name points in the DNS, to know the IP of the device gateway. */
  gatewayLookup?: HostLookup;
}

export interface App {
  fastify: FastifyInstance;
  live: LiveHub;
  /** Routes served by the API, such as "GET /api/vehicles". The contract test compares them. */
  routes: string[];
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    // The shared schemas write the key of their text, and so do the API's own; zod's own messages come as they are.
    const issue = result.error.issues[0];
    const said = issue ? issueSay(issue) : null;
    throw badRequest(said ? shared(said) : issue && isServerKey(issue.message) ? say(issue.message) : (issue?.message ?? say("api.errors.invalidData")));
  }
  return result.data;
}

const trackQuery = z.object({
  minutes: z.coerce.number().int().min(1).max(24 * 60).default(60),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
const historyQuery = z.object({
  from: z.coerce.date("api.validation.fromNeeded"),
  to: z.coerce.date("api.validation.toNeeded"),
});
const exportQuery = historyQuery.extend({
  format: z.enum(EXPORT_FORMATS, "api.validation.formatUnavailable"),
  zone: z.string().trim().min(1).max(64).default("UTC"),
});
const geocodeSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  vehicleId: z.string().optional(),
  geofenceId: z.string().optional(),
  /** With "1", only those that need attention. */
  alerts: z.enum(["0", "1"]).default("0"),
});
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});
const activeAccountSchema = z.object({ accountId: z.string().min(1) });
const consentSchema = z.object({ version: z.literal(LEGAL_VERSION, "api.validation.legalVersion") });
const adminListQuery = z.object({
  search: z.string().trim().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const banSchema = z.object({ banned: z.boolean(), reason: z.string().trim().max(200).optional() });

/** Where Apple sends the person back from. */
const APPLE_ORIGIN = "https://appleid.apple.com";

/** Parts of the session library that are not exposed: the platform has its own rules for them. */
const BLOCKED_AUTH_PATHS = ["/api/auth/organization/", "/api/auth/admin/"];

type IdParams = { Params: { id: string } };

/** Shared-link lookups accepted per IP each minute. The page asks for the position every few seconds. */
export const SHARE_VIEWS_PER_MINUTE = 120;

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config, db, auth, bus, gate, settings, outbox, system, backups, simulator } = deps;
  const vehicleDeps: VehicleDeps = { db, bus, traccar: deps.traccar, config };
  const memberDeps: MemberDeps = { db, bus, mailer: deps.mailer, config };
  const platformDeps: PlatformDeps = { db, bus, config };
  const privacyDeps: PrivacyDeps = { db, bus, traccar: deps.traccar };
  const live = createLiveHub(bus);
  const geocoder = deps.geocoder ?? createGeocoder(config, db.core);
  const notifyDeps = { db, bus, config, outbox };
  const gateway = createGatewayAddress(config, deps.gatewayLookup);
  void gateway.refresh();

  const app = Fastify({
    logger: config.env === "test" ? false : { level: config.isProduction ? "warn" : "info" },
    // Serving the web app itself, the backend is what visitors reach: it only believes the visitor's IP that a
    // proxy writes when that proxy is on a private network (a Cloudflare tunnel or Dokploy's, in Docker). In
    // development Vite is in front.
    trustProxy: config.webDir ? ["loopback", "linklocal", "uniquelocal"] : true,
    bodyLimit: 256 * 1024,
  });
  if (config.webDir) {
    // The header with the visitor's IP is the backend's own then: whatever the visitor sends in it is replaced.
    app.addHook("onRequest", async (request) => {
      request.headers[CLIENT_IP_HEADER] = request.ip;
    });
  }

  // A POST without a body but with a JSON header is valid (for example, signing out).
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (!body) return done(null, undefined);
    parseJson(request, body as string, done);
  });
  // Apple sends the person back with a form; it goes to the session library as it came.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));

  // The services people sign in with change from the console: the session library picks them up then.
  bus.on("settings_changed", ({ section }) => {
    if (section === "oauth") auth.reload();
  });

  const routes: string[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      // HEAD is added by the server to every GET; it is not a contract route.
      if (method !== "HEAD") routes.push(`${method} ${route.url}`);
    }
  });

  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  // The language a request is answered in: the one the app says it is showing, the one the
  // person chose, the one their browser asks for or, failing all that, the platform's.
  const chosen = new WeakMap<FastifyRequest, Language>();
  const languageOf = (request: FastifyRequest): Language =>
    knownLanguage(request.headers["x-language"]) ?? chosen.get(request) ?? headerLanguage(request.headers["accept-language"]) ?? config.defaultLanguage;

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({ error: { code: error.code, message: render(languageOf(request), error.text) } } satisfies ApiError);
    }
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) request.log.error(error);
    return reply.status(status).send({
      error: {
        code: status === 500 ? "internal" : "invalid_request",
        message: tr(languageOf(request), status === 500 ? "api.errors.internal" : "api.errors.badRequest"),
      },
    } satisfies ApiError);
  });
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: tr(languageOf(request), "api.errors.notFound") } } satisfies ApiError),
  );

  /**
   * Whether a page is the web app itself: the platform's address, or the very address this request was sent to,
   * whichever the platform was opened by (an IP, another domain). Any other website is not.
   */
  const fromItself = (request: FastifyRequest, origin: string): boolean => {
    if (origin === config.publicUrl) return true;
    try {
      return new URL(origin).host === request.host;
    } catch {
      return false;
    }
  };
  // A request that changes data is only accepted from the web app itself.
  app.addHook("onRequest", async (request) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const origin = request.headers.origin;
    // Apple sends the person back by posting from its own page: the session library turns it into a visit to the platform.
    if (origin === APPLE_ORIGIN && request.url.startsWith("/api/auth/callback/apple")) return;
    if (origin && !fromItself(request, origin)) throw forbidden(say("api.errors.origin"));
  });

  const clientIp = (request: FastifyRequest): string => {
    const header = request.headers[CLIENT_IP_HEADER];
    return (Array.isArray(header) ? header[0] : header) ?? request.ip;
  };

  /**
   * Session of the request. With `permission`, also requires that permission on the
   * active account. A suspended account cannot be used, except on the few
   * routes that pass `allowSuspended` so the user can see it and switch accounts.
   */
  async function session(request: FastifyRequest, permission?: Permission, opts: { allowSuspended?: boolean } = {}): Promise<SessionContext> {
    const ctx = await auth.sessionContext(request.headers);
    if (!ctx) throw unauthorized();
    if (ctx.language) chosen.set(request, ctx.language);
    if (ctx.suspended && !opts.allowSuspended) {
      throw new AppError(403, "account_suspended", say("api.errors.accountSuspended"));
    }
    if (permission) requirePermission(ctx, permission);
    return ctx;
  }

  /** Only for those who administer the platform. To everyone else, the console does not exist. */
  async function platformAdmin(request: FastifyRequest): Promise<SessionContext> {
    const ctx = await auth.sessionContext(request.headers);
    if (!ctx) throw unauthorized();
    if (!ctx.platformAdmin) throw notFound();
    return ctx;
  }
  // Brake on anyone trying to guess links or load the page without limit: lookups per IP and minute.
  const viewLog = new Map<string, number[]>();
  const allowView = (ip: string): boolean => {
    const now = Date.now();
    const recent = (viewLog.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (viewLog.size > 20_000) viewLog.clear();
    if (recent.length >= SHARE_VIEWS_PER_MINUTE) {
      viewLog.set(ip, recent);
      return false;
    }
    viewLog.set(ip, [...recent, now]);
    return true;
  };
  const userSettings = async (userId: string): Promise<Me["settings"]> => {
    const r = await db.core.query<{ theme: "light" | "dark" | null; language: string | null; phone: string | null }>(`SELECT theme, language, phone FROM gps.user_settings WHERE user_id = $1`, [userId]);
    const row = r.rows[0];
    const language = LANGUAGES.find((l) => l === row?.language) ?? null;
    return { theme: row?.theme ?? "system", language, phone: row?.phone ?? null };
  };
  /** Whether the person has a password: whoever only signs in with another service has none. */
  const hasPassword = async (userId: string): Promise<boolean> => {
    const r = await db.core.query(`SELECT 1 FROM auth.account WHERE "userId" = $1 AND "providerId" = 'credential' AND password IS NOT NULL LIMIT 1`, [userId]);
    return (r.rowCount ?? 0) > 0;
  };
  /** With registration closed, only those with a current invitation to their email can sign up. */
  const hasInvitation = async (email: string): Promise<boolean> => {
    const r = await db.core.query(`SELECT 1 FROM auth.invitation WHERE lower(email) = lower($1) AND status = 'pending' AND "expiresAt" > now() LIMIT 1`, [email.trim()]);
    return (r.rowCount ?? 0) > 0;
  };
  const checkPassword = (password: unknown): void => {
    const problem = passwordProblem(typeof password === "string" ? password : "", config.passwordPolicy);
    if (problem) throw new AppError(400, "password_policy", shared(problem));
  };
  const actorOf = (ctx: SessionContext, request: FastifyRequest): Actor => ({
    orgId: ctx.orgId,
    groups: ctx.groups,
    vehicles: ctx.vehicles,
    userId: ctx.userId,
    ip: clientIp(request),
  });

  // ─── Public ────────────────────────────────────────────────────────────────

  app.get("/api/health", async (_request, reply) => {
    try {
      await db.core.query("SELECT 1");
    } catch {
      return reply.status(503).send({ ok: false });
    }
    return { ok: true, version: config.appVersion, ingest: deps.ingest?.status() ?? null, live: live.connections() };
  });

  app.get("/api/config", async (): Promise<PublicConfig> => {
    gateway.touch();
    return publicConfig();
  });
  const publicConfig = (): PublicConfig => ({
    apiVersion: API_VERSION,
    version: config.appVersion,
    appName: config.appName,
    defaultLanguage: config.defaultLanguage,
    mapStyleUrl: config.mapStyleUrl,
    gatewayHost: config.gatewayHost,
    gatewayIp: config.gatewayIp,
    claimWindowMinutes: config.claimWindowMinutes,
    geocoding: geocoder.enabled,
    legal: { version: LEGAL_VERSION, ...config.legal },
    registrationOpen: config.registrationOpen,
    signIn: signInButtons(config),
    passwordPolicy: config.passwordPolicy,
    maxUploadMb: config.maxUploadMb,
  });

  // ─── Session: sign-up, login, verification and password ────────────────────

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      if (BLOCKED_AUTH_PATHS.some((p) => request.url.startsWith(p))) throw notFound();
      const url = new URL(request.url, config.publicUrl);
      const hasBody = request.method !== "GET" && request.body !== undefined && request.body !== null;
      // A form (Apple's) goes as it came; anything else, as JSON.
      const raw = typeof request.body === "string";
      // What the platform settings fix is checked before passing to the session library.
      if (request.method === "POST") {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const path = url.pathname.slice("/api/auth".length);
        if (path === "/sign-up/email") {
          if (!config.registrationOpen && !(await hasInvitation(String(body.email ?? "")))) {
            throw new AppError(403, "registration_closed", say("api.errors.registrationClosed"));
          }
          checkPassword(body.password);
        }
        if (path === "/reset-password" || path === "/change-password") checkPassword(body.newPassword);
      }
      const headers = fromNodeHeaders(request.headers);
      // The session library is told here which page asks, when it is the web app at another of its addresses:
      // only here is it known which address the request was sent to. Whatever the visitor writes in it is replaced.
      const origin = request.headers.origin;
      headers.delete(OWN_ORIGIN_HEADER);
      if (origin && fromItself(request, origin)) headers.set(OWN_ORIGIN_HEADER, origin);
      const response = await auth.auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          ...(hasBody ? { body: raw ? (request.body as string) : JSON.stringify(request.body) } : {}),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      return reply.send(response.body ? await response.text() : null);
    },
  });

  // ─── With a session ────────────────────────────────────────────────────────

  app.get("/api/me", async (request): Promise<Me> => {
    const ctx = await session(request, undefined, { allowSuspended: true });
    return {
      user: {
        id: ctx.userId,
        name: ctx.userName,
        email: ctx.email,
        platformAdmin: ctx.platformAdmin,
        hasPassword: await hasPassword(ctx.userId),
        photoUrl: await photoUrlOf(db.core, ctx.userId),
      },
      account: {
        id: ctx.orgId,
        name: ctx.orgName,
        role: ctx.role,
        roleName: ctx.roleName,
        permissions: ctx.permissions,
        groups: ctx.groups,
        vehicles: ctx.vehicles,
        suspended: ctx.suspended,
        modules: ctx.modules,
      },
      accounts: await listAccounts(db.core, ctx.userId),
      needsConsent: !(await hasConsent(db.core, ctx.userId, LEGAL_VERSION)),
      settings: await userSettings(ctx.userId),
    };
  });

  /** The person's preferences: color mode, language and the phone they are notified on. Only what is sent changes. */
  app.put("/api/me/settings", async (request, reply) => {
    const ctx = await session(request, undefined, { allowSuspended: true });
    const sent = parse(userSettingsSchema, request.body);
    // "system" is stored as no preference: the device decides.
    const theme = sent.theme === undefined || sent.theme === "system" ? null : sent.theme;
    // The name is the person's, in every account they are in.
    if (sent.name !== undefined) await db.core.query(`UPDATE auth."user" SET name = $2, "updatedAt" = now() WHERE id = $1`, [ctx.userId, sent.name]);
    await db.core.query(
      `INSERT INTO gps.user_settings (user_id, phone, theme, language) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         phone = CASE WHEN $7 THEN $2 ELSE gps.user_settings.phone END,
         theme = CASE WHEN $5 THEN $3 ELSE gps.user_settings.theme END,
         language = CASE WHEN $6 THEN $4 ELSE gps.user_settings.language END`,
      [ctx.userId, sent.phone ?? null, theme, sent.language ?? null, sent.theme !== undefined, sent.language !== undefined, sent.phone !== undefined],
    );
    return reply.status(204).send();
  });

  /** Renames the account. Its owner and its administrators do it. */
  app.patch("/api/account", async (request, reply) => {
    const ctx = await session(request);
    if (ctx.role !== "owner" && ctx.role !== "admin") throw forbidden(say("api.account.renameOwnerOnly"));
    const { name } = parse(accountNameSchema, request.body);
    if (name !== ctx.orgName) {
      await db.core.query(`UPDATE auth.organization SET name = $2 WHERE id = $1`, [ctx.orgId, name]);
      await audit(db.core, actorOf(ctx, request), "account.rename", "account", ctx.orgId, { name, before: ctx.orgName });
    }
    return reply.status(204).send();
  });

  /** Records that the person accepted the current terms and policy. */
  app.post("/api/consent", async (request, reply) => {
    const ctx = await session(request, undefined, { allowSuspended: true });
    const { version } = parse(consentSchema, request.body);
    await recordConsent(db.core, ctx.userId, version, clientIp(request));
    return reply.status(204).send();
  });

  /** An invited person leaves the account they are working in. */
  app.post("/api/accounts/leave", async (request, reply) => {
    const ctx = await session(request, undefined, { allowSuspended: true });
    await leaveAccount(privacyDeps, { orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, email: ctx.email, ip: clientIp(request) });
    return reply.status(204).send();
  });

  /** Switches the account being worked in. */
  app.post("/api/accounts/active", async (request, reply) => {
    const ctx = await session(request, undefined, { allowSuspended: true });
    const { accountId } = parse(activeAccountSchema, request.body);
    const accounts = await listAccounts(db.core, ctx.userId);
    if (!accounts.some((a) => a.id === accountId)) throw notFound(say("api.errors.notYourAccount"));
    await auth.setActiveAccount(request.headers, accountId);
    await rememberAccount(db.core, ctx.userId, accountId);
    return reply.status(204).send();
  });

  app.get("/api/device-models", async (request) => {
    await session(request);
    return { models: deviceCatalog(languageOf(request)) };
  });

  // ─── Vehicles ──────────────────────────────────────────────────────────────

  app.get("/api/vehicles", async (request) => {
    const ctx = await session(request);
    return { vehicles: await listVehicles(db.core, ctx) };
  });

  app.post("/api/vehicles", async (request, reply) => {
    const ctx = await session(request, "vehicles.manage");
    const input = parse(createVehicleSchema, request.body);
    const vehicle = await createVehicle(vehicleDeps, actorOf(ctx, request), input);
    return reply.status(201).send({ vehicle });
  });

  app.get<IdParams>("/api/vehicles/:id", async (request) => {
    const ctx = await session(request);
    return { vehicle: await getVehicle(db.core, ctx, request.params.id) };
  });

  app.patch<IdParams>("/api/vehicles/:id", async (request) => {
    const ctx = await session(request, "vehicles.manage");
    const patch = parse(updateVehicleSchema, request.body);
    return { vehicle: await updateVehicle(vehicleDeps, actorOf(ctx, request), request.params.id, patch) };
  });

  app.delete<IdParams>("/api/vehicles/:id", async (request, reply) => {
    const ctx = await session(request, "vehicles.manage");
    await deleteVehicle(vehicleDeps, actorOf(ctx, request), request.params.id);
    return reply.status(204).send();
  });

  app.post<IdParams>("/api/vehicles/:id/device", async (request, reply) => {
    const ctx = await session(request, "vehicles.manage");
    const input = parse(attachDeviceSchema, request.body);
    const vehicle = await attachDevice(vehicleDeps, actorOf(ctx, request), request.params.id, input);
    return reply.status(201).send({ vehicle });
  });

  app.delete<IdParams>("/api/vehicles/:id/device", async (request) => {
    const ctx = await session(request, "vehicles.manage");
    return { vehicle: await removeDevice(vehicleDeps, actorOf(ctx, request), request.params.id) };
  });

  app.post<IdParams>("/api/vehicles/:id/park", async (request) => {
    const ctx = await session(request, "vehicles.manage");
    const { parked } = parse(parkSchema, request.body);
    const vehicle = await setParked(vehicleDeps, actorOf(ctx, request), request.params.id, parked);
    // The event engine re-reads where it was parked.
    bus.emit("alerts_changed", { orgId: ctx.orgId });
    return { vehicle };
  });

  app.get<IdParams>("/api/vehicles/:id/track", async (request) => {
    const ctx = await session(request);
    const query = parse(trackQuery, request.query);
    return { points: await recentTrack(db.core, ctx, request.params.id, query) };
  });

  app.get<IdParams>("/api/vehicles/:id/address", async (request) => {
    const ctx = await session(request);
    const vehicle = await getVehicle(db.core, ctx, request.params.id);
    const { lat, lon } = vehicle.state ?? {};
    if (!geocoder.enabled || lat == null || lon == null) return { address: null };
    return { address: await geocoder.reverse(lat, lon) };
  });

  // ─── Trip history ──────────────────────────────────────────────────────────

  app.get<IdParams>("/api/vehicles/:id/history", async (request) => {
    const ctx = await session(request);
    const range = parse(historyQuery, request.query);
    const data = await loadHistory(db.core, ctx, request.params.id, range, { addresses: geocoder.enabled });
    return { history: toVehicleHistory(data) };
  });

  app.get<IdParams>("/api/vehicles/:id/history/export", async (request, reply) => {
    const ctx = await session(request);
    const { format, zone, ...range } = parse(exportQuery, request.query);
    const data = await loadHistory(db.core, ctx, request.params.id, range, { addresses: geocoder.enabled });
    const file = await exportHistory(format, data, { zone, appName: config.appName, language: languageOf(request) });
    // Taking history out of the platform is logged.
    await audit(db.core, actorOf(ctx, request), "history.export", "vehicle", data.vehicle.id, {
      name: data.vehicle.name,
      format,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    });
    return reply
      .header("Content-Type", file.contentType)
      .header("Content-Disposition", `attachment; filename="${file.filename}"`)
      .header("Cache-Control", "private, no-store")
      .send(file.body);
  });

  /** Approximate address of a history point. It goes in the body so the coordinate does not end up in the access logs. */
  app.post("/api/geocode", async (request) => {
    await session(request);
    const { lat, lon } = parse(geocodeSchema, request.body);
    return { address: geocoder.enabled ? await geocoder.reverse(lat, lon) : null };
  });

  // ─── Geofences and events ──────────────────────────────────────────────────

  app.get("/api/geofences", async (request) => {
    const ctx = await session(request);
    return { geofences: await listGeofences(db.core, ctx) };
  });

  app.post("/api/geofences", async (request, reply) => {
    const ctx = await session(request, "geofences.manage");
    const input = parse(geofenceSchema, request.body);
    return reply.status(201).send({ geofence: await createGeofence({ db, bus }, actorOf(ctx, request), input) });
  });

  app.put<IdParams>("/api/geofences/:id", async (request) => {
    const ctx = await session(request, "geofences.manage");
    const input = parse(geofenceSchema, request.body);
    return { geofence: await updateGeofence({ db, bus }, actorOf(ctx, request), request.params.id, input) };
  });

  app.delete<IdParams>("/api/geofences/:id", async (request, reply) => {
    const ctx = await session(request, "geofences.manage");
    await deleteGeofence({ db, bus }, actorOf(ctx, request), request.params.id);
    return reply.status(204).send();
  });

  app.get("/api/events", async (request) => {
    const ctx = await session(request);
    const { alerts, ...filter } = parse(eventsQuery, request.query);
    return { events: await listEvents(db.core, ctx, { ...filter, types: alerts === "1" ? ALERT_EVENTS : undefined }) };
  });

  // ─── Shared location ───────────────────────────────────────────────────────

  app.get<IdParams>("/api/vehicles/:id/shares", async (request) => {
    const ctx = await session(request, "links.share");
    return { links: await listShares(db.core, ctx, request.params.id) };
  });

  app.post<IdParams>("/api/vehicles/:id/shares", async (request, reply) => {
    const ctx = await session(request, "links.share");
    const input = parse(shareSchema, request.body);
    // The link's key travels only once, in this response.
    return reply
      .status(201)
      .header("Cache-Control", "no-store")
      .send(await createShare({ db, bus }, actorOf(ctx, request), request.params.id, input));
  });

  app.delete<IdParams>("/api/shares/:id", async (request, reply) => {
    const ctx = await session(request, "links.share");
    await revokeShare({ db, bus }, actorOf(ctx, request), request.params.id);
    return reply.status(204).send();
  });

  /**
   * What someone sees when opening a link, without a session. The key goes in the body so
   * it does not end up in the access logs. A link that does not exist, expired or
   * was revoked responds the same way.
   */
  app.post("/api/share/view", async (request, reply) => {
    if (!allowView(clientIp(request))) throw tooMany(say("api.errors.tooManyLookups"));
    const parsed = shareViewSchema.safeParse(request.body);
    const view = parsed.success ? await viewShared(db.core, parsed.data.token) : null;
    if (!view) throw notFound(say("api.errors.shareGone"));
    return reply.header("Cache-Control", "no-store").send({ view });
  });

  // ─── Alerts ────────────────────────────────────────────────────────────────

  app.get("/api/alerts", async (request) => {
    const ctx = await session(request);
    return { alerts: await listAlerts(db.core, ctx, config.defaultLanguage) }; // i18n: stored text
  });

  app.post("/api/alerts", async (request, reply) => {
    const ctx = await session(request, "alerts.manage");
    const input = parse(alertRuleSchema, request.body);
    return reply.status(201).send({ alert: await createAlert({ db, bus }, actorOf(ctx, request), input) });
  });

  app.put<IdParams>("/api/alerts/:id", async (request) => {
    const ctx = await session(request, "alerts.manage");
    const input = parse(alertRuleSchema, request.body);
    return { alert: await updateAlert({ db, bus }, actorOf(ctx, request), request.params.id, input) };
  });

  app.delete<IdParams>("/api/alerts/:id", async (request, reply) => {
    const ctx = await session(request, "alerts.manage");
    await deleteAlert({ db, bus }, actorOf(ctx, request), request.params.id);
    return reply.status(204).send();
  });

  // ─── Groups ────────────────────────────────────────────────────────────────

  app.get("/api/groups", async (request) => {
    const ctx = await session(request);
    const groups = await listGroups(db.core, ctx.orgId);
    // Someone with group scope only sees their own.
    return { groups: ctx.groups === null ? groups : groups.filter((g) => ctx.groups?.includes(g.id)) };
  });

  app.post("/api/groups", async (request, reply) => {
    const ctx = await session(request, "vehicles.manage");
    requireUnrestricted(ctx);
    const { name } = parse(groupSchema, request.body);
    return reply.status(201).send({ group: await createGroup({ db, bus }, actorOf(ctx, request), name) });
  });

  app.patch<IdParams>("/api/groups/:id", async (request) => {
    const ctx = await session(request, "vehicles.manage");
    requireUnrestricted(ctx);
    const { name } = parse(groupSchema, request.body);
    await renameGroup({ db, bus }, actorOf(ctx, request), request.params.id, name);
    return { groups: await listGroups(db.core, ctx.orgId) };
  });

  app.delete<IdParams>("/api/groups/:id", async (request, reply) => {
    const ctx = await session(request, "vehicles.manage");
    requireUnrestricted(ctx);
    await deleteGroup({ db, bus }, actorOf(ctx, request), request.params.id);
    return reply.status(204).send();
  });

  // ─── Account users ─────────────────────────────────────────────────────────

  app.get("/api/members", async (request) => {
    const ctx = await session(request, "members.manage");
    return {
      members: await listMembers(db.core, ctx.orgId, ctx.userId, languageOf(request)),
      invitations: await listInvitations(db.core, ctx.orgId, languageOf(request)),
      roles: await listRoles(db.core, ctx.orgId, languageOf(request)),
    };
  });

  app.post("/api/members/invitations", async (request, reply) => {
    const ctx = await session(request, "members.manage");
    const input = parse(inviteSchema, request.body);
    const invitation = await invite(memberDeps, { ...actorOf(ctx, request), userName: ctx.userName, orgName: ctx.orgName }, input, languageOf(request));
    return reply.status(201).send({ invitation });
  });

  app.delete<IdParams>("/api/members/invitations/:id", async (request, reply) => {
    const ctx = await session(request, "members.manage");
    await cancelInvitation(memberDeps, actorOf(ctx, request), request.params.id);
    return reply.status(204).send();
  });

  app.patch<IdParams>("/api/members/:id", async (request, reply) => {
    const ctx = await session(request, "members.manage");
    await updateMember(memberDeps, actorOf(ctx, request), request.params.id, parse(memberUpdateSchema, request.body));
    return reply.status(204).send();
  });

  app.delete<IdParams>("/api/members/:id", async (request, reply) => {
    const ctx = await session(request, "members.manage");
    await removeMember(memberDeps, actorOf(ctx, request), request.params.id);
    return reply.status(204).send();
  });

  app.post("/api/roles", async (request, reply) => {
    const ctx = await session(request, "members.manage");
    await createRole(memberDeps, actorOf(ctx, request), parse(roleSchema, request.body));
    return reply.status(201).send({ roles: await listRoles(db.core, ctx.orgId, languageOf(request)) });
  });

  app.patch<IdParams>("/api/roles/:id", async (request) => {
    const ctx = await session(request, "members.manage");
    await updateRole(memberDeps, actorOf(ctx, request), request.params.id, parse(roleSchema, request.body));
    return { roles: await listRoles(db.core, ctx.orgId, languageOf(request)) };
  });

  app.delete<IdParams>("/api/roles/:id", async (request, reply) => {
    const ctx = await session(request, "members.manage");
    await deleteRole(memberDeps, actorOf(ctx, request), request.params.id);
    return reply.status(204).send();
  });

  // ─── Invitations, from the recipient's side ────────────────────────────────

  // Without a session: whoever opens the link sees which account invites them before entering.
  app.get<IdParams>("/api/invitations/:id", async (request) => ({ invitation: await previewInvitation(db.core, request.params.id, languageOf(request)) }));

  app.post<IdParams>("/api/invitations/:id/accept", async (request, reply) => {
    const ctx = await session(request);
    await auth.acceptInvitation(request.headers, request.params.id);
    const orgId = await applyInvitationAccess(memberDeps, ctx.userId, request.params.id);
    await auth.setActiveAccount(request.headers, orgId);
    return reply.status(204).send();
  });

  // ─── Activity ──────────────────────────────────────────────────────────────

  app.get("/api/audit", async (request) => {
    const ctx = await session(request, "audit.view");
    return { entries: await listAudit(db.core, ctx.orgId, parse(auditQuery, request.query)) };
  });

  /** The account at a glance, for the administration panel. Counts only what the person can see. */
  app.get("/api/account/summary", async (request) => {
    const ctx = await session(request);
    return { summary: await accountSummary(db.core, ctx) };
  });

  // ─── Platform console ──────────────────────────────────────────────────────

  app.get("/api/admin/stats", async (request) => {
    await platformAdmin(request);
    return { stats: await platformStats(platformDeps) };
  });

  /** What was done from the platform's administration. */
  app.get("/api/admin/audit", async (request) => {
    await platformAdmin(request);
    return { entries: await listPlatformAudit(db.core, parse(auditQuery, request.query)) };
  });

  app.get("/api/admin/accounts", async (request) => {
    await platformAdmin(request);
    return { accounts: await listAllAccounts(db.core, parse(adminListQuery, request.query)) };
  });

  app.get<IdParams>("/api/admin/accounts/:id", async (request) => {
    await platformAdmin(request);
    return { account: await getAccountDetail(db.core, request.params.id) };
  });

  app.patch<IdParams>("/api/admin/accounts/:id", async (request) => {
    const ctx = await platformAdmin(request);
    const patch = parse(accountAdminSchema, request.body);
    return { account: await updateAccount(platformDeps, { userId: ctx.userId, ip: clientIp(request) }, request.params.id, patch) };
  });

  // Deleting, from the console: the word confirms it, as in the screen.
  const deleteWord = z.object({ word: z.string().refine((word) => isConfirmWord("deleteAccount", word), "api.validation.deleteWord") });
  app.post<IdParams>("/api/admin/accounts/:id/delete", async (request, reply) => {
    const ctx = await platformAdmin(request);
    parse(deleteWord, request.body);
    await deleteAccountByAdmin(privacyDeps, { userId: ctx.userId, ip: clientIp(request) }, request.params.id);
    return reply.status(204).send();
  });
  app.post<IdParams>("/api/admin/users/:id/delete", async (request, reply) => {
    const ctx = await platformAdmin(request);
    parse(deleteWord, request.body);
    await deleteUserByAdmin(privacyDeps, { userId: ctx.userId, ip: clientIp(request) }, request.params.id);
    return reply.status(204).send();
  });

  app.post<IdParams>("/api/admin/users/:id/ban", async (request, reply) => {
    const ctx = await platformAdmin(request);
    const { banned, reason } = parse(banSchema, request.body);
    await setUserBanned(platformDeps, { userId: ctx.userId, ip: clientIp(request) }, request.params.id, banned, reason || null);
    return reply.status(204).send();
  });

  // ─── Notifications ─────────────────────────────────────────────────────────

  app.get("/api/notifications", async (request) => {
    const ctx = await session(request, "notifications.manage");
    const actor = actorOf(ctx, request);
    return { notifications: await listNotifications(notifyDeps, actor), options: await notificationOptions(notifyDeps, actor, languageOf(request)) };
  });

  app.post("/api/notifications", async (request, reply) => {
    const ctx = await session(request, "notifications.manage");
    return reply.status(201).send({ notifications: await saveNotification(notifyDeps, actorOf(ctx, request), null, parse(accountNotificationSchema, request.body)) });
  });

  app.put<IdParams>("/api/notifications/:id", async (request) => {
    const ctx = await session(request, "notifications.manage");
    return { notifications: await saveNotification(notifyDeps, actorOf(ctx, request), request.params.id, parse(accountNotificationSchema, request.body)) };
  });

  app.delete<IdParams>("/api/notifications/:id", async (request, reply) => {
    const ctx = await session(request, "notifications.manage");
    await deleteNotification(notifyDeps, actorOf(ctx, request), request.params.id);
    return reply.status(204).send();
  });

  /** Sends a test message now to everyone the notification names. */
  app.post<IdParams>("/api/notifications/:id/test", async (request) => {
    const ctx = await session(request, "notifications.manage");
    return { deliveries: await testNotification(notifyDeps, actorOf(ctx, request), request.params.id) };
  });

  /** The account's latest messages: where each went and how it ended. */
  app.get("/api/notifications/deliveries", async (request) => {
    const ctx = await session(request, "notifications.manage");
    return { deliveries: await notificationLog(notifyDeps, actorOf(ctx, request)) };
  });

  registerPlatformSettings({ app, db, bus, config, traccar: deps.traccar, mailer: deps.mailer, settings, backups, outbox, system, platformAdmin, clientIp, language: languageOf, parse });
  registerSimulator({ app, simulator, geocoder, db, platformAdmin, clientIp, language: languageOf, parse });
  registerUpdates({ app, updates: deps.updates, backups, platformAdmin, clientIp, parse });

  // ─── Live ──────────────────────────────────────────────────────────────────

  const liveSessions = new WeakMap<FastifyRequest, SessionContext>();
  // ─── Optional modules ──────────────────────────────────────────────────────
  // Each one registers its routes; all of them go through the check that the
  // account has the module enabled. Otherwise they respond as if they did not exist.
  const modules: ModuleContext = {
    app,
    db,
    bus,
    config,
    traccar: deps.traccar,
    mailer: deps.mailer,
    gate,
    outbox,
    language: languageOf,
    async session(request, module: ModuleKey, permission) {
      const ctx = await session(request);
      if (!ctx.modules.includes(module)) throw notFound();
      if (permission) requirePermission(ctx, permission);
      return ctx;
    },
    actorOf,
    publicLimit(request) {
      if (!allowView(clientIp(request))) throw tooMany(say("api.errors.tooManyLookups"));
    },
    parse,
  };
  registerAntitheft(modules);
  registerDrivers(modules);
  registerFuel(modules);
  registerDiagnostics(modules);
  registerFleet(modules);
  registerMaintenance(modules);
  registerRoutes(modules);
  registerIntegrations(modules);
  registerReports(modules);

  // ─── The person's photo ────────────────────────────────────────────────────
  // It arrives as the file itself, with its type in the header. Registered after the modules: some of them
  // read the same image types and add their reader without asking first. The route's limit is what applies;
  // a photo a little over the maximum still arrives, to be answered with a clear message.
  for (const type of USER_PHOTO_TYPES) {
    if (!app.hasContentTypeParser(type)) app.addContentTypeParser(type, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  }
  app.put("/api/me/photo", { bodyLimit: 2 * USER_PHOTO_MAX_BYTES }, async (request) => {
    const ctx = await session(request, undefined, { allowSuspended: true });
    if (!Buffer.isBuffer(request.body)) throw badRequest(say("core.photo.type"), "photo_type");
    const mime = String(request.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
    return { photoUrl: await savePhoto(db.core, ctx.userId, mime, request.body) };
  });
  app.get("/api/me/photo", async (request, reply) => {
    const ctx = await session(request, undefined, { allowSuspended: true });
    const photo = await readPhoto(db.core, ctx.userId);
    // Its address changes with each new photo: the browser may keep it for a day.
    return reply.header("Content-Type", photo.mime).header("Cache-Control", "private, max-age=86400").header("X-Content-Type-Options", "nosniff").send(photo.data);
  });
  app.delete("/api/me/photo", async (request, reply) => {
    const ctx = await session(request, undefined, { allowSuspended: true });
    await deletePhoto(db.core, ctx.userId);
    return reply.status(204).send();
  });

  app.get(
    "/api/live",
    {
      websocket: true,
      // The session is checked before accepting the connection.
      preValidation: async (request) => {
        const origin = request.headers.origin;
        if (origin && !fromItself(request, origin)) throw forbidden(say("api.errors.origin"));
        liveSessions.set(request, await session(request));
      },
    },
    (socket, request) => {
      const ctx = liveSessions.get(request);
      if (!ctx) return socket.close(1008);
      live.add({ orgId: ctx.orgId, userId: ctx.userId, groups: ctx.groups, vehicles: ctx.vehicles }, socket);
    },
  );

  // The web app is served from here, on the same port as the API. In development, Vite serves it.
  if (config.webDir) registerWeb(app, config.webDir);

  app.addHook("onClose", async () => live.close());
  return { fastify: app, live, routes };
}
