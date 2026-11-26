// API client. Every call goes to the platform the person chose, with the
// session cookie the app keeps; the system's own cookie jar is never used.
import {
  APP_OAUTH_START,
  type AccountSummary,
  type CreateVehicleInput,
  type DeviceModel,
  type DiagFault,
  type DiagStatus,
  type Driver,
  type ExportFormat,
  type FuelStatus,
  type Incident,
  type IncidentDetail,
  type IncidentResolution,
  type LockCheck,
  type VehicleSecurity,
  type Language,
  LEGAL_VERSION,
  type Me,
  type OAuthProvider,
  type PublicConfig,
  type ShareInput,
  type ShareLink,
  type ThemeMode,
  type TrackPoint,
  type UpdateVehicleInput,
  type Vehicle,
  type VehicleDriver,
  type VehicleEvent,
  type VehicleGroup,
  type VehicleHistory,
} from "@opengps/shared";
import { Directory, File, Paths } from "expo-file-system";
import { mergeCookies } from "./cookies";
import { writeQuery } from "./oauth";
import i18n, { currentLanguage } from "./i18n";
import { getSaved, save } from "./storage";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Said when the server does not answer, or answers without a message. */
const generic = () => i18n.t("errors.network");

interface Init {
  method?: string;
  body?: unknown;
  /** Another platform than the saved one: to check an address before keeping it. Nothing of the session goes or stays. */
  base?: string;
  /** Without the session: signing in starts a new one. */
  anonymous?: boolean;
  /** A file sent as it is, with its type, instead of a JSON body: the person's photo. */
  file?: { data: Blob; type: string };
}

