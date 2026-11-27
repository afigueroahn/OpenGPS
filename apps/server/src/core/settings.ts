// Platform settings defined in the console. They are stored in
// sections and applied over the backend's configuration, which the rest of the
// code reads on every use: a change takes effect from that moment, without restarting.
//
// What has never been saved takes its factory value (ADR-0010).
import {
  type BackupSettings,
  CHANNELS_DEFAULT,
  type ChannelSettings,
  type CustomHeader,
  type CustomMethod,
  type GeneralSettings,
  type MailSecurity,
  type MailSettings,
  type MailTemplates,
  OAUTH_DEFAULT,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type OAuthSettings,
  PASSWORD_POLICY_DEFAULT,
  type PasswordPolicy,
  type PlatformSettings,
  STORAGE_PROVIDER_DEFAULT,
  type StorageSettings,
  type backupSettingsSchema,
  type channelSettingsSchema,
  type generalSettingsSchema,
  type mailSettingsSchema,
  type mailTemplatesSchema,
  type oauthSettingsSchema,
  type passwordPolicySchema,
  type storageSettingsSchema,
} from "@opengps/shared";
import type { z } from "zod";
import type { Bus } from "../bus";
import type { Config, S3Target } from "../config";
import type { Db } from "../db";
import { badRequest } from "../errors";
import { say } from "../i18n";
import { audit } from "./audit";
import { PROVIDER_NAME, isAppleKey } from "./oauth";
import { checkFlags } from "./s3";
import { createVault } from "./secrets";

/** What is left in the database: as in the console, but with the keys encrypted instead of the marker that says they exist. */
type StoredMail = Omit<MailSettings, "hasPassword"> & { password: string | null };
/** The additional arguments may carry keys (an access header, for example): they are also stored encrypted, together, in `args`. */
type StoredStorage = Omit<StorageSettings, "hasSecret" | "flags"> & { secret: string | null; args: string | null };
/**
 * Twilio's key is stored encrypted in `token`. The custom channel's address, body and headers may carry keys of
 * the other system: they are stored encrypted, together, in `call`.
 */
interface StoredChannels {
  email: ChannelSettings["email"];
  sms: Omit<ChannelSettings["sms"], "hasToken"> & { token: string | null };
  webhook: { enabled: boolean; method: CustomMethod; call: string | null };
  push: ChannelSettings["push"];
}
/** What the custom channel calls, once opened. */
interface CustomCall {
  url: string;
  body: string;
  headers: CustomHeader[];
}
/** Each service to sign in with, with its secret encrypted in `secret`. */
type StoredOAuth = { [P in OAuthProvider]: Omit<OAuthSettings[P], "hasSecret"> & { secret: string | null } };
interface Stored {
  oauth?: StoredOAuth;
  general?: GeneralSettings;
  passwords?: PasswordPolicy;
  mail?: StoredMail;
  storage?: StoredStorage;
  backups?: BackupSettings;
  channels?: StoredChannels;
  mailTemplates?: MailTemplates;
}

/** The sections that carry a key, as stored (encrypted). `null` means nothing is stored. */
export interface KeptKeys {
  mail: StoredMail | null;
  storage: StoredStorage | null;
  channels: StoredChannels | null;
  oauth: StoredOAuth | null;
}

export interface SettingsInput {
  general: z.output<typeof generalSettingsSchema>;
  passwords: z.output<typeof passwordPolicySchema>;
  mail: z.output<typeof mailSettingsSchema>;
  storage: z.output<typeof storageSettingsSchema>;
  backups: z.output<typeof backupSettingsSchema>;
  channels: z.output<typeof channelSettingsSchema>;
  oauth: z.output<typeof oauthSettingsSchema>;
  mailTemplates: z.output<typeof mailTemplatesSchema>;
}
export type Section = keyof SettingsInput;

export interface SettingsActor {
  userId: string;
  ip?: string | null;
}

