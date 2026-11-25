// API client. All calls go to the same origin, with the session cookie.
import i18n, { currentLanguage } from "./i18n";
import {
  type AccountAdminInput,
  type AccountSummary,
  type AdminAccount,
  type AdminAccountDetail,
  type AlertRule,
  type AlertRuleInput,
  type AttachDeviceInput,
  type AuditEntry,
  type BackupSettingsInput,
  type BackupsInfo,
  type ChannelSettingsInput,
  type CreateVehicleInput,
  type Dashboard,
  type DashboardData,
  type DashboardInput,
  type DeviceModel,
  type DiagFault,
  type DiagLimits,
  type DiagParam,
  type DiagSeries,
  type DiagSettings,
  type DiagStatus,
  type Driver,
  type DriverInput,
  type DriverRank,
  type DriverReport,
  type DriverSettings,
  type ExportFormat,
  type FleetAssignments,
  type FleetDetail,
  type FleetExpense,
  type FleetExpenseInput,
  type FleetExpenses,
  type FleetProfileInput,
  type FleetState,
  type FleetStatus,
  type FleetUtilization,
  type FleetVehicle,
  type FuelFill,
  type FuelFillInput,
  type FuelImportResult,
  type FuelReport,
  type FuelSettings,
  type FuelStatus,
  type FuelTankInput,
  type GeneralSettingsInput,
  type Geofence,
  type GeofenceInput,
  type Incident,
  type IncidentDetail,
  type IncidentResolution,
  type InvitationPreview,
  type InviteInput,
  type Language,
  LEGAL_VERSION,
  type OAuthProvider,
  type OAuthSettingsInput,
  type LockCheck,
  type MailSettingsInput,
  type MailTemplateInfo,
  type MailTemplatesInput,
  type Me,
  type Member,
  type MemberUpdateInput,
  type PasswordPolicy,
  type PendingInvitation,
  type PlatformSettings,
  type PlatformStats,
  type PublicConfig,
  type ReportDocument,
  type ReportFormat,
  type ReportParams,
  type ReportSchedule,
  type ReportScheduleInput,
  type ReportType,
  type RoleInfo,
  type RoleInput,
  type SharedView,
  type ShareInput,
  type ShareLink,
  type StorageSettingsInput,
  type ThemeMode,
  type TrackPoint,
  type UpdateStatus,
  type UpdateVehicleInput,
  type Vehicle,
  type VehicleDriver,
  type VehicleEvent,
  type VehicleGroup,
  type VehicleHistory,
  type VehicleMeters,
  type VehicleSecurity,
} from "@opengps/shared";

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
const generic = () => i18n.t("map.errors.network");

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      // The backend answers in the language the interface is showing.
      headers: { "X-Language": currentLanguage(), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiRequestError(0, "network", generic());
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

export const getConfig = () => api<PublicConfig>("/api/config");
export const getMe = () => api<Me>("/api/me");
export const getModels = () => api<{ models: DeviceModel[] }>("/api/device-models").then((r) => r.models);
export const getVehicles = () => api<{ vehicles: Vehicle[] }>("/api/vehicles").then((r) => r.vehicles);
export const getTrack = (id: string, minutes = 60) =>
  api<{ points: TrackPoint[] }>(`/api/vehicles/${id}/track?minutes=${minutes}`).then((r) => r.points);
export const createVehicle = (body: CreateVehicleInput) =>
  api<{ vehicle: Vehicle }>("/api/vehicles", { method: "POST", body }).then((r) => r.vehicle);
export const updateVehicle = (id: string, body: UpdateVehicleInput) =>
  api<{ vehicle: Vehicle }>(`/api/vehicles/${id}`, { method: "PATCH", body }).then((r) => r.vehicle);
export const deleteVehicle = (id: string) => api<null>(`/api/vehicles/${id}`, { method: "DELETE" });
export const attachDevice = (id: string, body: AttachDeviceInput) =>
  api<{ vehicle: Vehicle }>(`/api/vehicles/${id}/device`, { method: "POST", body }).then((r) => r.vehicle);
export const removeDevice = (id: string) =>
  api<{ vehicle: Vehicle }>(`/api/vehicles/${id}/device`, { method: "DELETE" }).then((r) => r.vehicle);

export const getAddress = (id: string) => api<{ address: string | null }>(`/api/vehicles/${id}/address`).then((r) => r.address);

// ─── History ─────────────────────────────────────────────────────────────────

const rangeQuery = (from: Date, to: Date) => `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;

export const getHistory = (id: string, from: Date, to: Date) =>
  api<{ history: VehicleHistory }>(`/api/vehicles/${id}/history?${rangeQuery(from, to)}`).then((r) => r.history);

// Addresses come from a slow service: they are requested a few at a time.
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

/** Time zone of this browser: file times are written in it and report days are counted in it. */
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Downloads the trip as a file, with times in this browser's time zone. */
export const downloadHistory = (id: string, from: Date, to: Date, format: ExportFormat): Promise<void> =>
  download(`/api/vehicles/${id}/history/export?${rangeQuery(from, to)}&format=${format}&zone=${encodeURIComponent(browserZone())}`, i18n.t("map.files.trip", { format }));

/** Requests a file and saves it under the name the server proposes. */
async function download(path: string, fallbackName: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin" });
  } catch {
    throw new ApiRequestError(0, "network", generic());
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiRequestError(response.status, data?.error?.code ?? "unknown", data?.error?.message ?? generic());
  }
  const name = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ─── Geofences and events ────────────────────────────────────────────────────

export const getGeofences = () => api<{ geofences: Geofence[] }>("/api/geofences").then((r) => r.geofences);
/** Creates the geofence, or replaces it if its id is given. */
export const saveGeofence = (body: GeofenceInput, id?: string) =>
  api<{ geofence: Geofence }>(id ? `/api/geofences/${id}` : "/api/geofences", { method: id ? "PUT" : "POST", body }).then((r) => r.geofence);
export const deleteGeofence = (id: string) => api<null>(`/api/geofences/${id}`, { method: "DELETE" });
export const getEvents = (opts: { before?: number | undefined; alerts?: boolean; vehicleId?: string | undefined } = {}) =>
  api<{ events: VehicleEvent[] }>(
    `/api/events?limit=40${opts.before ? `&before=${opts.before}` : ""}${opts.alerts ? "&alerts=1" : ""}${opts.vehicleId ? `&vehicleId=${opts.vehicleId}` : ""}`,
  ).then((r) => r.events);

// ─── Shared location ─────────────────────────────────────────────────────────

export const getShares = (vehicleId: string) => api<{ links: ShareLink[] }>(`/api/vehicles/${vehicleId}/shares`).then((r) => r.links);
/** Creates a link. Its key arrives only in this response. */
export const createShare = (vehicleId: string, body: ShareInput) => api<{ link: ShareLink; token: string }>(`/api/vehicles/${vehicleId}/shares`, { method: "POST", body });
export const revokeShare = (id: string) => api<null>(`/api/shares/${id}`, { method: "DELETE" });
/** What whoever opens a link sees, without a session. */
export const viewShared = (token: string) => api<{ view: SharedView }>("/api/share/view", { method: "POST", body: { token } }).then((r) => r.view);
/** URL sent to the other person. The key goes after the hash: it never reaches the server logs. */
export const shareUrl = (token: string) => `${location.origin}/shared#${token}`;

// ─── Alerts ──────────────────────────────────────────────────────────────────

export const getAlerts = () => api<{ alerts: AlertRule[] }>("/api/alerts").then((r) => r.alerts);
/** Creates the alert, or replaces it if its id is given. */
export const saveAlert = (body: AlertRuleInput, id?: string) =>
  api<{ alert: AlertRule }>(id ? `/api/alerts/${id}` : "/api/alerts", { method: id ? "PUT" : "POST", body }).then((r) => r.alert);
export const deleteAlert = (id: string) => api<null>(`/api/alerts/${id}`, { method: "DELETE" });
/** Puts the vehicle in parked mode where it is, or takes it out of that mode. */
export const setParked = (id: string, parked: boolean) =>
  api<{ vehicle: Vehicle }>(`/api/vehicles/${id}/park`, { method: "POST", body: { parked } }).then((r) => r.vehicle);
export const saveSettings = (settings: { name?: string; theme?: ThemeMode; language?: Language | null; phone?: string | null }) => api<null>("/api/me/settings", { method: "PUT", body: settings });
/** Replaces the person's photo. The image goes as is, with its type in the header. Returns where the new one is served. */
export async function uploadPhoto(photo: Blob): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/me/photo", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": photo.type, "X-Language": currentLanguage() }, body: photo });
  } catch {
    throw new ApiRequestError(0, "network", generic());
  }
  const data = (await response.json().catch(() => null)) as { photoUrl?: string; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !data?.photoUrl) throw new ApiRequestError(response.status, data?.error?.code ?? "error", data?.error?.message ?? i18n.t("admin.profile.photo.failed"));
  return data.photoUrl;
}
export const deletePhoto = () => api<null>("/api/me/photo", { method: "DELETE" });
/** Renames the account the person is in. Its owner and its administrators do it. */
export const renameAccount = (name: string) => api<null>("/api/account", { method: "PATCH", body: { name } });

