// Responses.
import type { Language } from "./languages";
import type { ModuleKey } from "./modules";
import type { OAuthProvider } from "./oauth";
import type { ThemeMode } from "./requests";
import type { Permission } from "./roles";
import type { PasswordPolicy } from "./settings";

/**
 * API contract version. It goes up when a change breaks whoever already
 * uses it (a route that disappears, a value that changes shape). Adding routes or
 * new values does not change it.
 */
export const API_VERSION = 3;

/**
 * Compares two versions X.Y.Z, with an optional leading "v" and an optional
 * "-suffix" (0.1.0-dev, 1.0.0-beta.2), which goes before the same version
 * without it. Returns -1, 0 or 1, or null when either is not a version.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] as number) - (y.core[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Why the last look for a new version failed. */
export type UpdateCheckError = "unreachable" | "rate_limited" | "unexpected";

/** The platform's version against the latest release, as the server last looked. */
export interface UpdateCheck {
  /** The version running. */
  current: string;
  /** Where releases are looked for ("owner/name"); null when looking is turned off. */
  repository: string | null;
  /** The latest release; null while none is known (none published, or not looked yet). */
  latest: { version: string; name: string; notes: string; url: string; publishedAt: string } | null;
  /** The latest release is newer than the version running. */
  available: boolean;
  /** When it was last looked for, successfully or not. */
  checkedAt: string | null;
  /** Why the last look failed; what was known before is kept. */
  error: UpdateCheckError | null;
}

/**
 * How this installation installs a new version: from the console, by the
 * helper (Docker Compose); by hand (Dokploy, or a helper that cannot); or
 * from the code (a build that is not a release image).
 */
export type UpdateInstallMode = "console" | "manual" | "source";

/** Why an install from the console did not end well: the helper's code, or "backup" if the backup before it failed. */
export type UpdateFailure = "backup" | "invalid" | "unsupported" | "pull" | "files" | "env" | "start" | "rolled_back" | "restored" | "broken" | "cut";

export interface UpdateInstall {
  mode: UpdateInstallMode;
  /**
   * The last install asked from the console: making the backup before it,
   * waiting for the helper, under way, or how it ended.
   */
  last: { state: "preparing" | "requested" | "running" | "ok" | "failed"; version: string; from: string | null; at: string; reason: UpdateFailure | null } | null;
}

/** The platform's version against the latest release, and how to install it, for the owner of the platform. */
export interface UpdateStatus extends UpdateCheck {
  install: UpdateInstall;
}

export interface PublicConfig {
  /** API contract version this server serves. */
  apiVersion: number;
  /** The platform's version: the release's (0.1.0), or the repository's with "-dev" when built from the code. */
  version: string;
  appName: string;
  /** Language of whoever has not chosen one. */
  defaultLanguage: Language;
  mapStyleUrl: string;
  gatewayHost: string;
  gatewayIp: string | null;
  claimWindowMinutes: number;
  /** An address service is configured. */
  geocoding: boolean;
  legal: LegalInfo;
  /** Anyone can create an account; if not, only those with an invitation. */
  registrationOpen: boolean;
  /** The other services people can sign in and sign up with, in the order their buttons go. */
  signIn: { id: OAuthProvider; name: string }[];
  /** People can register passkeys and sign in with them (ADR-0020): the platform has HTTPS and a domain name, and the console did not turn them off. */
  passkeys: boolean;
  /** The platform's address allows passkeys (HTTPS and a domain name), whether or not the console has them on. */
  passkeysSupported: boolean;
  /** What is required of a new password. */
  passwordPolicy: PasswordPolicy;
  /** Maximum size of a file uploaded by a user, in MB. */
  maxUploadMb: number;
}

/**
 * Current version of the terms of use and the privacy policy. When
 * it changes, the platform asks everyone to accept again.
 */
export const LEGAL_VERSION = "2026-11-21";

export interface LegalInfo {
  version: string;
  /** Who provides the service and is responsible for the data. */
  entity: string;
  /** Country whose law governs. Empty until defined. */
  country: string;
  /** Email for requests and complaints. Empty until defined. */
  contactEmail: string;
}

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    /** Administers the whole platform. */
    platformAdmin: boolean;
    /** Has a password; whoever only signs in with another service has none. */
    hasPassword: boolean;
    /** Where their photo is served, changing with each new photo; null = none, the initials are shown. */
    photoUrl: string | null;
  };
  account: {
    id: string;
    name: string;
    /** "owner", "admin", "operator", "viewer" or the id of a custom role. */
    role: string;
    roleName: string;
    permissions: Permission[];
    /** Groups this user can see; null = all. */
    groups: string[] | null;
    /** Vehicles this user sees one by one, besides those of the groups. */
    vehicles: string[];
    /** The platform suspended this account: it cannot be used until it is reactivated. */
    suspended: boolean;
    /** Optional modules enabled in this account. */
    modules: ModuleKey[];
  };
  /** All the accounts it belongs to. */
  accounts: { id: string; name: string }[];
  /** It still needs to accept the current version of the terms and the policy. */
  needsConsent: boolean;
  /** This person's preferences. */
  settings: {
    theme: ThemeMode;
    /** null = the platform's default. */
    language: Language | null;
    /** Where SMS notifications reach them. */
    phone: string | null;
  };
}

export interface ApiError {
  error: { code: string; message: string };
}
