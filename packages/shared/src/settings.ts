// Platform settings.
import type { ChannelSettings } from "./channels";
import type { Language } from "./languages";
import type { SharedSay } from "./locales";
import { es } from "./locales/es";
import type { ModuleKey } from "./modules";
import type { OAuthSettings } from "./oauth";
import type { MailTemplates } from "./requests";

// What whoever administers the platform defines in the admin console, without touching the
// server. What has not been defined there takes whatever its variables say.

/** What is required of a new password. */
export interface PasswordPolicy {
  minLength: number;
  number: boolean;
  symbol: boolean;
  lowercase: boolean;
  uppercase: boolean;
}
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;
export const PASSWORD_POLICY_DEFAULT: PasswordPolicy = { minLength: 8, number: false, symbol: false, lowercase: false, uppercase: false };

/** What a password lacks to meet the policy, as a text to say, or null if it meets it. */
export function passwordProblem(password: string, policy: PasswordPolicy): SharedSay | null {
  if (password.length < policy.minLength) return { key: "password.tooShort", params: { min: policy.minLength } };
  if (password.length > PASSWORD_MAX) return { key: "password.tooLong", params: { max: PASSWORD_MAX } };
  if (policy.number && !/\d/.test(password)) return { key: "password.needsNumber" };
  if (policy.lowercase && !/\p{Ll}/u.test(password)) return { key: "password.needsLowercase" };
  if (policy.uppercase && !/\p{Lu}/u.test(password)) return { key: "password.needsUppercase" };
  if (policy.symbol && !/[^\p{L}\p{N}\s]/u.test(password)) return { key: "password.needsSymbol" };
  return null;
}
/**
 * What a password must have, as a text to say: in Spanish, "Mínimo 8 caracteres,
 * con un número y una mayúscula." ("At least 8 characters, with a number and an
 * uppercase letter."). The catalog has one text per combination of requirements:
 * a list put together from pieces would not read well in every language.
 */
export function passwordHint(policy: PasswordPolicy): SharedSay {
  const number = policy.number ? "Number" : "";
  const lowercase = policy.lowercase ? "Lowercase" : "";
  const uppercase = policy.uppercase ? "Uppercase" : "";
  const symbol = policy.symbol ? "Symbol" : "";
  return { key: `passwordHint.min${number}${lowercase}${uppercase}${symbol}`, params: { min: policy.minLength } };
}

export interface GeneralSettings {
  /** Anyone can create an account. When off, only those with an invitation can sign up. */
  registrationOpen: boolean;
  /** People can register passkeys and sign in with them. They also need HTTPS and a domain name (ADR-0020). */
  passkeysEnabled: boolean;
  /** Quotas and modules each new account starts with. Without a quota, there is no limit. */
  newAccountMaxVehicles: number | null;
  newAccountMaxUsers: number | null;
  newAccountModules: ModuleKey[];
  /** Base map style. */
  mapStyleUrl: string;
  /** Address service compatible with Nominatim, up to `/reverse`. Empty = off. */
  geocoderUrl: string;
  /** How the platform introduces itself to that service. Empty = its name and address. */
  geocoderUserAgent: string;
  /** Milliseconds between two requests to that service. */
  geocoderIntervalMs: number;
  /** Routing service that speaks OSRM's API, to trace the simulator's routes along streets. Empty = off. */
  routingUrl: string;
  /** Minutes a newly added GPS has to send its first report. */
  claimWindowMinutes: number;
  /** GPS added and still waiting for their first report that one account can have at once. */
  maxPendingDevices: number;
  /** Days of position history kept. 0 = no limit. */
  historyRetentionDays: number;
  /** Days the device receiver keeps its own positions. */
  traccarRetentionDays: number;
  /** Email that receives operations notifications: disk nearly full, a failing backup. */
  alertEmail: string;
  /** Percentage of disk used above which a notification is sent. */
  diskAlertPercent: number;
  /** Language of whoever has not chosen one, and of what is sent to addresses outside the platform. */
  defaultLanguage: Language;
  /** Alert emails an account can generate per hour. */
  alertEmailsPerHour: number;
  /** Maximum size of a file uploaded by a user, in MB. */
  maxUploadMb: number;
  /** Who provides the service, country whose law governs, and contact email, for the legal texts. Only the email is asked for: the texts read well without the other two. */
  legalEntity: string;
  legalCountry: string;
  legalContactEmail: string;
}
/** History: no limit, or at least this many days. */
export const HISTORY_RETENTION_MIN_DAYS = 30;
export const UPLOAD_MAX_MB = 50;