// ─── Module A · Anti-theft and commands ──────────────────────────────────────

export const getSecurity = (vehicleId: string) => api<{ security: VehicleSecurity }>(`/api/vehicles/${vehicleId}/security`).then((r) => r.security);
/** First step of a lock: the conditions the vehicle is in. */
export const prepareLock = (vehicleId: string, action: "lock" | "unlock") =>
  api<{ check: LockCheck }>(`/api/vehicles/${vehicleId}/lock/prepare`, { method: "POST", body: { action } }).then((r) => r.check);
/** Second step: the check from the first step and the word the person typed. */
export const sendLock = (vehicleId: string, body: { action: "lock" | "unlock"; confirmToken: string; word: string }) =>
  api<{ security: VehicleSecurity }>(`/api/vehicles/${vehicleId}/lock`, { method: "POST", body }).then((r) => r.security);
export const cancelLock = (vehicleId: string) => api<{ security: VehicleSecurity }>(`/api/vehicles/${vehicleId}/lock`, { method: "DELETE" }).then((r) => r.security);
/** Turns recovery mode on or off. On turning it on, it returns, only this once, the key of the link for authorities. */
export const setRecovery = (vehicleId: string, on: boolean) =>
  api<{ security: VehicleSecurity; shareToken: string | null }>(`/api/vehicles/${vehicleId}/recovery`, { method: "POST", body: { on } });

