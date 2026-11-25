// Backend configuration, read once from the environment variables.
import { createHmac } from "node:crypto";
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
  PUBLIC_URL: z.url(),
  /** Additional origins authorized to use the API, comma-separated. */
  TRUSTED_ORIGINS: z.string().default(""),
  /** Name the GPS devices point to. Empty = gw.<host of PUBLIC_URL>. */
  DEVICE_GATEWAY_HOST: z.string().default(""),
  DEVICE_GATEWAY_IP: z.string().default(""),
  MAP_STYLE_URL: z.url().default("https://tiles.openfreemap.org/styles/liberty"),

  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters long"),

  DATABASE_URL: z.string().min(1),
  TRACCAR_DATABASE_URL: z.string().min(1),
  TRACCAR_API_URL: z.url(),
  TRACCAR_ADMIN_EMAIL: z.string().min(3).default("plataforma@gps.local"),
  /** Empty = derived from AUTH_SECRET: nobody needs to know it, the platform signs in with it by itself. */
  TRACCAR_ADMIN_PASSWORD: z.string().default(""),

  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURITY: z.enum(["none", "starttls", "ssl", "tls"]).default("starttls"),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  MAIL_FROM: z.string().default(""),

  /** Minutes a newly added GPS has to send its first report. */
  CLAIM_WINDOW_MINUTES: z.coerce.number().int().min(5).default(60),
  /** Unconfirmed GPS additions an account can have at once. */
  MAX_PENDING_DEVICES: z.coerce.number().int().min(1).default(20),
  /** Days of history kept. 0 = no limit. */
  HISTORY_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  /** Days Traccar keeps its own positions. */
  TRACCAR_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),

  /**
   * Nominatim-compatible address service, up to `/reverse`. Out of the box it
   * is OpenStreetMap's public one, free and limited to one query per second.
   * Set to empty = off.
   */
  GEOCODER_URL: z.string().default("https://nominatim.openstreetmap.org/reverse"),
  /** How the platform identifies itself to that service. */
  GEOCODER_USER_AGENT: z.string().default(""),
  /** Milliseconds between queries to that service. */
  GEOCODER_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(1100),

  /**
   * Routing service that speaks OSRM's API, to trace the simulator's routes
   * along streets. Out of the box it is the public one over OpenStreetMap
   * data, free and limited to one query per second. Set to empty = off.
   */
  ROUTING_URL: z.string().default("https://router.project-osrm.org"),

  /** Simulated devices the admin console's simulator can run at once. */
  SIMULATOR_MAX_DEVICES: z.coerce.number().int().min(1).max(5000).default(50),

  /** Where Twilio, the SMS service, is reached. It only changes for tests. */
  TWILIO_API_URL: z.url().default("https://api.twilio.com"),

  /** Who provides the service, for the terms and the privacy policy. */
  LEGAL_ENTITY: z.string().default(""),
  /** Country whose law governs those texts. */
  LEGAL_COUNTRY: z.string().default(""),
  /** Email for privacy requests and complaints. */
  LEGAL_CONTACT_EMAIL: z.string().default(""),
  /** Email that receives operations notifications (disk almost full). Empty = only in the log. */
  ALERT_EMAIL: z.string().default(""),
  /** Percentage of disk used above which a notification is sent. */
  DISK_ALERT_PERCENT: z.coerce.number().int().min(1).max(99).default(70),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Incomplete or invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const publicUrl = e.PUBLIC_URL.replace(/\/+$/, "");
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    port: e.PORT,
    host: e.HOST,
    appName: e.APP_NAME,
    appVersion: e.APP_VERSION || SOURCE_VERSION,
    publicUrl,
    trustedOrigins: [
      publicUrl,
      ...e.TRUSTED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    ],
    gatewayHost: e.DEVICE_GATEWAY_HOST || `gw.${new URL(publicUrl).hostname}`,
    gatewayIp: e.DEVICE_GATEWAY_IP || null,
    mapStyleUrl: e.MAP_STYLE_URL,
    authSecret: e.AUTH_SECRET,
    databaseUrl: e.DATABASE_URL,
    traccar: {
      databaseUrl: e.TRACCAR_DATABASE_URL,
      apiUrl: e.TRACCAR_API_URL.replace(/\/+$/, ""),
      adminEmail: e.TRACCAR_ADMIN_EMAIL,
      adminPassword: e.TRACCAR_ADMIN_PASSWORD || createHmac("sha256", e.AUTH_SECRET).update("traccar-admin").digest("hex").slice(0, 32),
      retentionDays: e.TRACCAR_RETENTION_DAYS,
    },
    smtp: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      security: (e.SMTP_SECURITY === "tls" ? "ssl" : e.SMTP_SECURITY) as "none" | "starttls" | "ssl",
      user: e.SMTP_USER,
      password: e.SMTP_PASSWORD,
      from: e.MAIL_FROM || `${e.APP_NAME} <no-reply@localhost>`,
    },
    claimWindowMinutes: e.CLAIM_WINDOW_MINUTES,
    maxPendingDevices: e.MAX_PENDING_DEVICES,
    historyRetentionDays: e.HISTORY_RETENTION_DAYS,
    geocoder: {
      url: e.GEOCODER_URL.replace(/\/+$/, ""),
      userAgent: e.GEOCODER_USER_AGENT || `${e.APP_NAME} (${publicUrl})`,
      minIntervalMs: e.GEOCODER_MIN_INTERVAL_MS,
    },
    routing: { url: e.ROUTING_URL.replace(/\/+$/, "") },
    simulator: { maxDevices: e.SIMULATOR_MAX_DEVICES },
    legal: { entity: e.LEGAL_ENTITY, country: e.LEGAL_COUNTRY, contactEmail: e.LEGAL_CONTACT_EMAIL },
    alertEmail: e.ALERT_EMAIL,
    diskAlertPercent: e.DISK_ALERT_PERCENT,
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
    // and changes while the backend runs. Here are its starting values.
    registrationOpen: true,
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
