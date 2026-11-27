// Backend configuration: what is read once from the environment variables, and
// the factory values of what the platform's admin console defines.
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { CHANNELS_DEFAULT, type ChannelSettings, type CustomHeader, type Language, OAUTH_DEFAULT, type MailTemplates, type ModuleKey, PASSWORD_POLICY_DEFAULT, type PasswordPolicy } from "@opengps/shared";
import { z } from "zod";
import { SOURCE_VERSION } from "./version";

/** External S3-compatible storage, already with its key. */
export interface S3Target {
  /** Which service it is, according to rclone's provider list. "Other" is any S3-compatible one. */
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  /** Folder inside the bucket; empty = the root. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Additional arguments for rclone, as written in the console. */
  flags: string[];
}

/** The channels as the backend uses them: with their keys, which the console never sees. */
export interface ChannelsConfig {
  email: ChannelSettings["email"];
  sms: Omit<ChannelSettings["sms"], "hasToken"> & { token: string };
  /** The custom channel, with its headers' values. */
  webhook: Omit<ChannelSettings["webhook"], "headerNames"> & { headers: CustomHeader[] };
  push: ChannelSettings["push"];
}
/** The services people can sign in with, with their secrets readable. Apple's secret is its key (.p8). */
export interface OAuthConfig {
  google: { enabled: boolean; clientId: string; secret: string };
  github: { enabled: boolean; clientId: string; secret: string };
  facebook: { enabled: boolean; clientId: string; secret: string };
  apple: { enabled: boolean; clientId: string; teamId: string; keyId: string; secret: string };
  custom: { enabled: boolean; name: string; issuer: string; clientId: string; secret: string; scopes: string };
}
export function defaultOAuth(): OAuthConfig {
  const plain = { enabled: false, clientId: "", secret: "" };
  return { google: { ...plain }, github: { ...plain }, facebook: { ...plain }, apple: { ...plain, teamId: "", keyId: "" }, custom: { ...plain, name: "", issuer: "", scopes: OAUTH_DEFAULT.custom.scopes } };
}

export function defaultChannels(): ChannelsConfig {
  const { sms } = CHANNELS_DEFAULT;
  return {
    email: { ...CHANNELS_DEFAULT.email },
    sms: { enabled: sms.enabled, accountSid: sms.accountSid, token: "", from: sms.from, monthlyCap: sms.monthlyCap },
    webhook: { enabled: CHANNELS_DEFAULT.webhook.enabled, method: CHANNELS_DEFAULT.webhook.method, url: "", body: "", headers: [] },
    push: { ...CHANNELS_DEFAULT.push },
  };
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),

  APP_NAME: z.string().min(1).default("OpenGPS"),
  // The release this image is, set when the image is built. Empty: built from the code.
  APP_VERSION: z.string().default(""),
  // GitHub repository whose releases are new versions of this one ("owner/name"). Empty: no looking.
  UPDATE_REPOSITORY: z.string().default("afigueroahn/OpenGPS"),
  PUBLIC_URL: z.url(),

  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters long"),

  DATABASE_URL: z.string().min(1),
  TRACCAR_DATABASE_URL: z.string().min(1),
  TRACCAR_API_URL: z.url(),
  TRACCAR_ADMIN_EMAIL: z.string().min(3).default("plataforma@gps.local"),
  /** Empty = derived from AUTH_SECRET: nobody needs to know it, the platform signs in with it by itself. */
  TRACCAR_ADMIN_PASSWORD: z.string().default(""),

  /** Where Twilio, the SMS service, is reached. It only changes for tests. */
  TWILIO_API_URL: z.url().default("https://api.twilio.com"),

  /** Platform files folder; its disk is the one that is watched. */
  FILES_DIR: z.string().default("/data/files"),

  /** Folder where backups are kept. */
  BACKUP_DIR: z.string().default("/data/backups"),

  MIGRATIONS_DIR: z.string().default(""),
  /**
   * The built web app, served by the backend itself on its own port. Empty = something else
   * serves it: in development, Vite.
   */
  WEB_DIR: z.string().default(""),
  /** Turns off ingest and the periodic tasks: API only. */
  DISABLE_BACKGROUND: z.stringbool().default(false),
});

export type Config = ReturnType<typeof loadConfig>;

/**
 * Where the GPS devices are pointed: gw.<domain of the platform>. A platform
 * that is opened by an IP, or on this same machine, has no domain to put a
 * name under: its devices go to that same place.
 */