export const getIncidents = (open: boolean) => api<{ incidents: Incident[] }>(`/api/incidents?open=${open ? 1 : 0}`).then((r) => r.incidents);
export const getIncident = (id: string) => api<{ incident: IncidentDetail }>(`/api/incidents/${id}`).then((r) => r.incident);
export const reportIncident = (vehicleId: string, note: string) =>
  api<{ incident: IncidentDetail }>("/api/incidents", { method: "POST", body: { vehicleId, note } }).then((r) => r.incident);
export const attendIncident = (id: string) => api<{ incident: IncidentDetail }>(`/api/incidents/${id}/attend`, { method: "POST", body: {} }).then((r) => r.incident);
export const noteIncident = (id: string, text: string) =>
  api<{ incident: IncidentDetail }>(`/api/incidents/${id}/notes`, { method: "POST", body: { text } }).then((r) => r.incident);
export const closeIncident = (id: string, body: { resolution: IncidentResolution; note: string }) =>
  api<{ incident: IncidentDetail }>(`/api/incidents/${id}/close`, { method: "POST", body }).then((r) => r.incident);
export const evidenceUrl = (incidentId: string, fileId: string) => `/api/incidents/${incidentId}/files/${fileId}`;
/** Uploads a photo or a PDF as evidence. The file goes as is, with its type in the header. */
export async function uploadEvidence(incidentId: string, file: File): Promise<IncidentDetail> {
  let response: Response;
  try {
    response = await fetch(`/api/incidents/${incidentId}/files?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
  } catch {
    throw new ApiRequestError(0, "network", generic());
  }
  const data = (await response.json().catch(() => null)) as { incident?: IncidentDetail; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !data?.incident) {
    const message = response.status === 413 || response.status === 415 ? i18n.t("map.errors.evidenceFile") : (data?.error?.message ?? generic());
    throw new ApiRequestError(response.status, data?.error?.code ?? "unknown", message);
  }
  return data.incident;
}

// ─── Module B · Driver ───────────────────────────────────────────────────────

export const getDrivers = () => api<{ drivers: Driver[] }>("/api/drivers").then((r) => r.drivers);
/** Creates the driver, or replaces it if its id is given. */
export const saveDriver = (body: DriverInput, id?: string) =>
  api<{ driver: Driver }>(id ? `/api/drivers/${id}` : "/api/drivers", { method: id ? "PUT" : "POST", body }).then((r) => r.driver);
export const deleteDriver = (id: string) => api<null>(`/api/drivers/${id}`, { method: "DELETE" });
export const getDriverSettings = () => api<{ settings: DriverSettings }>("/api/drivers/settings").then((r) => r.settings);
export const saveDriverSettings = (body: DriverSettings) => api<{ settings: DriverSettings }>("/api/drivers/settings", { method: "PUT", body }).then((r) => r.settings);
export const getDriverRanking = (from: Date, to: Date, groupId: string | null) =>
  api<{ ranking: DriverRank[] }>(`/api/drivers/ranking?${rangeQuery(from, to)}${groupId ? `&groupId=${groupId}` : ""}`).then((r) => r.ranking);
export const getDriverReport = (id: string, from: Date, to: Date) =>
  api<{ report: DriverReport }>(
    `/api/drivers/${id}/report?${rangeQuery(from, to)}&zone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}`,
  ).then((r) => r.report);
export const getVehicleDriver = (vehicleId: string) => api<VehicleDriver>(`/api/vehicles/${vehicleId}/driver`);
export const setVehicleDriver = (vehicleId: string, driverId: string | null) => api<VehicleDriver>(`/api/vehicles/${vehicleId}/driver`, { method: "PUT", body: { driverId } });

// ─── Module D · Fleet ────────────────────────────────────────────────────────
export const getFleet = () => api<{ fleet: FleetVehicle[] }>("/api/fleet").then((r) => r.fleet);
export const getFleetVehicle = (vehicleId: string) => api<{ vehicle: FleetDetail }>(`/api/vehicles/${vehicleId}/fleet`).then((r) => r.vehicle);
export const saveFleetProfile = (vehicleId: string, body: FleetProfileInput) => api<{ vehicle: FleetDetail }>(`/api/vehicles/${vehicleId}/fleet`, { method: "PUT", body }).then((r) => r.vehicle);
export const setFleetStatus = (vehicleId: string, status: FleetStatus, note: string | null) =>
  api<{ vehicle: FleetDetail }>(`/api/vehicles/${vehicleId}/fleet/status`, { method: "PUT", body: { status, note } }).then((r) => r.vehicle);
export const setFleetState = (vehicleId: string, state: FleetState, note: string | null) =>
  api<{ vehicle: FleetDetail }>(`/api/vehicles/${vehicleId}/fleet/state`, { method: "PUT", body: { state, note } }).then((r) => r.vehicle);
export const fleetDocumentUrl = (documentId: string) => `/api/fleet/documents/${documentId}`;
/** Uploads a photo or a PDF of the vehicle. The file goes as is, with its type in the header. */
export async function uploadFleetDocument(vehicleId: string, file: File, meta: { kind: string; expiresOn?: string; note?: string }): Promise<FleetDetail> {
  const query = new URLSearchParams({ name: file.name, kind: meta.kind, ...(meta.expiresOn ? { expiresOn: meta.expiresOn } : {}), ...(meta.note ? { note: meta.note } : {}) });
  let response: Response;
  try {
    response = await fetch(`/api/vehicles/${vehicleId}/fleet/documents?${query}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  } catch {
    throw new ApiRequestError(0, "network", generic());
  }
  const data = (await response.json().catch(() => null)) as { vehicle?: FleetDetail; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !data?.vehicle) throw new ApiRequestError(response.status, data?.error?.code ?? "error", data?.error?.message ?? i18n.t("map.errors.documentFile"));
  return data.vehicle;
}
export const deleteFleetDocument = (documentId: string) => api<{ vehicle: FleetDetail }>(`/api/fleet/documents/${documentId}`, { method: "DELETE" }).then((r) => r.vehicle);
export const getFleetAssignments = (vehicleId: string) => api<{ assignments: FleetAssignments }>(`/api/vehicles/${vehicleId}/fleet/assignments`).then((r) => r.assignments);
export const addFleetAssignment = (vehicleId: string, body: { person: string; from: string; to: string | null; note: string | null }) =>
  api<{ assignments: FleetAssignments }>(`/api/vehicles/${vehicleId}/fleet/assignments`, { method: "POST", body }).then((r) => r.assignments);
