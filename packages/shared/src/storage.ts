// External storage: the providers that can be chosen and the
// additional arguments passed to rclone, the program that moves the
// files. Used by the admin console, to warn while typing, and by the backend.
import type { SharedSay } from "./locales";
import { es } from "./locales/es";

/**
 * S3 providers that rclone distinguishes. It applies each one's particularities.
 * Most names are brands. Those of "Other" and "Rclone" are Spanish only and will go: use the catalog, "storageProvider.<id>".
 */
export const STORAGE_PROVIDERS: readonly { id: string; name: string }[] = [
  { id: "Other", name: es.storageProvider.Other },
  { id: "Alibaba", name: "Alibaba Cloud OSS" },
  { id: "AWS", name: "Amazon Web Services (AWS) S3" },
  { id: "ArvanCloud", name: "Arvan Cloud" },
  { id: "Autonomys", name: "Autonomys Auto Drive" },
  { id: "BizflyCloud", name: "Bizfly Cloud" },
  { id: "Ceph", name: "Ceph" },
  { id: "ChinaMobile", name: "China Mobile Ecloud" },
  { id: "Cellar", name: "Clever Cloud Cellar" },
  { id: "Cloudflare", name: "Cloudflare R2" },
  { id: "Cubbit", name: "Cubbit DS3" },
  { id: "DigitalOcean", name: "DigitalOcean Spaces" },
  { id: "Dreamhost", name: "Dreamhost DreamObjects" },
  { id: "Exaba", name: "Exaba" },
  { id: "Fastly", name: "Fastly Object Storage" },
  { id: "FileLu", name: "FileLu S5" },
  { id: "GCS", name: "Google Cloud Storage" },
  { id: "Hetzner", name: "Hetzner Object Storage" },
  { id: "HCP", name: "Hitachi Content Platform" },
  { id: "HuaweiOBS", name: "Huawei OBS" },
  { id: "IBMCOS", name: "IBM COS" },
  { id: "IDrive", name: "IDrive e2" },
  { id: "ImpossibleCloud", name: "Impossible Cloud" },
  { id: "Infomaniak", name: "Infomaniak Swiss Backup" },
  { id: "Intercolo", name: "Intercolo" },
  { id: "IONOS", name: "IONOS Cloud" },
  { id: "Leviia", name: "Leviia" },
  { id: "Liara", name: "Liara" },
  { id: "Linode", name: "Linode Object Storage" },
  { id: "Magalu", name: "Magalu" },
  { id: "Mega", name: "MEGA S4" },
  { id: "Minio", name: "MinIO" },
  { id: "Neon", name: "Neon" },
  { id: "Netease", name: "Netease NOS" },
  { id: "Outscale", name: "OUTSCALE" },
  { id: "OVHcloud", name: "OVHcloud" },
  { id: "Petabox", name: "Petabox" },
  { id: "FlashBlade", name: "Pure Storage FlashBlade" },
  { id: "Qiniu", name: "Qiniu Kodo" },
  { id: "Rabata", name: "Rabata" },
  { id: "RackCorp", name: "RackCorp" },
  { id: "Rclone", name: es.storageProvider.Rclone },
  { id: "RelAix", name: "RelAix.Storage" },
  { id: "Scaleway", name: "Scaleway" },
  { id: "Scality", name: "Scality" },
  { id: "LyveCloud", name: "Seagate Lyve Cloud" },
  { id: "SeaweedFS", name: "SeaweedFS" },
  { id: "Selectel", name: "Selectel" },
  { id: "Servercore", name: "Servercore" },
  { id: "SpectraLogic", name: "Spectra Logic Black Pearl" },
  { id: "Storj", name: "Storj" },
  { id: "Synology", name: "Synology C2" },
  { id: "TencentCOS", name: "Tencent COS" },
  { id: "US3", name: "US3" },
  { id: "Wasabi", name: "Wasabi" },
  { id: "Zadara", name: "Zadara" },
  { id: "Zata", name: "Zata" },
  { id: "ZeroServices", name: "Zero Services (ZERO-Z3)" },
];
export const STORAGE_PROVIDER_DEFAULT = "Other";
/** With Amazon the endpoint is not needed: rclone derives it from the region. */
export const storageNeedsEndpoint = (provider: string) => provider !== "AWS";