export async function api<T>(path: string, init: Init = {}): Promise<T> {
  const base = init.base ?? getSaved().server;
  if (!base) throw new ApiRequestError(0, "no_server", generic());
  const method = init.method ?? "GET";
  const withSession = init.base === undefined && !init.anonymous;
  const headers: Record<string, string> = { Accept: "application/json", "X-Language": currentLanguage() };
  if (init.file) headers["Content-Type"] = init.file.type;
  else if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (withSession && getSaved().cookie) headers.Cookie = getSaved().cookie;
  // A change is accepted only from the platform's own pages: the app says it comes from there, as the web app does.
  if (method !== "GET" && method !== "HEAD") {
    headers.Origin = base;
    headers.Referer = `${base}/`;
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      credentials: "omit",
      ...(init.file ? { body: init.file.data } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiRequestError(0, "network", generic());
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie && init.base === undefined) {
    const next = mergeCookies(withSession ? getSaved().cookie : "", setCookie);
    if (next !== getSaved().cookie) save({ cookie: next });
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* response without JSON */
  }
  if (!response.ok) {
    // Two formats: the platform's ({error:{code,message}}) and the session's ({code,message}).
    const d = (data ?? {}) as { error?: { code?: string; message?: string }; code?: string; message?: string };
    const code = d.error?.code ?? d.code ?? (response.status === 429 ? "too_many_requests" : "unknown");
    throw new ApiRequestError(response.status, code, d.error?.message ?? d.message ?? generic());
  }
  return data as T;
}

/** The platform's public configuration; with `base`, of a platform that is not saved yet. */
export const getConfig = (base?: string) => api<PublicConfig>("/api/config", base === undefined ? {} : { base });
export const getMe = () => api<Me>("/api/me");
export const getVehicles = () => api<{ vehicles: Vehicle[] }>("/api/vehicles").then((r) => r.vehicles);
export const getTrack = (id: string, minutes = 60) =>
  api<{ points: TrackPoint[] }>(`/api/vehicles/${encodeURIComponent(id)}/track?minutes=${minutes}`).then((r) => r.points);
export const getAddress = (id: string) =>
  api<{ address: string | null }>(`/api/vehicles/${encodeURIComponent(id)}/address`).then((r) => r.address);
export const setActiveAccount = (accountId: string) => api<null>("/api/accounts/active", { method: "POST", body: { accountId } });
/** Only what is sent changes: `phone: null` deletes the phone. */
export const updateSettings = (body: { name?: string; phone?: string | null; theme?: ThemeMode; language?: Language }) =>
  api<null>("/api/me/settings", { method: "PUT", body });
export const acceptTerms = () => api<null>("/api/consent", { method: "POST", body: { version: LEGAL_VERSION } });

/** Replaces the person's photo with a JPEG already cut to size. Returns where the new one is served. */
export const uploadPhoto = (data: Blob) => api<{ photoUrl: string }>("/api/me/photo", { method: "PUT", file: { data, type: "image/jpeg" } }).then((r) => r.photoUrl);
export const deletePhoto = () => api<null>("/api/me/photo", { method: "DELETE" });

/** Parked mode: the platform warns if the vehicle moves from where it was left. */
export const setParked = (id: string, parked: boolean) =>
  api<{ vehicle: Vehicle }>(`/api/vehicles/${encodeURIComponent(id)}/park`, { method: "POST", body: { parked } }).then((r) => r.vehicle);

/** The vehicle's latest events, the most recent first. */
export const getEvents = (vehicleId: string, limit: number) =>
  api<{ events: VehicleEvent[] }>(`/api/events?limit=${limit}&vehicleId=${encodeURIComponent(vehicleId)}`).then((r) => r.events);

/** Events asked for a page at a time, the most recent first. */
export const EVENTS_PAGE = 40;
/** A page of the account's events: those older than `before` (an event id); only the ones that ask for attention with `alerts`. */
export const getEventsPage = (opts: { before?: number | undefined; alerts: boolean }) =>
  api<{ events: VehicleEvent[] }>(`/api/events?limit=${EVENTS_PAGE}${opts.before ? `&before=${opts.before}` : ""}${opts.alerts ? "&alerts=1" : ""}`).then((r) => r.events);

/** What the account looks like now: its vehicles, those reporting and the events of the last day. */
export const getAccountSummary = () => api<{ summary: AccountSummary }>("/api/account/summary").then((r) => r.summary);

const rangeQuery = (from: Date, to: Date) => `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
/** Trips, stops and positions of a period, of at most 31 days. */
export const getHistory = (id: string, from: Date, to: Date) =>
  api<{ history: VehicleHistory }>(`/api/vehicles/${encodeURIComponent(id)}/history?${rangeQuery(from, to)}`).then((r) => r.history);

// Addresses come from a slow service: they are asked a few at a time, as the web app does.
const GEOCODE_AT_ONCE = 3;
let geocoding = 0;
const geocodeQueue: (() => void)[] = [];
export async function geocodePoint(lat: number, lon: number): Promise<string | null> {
  if (geocoding >= GEOCODE_AT_ONCE) await new Promise<void>((resolve) => geocodeQueue.push(resolve));
  geocoding++;
  try {
    return (await api<{ address: string | null }>("/api/geocode", { method: "POST", body: { lat, lon } })).address;
  } finally {
    geocoding--;
    geocodeQueue.shift()?.();
  }
}

// ─── Adding a GPS ────────────────────────────────────────────────────────────

/** The device families the platform knows, with their port and how each one is set up. */
export const getDeviceModels = () => api<{ models: DeviceModel[] }>("/api/device-models").then((r) => r.models);
export const createVehicle = (body: CreateVehicleInput) => api<{ vehicle: Vehicle }>("/api/vehicles", { method: "POST", body }).then((r) => r.vehicle);

// ─── Anti-theft (module A) and fuel (module F) ───────────────────────────────

export const getSecurity = (id: string) => api<{ security: VehicleSecurity }>(`/api/vehicles/${encodeURIComponent(id)}/security`).then((r) => r.security);
/** First step: the platform says how fast it goes and how recent its position is, and signs the request for two minutes. */
export const prepareLock = (id: string, action: "lock" | "unlock") =>
  api<{ check: LockCheck }>(`/api/vehicles/${encodeURIComponent(id)}/lock/prepare`, { method: "POST", body: { action } }).then((r) => r.check);
/** Second step: the signed request and the word the person typed. */
export const requestLock = (id: string, body: { action: "lock" | "unlock"; confirmToken: string; word: string }) =>
  api<{ security: VehicleSecurity }>(`/api/vehicles/${encodeURIComponent(id)}/lock`, { method: "POST", body }).then((r) => r.security);
export const cancelLock = (id: string) => api<{ security: VehicleSecurity }>(`/api/vehicles/${encodeURIComponent(id)}/lock`, { method: "DELETE" }).then((r) => r.security);
/** Turning it on gives the token of the link for the authorities, only this once. */
export const setRecovery = (id: string, on: boolean) =>
  api<{ security: VehicleSecurity; shareToken: string | null }>(`/api/vehicles/${encodeURIComponent(id)}/recovery`, { method: "POST", body: { on } });
export const getFuel = (id: string) => api<{ fuel: FuelStatus }>(`/api/vehicles/${encodeURIComponent(id)}/fuel`).then((r) => r.fuel);

// ─── Vehicles: editing and groups ────────────────────────────────────────────

export const getGroups = () => api<{ groups: VehicleGroup[] }>("/api/groups").then((r) => r.groups);
/** Name, plate and group; `groupId: null` leaves it without a group. */
export const updateVehicle = (id: string, body: UpdateVehicleInput) =>
  api<{ vehicle: Vehicle }>(`/api/vehicles/${encodeURIComponent(id)}`, { method: "PATCH", body }).then((r) => r.vehicle);
/** The device stops reporting to the account and the vehicle's trip history is deleted. */
export const removeDevice = (id: string) =>
  api<{ vehicle: Vehicle }>(`/api/vehicles/${encodeURIComponent(id)}/device`, { method: "DELETE" }).then((r) => r.vehicle);

// ─── Drivers (module B) and diagnostics (module C) ───────────────────────────

export const getDrivers = () => api<{ drivers: Driver[] }>("/api/drivers").then((r) => r.drivers);
export const getVehicleDriver = (id: string) => api<VehicleDriver>(`/api/vehicles/${encodeURIComponent(id)}/driver`);
/** `null` leaves the vehicle without a driver. */
export const setVehicleDriver = (id: string, driverId: string | null) =>
  api<VehicleDriver>(`/api/vehicles/${encodeURIComponent(id)}/driver`, { method: "PUT", body: { driverId } });
export const getDiagnostics = (id: string) => api<{ diagnostics: DiagStatus }>(`/api/vehicles/${encodeURIComponent(id)}/diagnostics`).then((r) => r.diagnostics);
/** Active fault codes and the resolved ones. */
export const getDiagFaults = (id: string) => api<{ faults: DiagFault[] }>(`/api/vehicles/${encodeURIComponent(id)}/diagnostics/faults`).then((r) => r.faults);

// ─── Incidents (module A) ────────────────────────────────────────────────────

/** The open ones, or all of them. */
export const getIncidents = (open: boolean) => api<{ incidents: Incident[] }>(`/api/incidents?open=${open ? 1 : 0}`).then((r) => r.incidents);
export const getIncident = (id: string) => api<{ incident: IncidentDetail }>(`/api/incidents/${encodeURIComponent(id)}`).then((r) => r.incident);
/** What the device does not report on its own: a theft told by phone, a crash. */
export const reportIncident = (vehicleId: string, note: string) =>
  api<{ incident: IncidentDetail }>("/api/incidents", { method: "POST", body: { vehicleId, note } }).then((r) => r.incident);
export const attendIncident = (id: string) =>
  api<{ incident: IncidentDetail }>(`/api/incidents/${encodeURIComponent(id)}/attend`, { method: "POST", body: {} }).then((r) => r.incident);
export const noteIncident = (id: string, text: string) =>
  api<{ incident: IncidentDetail }>(`/api/incidents/${encodeURIComponent(id)}/notes`, { method: "POST", body: { text } }).then((r) => r.incident);
export const closeIncident = (id: string, body: { resolution: IncidentResolution; note: string }) =>
  api<{ incident: IncidentDetail }>(`/api/incidents/${encodeURIComponent(id)}/close`, { method: "POST", body }).then((r) => r.incident);
/** A photo as evidence: the file goes as it is, with its name in the address. */
export const uploadEvidence = (id: string, data: Blob, name: string) =>
  api<{ incident: IncidentDetail }>(`/api/incidents/${encodeURIComponent(id)}/files?name=${encodeURIComponent(name)}`, { method: "POST", file: { data, type: "image/jpeg" } }).then(
    (r) => r.incident,
  );
export const evidencePath = (incidentId: string, fileId: string) => `/api/incidents/${encodeURIComponent(incidentId)}/files/${encodeURIComponent(fileId)}`;

// ─── Files ───────────────────────────────────────────────────────────────────

/** The trip of a period in a file, with the times in the phone's zone. */
export const historyExportPath = (id: string, from: Date, to: Date, format: ExportFormat, zone: string) =>
  `/api/vehicles/${encodeURIComponent(id)}/history/export?${rangeQuery(from, to)}&format=${format}&zone=${encodeURIComponent(zone)}`;

/**
 * Downloads a file of the platform with the session, to the phone's cache, with the name the platform
 * gives it. It is what the share menu then sends, or what opens to look at it.
 */
export async function downloadFile(path: string): Promise<File> {
  const base = getSaved().server;
  if (!base) throw new ApiRequestError(0, "no_server", generic());
  const folder = new Directory(Paths.cache, "files");
  folder.create({ idempotent: true, intermediates: true });
  try {
    return await File.downloadFileAsync(`${base}${path}`, folder, {
      headers: { Cookie: getSaved().cookie, "X-Language": currentLanguage() },
      idempotent: true,
    });
  } catch {
    throw new ApiRequestError(0, "network", generic());
  }
}

// ─── Shared location ─────────────────────────────────────────────────────────

export const getShares = (vehicleId: string) => api<{ links: ShareLink[] }>(`/api/vehicles/${encodeURIComponent(vehicleId)}/shares`).then((r) => r.links);
/** The token comes only now: the link cannot be shown again later. */
export const createShare = (vehicleId: string, body: ShareInput) =>
  api<{ link: ShareLink; token: string }>(`/api/vehicles/${encodeURIComponent(vehicleId)}/shares`, { method: "POST", body });
export const revokeShare = (id: string) => api<null>(`/api/shares/${encodeURIComponent(id)}`, { method: "DELETE" });

/** What to tell the person when an action fails: the platform's message, or the general one. */
export const errorText = (err: unknown) => (err instanceof ApiRequestError && err.status !== 0 ? err.message : i18n.t("errors.network"));

/** Where the confirmation email sends the person: the platform's own sign-in page, which says the email is confirmed. */
const VERIFIED_PAGE = "/login?verified=1";

/**
 * Where the system's browser goes to sign in with a service (ADR-0013): the platform starts the trip there and
 * sends the person back to the app with a pass. With `legalVersion`, whoever has no account gets one, having
 * accepted the terms the screen showed next to the buttons.
 */
export function oauthStartUrl(provider: OAuthProvider, legalVersion: string | null): string {
  return `${getSaved().server}${APP_OAUTH_START}?${writeQuery({ provider, ...(legalVersion ? { legalVersion } : {}) })}`;
}

export const auth = {
  /**
   * Creates the person and their account, with the terms they accepted. The platform asks them to confirm their
   * email first; the first account of an installation without mail comes in straight away (`emailVerified`).
   */
  signUp: (body: { name: string; email: string; password: string }) =>
    api<{ user?: { emailVerified?: boolean } } | null>("/api/auth/sign-up/email", {
      method: "POST",
      body: { ...body, legalVersion: LEGAL_VERSION, callbackURL: VERIFIED_PAGE },
      anonymous: true,
    }),
  /** Exchanges the pass the platform gave the app after the trip to a service for the session's cookie. */
  exchangePass: (token: string) => api<unknown>("/api/auth/one-time-token/verify", { method: "POST", body: { token }, anonymous: true }),
  signIn: (body: { email: string; password: string }) => api<unknown>("/api/auth/sign-in/email", { method: "POST", body, anonymous: true }),
  signOut: () => api<unknown>("/api/auth/sign-out", { method: "POST", body: {} }),
  /** The link arrives by email and opens the platform's own page to choose the new password. */
  requestPasswordReset: (email: string) =>
    api<unknown>("/api/auth/request-password-reset", { method: "POST", body: { email, redirectTo: "/reset-password" }, anonymous: true }),
  /** The link arrives by email and confirms the account on the platform's own page. */
  resendVerification: (email: string) =>
    api<unknown>("/api/auth/send-verification-email", { method: "POST", body: { email, callbackURL: VERIFIED_PAGE }, anonymous: true }),
  /** Deletes the person and the accounts they own. Asks for their password; whoever has none, a recent session. */
  deleteAccount: (password: string | null) => api<unknown>("/api/auth/delete-user", { method: "POST", body: password ? { password } : {} }),
};

// ─── Session messages ────────────────────────────────────────────────────────

/** Catalog key of the message for each session API error code. */
const AUTH_MESSAGES: Partial<Record<string, string>> = {
  INVALID_EMAIL_OR_PASSWORD: "auth.wrongCredentials",
  INVALID_PASSWORD: "deleteAccount.wrongPassword",
  EMAIL_NOT_VERIFIED: "auth.emailNotVerified",
  INVALID_EMAIL: "auth.invalidEmail",
  BANNED_USER: "auth.banned",
  SESSION_EXPIRED: "auth.sessionOld",
  too_many_requests: "auth.tooManyAttempts",
};

/** Message for a session API error, in the language of the app. */
export function authMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return i18n.t("auth.tooManyAttempts");
    // The platform explains these itself, in the app's language.
    if (["PLATFORM_OWNER", "password_policy", "registration_closed", "LEGAL_NOT_ACCEPTED"].includes(err.code)) return err.message;
    const key = AUTH_MESSAGES[err.code];
    return key ? i18n.t(key) : err.status === 0 ? err.message : generic();
  }
  return generic();
}