export const removeFleetAssignment = (id: string) => api<{ assignments: FleetAssignments }>(`/api/fleet/assignments/${id}`, { method: "DELETE" }).then((r) => r.assignments);
export const getFleetExpenses = (from: string, to: string, vehicleId?: string) =>
  api<{ expenses: FleetExpenses }>(`/api/fleet/expenses?from=${from}&to=${to}${vehicleId ? `&vehicleId=${vehicleId}` : ""}&zone=${encodeURIComponent(browserZone())}`).then((r) => r.expenses);
export const addFleetExpense = (body: FleetExpenseInput) => api<{ expense: FleetExpense }>("/api/fleet/expenses", { method: "POST", body }).then((r) => r.expense);
export const updateFleetExpense = (id: string, body: FleetExpenseInput) => api<{ expense: FleetExpense }>(`/api/fleet/expenses/${id}`, { method: "PUT", body }).then((r) => r.expense);
export const deleteFleetExpense = (id: string) => api<null>(`/api/fleet/expenses/${id}`, { method: "DELETE" });
export const getFleetUtilization = (from: Date, to: Date) =>
  api<{ utilization: FleetUtilization }>(`/api/fleet/utilization?${rangeQuery(from, to)}&zone=${encodeURIComponent(browserZone())}`).then((r) => r.utilization);