export const STORAGE_FLAGS_MAX = 30;
export const STORAGE_FLAG_MAX_LENGTH = 400;

/** General rclone arguments that are accepted, in addition to all the S3 ones (those starting with --s3-). */
export const STORAGE_GENERAL_FLAGS: readonly string[] = [
  "header",
  "header-upload",
  "header-download",
  "no-check-certificate",
  "timeout",
  "contimeout",
  "expect-continue-timeout",
  "retries",
  "retries-sleep",
  "low-level-retries",
  "transfers",
  "checkers",
  "buffer-size",
  "bwlimit",
  "bwlimit-file",
  "tpslimit",
  "tpslimit-burst",
  "user-agent",
  "bind",
  "http-proxy",
  "disable-http2",
  "no-gzip-encoding",
  "ignore-checksum",
];
/** What already has its own field in the form. */
const OWN_FIELD = new Set(["s3-provider", "s3-access-key-id", "s3-secret-access-key", "s3-endpoint", "s3-region"]);
/** What would take the keys from somewhere other than the form, or leave them written in the logs. */
const NOT_ALLOWED = new Set(["s3-env-auth", "s3-profile", "s3-shared-credentials-file", "s3-session-token", "s3-sdk-log-mode"]);

export interface StorageFlag {
  /** Without the dashes: "s3-sign-accept-encoding". */
  name: string;
  /** `null` when the argument has no value. */
  value: string | null;
}

/**
 * Reads an argument as typed in the admin console: "--nombre",
 * "--nombre=valor" or "--nombre valor", with the value quoted or without
 * quotes. Returns the argument, or what is wrong with it, as a text to say.
 */
export function parseStorageFlag(text: string): StorageFlag | SharedSay {
  const flag = text.trim();
  if (flag === "") return { key: "storageFlag.empty" };
  if (flag.length > STORAGE_FLAG_MAX_LENGTH) return { key: "storageFlag.tooLong", params: { max: STORAGE_FLAG_MAX_LENGTH } };
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is being searched for
  if (/[\u0000-\u001f\u007f]/.test(flag)) return { key: "storageFlag.oneLine" };
  const m = flag.match(/^--([a-z0-9][a-z0-9-]*)(?:(?:\s*=\s*|\s+)(.*))?$/);
  if (!m) return { key: "storageFlag.format" };
  const name = m[1] as string;
  let value = m[2] === undefined ? null : m[2].trim();
  if (value !== null && value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value.charAt(0))) value = value.slice(1, -1);
  if (OWN_FIELD.has(name)) return { key: "storageFlag.ownField", params: { name } };
  if (NOT_ALLOWED.has(name) || !(name.startsWith("s3-") || STORAGE_GENERAL_FLAGS.includes(name))) {
    return { key: "storageFlag.notAllowed", params: { name, general: STORAGE_GENERAL_FLAGS.map((f) => `--${f}`).join(", ") } };
  }
  // Two arguments on the same line: the second would end up as the first one's value.
  if (value !== null && !name.startsWith("header") && /(^|\s)--[a-z0-9]/.test(value)) return { key: "storageFlag.onePerLine" };
  return { name, value };
}

/** What is wrong with an argument, as a text to say, or `null` if it can be used. */
export const storageFlagProblem = (text: string): SharedSay | null => {
  const parsed = parseStorageFlag(text);
  return "key" in parsed ? parsed : null;
};

/** The arguments as rclone receives them: "--nombre=valor" or "--nombre". Those that cannot be used are left out. */
export function storageFlagArgs(flags: readonly string[]): string[] {
  return flags.flatMap((text) => {
    const parsed = parseStorageFlag(text);
    if ("key" in parsed) return [];
    return [parsed.value === null ? `--${parsed.name}` : `--${parsed.name}=${parsed.value}`];
  });
}