export interface Settings {
  /** Reads what is stored and applies it. Called at startup. */
  load(): Promise<void>;
  /** What is in effect, as the console sees it: without keys. */
  view(): PlatformSettings;
  backups(): BackupSettings;
  /** When the backup schedule was last saved, in milliseconds. */
  backupsSavedAt(): number | null;
  save<S extends Section>(section: S, data: SettingsInput[S], actor: SettingsActor): Promise<PlatformSettings>;
  /** Forgets what is stored in a section: its factory values apply again. Its keys are deleted with it. */
  reset(section: Section, actor: SettingsActor): Promise<PlatformSettings>;
  /**
   * The destination resulting from storage settings not yet saved,
   * to test them first. If they carry no secret key, the stored one applies.
   */
  storageTarget(data: SettingsInput["storage"]): Promise<S3Target>;
  /** The sections with a key (mail, storage, channels and the services to sign in with), to keep them through a restore. */
  keys(): KeptKeys;
  /**
   * For after restoring a backup from another server: its keys come
   * encrypted with that server's secret and cannot be read here. The sections
   * in that case are replaced with the ones this server had. Returns which ones.
   */
  adopt(kept: Partial<KeptKeys>): Promise<Section[]>;
}

/** By default, one daily backup at midnight UTC, kept for 7 days. */
export const BACKUPS_DEFAULT: BackupSettings = { scheduled: true, cron: "0 0 * * *", retentionDays: 7, upload: false };