/** Hangs a group under another, or leaves it loose with `null`. */
export const setGroupParent = (groupId: string, parentId: string | null) =>
  api<{ groups: VehicleGroup[] }>(`/api/fleet/groups/${groupId}/parent`, { method: "PUT", body: { parentId } }).then((r) => r.groups);

// ─── Module F · Fuel ─────────────────────────────────────────────────────────

export const getFuel = (vehicleId: string) => api<{ fuel: FuelStatus }>(`/api/vehicles/${vehicleId}/fuel`).then((r) => r.fuel);
export const saveFuel = (vehicleId: string, body: FuelTankInput) => api<{ fuel: FuelStatus }>(`/api/vehicles/${vehicleId}/fuel`, { method: "PUT", body }).then((r) => r.fuel);
export const removeFuel = (vehicleId: string) => api<null>(`/api/vehicles/${vehicleId}/fuel`, { method: "DELETE" });
export const getFuelReport = (vehicleId: string, from: Date, to: Date) =>
  api<{ report: FuelReport }>(`/api/vehicles/${vehicleId}/fuel/report?${rangeQuery(from, to)}`).then((r) => r.report);
/** Recorded fills and refuelings the sensor detected, from newest to oldest. */
export const getFuelFills = (vehicleId: string, from: Date, to: Date) =>
  api<{ fills: FuelFill[] }>(`/api/vehicles/${vehicleId}/fuel/fills?${rangeQuery(from, to)}`).then((r) => r.fills);
export const addFuelFill = (vehicleId: string, body: FuelFillInput) => api<{ fill: FuelFill }>(`/api/vehicles/${vehicleId}/fuel/fills`, { method: "POST", body }).then((r) => r.fill);
export const updateFuelFill = (id: string, body: FuelFillInput) => api<{ fill: FuelFill }>(`/api/fuel/fills/${id}`, { method: "PUT", body }).then((r) => r.fill);
export const deleteFuelFill = (id: string) => api<null>(`/api/fuel/fills/${id}`, { method: "DELETE" });
/** Records the fills from a CSV file; dates without a time zone are in this browser's time zone. */
export const importFuelFills = (csv: string) => api<{ result: FuelImportResult }>("/api/fuel/fills/import", { method: "POST", body: { csv, zone: browserZone() } }).then((r) => r.result);
export const getFuelSettings = () => api<{ settings: FuelSettings }>("/api/fuel/settings").then((r) => r.settings);
export const saveFuelSettings = (body: Pick<FuelSettings, "currency">) =>
  api<{ settings: FuelSettings }>("/api/fuel/settings", { method: "PUT", body: { ...body, zone: browserZone() } }).then((r) => r.settings);

// ─── Module C · Diagnostics ──────────────────────────────────────────────────
export const getDiagnostics = (vehicleId: string) => api<{ diagnostics: DiagStatus }>(`/api/vehicles/${vehicleId}/diagnostics`).then((r) => r.diagnostics);
export const getDiagSeries = (vehicleId: string, param: DiagParam, from: Date, to: Date) =>
  api<{ series: DiagSeries }>(`/api/vehicles/${vehicleId}/diagnostics/series?param=${param}&${rangeQuery(from, to)}`).then((r) => r.series);
export const getDiagFaults = (vehicleId: string) => api<{ faults: DiagFault[] }>(`/api/vehicles/${vehicleId}/diagnostics/faults`).then((r) => r.faults);
/** The vehicle's own limits: the ones sent; the rest go back to the account's. */
export const saveDiagLimits = (vehicleId: string, body: Partial<DiagLimits>) =>
  api<{ diagnostics: DiagStatus }>(`/api/vehicles/${vehicleId}/diagnostics/limits`, { method: "PUT", body }).then((r) => r.diagnostics);
export const getDiagSettings = () => api<{ settings: DiagSettings }>("/api/diagnostics/settings").then((r) => r.settings);
export const saveDiagSettings = (body: Omit<DiagSettings, "zone">) =>
  api<{ settings: DiagSettings }>("/api/diagnostics/settings", { method: "PUT", body: { ...body, zone: browserZone() } }).then((r) => r.settings);
export const getMeters = (vehicleId: string) => api<{ meters: VehicleMeters }>(`/api/vehicles/${vehicleId}/meters`).then((r) => r.meters);
/** Adjusts the odometer or engine hours to what the dashboard shows. */
export const saveMeters = (vehicleId: string, body: { odometerKm?: number; engineHours?: number }) =>
  api<{ meters: VehicleMeters }>(`/api/vehicles/${vehicleId}/meters`, { method: "PUT", body }).then((r) => r.meters);

// ─── Module G · Reports and dashboards ───────────────────────────────────────