export function gatewayOf(publicUrl: string): { host: string; ip: string | null } {
  const host = new URL(publicUrl).hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host)) return { host, ip: host };
  return { host: host === "localhost" ? host : `gw.${host}`, ip: null };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Incomplete or invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const publicUrl = e.PUBLIC_URL.replace(/\/+$/, "");
  const gateway = gatewayOf(publicUrl);
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    port: e.PORT,
    host: e.HOST,
    appName: e.APP_NAME,
    appVersion: e.APP_VERSION || SOURCE_VERSION,
    updateRepository: e.UPDATE_REPOSITORY.trim(),
    publicUrl,
    gatewayHost: gateway.host,
    /** The IP that name points to, looked up while the backend runs (core/gateway.ts). Null: not known. */
    gatewayIp: gateway.ip,
    authSecret: e.AUTH_SECRET,
    databaseUrl: e.DATABASE_URL,
    traccar: {
      databaseUrl: e.TRACCAR_DATABASE_URL,
      apiUrl: e.TRACCAR_API_URL.replace(/\/+$/, ""),
      adminEmail: e.TRACCAR_ADMIN_EMAIL,
      adminPassword: e.TRACCAR_ADMIN_PASSWORD || createHmac("sha256", e.AUTH_SECRET).update("traccar-admin").digest("hex").slice(0, 32),
      /** Days Traccar keeps its own positions. Defined by the console, like what the end of this list holds. */
      retentionDays: 14,
    },
    filesDir: e.FILES_DIR,
    // The backups are made with the same user as everything else.
    backup: { databaseUrl: e.DATABASE_URL, traccarDatabaseUrl: e.TRACCAR_DATABASE_URL, dir: e.BACKUP_DIR },
    migrationsDir: e.MIGRATIONS_DIR,
    webDir: e.WEB_DIR,
    disableBackground: e.DISABLE_BACKGROUND,
    providers: {
      twilio: e.TWILIO_API_URL.replace(/\/+$/, ""),
    },

    // What follows does not come from variables: it is defined by the platform's admin console
    // and changes while the backend runs. Here are its factory values (ADR-0010).
    mapStyleUrl: "https://tiles.openfreemap.org/styles/liberty",
    /** Outgoing mail. Without a host, no mail is sent. The sender is written in the console along with the server. */
    smtp: { host: "", port: 587, security: "starttls" as "none" | "starttls" | "ssl", user: "", password: "", from: "" },
    /** Minutes a newly added GPS has to send its first report. */
    claimWindowMinutes: 60,
    /** Unconfirmed GPS additions an account can have at once. */
    maxPendingDevices: 20,
    /** Days of history kept. 0 = no limit. */
    historyRetentionDays: 0,
    /**
     * Nominatim-compatible address service, up to `/reverse`: OpenStreetMap's
     * public one, free and limited to one query per second. An empty address
     * turns it off. The platform identifies itself to it with its name and
     * address, and waits these milliseconds between queries.
     */
    geocoder: { url: "https://nominatim.openstreetmap.org/reverse", userAgent: `${e.APP_NAME} (${publicUrl})`, minIntervalMs: 1100 },
    /**
     * Routing service that speaks OSRM's API, to trace the simulator's routes
     * along streets: the public one over OpenStreetMap data, free and limited
     * to one query per second. An empty address turns it off.
     */
    routing: { url: "https://router.project-osrm.org" },
    /** Who provides the service, the country whose law governs the terms and the privacy policy, and the email for privacy requests and complaints. */
    legal: { entity: "", country: "", contactEmail: "" },
    /** Email that receives operations notifications (disk almost full). Empty = only in the log. */
    alertEmail: "",
    /** Percentage of disk used above which a notification is sent. */
    diskAlertPercent: 70,
    registrationOpen: true,
    /** People can sign in with passkeys, where the address allows them (ADR-0020). */
    passkeysEnabled: true,
    passwordPolicy: { ...PASSWORD_POLICY_DEFAULT } as PasswordPolicy,
    newAccount: { maxVehicles: null as number | null, maxUsers: null as number | null, modules: [] as ModuleKey[] },
    defaultLanguage: "es" as Language,
    alertEmailsPerHour: 40,
    maxUploadMb: 8,
    storage: null as S3Target | null,
    channels: defaultChannels(),
    oauth: defaultOAuth(),
    /** The emails the console rewrote, by email and language. */
    mailTemplates: {} as MailTemplates,
  };
}