export const MAIL_SECURITIES = ["starttls", "ssl", "none"] as const;
export type MailSecurity = (typeof MAIL_SECURITIES)[number];
export interface MailSettings {
  /** Uses the mail server defined here instead of the one the server comes with. */
  custom: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  user: string;
  /** A key is saved. The key never comes back to the admin console. */
  hasPassword: boolean;
  /** Sender: "OpenGPS <no-reply@opengps.dev>". */
  from: string;
}

export interface StorageSettings {
  enabled: boolean;
  /** Which service it is, from the provider list: rclone applies its particularities. */
  provider: string;
  /** Address of the S3 service: "https://s3.us-east-1.amazonaws.com". */
  endpoint: string;
  region: string;
  bucket: string;
  /** Folder inside the bucket where the platform stores its data. */
  prefix: string;
  accessKeyId: string;
  /** A secret key is saved. It never comes back to the admin console. */
  hasSecret: boolean;
  /** Additional arguments for rclone, one per element: "--s3-sign-accept-encoding=false". */
  flags: string[];
}

/**
 * Backup schedules offered with a button; any other is typed by hand.
 * Each `label` is Spanish only and will go: use the catalog, "backupPreset.<id>".
 */
export const BACKUP_PRESETS = [
  { id: "daily", label: es.backupPreset.daily, cron: "0 0 * * *" },
  { id: "12h", label: es.backupPreset["12h"], cron: "0 */12 * * *" },
  { id: "6h", label: es.backupPreset["6h"], cron: "0 */6 * * *" },
  { id: "weekly", label: es.backupPreset.weekly, cron: "0 0 * * 0" },
] as const;
/** The most frequent a backup can be scheduled, in minutes. */
export const BACKUP_MIN_GAP_MIN = 60;
export const BACKUP_RETENTIONS = [3, 7, 14, 30, 60, 90] as const;
export interface BackupSettings {
  scheduled: boolean;
  /** When they are made: five-field cron expression, with times in UTC. */
  cron: string;
  /** Days scheduled backups are kept. Manual ones are not deleted automatically. */
  retentionDays: number;
  /** In addition to saving it on the server, it sends it to the external storage. */
  upload: boolean;
}

export interface PlatformSettings {
  general: GeneralSettings;
  passwords: PasswordPolicy;
  mail: MailSettings;
  storage: StorageSettings;
  backups: BackupSettings;
  channels: ChannelSettings;
  oauth: OAuthSettings;
  mailTemplates: MailTemplates;
}

export type BackupPart = "gps" | "traccar" | "files";
export interface BackupFile {
  name: string;
  part: BackupPart;
  bytes: number;
}
export interface Backup {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  /** `pre_restore` and `pre_update` are made automatically before restoring another and before installing a new version; `imported`, one found in the external storage. */
  kind: "scheduled" | "manual" | "pre_restore" | "pre_update" | "imported";
  status: "running" | "ok" | "failed";
  error: string | null;
  files: BackupFile[];
  bytes: number;
  /** It is on the server, in the external storage, or in both. */
  local: boolean;
  remote: boolean;
  /** Why it did not reach the external storage, if it was attempted. */
  remoteError: string | null;
}
/** How the restore of a backup is going. The platform does it, and stops a moment while it swaps the databases (ADR-0009). */
export interface RestoreInfo {
  /** "requested": asked for, not started yet. "running": in progress. "done" and "failed": how the last one ended. */
  state: "requested" | "running" | "done" | "failed";
  backupId: string;
  /** When the backup being restored was made. */
  backupAt: string | null;
  at: string;
  error: string | null;
}
export interface BackupsInfo {
  /** This server can make backups: it has access to the databases. */
  available: boolean;
  running: boolean;
  /** Next scheduled backup. */
  nextAt: string | null;
  backups: Backup[];
  /** A backup can be restored from the console: the platform has access to the databases. */
  canRestore: boolean;
  /** The restore requested or in progress, or how the last one ended; null if there has never been one. */
  restore: RestoreInfo | null;
}