function reportQuery(from: Date, to: Date, params: ReportParams): string {
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), zone: browserZone(), speedLimitKmh: String(params.speedLimitKmh), minStopMin: String(params.minStopMin) });
  if (params.groupId) query.set("groupId", params.groupId);
  if (params.vehicleIds) query.set("vehicleIds", params.vehicleIds.join(","));
  return query.toString();
}
export const getReport = (type: ReportType, from: Date, to: Date, params: ReportParams) =>
  api<{ report: ReportDocument }>(`/api/reports/${type}?${reportQuery(from, to, params)}`).then((r) => r.report);
export const downloadReport = (type: ReportType, from: Date, to: Date, params: ReportParams, format: ReportFormat) =>
  download(`/api/reports/${type}/export?${reportQuery(from, to, params)}&format=${format}`, i18n.t("map.files.report", { format }));

export interface SchedulesData {
  schedules: ReportSchedule[];
  /** People in the account who can receive a report. */
  people: { userId: string; name: string; email: string }[];
}
export const getSchedules = () => api<SchedulesData>("/api/reports/schedules");
export const saveSchedule = (body: ReportScheduleInput, id?: string) =>
  api<{ schedule: ReportSchedule }>(id ? `/api/reports/schedules/${id}` : "/api/reports/schedules", { method: id ? "PUT" : "POST", body }).then((r) => r.schedule);
export const deleteSchedule = (id: string) => api<null>(`/api/reports/schedules/${id}`, { method: "DELETE" });
export const sendSchedule = (id: string) => api<{ sentTo: number; schedule: ReportSchedule }>(`/api/reports/schedules/${id}/send`, { method: "POST", body: {} });

export const getDashboards = () => api<{ dashboards: Dashboard[] }>("/api/dashboards").then((r) => r.dashboards);
export const saveDashboard = (body: DashboardInput, id?: string) =>
  api<{ dashboard: Dashboard }>(id ? `/api/dashboards/${id}` : "/api/dashboards", { method: id ? "PUT" : "POST", body }).then((r) => r.dashboard);
export const deleteDashboard = (id: string) => api<null>(`/api/dashboards/${id}`, { method: "DELETE" });
export const getDashboardData = (from: Date, to: Date, scope: { groupId: string | null; vehicleIds: string[] | null }) =>
  api<{ data: DashboardData }>(
    `/api/dashboards/data?${rangeQuery(from, to)}&zone=${encodeURIComponent(browserZone())}${scope.vehicleIds ? `&vehicleIds=${scope.vehicleIds.join(",")}` : scope.groupId ? `&groupId=${scope.groupId}` : ""}`,
  ).then((r) => r.data);

export const getGroups = () => api<{ groups: VehicleGroup[] }>("/api/groups").then((r) => r.groups);
export const createGroup = (name: string) => api<{ group: VehicleGroup }>("/api/groups", { method: "POST", body: { name } }).then((r) => r.group);
export const renameGroup = (id: string, name: string) =>
  api<{ groups: VehicleGroup[] }>(`/api/groups/${id}`, { method: "PATCH", body: { name } }).then((r) => r.groups);
export const deleteGroup = (id: string) => api<null>(`/api/groups/${id}`, { method: "DELETE" });

// ─── Account users ───────────────────────────────────────────────────────────