export function createSettings(deps: { db: Db; bus: Bus; config: Config }): Settings {
  const { db, bus, config } = deps;
  const vault = createVault(config.authSecret);
  /** How the platform introduces itself to the address service when nobody wrote something else. */
  const automaticAgent = () => `${config.appName} (${config.publicUrl})`;
  // The factory values, to go back to them if something stops being defined here.
  const factory = {
    smtp: { ...config.smtp },
    general: {
      // APP_NAME, or "OpenGPS" without it: what the platform is called until the console changes it (ADR-0022).
      appName: config.appName,
      registrationOpen: config.registrationOpen,
      passkeysEnabled: config.passkeysEnabled,
      newAccountMaxVehicles: config.newAccount.maxVehicles,
      newAccountMaxUsers: config.newAccount.maxUsers,
      newAccountModules: [...config.newAccount.modules],
      mapStyleUrl: config.mapStyleUrl,
      geocoderUrl: config.geocoder.url,
      // The automatic one is said as empty, so it follows the platform's name and address.
      geocoderUserAgent: config.geocoder.userAgent === automaticAgent() ? "" : config.geocoder.userAgent,
      geocoderIntervalMs: config.geocoder.minIntervalMs,
      routingUrl: config.routing.url,
      claimWindowMinutes: config.claimWindowMinutes,
      maxPendingDevices: config.maxPendingDevices,
      historyRetentionDays: config.historyRetentionDays,
      traccarRetentionDays: config.traccar.retentionDays,
      alertEmail: config.alertEmail,
      diskAlertPercent: config.diskAlertPercent,
      defaultLanguage: config.defaultLanguage,
      alertEmailsPerHour: config.alertEmailsPerHour,
      maxUploadMb: config.maxUploadMb,
      legalEntity: config.legal.entity,
      legalCountry: config.legal.country,
      legalContactEmail: config.legal.contactEmail,
    } satisfies GeneralSettings,
  };
  let stored: Stored = {};
  let backupsSavedAt: number | null = null;

  const general = (): GeneralSettings => ({ ...factory.general, ...stored.general });
  const passwords = (): PasswordPolicy => ({ ...PASSWORD_POLICY_DEFAULT, ...stored.passwords });
  const backups = (): BackupSettings => {
    const b = { ...BACKUPS_DEFAULT, ...stored.backups };
    return { scheduled: b.scheduled, cron: b.cron, retentionDays: b.retentionDays, upload: b.upload };
  };
  const mail = (): StoredMail =>
    stored.mail ?? { custom: false, host: factory.smtp.host, port: factory.smtp.port, security: factory.smtp.security as MailSecurity, user: factory.smtp.user, password: null, from: factory.smtp.from };
  const storage = (): StoredStorage => {
    const s = stored.storage;
    if (!s) return { enabled: false, provider: STORAGE_PROVIDER_DEFAULT, endpoint: "", region: "us-east-1", bucket: "", prefix: "", accessKeyId: "", secret: null, args: null };
    return { enabled: s.enabled, provider: s.provider, endpoint: s.endpoint, region: s.region, bucket: s.bucket, prefix: s.prefix, accessKeyId: s.accessKeyId, secret: s.secret ?? null, args: s.args ?? null };
  };
  const channels = (): StoredChannels => {
    const d = CHANNELS_DEFAULT;
    const s = stored.channels;
    return {
      // Until the console turns email on or off, it follows the mail server: on when there is one to send with.
      email: s?.email ?? { enabled: mail().custom },
      sms: { enabled: d.sms.enabled, accountSid: d.sms.accountSid, from: d.sms.from, monthlyCap: d.sms.monthlyCap, token: null, ...s?.sms },
      webhook: { enabled: s?.webhook?.enabled ?? d.webhook.enabled, method: s?.webhook?.method ?? d.webhook.method, call: s?.webhook?.call ?? null },
      push: { ...d.push, ...s?.push },
    };
  };
  /** What the custom channel calls. Encrypted with another server's secret it is not read: it is as if there were nothing. */
  const callOf = (w: StoredChannels["webhook"]): CustomCall => {
    try {
      const c = JSON.parse(vault.open(w.call) ?? "{}") as Partial<CustomCall>;
      const headers = Array.isArray(c.headers) ? c.headers.filter((h): h is CustomHeader => typeof h?.name === "string" && typeof h?.value === "string") : [];
      return { url: typeof c.url === "string" ? c.url : "", body: typeof c.body === "string" ? c.body : "", headers };
    } catch {
      return { url: "", body: "", headers: [] };
    }
  };
  /** What is stored from channel settings that come from the console. A key that is not sent stays as it is. */
  function sealChannels(data: SettingsInput["channels"]): StoredChannels {
    const before = channels();
    const keep = (fresh: string | undefined, kept: string | null) => (fresh ? vault.seal(fresh) : kept);
    const sms = { ...data.sms, token: keep(data.sms.token, before.sms.token) };
    if (sms.enabled && (!sms.accountSid || !sms.from || vault.open(sms.token) === null)) throw badRequest(say("core.settings.twilioIncomplete"));
    const { token: _smsKey, ...smsRest } = sms;
    // Headers that are not sent stay as they were: their values do not go back to the screen.
    const call: CustomCall = { url: data.webhook.url, body: data.webhook.body, headers: data.webhook.headers ?? callOf(before.webhook).headers };
    if (data.webhook.enabled && !call.url) throw badRequest(say("core.settings.customUrl"));
    const written = call.url !== "" || call.body !== "" || call.headers.length > 0;
    return {
      email: data.email,
      sms: { ...smsRest, token: sms.token },
      webhook: { enabled: data.webhook.enabled, method: data.webhook.method, call: written ? vault.seal(JSON.stringify(call)) : null },
      push: data.push,
    };
  }
  const oauth = (): StoredOAuth => {
    const s = stored.oauth;
    const of = <P extends OAuthProvider>(p: P): StoredOAuth[P] => {
      const { hasSecret: _secret, ...plain } = OAUTH_DEFAULT[p];
      return { ...plain, secret: null, ...s?.[p] } as StoredOAuth[P];
    };
    return { google: of("google"), github: of("github"), facebook: of("facebook"), apple: of("apple"), custom: of("custom") };
  };
  /** What is stored from the services to sign in with that come from the console. A secret that is not sent stays as it is. */
  function sealOAuth(data: SettingsInput["oauth"]): StoredOAuth {
    const before = oauth();
    const next = {} as Record<OAuthProvider, unknown>;
    for (const p of OAUTH_PROVIDERS) {
      const { secret: fresh, ...rest } = data[p];
      const secret = fresh ? vault.seal(fresh) : before[p].secret;
      const entry = { ...rest, secret } as StoredOAuth[typeof p];
      if (entry.enabled) {
        const name = p === "custom" ? data.custom.name || "OpenID Connect" : PROVIDER_NAME[p];
        const complete =
          Boolean(entry.clientId) && vault.open(secret) !== null && (p !== "apple" || Boolean(data.apple.teamId && data.apple.keyId)) && (p !== "custom" || Boolean(data.custom.name && data.custom.issuer));
        if (!complete) throw badRequest(say("core.settings.oauthIncomplete", { provider: name }));
        if (p === "apple" && fresh && !isAppleKey(fresh)) throw badRequest(say("core.settings.appleKey"));
      }
      next[p] = entry;
    }
    return next as StoredOAuth;
  }
  /** The stored additional arguments. Encrypted with another server's secret they are not read: it is as if there were none. */
  const flagsOf = (s: StoredStorage): string[] => {
    try {
      const list: unknown = JSON.parse(vault.open(s.args) ?? "[]");
      return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
    } catch {
      return [];
    }
  };
  const targetOf = (s: StoredStorage, secret: string): S3Target => ({
    provider: s.provider,
    endpoint: s.endpoint,
    region: s.region || "us-east-1",
    bucket: s.bucket,
    prefix: s.prefix,
    accessKeyId: s.accessKeyId,
    secretAccessKey: secret,
    flags: flagsOf(s),
  });
  /** What is stored from storage settings that come from the console. Rejects arguments rclone does not accept. */
  async function sealStorage(data: SettingsInput["storage"]): Promise<StoredStorage> {
    const { secretAccessKey, flags, ...rest } = data;
    const problem = await checkFlags(flags);
    if (problem) throw badRequest(problem);
    // Without a new key the stored one is kept.
    return { ...rest, secret: secretAccessKey ? vault.seal(secretAccessKey) : storage().secret, args: flags.length > 0 ? vault.seal(JSON.stringify(flags)) : null };
  }

  /** Passes what is in effect to the configuration the rest of the backend reads. */
  function apply(): void {
    const g = general();
    // First: the automatic name the address service is told comes from it.
    config.appName = g.appName;
    config.registrationOpen = g.registrationOpen;
    config.passkeysEnabled = g.passkeysEnabled;
    config.newAccount = { maxVehicles: g.newAccountMaxVehicles, maxUsers: g.newAccountMaxUsers, modules: g.newAccountModules };
    config.mapStyleUrl = g.mapStyleUrl;
    config.geocoder.url = g.geocoderUrl.replace(/\/+$/, "");
    config.geocoder.userAgent = g.geocoderUserAgent || automaticAgent();
    config.geocoder.minIntervalMs = g.geocoderIntervalMs;
    config.routing.url = g.routingUrl.replace(/\/+$/, "");
    config.claimWindowMinutes = g.claimWindowMinutes;
    config.maxPendingDevices = g.maxPendingDevices;
    config.historyRetentionDays = g.historyRetentionDays;
    config.traccar.retentionDays = g.traccarRetentionDays;
    config.alertEmail = g.alertEmail;
    config.diskAlertPercent = g.diskAlertPercent;
    config.defaultLanguage = g.defaultLanguage;
    config.alertEmailsPerHour = g.alertEmailsPerHour;
    config.maxUploadMb = g.maxUploadMb;
    config.legal = { entity: g.legalEntity, country: g.legalCountry, contactEmail: g.legalContactEmail };
    config.passwordPolicy = passwords();

    const m = mail();
    config.smtp = m.custom ? { host: m.host, port: m.port, security: m.security, user: m.user, password: vault.open(m.password) ?? "", from: m.from } : { ...factory.smtp };

    const s = storage();
    const secret = vault.open(s.secret);
    config.storage = s.enabled && secret ? targetOf(s, secret) : null;

    const c = channels();
    config.channels = {
      email: c.email,
      sms: { ...c.sms, token: vault.open(c.sms.token) ?? "" },
      webhook: { enabled: c.webhook.enabled, method: c.webhook.method, ...callOf(c.webhook) },
      push: c.push,
    };

    const o = oauth();
    const open = <P extends OAuthProvider>(p: P) => ({ ...o[p], secret: vault.open(o[p].secret) ?? "" });
    config.oauth = { google: open("google"), github: open("github"), facebook: open("facebook"), apple: open("apple"), custom: open("custom") };

    config.mailTemplates = stored.mailTemplates ?? {};
  }

  function viewOAuth(): OAuthSettings {
    const o = oauth();
    const view = <P extends OAuthProvider>(p: P): OAuthSettings[P] => {
      const { secret, ...rest } = o[p];
      return { ...rest, hasSecret: vault.open(secret) !== null } as unknown as OAuthSettings[P];
    };
    return { google: view("google"), github: view("github"), facebook: view("facebook"), apple: view("apple"), custom: view("custom") };
  }

  function viewChannels(): ChannelSettings {
    const c = channels();
    const { token: smsKey, ...sms } = c.sms;
    return {
      email: c.email,
      sms: { ...sms, hasToken: vault.open(smsKey) !== null },
      webhook: (({ url, body, headers }) => ({ enabled: c.webhook.enabled, method: c.webhook.method, url, body, headerNames: headers.map((h) => h.name) }))(callOf(c.webhook)),
      push: c.push,
    };
  }

  function view(): PlatformSettings {
    const { password, ...m } = mail();
    const { secret, args: _args, ...s } = storage();
    const g = general();
    return {
      // The console shows the identification in effect, not an empty box.
      general: { ...g, geocoderUserAgent: g.geocoderUserAgent || automaticAgent() },
      passwords: passwords(),
      mail: { ...m, hasPassword: vault.open(password) !== null },
      storage: { ...s, hasSecret: vault.open(secret) !== null, flags: flagsOf(storage()) },
      backups: backups(),
      channels: viewChannels(),
      oauth: viewOAuth(),
      mailTemplates: stored.mailTemplates ?? {},
    };
  }

  return {
    async load() {
      const r = await db.core.query<{ section: Section; value: unknown; updated_at: Date }>(`SELECT section, value, updated_at FROM gps.platform_settings`);
      stored = {};
      backupsSavedAt = null;
      for (const row of r.rows) {
        (stored as Record<string, unknown>)[row.section] = row.value;
        if (row.section === "backups") backupsSavedAt = row.updated_at.getTime();
      }
      apply();
    },
    view,
    backups,
    backupsSavedAt: () => backupsSavedAt,
    async save(section, data, actor) {
      let value: Stored[Section];
      if (section === "mail") {
        const { password, ...rest } = data as SettingsInput["mail"];
        // Without a new key the stored one is kept.
        value = { ...rest, password: password ? vault.seal(password) : mail().password };
      } else if (section === "storage") {
        const sealed = await sealStorage(data as SettingsInput["storage"]);
        if (sealed.enabled && vault.open(sealed.secret) === null) throw badRequest(say("core.settings.storageSecret"));
        value = sealed;
      } else if (section === "channels") {
        value = sealChannels(data as SettingsInput["channels"]);
      } else if (section === "oauth") {
        value = sealOAuth(data as SettingsInput["oauth"]);
      } else if (section === "general") {
        const g = data as SettingsInput["general"];
        // The automatic identification is stored as empty, so it keeps following the platform's name and address.
        value = { ...g, geocoderUserAgent: g.geocoderUserAgent === automaticAgent() ? "" : g.geocoderUserAgent };
      } else {
        value = data as Stored[Section];
      }
      const saved = await db.core.query<{ updated_at: Date }>(
        `INSERT INTO gps.platform_settings (section, value, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING updated_at`,
        [section, JSON.stringify(value), actor.userId],
      );
      (stored as Record<string, unknown>)[section] = value;
      if (section === "backups") backupsSavedAt = saved.rows[0]?.updated_at.getTime() ?? Date.now();
      apply();
      // Who changed it and which section is recorded; keys never go into the log.
      await audit(db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.settings", "platform", section, { section });
      bus.emit("settings_changed", { section });
      return view();
    },
    async reset(section, actor) {
      await db.core.query(`DELETE FROM gps.platform_settings WHERE section = $1`, [section]);
      delete stored[section];
      if (section === "backups") backupsSavedAt = null;
      apply();
      await audit(db.core, { orgId: null, userId: actor.userId, ip: actor.ip ?? null }, "admin.settings_reset", "platform", section, { section });
      bus.emit("settings_changed", { section });
      return view();
    },
    async storageTarget(data) {
      const sealed = await sealStorage(data);
      const secret = vault.open(sealed.secret);
      if (!secret) throw badRequest(say("core.settings.storageSecret"));
      if (sealed.bucket === "" || sealed.accessKeyId === "") throw badRequest(say("core.settings.storageBucket"));
      return targetOf(sealed, secret);
    },
    keys: () => ({ mail: stored.mail ?? null, storage: stored.storage ?? null, channels: stored.channels ?? null, oauth: stored.oauth ?? null }),
    async adopt(kept) {
      // A stored key that does not open with this server's secret.
      const sealedElsewhere = (secret: string | null | undefined) => Boolean(secret) && vault.open(secret) === null;
      const channelKeys = (c: StoredChannels | null | undefined) => [c?.sms?.token, c?.webhook?.call];
      const oauthKeys = (o: StoredOAuth | null | undefined) => OAUTH_PROVIDERS.map((p) => o?.[p]?.secret);
      const mine = {
        mail: kept.mail && typeof kept.mail === "object" && !sealedElsewhere(kept.mail.password) ? kept.mail : null,
        storage: kept.storage && typeof kept.storage === "object" && !sealedElsewhere(kept.storage.secret) ? kept.storage : null,
        channels: kept.channels && typeof kept.channels === "object" && !channelKeys(kept.channels).some(sealedElsewhere) ? kept.channels : null,
        oauth: kept.oauth && typeof kept.oauth === "object" && !oauthKeys(kept.oauth).some(sealedElsewhere) ? kept.oauth : null,
      };
      const changed: Section[] = [];
      for (const section of ["mail", "storage", "channels", "oauth"] as const) {
        const theirs =
          section === "mail" ? [stored.mail?.password] : section === "storage" ? [stored.storage?.secret] : section === "channels" ? channelKeys(stored.channels) : oauthKeys(stored.oauth);
        if (!theirs.some(sealedElsewhere)) continue;
        const value = mine[section];
        if (value) {
          await db.core.query(
            `INSERT INTO gps.platform_settings (section, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_by = NULL, updated_at = now()`,
            [section, JSON.stringify(value)],
          );
          (stored as Record<string, unknown>)[section] = value;
        } else {
          // This server had nothing stored there: the value from its variables applies again.
          await db.core.query(`DELETE FROM gps.platform_settings WHERE section = $1`, [section]);
          delete stored[section];
        }
        changed.push(section);
      }
      if (changed.length > 0) {
        apply();
        for (const section of changed) bus.emit("settings_changed", { section });
      }
      return changed;
    },
  };
}