export interface MembersData {
  members: Member[];
  invitations: PendingInvitation[];
  roles: RoleInfo[];
}
export const getMembers = () => api<MembersData>("/api/members");
export const inviteMember = (body: InviteInput) => api<{ invitation: PendingInvitation }>("/api/members/invitations", { method: "POST", body });
export const cancelInvitation = (id: string) => api<null>(`/api/members/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
export const updateMember = (userId: string, body: MemberUpdateInput) => api<null>(`/api/members/${encodeURIComponent(userId)}`, { method: "PATCH", body });
export const removeMember = (userId: string) => api<null>(`/api/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
export const createRole = (body: RoleInput) => api<{ roles: RoleInfo[] }>("/api/roles", { method: "POST", body });
export const updateRole = (id: string, body: RoleInput) => api<{ roles: RoleInfo[] }>(`/api/roles/${id}`, { method: "PATCH", body });
export const deleteRole = (id: string) => api<null>(`/api/roles/${id}`, { method: "DELETE" });

export const getInvitation = (id: string) =>
  api<{ invitation: InvitationPreview }>(`/api/invitations/${encodeURIComponent(id)}`).then((r) => r.invitation);
export const acceptInvitation = (id: string) => api<null>(`/api/invitations/${encodeURIComponent(id)}/accept`, { method: "POST", body: {} });
export const acceptLegal = () => api<null>("/api/consent", { method: "POST", body: { version: LEGAL_VERSION } });
export const leaveAccount = () => api<null>("/api/accounts/leave", { method: "POST", body: {} });
export const setActiveAccount = (accountId: string) => api<null>("/api/accounts/active", { method: "POST", body: { accountId } });

export const getAudit = (before?: number) =>
  api<{ entries: AuditEntry[] }>(`/api/audit?limit=50${before ? `&before=${before}` : ""}`).then((r) => r.entries);

// ─── Platform admin console ──────────────────────────────────────────────────

export const getAdminStats = () => api<{ stats: PlatformStats }>("/api/admin/stats").then((r) => r.stats);
/** The platform's version against the latest release. Only for whoever administers the platform. */
export const getUpdates = () => api<{ updates: UpdateStatus }>("/api/admin/updates").then((r) => r.updates);
/** Looks for a new version now, unless it was looked for less than a minute ago. */
export const checkUpdates = () => api<{ updates: UpdateStatus }>("/api/admin/updates/check", { method: "POST", body: {} }).then((r) => r.updates);
export const getAdminAudit = (before?: number) =>
  api<{ entries: AuditEntry[] }>(`/api/admin/audit?limit=50${before ? `&before=${before}` : ""}`).then((r) => r.entries);
export const getAccountSummary = () => api<{ summary: AccountSummary }>("/api/account/summary").then((r) => r.summary);
export const getAdminAccounts = (search: string) =>
  api<{ accounts: AdminAccount[] }>(`/api/admin/accounts?limit=100&search=${encodeURIComponent(search)}`).then((r) => r.accounts);
export const getAdminAccount = (id: string) =>
  api<{ account: AdminAccountDetail }>(`/api/admin/accounts/${encodeURIComponent(id)}`).then((r) => r.account);
export const updateAdminAccount = (id: string, body: AccountAdminInput) =>
  api<{ account: AdminAccountDetail }>(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body }).then((r) => r.account);
export interface SettingsInputs {
  general: GeneralSettingsInput;
  passwords: PasswordPolicy;
  mail: MailSettingsInput;
  storage: StorageSettingsInput;
  backups: BackupSettingsInput;
  channels: ChannelSettingsInput;
  oauth: OAuthSettingsInput;
  mailTemplates: MailTemplatesInput;
}
export const getPlatformSettings = () => api<{ settings: PlatformSettings }>("/api/admin/settings").then((r) => r.settings);
export const savePlatformSettings = <S extends keyof SettingsInputs>(section: S, body: SettingsInputs[S]) =>
  api<{ settings: PlatformSettings }>(`/api/admin/settings/${section}`, { method: "PUT", body }).then((r) => r.settings);
/** Resets a section to its defaults: what was saved is forgotten, along with its keys. */
export const resetPlatformSettings = (section: keyof SettingsInputs) => api<{ settings: PlatformSettings }>(`/api/admin/settings/${section}`, { method: "DELETE" }).then((r) => r.settings);
export const sendTestMail = () => api<{ sentTo: string }>("/api/admin/settings/mail/test", { method: "POST", body: {} });
/** The emails the platform writes, with their variables and how it writes them in each language. */
export const getMailTemplates = () => api<{ templates: MailTemplateInfo[] }>("/api/admin/settings/mail/templates").then((r) => r.templates);
/** Tests the storage with the form's data, without saving it. Without a secret key, the saved one is used. */
export const testPlatformStorage = (body: SettingsInputs["storage"]) => api<null>("/api/admin/settings/storage/test", { method: "POST", body });
export const getBackups = () => api<{ info: BackupsInfo }>("/api/admin/backups").then((r) => r.info);
export const startBackup = () => api<{ info: BackupsInfo }>("/api/admin/backups", { method: "POST", body: {} }).then((r) => r.info);
/** Looks in the external storage for backups not in the list and adds them. */
export const discoverBackups = () => api<{ info: BackupsInfo; found: number; added: number }>("/api/admin/backups/discover", { method: "POST", body: {} });
export const restoreBackup = (id: string, word: string) => api<{ info: BackupsInfo }>(`/api/admin/backups/${id}/restore`, { method: "POST", body: { word } }).then((r) => r.info);
export const deleteBackup = (id: string) => api<null>(`/api/admin/backups/${id}`, { method: "DELETE" });
/** The files of a backup can be very large: they are downloaded with a link, without going through the page's memory. */
export const backupFileUrl = (id: string, name: string) => `/api/admin/backups/${id}/files/${encodeURIComponent(name)}`;

export const banUser = (userId: string, banned: boolean) =>
  api<null>(`/api/admin/users/${encodeURIComponent(userId)}/ban`, { method: "POST", body: { banned } });
/** Deletes an account with everything in it; its people stay. `word` confirms it. */
export const deleteAdminAccount = (id: string, word: string) => api<null>(`/api/admin/accounts/${encodeURIComponent(id)}/delete`, { method: "POST", body: { word } });
/** Deletes a person and the accounts they own. `word` confirms it. */
export const deleteAdminUser = (userId: string, word: string) => api<null>(`/api/admin/users/${encodeURIComponent(userId)}/delete`, { method: "POST", body: { word } });

// ─── Session ─────────────────────────────────────────────────────────────────

/** Catalog key of the message for each session API error code. */
const AUTH_MESSAGES = {
  INVALID_EMAIL_OR_PASSWORD: "map.auth.wrongCredentials",
  EMAIL_NOT_VERIFIED: "map.auth.emailNotVerified",
  INVALID_EMAIL: "map.auth.invalidEmail",
  PASSWORD_TOO_SHORT: "map.auth.passwordTooShort",
  PASSWORD_TOO_LONG: "map.auth.passwordTooLong",
  USER_ALREADY_EXISTS: "map.auth.emailTaken",
  LEGAL_NOT_ACCEPTED: "map.auth.legalNotAccepted",
  INVALID_PASSWORD: "map.auth.wrongPassword",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "map.auth.emailTaken",
  INVALID_TOKEN: "map.auth.invalidLink",
  BANNED_USER: "map.auth.banned",
  SESSION_EXPIRED: "map.auth.sessionOld",
  too_many_requests: "map.auth.tooManyAttempts",
} as const;

/** Errors that already arrive explained from the server: the password policy and closed registration. */
const SERVER_WORDED = ["password_policy", "registration_closed", "PLATFORM_OWNER"];

/** Message for a session API error, in the language of the interface. */
export function authMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return i18n.t(AUTH_MESSAGES.too_many_requests);
    if (SERVER_WORDED.includes(err.code)) return err.message;
    const key = (AUTH_MESSAGES as Partial<Record<string, (typeof AUTH_MESSAGES)[keyof typeof AUTH_MESSAGES]>>)[err.code];
    return key ? i18n.t(key) : err.status === 0 ? err.message : generic();
  }
  return generic();
}

const VERIFY_CALLBACK = "/login?verified=1";

/** Internal destination to return to after signing in; never an external URL. */
export function safeNext(next: string | null | undefined): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
}

export const auth = {
  /** `next`: where to take the person once they confirm their email. */
  /** The account created. It comes already confirmed when it is the first one of an installation without mail. */
  signUp: (body: { name: string; email: string; password: string }, next?: string | null) =>
    api<{ user?: { emailVerified?: boolean } } | null>("/api/auth/sign-up/email", { method: "POST", body: { ...body, legalVersion: LEGAL_VERSION, callbackURL: safeNext(next) ?? VERIFY_CALLBACK } }),
  signIn: (body: { email: string; password: string }) => api("/api/auth/sign-in/email", { method: "POST", body: { ...body, callbackURL: VERIFY_CALLBACK } }),
  signOut: () => api("/api/auth/sign-out", { method: "POST", body: {} }),
  resendVerification: (email: string, next?: string | null) =>
    api("/api/auth/send-verification-email", { method: "POST", body: { email, callbackURL: safeNext(next) ?? VERIFY_CALLBACK } }),
  requestPasswordReset: (email: string) =>
    api("/api/auth/request-password-reset", { method: "POST", body: { email, redirectTo: "/reset-password" } }),
  /**
   * Where to go to sign in with another service. Whoever has no account yet gets one there and then, with the terms
   * the screen shows next to the button accepted; whatever goes wrong comes back to the screen it started from.
   */
  social: (provider: OAuthProvider, opts: { from: "login" | "signup"; next: string | null }) => {
    const next = safeNext(opts.next);
    const back = `/${opts.from}?via=oauth${next ? `&next=${encodeURIComponent(next)}` : ""}`;
    return api<{ url: string }>("/api/auth/sign-in/social", {
      method: "POST",
      body: {
        provider,
        disableRedirect: true,
        callbackURL: next ?? "/",
        errorCallbackURL: back,
        requestSignUp: true,
        newUserCallbackURL: next ?? "/",
        additionalData: { legalVersion: LEGAL_VERSION },
      },
    });
  },
  /** Deletes the user and the accounts they own. Asks for their password; whoever has none, a recent session. */
  deleteAccount: (password: string | null) => api("/api/auth/delete-user", { method: "POST", body: password ? { password } : {} }),
  resetPassword: (token: string, newPassword: string) => api("/api/auth/reset-password", { method: "POST", body: { token, newPassword } }),
};
