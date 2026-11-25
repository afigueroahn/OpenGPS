// Types and rules shared by the backend and the web app.
import { GEOFENCE_LIMITS, type GeofenceGeometry, geometryProblem } from "./geo";
import { cronProblem } from "./cron";
import { STORAGE_FLAGS_MAX, STORAGE_FLAG_MAX_LENGTH, STORAGE_PROVIDERS, STORAGE_PROVIDER_DEFAULT, storageFlagProblem, storageNeedsEndpoint } from "./storage";
import { type WeekSchedule, isValidZone } from "./schedule";
import { SHARED_TEXT, type SharedKey, type SharedSay } from "./locales";
import { es } from "./locales/es";
import { z } from "zod";

/**
 * The message of a validation rule: zod carries a plain text, so the schemas
 * write the key of the shared text ("validation.zone") and whoever shows the
 * issue says it in the reader's language (see `issueSay`).
 */
const v = <K extends SharedKey>(key: K): K => key;
/** The issue of a rule whose text has variables, or comes from a helper of this package: the key as the message, the variables in `params`. */
const issueOf = (problem: SharedSay) => ({ code: "custom" as const, message: problem.key, params: problem.params });

/** Languages the platform is available in. The first one is the default. */
export const LANGUAGES = ["es", "en"] as const;
export type Language = (typeof LANGUAGES)[number];
/** Each language, written in that language. */
export const LANGUAGE_NAME: Record<Language, string> = { es: "Español", en: "English" };

// ─── Confirmation words ──────────────────────────────────────────────────────
// What is dangerous is confirmed by typing a word. The screen asks for the word
// of the reader's language, and the backend accepts the word of any language.

/** What is confirmed by typing a word: locking or unlocking a vehicle remotely, restoring a backup, deleting an account. */
export type ConfirmAction = keyof typeof es.confirmWord;
/** The word to type, in a language. */
export const confirmWord = (action: ConfirmAction, language: Language): string => SHARED_TEXT[language].confirmWord[action];
/** The words that confirm an action: one per language. */
export const confirmWords = (action: ConfirmAction): string[] => LANGUAGES.map((language) => confirmWord(action, language));
/** Whether what the person typed is the word of the action in some language. Capitals and the spaces around do not matter. */
export const isConfirmWord = (action: ConfirmAction, typed: string): boolean => confirmWords(action).some((word) => word.toUpperCase() === typed.trim().toUpperCase());

// ─── Device catalog ──────────────────────────────────────────────────────────

export interface SetupStep {
  title: string;
  /** Text with {host}, {ip} and {port}, which the web app replaces with the server's. */
  text: string;
  /** Example command, also with {host}, {ip} and {port}. */
  command?: string;
}

export interface DeviceModel {
  id: string;
  brand: string;
  name: string;
  examples: string;
  protocol: string;
  port: number;
  /** What the identifier is called on that device: "IMEI" or "ID". */
  idLabel: string;
  setup: SetupStep[];
  /** Models known to belong to this family, to find a device by its name. */
  models: string[];
}

// ─── Vehicles ────────────────────────────────────────────────────────────────

export type DeviceStatus = "pending" | "active";

export interface VehicleState {
  lastSeenAt: string;
  fixTime: string | null;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  speedKmh: number | null;
  course: number | null;
  accuracy: number | null;
  ignition: boolean | null;
  /** The ignition does not come from the device: it was inferred from the vehicle's voltage. */
  ignitionInferred: boolean;
  motion: boolean | null;
  /** Vehicle battery voltage, in volts. */
  powerVoltage: number | null;
  /** Device internal battery: volts and, if it reports it, percentage. */
  batteryVoltage: number | null;
  batteryLevel: number | null;
  satellites: number | null;
  /** Cellular signal in bars, from 0 to 4. */
  signalBars: number | null;
}

export interface VehicleDevice {
  uniqueId: string;
  modelId: string;
  /** The model chosen from the family's list when it was added; null = only the family is known. */
  modelName: string | null;
  status: DeviceStatus;
  claimExpiresAt: string | null;
  confirmedAt: string | null;
}

export interface Vehicle {
  id: string;
  name: string;
  plate: string | null;
  createdAt: string;
  groupId: string | null;
  /** Since when it has been in parked mode; null = it is not. */
  parkedSince: string | null;
  device: VehicleDevice | null;
  state: VehicleState | null;
}

export interface VehicleGroup {
  id: string;
  name: string;
  /** Group it hangs from, if it is a subgroup. What applies to a group applies to those that hang from it. */
  parentId: string | null;
  vehicleCount: number;
}

export interface TrackPoint {
  t: string;
  lat: number;
  lon: number;
  speedKmh: number | null;
  course: number | null;
}

// ─── Trip history ────────────────────────────────────────────────────────────

/** Trip point, compact: many are sent. */
export interface HistoryPoint {
  /** GPS time, in seconds since 1970. */
  t: number;
  lat: number;
  lon: number;
  /** Speed in km/h. */
  s: number;
  /** Heading in degrees. */
  c: number | null;
  /** Engine on, if known. */
  i: boolean | null;
}

export interface Trip {
  start: string;
  end: string;
  durationS: number;
  distanceM: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  /** Time with the engine on and not moving, within the trip. */
  idleS: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  /** Approximate address, if already known; if not, it is requested separately. */
  startAddress: string | null;
  endAddress: string | null;
}

export interface Stop {
  start: string;
  end: string;
  durationS: number;
  lat: number;
  lon: number;
  /** Part of the stop with the engine on. */
  idleS: number;
  /** Approximate address, if already known; if not, it is requested separately. */
  address: string | null;
}

export interface HistorySummary {
  from: string;
  to: string;
  distanceM: number;
  movingS: number;
  /** Engine on without moving, in trips and in stops. */
  idleS: number;
  stoppedS: number;
  maxSpeedKmh: number;
  /** Average while it was moving. */
  avgSpeedKmh: number;
  trips: number;
  stops: number;
  /** Positions of the period, before thinning them for the map. */
  positions: number;
}

export interface VehicleHistory {
  summary: HistorySummary;
  trips: Trip[];
  stops: Stop[];
  /** Trip for the map and the player; thinned if the period is long. */
  points: HistoryPoint[];
}

/** Days a history query can span. */
export const HISTORY_MAX_DAYS = 31;
/** Maximum number of points in the trip sent to the map. */
export const HISTORY_MAX_POINTS = 8000;
export const EXPORT_FORMATS = ["xlsx", "pdf", "csv", "gpx", "kml"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  xlsx: "Excel",
  pdf: "PDF",
  csv: "CSV",
  gpx: "GPX",
  kml: "KML",
};

// ─── Geofences and events ────────────────────────────────────────────────────

/**
 * What a geofence does: notify of entries and exits, notify if a vehicle
 * enters (forbidden zone) or notify if a vehicle leaves (authorized zone).
 */
export const GEOFENCE_KINDS = ["notify", "forbidden", "authorized"] as const;
export type GeofenceKind = (typeof GEOFENCE_KINDS)[number];
/** Color of each type on the map; routes have their own. */
export const GEOFENCE_COLOR: Record<GeofenceKind | "corridor", string> = {
  notify: "#3f7fd1",
  forbidden: "#cf3a32",
  authorized: "#12a065",
  corridor: "#7c6cf0",
};

export interface Geofence {
  id: string;
  name: string;
  geometry: GeofenceGeometry;
  kind: GeofenceKind;
  /** Days and hours when the rule applies; null = always. */
  schedule: WeekSchedule | null;
  /** Notifies if a vehicle stays fewer than this many minutes. */
  minStayMin: number | null;
  /** Notifies if a vehicle stays more than this many minutes. */
  maxStayMin: number | null;
  /** Vehicle groups it applies to; null = all in the account. */
  groupIds: string[] | null;
  /** Vehicles it applies to, chosen one by one; null = it goes by groups. */
  vehicleIds: string[] | null;
  active: boolean;
  createdAt: string;
  /** Vehicles that are inside right now. */
  inside: number;
}

export const EVENT_TYPES = [
  "geofence_enter",
  "geofence_exit",
  "zone_forbidden",
  "zone_left",
  "stay_short",
  "stay_long",
  "route_deviation",
  "route_return",
  "speeding",
  "ignition_off_hours",
  "signal_lost",
  "signal_back",
  "unauthorized_movement",
  "sos",
  "power_cut",
  "tow",
  "harsh_driving",
  "custom",
  "tampering",
  "jamming",
  "engine_locked",
  "engine_unlocked",
  "driving_time",
  "fuel_refuel",
  "fuel_drain",
  "fuel_theft",
  "engine_fault",
  "engine_fault_cleared",
  "engine_overrev",
  "engine_overheat",
  "battery_low",
  "service_soon",
  "service_due",
  "expiry_soon",
  "expiry_due",
  "sensor_alert",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
/** Events that call for attention; the rest are only records. */
export const ALERT_EVENTS: readonly EventType[] = [
  "zone_forbidden",
  "zone_left",
  "stay_short",
  "stay_long",
  "route_deviation",
  "speeding",
  "ignition_off_hours",
  "signal_lost",
  "unauthorized_movement",
  "sos",
  "power_cut",
  "tow",
  "harsh_driving",
  "custom",
  "tampering",
  "jamming",
  "driving_time",
  "fuel_drain",
  "fuel_theft",
  "engine_fault",
  "engine_overrev",
  "engine_overheat",
  "battery_low",
  "service_soon",
  "service_due",
  "expiry_soon",
  "expiry_due",
  "sensor_alert",
];

/** Notifications from the maintenance module: their detail says what they are about (`subject`) and why (`reason`). */
export const MAINTENANCE_EVENTS: readonly EventType[] = ["service_soon", "service_due", "expiry_soon", "expiry_due"];
/** Notifications that say what they are about and why in their detail (`subject` and `reason`): maintenance and sensor ones. */
export const SUBJECT_EVENTS: readonly EventType[] = [...MAINTENANCE_EVENTS, "sensor_alert"];

/** Events that originate from a geofence. */
export const GEOFENCE_EVENTS: readonly EventType[] = [
  "geofence_enter",
  "geofence_exit",
  "zone_forbidden",
  "zone_left",
  "stay_short",
  "stay_long",
  "route_deviation",
  "route_return",
];

export interface VehicleEvent {
  id: number;
  type: EventType;
  at: string;
  vehicleId: string;
  vehicleName: string;
  geofenceId: string | null;
  geofenceName: string | null;
  /** Alert that generated it, if it came from one. */
  ruleName: string | null;
  lat: number | null;
  lon: number | null;
  speedKmh: number | null;
  /** Type-specific data: minutes of stay, for example. */
  detail: Record<string, unknown>;
}

// ─── Shared location ─────────────────────────────────────────────────────────

/** Durations offered for a link, in hours. */
export const SHARE_DURATIONS = [1, 8, 24, 72, 168] as const;
/** The longest a link can last: 30 days. */
export const SHARE_MAX_HOURS = 30 * 24;
/** Active links a vehicle can have at once. */
export const SHARE_MAX_ACTIVE = 20;

/** Link as the account sees it. The full URL exists only when it is created. */
export interface ShareLink {
  id: string;
  vehicleId: string;
  note: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  /** Times someone opened the link. */
  views: number;
  lastViewedAt: string | null;
}

/** What whoever opens a link sees: just enough to know where the vehicle is. */
export interface SharedView {
  name: string;
  expiresAt: string;
  status: "moving" | "stopped" | "offline" | "unknown";
  position: { lat: number; lon: number; speedKmh: number; course: number | null; fixTime: string } | null;
  lastSeenAt: string | null;
}

// ─── Module A · Anti-theft and commands ──────────────────────────────────────

/** The lock is only sent with the vehicle below this speed. */
export const LOCK_MAX_SPEED_KMH = 10;
/** And with a position newer than this: without knowing where and how it is moving, it is not locked. */
export const LOCK_MAX_FIX_AGE_S = 90;
/** A command that could not be sent stops being retried after this time. */
export const COMMAND_TTL_MIN = 30;

export type CommandKind = "lock" | "unlock";
export type CommandStatus = "waiting" | "sent" | "confirmed" | "unconfirmed" | "failed" | "expired" | "cancelled";

export interface VehicleCommand {
  id: string;
  vehicleId: string;
  kind: CommandKind;
  status: CommandStatus;
  requestedBy: string | null;
  createdAt: string;
  expiresAt: string;
  sentAt: string | null;
  finishedAt: string | null;
  /** Why it is waiting, or why it failed. */
  note: string | null;
}

export interface VehicleSecurity {
  /** The device supports remote lock; null = not known yet because it has not reported. */
  lockSupported: boolean | null;
  /** Last commanded state, and whether the device confirmed it. null = never used. */
  lock: { state: "locked" | "unlocked"; confirmed: boolean; changedAt: string } | null;
  /** Command in progress, if any. */
  pending: VehicleCommand | null;
  recovery: { since: string } | null;
  /** Latest commands, from newest to oldest. */
  commands: VehicleCommand[];
}

/** What is checked before asking for confirmation of a lock. */
export interface LockCheck {
  /** Sent back on confirming; expires in two minutes. */
  confirmToken: string;
  speedKmh: number | null;
  fixAgeS: number | null;
  /** It can be sent now; if not, the command waits for the vehicle to slow down. */
  safeNow: boolean;
}

export const INCIDENT_KINDS = ["sos", "tow", "tampering", "jamming", "power_cut", "movement", "manual"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export type IncidentStatus = "open" | "attended" | "closed";
export const INCIDENT_RESOLUTIONS = ["recovered", "false_alarm", "resolved", "other"] as const;
export type IncidentResolution = (typeof INCIDENT_RESOLUTIONS)[number];
/** Minutes a panic button goes unattended before each escalation. */
export const SOS_ESCALATION_MIN = [5, 15] as const;

export interface Incident {
  id: string;
  vehicleId: string;
  vehicleName: string;
  kind: IncidentKind;
  /** 1 = priority. */
  priority: 1 | 2;
  status: IncidentStatus;
  openedAt: string;
  attendedBy: string | null;
  attendedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  resolution: IncidentResolution | null;
  /** Times it was escalated for staying unattended. */
  escalation: number;
  lat: number | null;
  lon: number | null;
}
export interface IncidentEntry {
  id: number;
  at: string;
  kind: "alarm" | "note" | "command" | "recovery" | "evidence" | "status" | "escalation";
  userName: string | null;
  text: string;
  file: { id: string; name: string; size: number; mime: string } | null;
}
export interface IncidentDetail extends Incident {
  entries: IncidentEntry[];
}

// ─── Module B · Driver ───────────────────────────────────────────────────────

export interface Driver {
  id: string;
  name: string;
  license: string | null;
  phone: string | null;
  /** Identification key (iButton or card), as the device reads it. */
  keyId: string | null;
  notes: string;
  active: boolean;
  /** Vehicle they are driving now, and since when. */
  vehicleId: string | null;
  since: string | null;
}

export const DRIVER_EVENT_TYPES = ["accel", "brake", "corner", "speeding"] as const;
export type DriverEventType = (typeof DRIVER_EVENT_TYPES)[number];
/** Points each event subtracts when computing the score. */
export const DRIVER_EVENT_POINTS: Record<DriverEventType, number> = { accel: 3, brake: 4, corner: 3, speeding: 5 };
/** With fewer kilometers than this there is no score: the sample is too small. */
export const SCORE_MIN_KM = 10;

/**
 * Driving score from 0 to 100: 100 minus the penalty points per
 * 100 km driven. One hard brake per 100 km leaves the score at 96.
 */
export function drivingScore(points: number, distanceM: number): number | null {
  const km = distanceM / 1000;
  if (km < SCORE_MIN_KM) return null;
  return Math.max(0, Math.round(100 - (points * 100) / km));
}

export interface DriverSettings {
  /** Speed above which an excess counts. */
  speedLimitKmh: number;
  /** Consecutive seconds above the limit for it to count. */
  speedingSeconds: number;
  /** Maximum continuous driving before notifying. */
  maxContinuousMin: number;
  /** Pause that counts as a rest. */
  minRestMin: number;
  /** Maximum driving in a day. */
  maxDailyMin: number;
}
export const DRIVER_SETTINGS_DEFAULT: DriverSettings = { speedLimitKmh: 100, speedingSeconds: 10, maxContinuousMin: 240, minRestMin: 30, maxDailyMin: 600 };
/** A shift ends with a rest of at least this long; the next driving opens another. */
export const SHIFT_REST_MIN = 480;

/** Who is driving a vehicle now, and the last key its device read. */
export interface VehicleDriver {
  driver: { id: string; name: string; since: string; source: "manual" | "key" } | null;
  /** Key read by the device that belongs to no registered driver. */
  unknownKey: { key: string; at: string } | null;
}

export interface DriverRank {
  /** null = what was driven without an assigned driver. */
  driverId: string | null;
  name: string;
  distanceM: number;
  drivingS: number;
  counts: Record<DriverEventType, number>;
  points: number;
  score: number | null;
  /** Longest stretch driving without a rest. */
  longestStretchS: number;
  /** Shifts in which it exceeded the daily maximum. */
  daysOverDaily: number;
}
/** A shift: the driving between two long rests. */
export interface DriverDay {
  /** Local day it started: "2026-11-22". */
  date: string;
  start: string;
  end: string;
  distanceM: number;
  drivingS: number;
  longestStretchS: number;
  rests: number;
  counts: Record<DriverEventType, number>;
}
export interface DriverEvent {
  id: number;
  type: DriverEventType;
  at: string;
  vehicleId: string;
  vehicleName: string;
  lat: number | null;
  lon: number | null;
  speedKmh: number | null;
}
export interface DriverReport {
  rank: DriverRank;
  days: DriverDay[];
  events: DriverEvent[];
}

// ─── Odometer and engine hours ───────────────────────────────────────────────

/** Odometer and engine hours of a vehicle: the vehicle's own if the device reads them, or those the platform keeps. */
export interface VehicleMeters {
  odometerKm: number;
  /** "ecu": the device reads it from the vehicle's computer. "gps": the platform adds it up from the distance driven. */
  odometerSource: "ecu" | "gps";
  engineHours: number;
  /** "ecu": from the vehicle. "ignition": the platform adds it up from engine-on time. */
  hoursSource: "ecu" | "ignition";
  /** Since when the platform has been keeping count. */
  since: string;
}
export const vehicleMetersSchema = z
  .object({
    /** What the dashboard shows now. Without the value, it is left untouched. */
    odometerKm: z.number().min(0).max(5_000_000).optional(),
    engineHours: z.number().min(0).max(500_000).optional(),
  })
  .refine((m) => m.odometerKm !== undefined || m.engineHours !== undefined, v("validation.metersNeeded"));

// ─── Module C · Diagnostics ──────────────────────────────────────────────────

/**
 * What the platform can read from the vehicle. Each device sends only part of it.
 * Each `label` is Spanish only and will go: use the catalog, "diagParam.<param>".
 */
export const DIAG_PARAMS = {
  rpm: { label: es.diagParam.rpm, unit: "rpm", decimals: 0 },
  coolantTemp: { label: es.diagParam.coolantTemp, unit: "°C", decimals: 0 },
  power: { label: es.diagParam.power, unit: "V", decimals: 1 },
  engineLoad: { label: es.diagParam.engineLoad, unit: "%", decimals: 0 },
  throttle: { label: es.diagParam.throttle, unit: "%", decimals: 0 },
  obdSpeed: { label: es.diagParam.obdSpeed, unit: "km/h", decimals: 0 },
  fuelLevel: { label: es.diagParam.fuelLevel, unit: "%", decimals: 0 },
  fuelLevelL: { label: es.diagParam.fuelLevelL, unit: "L", decimals: 1 },
  fuelUsed: { label: es.diagParam.fuelUsed, unit: "L", decimals: 1 },
  fuelRate: { label: es.diagParam.fuelRate, unit: "L/h", decimals: 1 },
  intakeTemp: { label: es.diagParam.intakeTemp, unit: "°C", decimals: 0 },
  oilTemp: { label: es.diagParam.oilTemp, unit: "°C", decimals: 0 },
  ecuOdometer: { label: es.diagParam.ecuOdometer, unit: "km", decimals: 0 },
  ecuHours: { label: es.diagParam.ecuHours, unit: "h", decimals: 1 },
  moduleVoltage: { label: es.diagParam.moduleVoltage, unit: "V", decimals: 1 },
  engineRuntime: { label: es.diagParam.engineRuntime, unit: "min", decimals: 0 },
  deviceBattery: { label: es.diagParam.deviceBattery, unit: "V", decimals: 2 },
} as const satisfies Record<string, { label: string; unit: string; decimals: number }>;
export type DiagParam = keyof typeof DIAG_PARAMS;
export const DIAG_PARAM_KEYS = Object.keys(DIAG_PARAMS) as DiagParam[];
/** Counters: they only grow, and what matters for the period is how much they advanced. */
export const DIAG_COUNTERS: readonly DiagParam[] = ["fuelUsed", "ecuOdometer", "ecuHours"];


export interface DiagReading {
  param: DiagParam;
  value: number;
  at: string;
}
export interface DiagFault {
  code: string;
  description: string;
  /** With its own description, or only that of its code family. */
  specific: boolean;
  system: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** When the vehicle stopped reporting it; null if still active. */
  clearedAt: string | null;
}
/** Values from which a notification is sent. Null: that notification is off. */
export interface DiagLimits {
  /** Revolutions per minute. */
  rpmMax: number | null;
  /** Engine temperature, in °C. */
  tempMaxC: number | null;
  /** Vehicle battery voltage, for a 12 V system. On a 24 V one it is double. */
  voltageMinV: number | null;
}
export const DIAG_LIMITS_DEFAULT: DiagLimits = { rpmMax: 4500, tempMaxC: 105, voltageMinV: 11.8 };
export interface DiagSettings extends DiagLimits {
  zone: string;
}
export interface DiagStatus {
  /** The latest the device read of each value, over the last days. */
  readings: DiagReading[];
  /** Active fault codes and the most recent resolved ones. */
  faults: DiagFault[];
  /** Numeric values the device sends that the platform cannot name. */
  others: { name: string; value: number }[];
  /** The limits that apply to this vehicle, and its own if it has any (the rest come from the account). */
  limits: DiagLimits;
  own: Partial<DiagLimits>;
  meters: VehicleMeters;
}
export interface DiagSeries {
  param: DiagParam;
  from: string;
  to: string;
  /** `t` in seconds. */
  points: { t: number; v: number }[];
  min: number | null;
  max: number | null;
  avg: number | null;
  /** For a counter, how much it advanced in the period. */
  delta: number | null;
  /** The notification limit that corresponds to it, if any. */
  limit: number | null;
}
const limitSchema = (min: number, max: number) => z.number().min(min).max(max).nullable();
export const diagLimitsSchema = z.object({
  rpmMax: limitSchema(500, 12_000).optional(),
  tempMaxC: limitSchema(40, 200).optional(),
  voltageMinV: limitSchema(6, 30).optional(),
});
export const diagSettingsSchema = z.object({
  rpmMax: limitSchema(500, 12_000),
  tempMaxC: limitSchema(40, 200),
  voltageMinV: limitSchema(6, 30),
  zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")),
});

// ─── Module D · Fleet ────────────────────────────────────────────────────────

/** Availability set by hand. "En ruta" (on route) is not set: an available vehicle that is moving is on route. */
export const FLEET_STATUSES = ["available", "workshop", "out_of_service"] as const;
export type FleetStatus = (typeof FLEET_STATUSES)[number];
export type FleetAvailability = FleetStatus | "on_route";
export const FLEET_STATES = ["active", "suspended", "retired"] as const;
export type FleetState = (typeof FLEET_STATES)[number];
export const FLEET_EXPENSE_CATEGORIES = ["fuel", "maintenance", "toll", "fine", "insurance", "tax", "parking", "other"] as const;
export type FleetExpenseCategory = (typeof FLEET_EXPENSE_CATEGORIES)[number];
export const FLEET_DOCUMENT_KINDS = ["photo", "registration", "insurance", "inspection", "permit", "invoice", "other"] as const;
export type FleetDocumentKind = (typeof FLEET_DOCUMENT_KINDS)[number];
export const FLEET_DOCUMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const FLEET_DOCUMENTS_MAX = 40;

export interface FleetDocument {
  id: string;
  vehicleId: string;
  kind: FleetDocumentKind;
  name: string;
  mime: string;
  size: number;
  /** When it expires, if it is a document with a validity period: "2027-03-31". */
  expiresOn: string | null;
  note: string | null;
  createdAt: string;
}
export interface FleetLogEntry {
  at: string;
  field: "status" | "state";
  value: string;
  note: string | null;
  userName: string | null;
}
/** Useful life: straight-line depreciation and what owning the vehicle has cost. */
export interface FleetLife {
  currency: string;
  ageYears: number;
  /** What it loses in value each year. */
  perYear: number;
  depreciated: number;
  bookValue: number;
  /** Share of the useful life already used, from 0 to 100. */
  usedPercent: number;
  /** When its useful life ends: "2031-05-10". */
  endsOn: string;
  /** Expenses recorded in that currency since it was purchased. */
  expenses: number;
  /** Total cost of ownership to date: what was depreciated plus what was spent. */
  totalCost: number;
  /** Kilometers since purchase, if known, and what each one has cost. */
  km: number | null;
  costPerKm: number | null;
}
export interface FleetVehicle {
  vehicleId: string;
  name: string;
  plate: string | null;
  groupId: string | null;
  vin: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  kind: string | null;
  notes: string | null;
  /** Document that is its photo, if any. */
  photoId: string | null;
  status: FleetStatus;
  /** What is shown: "en ruta" (on route) if it is available and moving. */
  availability: FleetAvailability;
  statusNote: string | null;
  statusSince: string;
  state: FleetState;
  stateNote: string | null;
  stateSince: string;
  purchaseDate: string | null;
  purchasePrice: number | null;
  currency: string | null;
  salvageValue: number | null;
  lifeYears: number | null;
  purchaseOdometerKm: number | null;
  /** Who has it assigned now. */
  assignedTo: string | null;
  odometerKm: number | null;
  documents: number;
  /** Documents that are expired or expire within the next 30 days. */
  expiring: number;
  life: FleetLife | null;
}
export interface FleetDetail extends FleetVehicle {
  log: FleetLogEntry[];
  docs: FleetDocument[];
}
export interface FleetAssignment {
  id: string;
  person: string;
  /** With the drivers module it is an instant; without it, a date. */
  from: string;
  to: string | null;
  note: string | null;
}
export interface FleetAssignments {
  /** "drivers": the history comes from the drivers module and is changed from there. "fleet": recorded here. */
  source: "drivers" | "fleet";
  items: FleetAssignment[];
}
export interface FleetExpense {
  /** Null for those that come on their own from another module, such as recorded fills. */
  id: string | null;
  vehicleId: string;
  vehicleName: string;
  date: string;
  category: FleetExpenseCategory;
  amount: number;
  currency: string;
  note: string | null;
}
export interface FleetExpenses {
  items: FleetExpense[];
  /** Totals by currency and, within each, by category. */
  totals: { currency: string; total: number; byCategory: { category: FleetExpenseCategory; total: number }[] }[];
}
export interface FleetUsage {
  vehicleId: string;
  name: string;
  groupId: string | null;
  distanceM: number;
  /** Time on trips and, separately, with the engine on without moving. */
  tripS: number;
  idleS: number;
  trips: number;
  activeDays: number;
  /** Share of the days in the period when it was not used, from 0 to 100. */
  unusedPercent: number;
}
export interface FleetUtilization {
  from: string;
  to: string;
  days: number;
  vehicles: FleetUsage[];
  totals: { distanceM: number; tripS: number; idleS: number; trips: number; unusedPercent: number; withoutUse: number };
}

const fleetText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => v || null);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, v("validation.dateFormat"));
const moneyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, v("validation.currencyCode"));
export const fleetProfileSchema = z
  .object({
    vin: fleetText(40),
    brand: fleetText(40),
    model: fleetText(60),
    year: z.number().int().min(1950).max(2100).nullable().default(null),
    color: fleetText(30),
    kind: fleetText(30),
    notes: fleetText(1000),
    purchaseDate: dateOnly.nullable().default(null),
    purchasePrice: z.number().min(0).max(1_000_000_000).nullable().default(null),
    currency: moneyCode.nullable().default(null),
    salvageValue: z.number().min(0).max(1_000_000_000).nullable().default(null),
    lifeYears: z.number().gt(0).max(60).nullable().default(null),
    purchaseOdometerKm: z.number().min(0).max(5_000_000).nullable().default(null),
  })
  .refine((p) => p.purchasePrice === null || p.currency !== null, v("validation.purchaseCurrency"))
  .refine((p) => p.salvageValue === null || p.purchasePrice === null || p.salvageValue <= p.purchasePrice, v("validation.salvageOverPrice"));
export type FleetProfileInput = z.input<typeof fleetProfileSchema>;
export const fleetStatusSchema = z.object({ status: z.enum(FLEET_STATUSES), note: fleetText(200) });
export const fleetStateSchema = z.object({ state: z.enum(FLEET_STATES), note: fleetText(200) });
export const fleetAssignmentSchema = z
  .object({ person: z.string().trim().min(1, v("validation.assigneeNeeded")).max(80), from: dateOnly, to: dateOnly.nullable().default(null), note: fleetText(200) })
  .refine((a) => a.to === null || a.to >= a.from, v("validation.endBeforeStart"));
export const fleetExpenseSchema = z.object({
  vehicleId: z.uuid(),
  date: dateOnly,
  category: z.enum(FLEET_EXPENSE_CATEGORIES),
  amount: z.number(v("validation.amountNeeded")).gt(0, v("validation.amountPositive")).max(1_000_000_000),
  currency: moneyCode,
  note: fleetText(200),
});
export type FleetExpenseInput = z.input<typeof fleetExpenseSchema>;
export const fleetDocumentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(FLEET_DOCUMENT_KINDS).default("other"),
  expiresOn: dateOnly.optional(),
  note: z.string().trim().max(200).optional(),
});
export const fleetGroupParentSchema = z.object({ parentId: z.uuid().nullable() });

// ─── Module E · Maintenance ──────────────────────────────────────────────────

/** Common plans, to avoid starting from scratch: the values are adjusted to each fleet. */
export const MAINT_TEMPLATES: readonly {
  id: string;
  /** @deprecated Spanish only. Use the catalog: "maintTemplate.<id>". */
  name: string;
  everyKm: number | null;
  everyHours: number | null;
  everyDays: number | null;
  warnKm: number | null;
  warnHours: number | null;
  warnDays: number | null;
}[] = [
  { id: "oil", name: es.maintTemplate.oil, everyKm: 5000, everyHours: 250, everyDays: 180, warnKm: 500, warnHours: 25, warnDays: 15 },
  { id: "tires", name: es.maintTemplate.tires, everyKm: 10000, everyHours: null, everyDays: null, warnKm: 1000, warnHours: null, warnDays: null },
  { id: "air", name: es.maintTemplate.air, everyKm: 15000, everyHours: 500, everyDays: 365, warnKm: 1000, warnHours: 50, warnDays: 30 },
  { id: "brakes", name: es.maintTemplate.brakes, everyKm: 20000, everyHours: null, everyDays: 365, warnKm: 1500, warnHours: null, warnDays: 30 },
  { id: "major", name: es.maintTemplate.major, everyKm: 40000, everyHours: 1000, everyDays: 730, warnKm: 2000, warnHours: 50, warnDays: 30 },
];

/** How often a service is due: by kilometers, engine hours or days; whichever comes first. */
export interface MaintTriggers {
  everyKm: number | null;
  everyHours: number | null;
  everyDays: number | null;
  /** How far in advance to notify, for each measure. */
  warnKm: number | null;
  warnHours: number | null;
  warnDays: number | null;
}
export interface MaintPlan extends MaintTriggers {
  id: string;
  name: string;
  notes: string | null;
  /** Vehicles it applies to. */
  vehicleIds: string[];
}
export type MaintDueStatus = "ok" | "soon" | "due";
/** How much remains until a service. What does not apply or cannot be known is null; what is already past, negative. */
export interface MaintDue {
  remainingKm: number | null;
  remainingHours: number | null;
  remainingDays: number | null;
  dueKm: number | null;
  dueHours: number | null;
  dueOn: string | null;
  status: MaintDueStatus;
}
/** A plan applied to a vehicle. */
export interface MaintSchedule extends MaintDue {
  id: string;
  planId: string;
  planName: string;
  vehicleId: string;
  vehicleName: string;
  /** When it was last done, and with what odometer and engine hours. */
  lastOn: string;
  lastKm: number | null;
  lastHours: number | null;
  /** What `maintReason` says, already written: "faltan 420 km", "se pasó por 3 días" ("420 km left", "overdue by 3 days"). */
  reason: string;
  /** Unfinished work order for this service, if any. */
  openOrderId: string | null;
}

/** How much remains until a service is due, given the odometer, hours and today's date. */
export function maintDue(plan: MaintTriggers, last: { on: string; km: number | null; hours: number | null }, now: { km: number | null; hours: number | null; today: string }): MaintDue {
  const dueKm = plan.everyKm !== null && last.km !== null ? last.km + plan.everyKm : null;
  const dueHours = plan.everyHours !== null && last.hours !== null ? last.hours + plan.everyHours : null;
  const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const dueOn = plan.everyDays !== null ? new Date(day(last.on) + plan.everyDays * 86_400_000).toISOString().slice(0, 10) : null;
  const remainingKm = dueKm !== null && now.km !== null ? Math.round(dueKm - now.km) : null;
  const remainingHours = dueHours !== null && now.hours !== null ? Math.round((dueHours - now.hours) * 10) / 10 : null;
  const remainingDays = dueOn !== null ? Math.round((day(dueOn) - day(now.today)) / 86_400_000) : null;
  const left: [number | null, number | null][] = [
    [remainingKm, plan.warnKm],
    [remainingHours, plan.warnHours],
    [remainingDays, plan.warnDays],
  ];
  const status: MaintDueStatus = left.some(([n]) => n !== null && n <= 0) ? "due" : left.some(([n, warn]) => n !== null && n <= (warn ?? 0)) ? "soon" : "ok";
  return { remainingKm, remainingHours, remainingDays, dueKm, dueHours, dueOn, status };
}

/**
 * The most urgent thing about a service, as a text to say: in Spanish, "se pasó
 * por 130 km" or "faltan 12 días" ("overdue by 130 km", "12 days left"). The
 * amount goes already written the way `language` writes numbers: say the text
 * in that same language.
 */
export function maintReason(due: MaintDue, plan: MaintTriggers, language: Language): SharedSay {
  const parts: { left: number; warn: number; over: SharedKey; ahead: SharedKey }[] = [];
  if (due.remainingKm !== null) parts.push({ left: due.remainingKm, warn: plan.warnKm ?? 0, over: "maintReason.overKm", ahead: "maintReason.leftKm" });
  if (due.remainingHours !== null) parts.push({ left: due.remainingHours, warn: plan.warnHours ?? 0, over: "maintReason.overHours", ahead: "maintReason.leftHours" });
  if (due.remainingDays !== null) parts.push({ left: due.remainingDays, warn: plan.warnDays ?? 0, over: "maintReason.overDays", ahead: "maintReason.leftDays" });
  if (parts.length === 0) return { key: "maintReason.noData" };
  // `count` chooses between the singular and the plural; `n` is what is read.
  const amount = (n: number) => ({ count: Math.abs(n), n: new Intl.NumberFormat(language, { useGrouping: "always", maximumFractionDigits: 1 }).format(Math.abs(n)) });
  const over = parts.filter((p) => p.left <= 0);
  if (over.length > 0) {
    const worst = over[0] as (typeof parts)[number];
    return worst.left === 0 ? { key: "maintReason.now" } : { key: worst.over, params: amount(worst.left) };
  }
  // Whatever reaches its notification threshold first is what governs.
  const next = parts.toSorted((a, b) => (a.left <= a.warn ? 0 : 1) - (b.left <= b.warn ? 0 : 1))[0] as (typeof parts)[number];
  return { key: next.ahead, params: amount(next.left) };
}

export const MAINT_EXPIRY_KINDS = ["insurance", "inspection", "registration", "license", "permit", "other"] as const;
export type MaintExpiryKind = (typeof MAINT_EXPIRY_KINDS)[number];
export interface MaintExpiry {
  id: string;
  /** "own": recorded here. "fleet": a document from the fleet module with an expiry date; changed there. */
  source: "own" | "fleet";
  vehicleId: string;
  vehicleName: string;
  kind: MaintExpiryKind;
  name: string | null;
  expiresOn: string;
  warnDays: number;
  /** Days remaining; negative if already expired. */
  daysLeft: number;
  status: MaintDueStatus;
  note: string | null;
}

export const MAINT_ORDER_KINDS = ["preventive", "corrective"] as const;
export type MaintOrderKind = (typeof MAINT_ORDER_KINDS)[number];
export const MAINT_ORDER_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type MaintOrderStatus = (typeof MAINT_ORDER_STATUSES)[number];
export const MAINT_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const MAINT_FILES_MAX = 20;
export const MAINT_ORDER_PARTS_MAX = 60;
export interface MaintOrderPart {
  /** Part from the catalog, if it came from it. */
  partId: string | null;
  name: string;
  quantity: number;
  unitCost: number;
}
export interface MaintOrderFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}
export interface MaintOrder {
  id: string;
  number: number;
  vehicleId: string;
  vehicleName: string;
  kind: MaintOrderKind;
  status: MaintOrderStatus;
  title: string;
  description: string | null;
  scheduleId: string | null;
  /** Plan of the scheduled service it fulfills. */
  planName: string | null;
  workshopId: string | null;
  workshopName: string | null;
  openedOn: string;
  doneOn: string | null;
  odometerKm: number | null;
  engineHours: number | null;
  laborCost: number;
  partsCost: number;
  total: number;
  currency: string;
  parts: MaintOrderPart[];
  files: MaintOrderFile[];
}
export const MAINT_WORKSHOP_KINDS = ["workshop", "supplier"] as const;
export type MaintWorkshopKind = (typeof MAINT_WORKSHOP_KINDS)[number];
export interface MaintWorkshop {
  id: string;
  name: string;
  kind: MaintWorkshopKind;
  contact: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  /** Work orders done there. */
  orders: number;
}
export interface MaintPart {
  id: string;
  name: string;
  code: string | null;
  unit: string;
  unitCost: number | null;
  /** Stock; null if not tracked. */
  stock: number | null;
  notes: string | null;
  /** Quantity used in finished orders. */
  used: number;
}
export interface MaintSettings {
  currency: string;
}
/** What needs attention: scheduled services of each vehicle and expiries. */
export interface MaintOverview {
  schedules: MaintSchedule[];
  expiries: MaintExpiry[];
  /** Open or in-progress orders. */
  openOrders: number;
}

const maintInt = (max: number) => z.number().int().min(1).max(max).nullable().default(null);
const maintWarn = (max: number) => z.number().int().min(0).max(max).nullable().default(null);
export const maintPlanSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.planName")).max(80),
    everyKm: maintInt(1_000_000),
    everyHours: maintInt(100_000),
    everyDays: maintInt(3650),
    warnKm: maintWarn(100_000),
    warnHours: maintWarn(10_000),
    warnDays: maintWarn(365),
    notes: fleetText(500),
    vehicleIds: z.array(z.uuid()).max(2000).default([]),
  })
  .refine((p) => p.everyKm !== null || p.everyHours !== null || p.everyDays !== null, v("validation.planInterval"));
export type MaintPlanInput = z.input<typeof maintPlanSchema>;
/** When the service was last done: counting starts from there. */
export const maintBaselineSchema = z.object({ lastOn: dateOnly, lastKm: z.number().min(0).max(5_000_000).nullable(), lastHours: z.number().min(0).max(500_000).nullable() });
export const maintOrderSchema = z
  .object({
    vehicleId: z.uuid(),
    kind: z.enum(MAINT_ORDER_KINDS),
    status: z.enum(MAINT_ORDER_STATUSES).default("open"),
    title: z.string().trim().min(1, v("validation.orderTitle")).max(120),
    description: fleetText(2000),
    scheduleId: z.uuid().nullable().default(null),
    workshopId: z.uuid().nullable().default(null),
    openedOn: dateOnly,
    doneOn: dateOnly.nullable().default(null),
    odometerKm: z.number().min(0).max(5_000_000).nullable().default(null),
    engineHours: z.number().min(0).max(500_000).nullable().default(null),
    laborCost: z.number().min(0).max(1_000_000_000).default(0),
    currency: moneyCode,
    parts: z
      .array(z.object({ partId: z.uuid().nullable().default(null), name: z.string().trim().min(1, v("validation.partName")).max(120), quantity: z.number().gt(0, v("validation.quantityPositive")).max(100_000), unitCost: z.number().min(0).max(1_000_000_000).default(0) }))
      .max(MAINT_ORDER_PARTS_MAX)
      .default([]),
  })
  .refine((o) => o.doneOn === null || o.doneOn >= o.openedOn, v("validation.doneBeforeOpened"));
export type MaintOrderInput = z.input<typeof maintOrderSchema>;
export const maintFileSchema = z.object({ name: z.string().trim().min(1).max(200) });
export const maintWorkshopSchema = z.object({
  name: z.string().trim().min(1, v("validation.nameNeeded")).max(80),
  kind: z.enum(MAINT_WORKSHOP_KINDS).default("workshop"),
  contact: fleetText(80),
  phone: fleetText(40),
  email: fleetText(120),
  address: fleetText(200),
  notes: fleetText(500),
});
export type MaintWorkshopInput = z.input<typeof maintWorkshopSchema>;
export const maintPartSchema = z.object({
  name: z.string().trim().min(1, v("validation.nameNeeded")).max(120),
  code: fleetText(40),
  unit: z.string().trim().min(1).max(20).default("unidad"),
  unitCost: z.number().min(0).max(1_000_000_000).nullable().default(null),
  stock: z.number().min(-1_000_000).max(1_000_000).nullable().default(null),
  notes: fleetText(500),
});
export type MaintPartInput = z.input<typeof maintPartSchema>;
export const maintExpirySchema = z.object({
  vehicleId: z.uuid(),
  kind: z.enum(MAINT_EXPIRY_KINDS),
  name: fleetText(80),
  expiresOn: dateOnly,
  warnDays: z.number().int().min(0).max(365).default(30),
  note: fleetText(200),
});
export type MaintExpiryInput = z.input<typeof maintExpirySchema>;
export const maintSettingsSchema = z.object({ currency: moneyCode, zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")).default("UTC") });

// ─── Module H · Routes and logistics ─────────────────────────────────────────

export const POI_CATEGORIES = ["client", "warehouse", "branch", "fuel", "workshop", "parking", "other"] as const;
export type PoiCategory = (typeof POI_CATEGORIES)[number];
/** A place the account visits. */
export interface Poi {
  id: string;
  name: string;
  category: PoiCategory;
  lat: number;
  lon: number;
  /** How close a vehicle must be to be considered at the place. */
  radiusM: number;
  address: string | null;
  phone: string | null;
  notes: string | null;
}
const routeLat = z.number().min(-90).max(90);
const routeLon = z.number().min(-180).max(180);
export const poiSchema = z.object({
  name: z.string().trim().min(1, v("validation.placeName")).max(80),
  category: z.enum(POI_CATEGORIES).default("other"),
  lat: routeLat,
  lon: routeLon,
  radiusM: z.number().int().min(20).max(2000).default(100),
  address: fleetText(200),
  phone: fleetText(40),
  notes: fleetText(300),
});
export type PoiInput = z.input<typeof poiSchema>;

export const ROUTE_LINE_MAX = 2000;
export const ROUTE_STOPS_MAX = 50;
/** A stop on a planned route. */
export interface RoutePlanStop {
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  /** Minutes after departure at which arrival is expected, and minutes of stay. */
  etaMin: number | null;
  stayMin: number | null;
  contact: string | null;
}
export interface RoutePlan {
  id: string;
  name: string;
  /** The path, as [lon, lat] points; empty if the route is only its stops. */
  line: [number, number][];
  /** How far a vehicle may stray from the path before notifying. */
  toleranceM: number;
  lengthM: number;
  notes: string | null;
  stops: RoutePlanStop[];
}
const routeStopSchema = z.object({
  name: z.string().trim().min(1, v("validation.stopName")).max(80),
  lat: routeLat,
  lon: routeLon,
  radiusM: z.number().int().min(20).max(2000).default(100),
  etaMin: z.number().int().min(0).max(100_000).nullable().default(null),
  stayMin: z.number().int().min(0).max(10_000).nullable().default(null),
  contact: fleetText(80),
});
const routeLineSchema = z.array(z.tuple([routeLon, routeLat])).max(ROUTE_LINE_MAX);
export const routePlanSchema = z.object({
  name: z.string().trim().min(1, v("validation.routeName")).max(80),
  line: routeLineSchema.default([]),
  toleranceM: z.number().int().min(30).max(2000).default(150),
  notes: fleetText(500),
  stops: z.array(routeStopSchema).min(1, v("validation.routeStopNeeded")).max(ROUTE_STOPS_MAX),
});
export type RoutePlanInput = z.input<typeof routePlanSchema>;

export const ROUTE_TRIP_STATUSES = ["assigned", "in_progress", "done", "cancelled"] as const;
export type RouteTripStatus = (typeof ROUTE_TRIP_STATUSES)[number];
export const ROUTE_STOP_STATUSES = ["pending", "arrived", "done", "failed", "skipped"] as const;
export type RouteStopStatus = (typeof ROUTE_STOP_STATUSES)[number];
export const ROUTE_PROOF_KINDS = ["photo", "signature"] as const;
export type RouteProofKind = (typeof ROUTE_PROOF_KINDS)[number];
export const ROUTE_PROOF_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export interface RouteTripStop {
  id: string;
  seq: number;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  plannedAt: string | null;
  contact: string | null;
  status: RouteStopStatus;
  arrivedAt: string | null;
  doneAt: string | null;
  /** Proof of delivery. */
  recipient: string | null;
  note: string | null;
  hasPhoto: boolean;
  hasSignature: boolean;
}
/** A dispatch: some stops assigned to a vehicle. */
export interface RouteTrip {
  id: string;
  name: string;
  planId: string | null;
  vehicleId: string;
  vehicleName: string;
  driver: string | null;
  startsAt: string;
  status: RouteTripStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Is outside its route's corridor at the moment. */
  offRoute: boolean;
  toleranceM: number;
  line: [number, number][];
  stops: RouteTripStop[];
}
export const routeTripSchema = z.object({
  name: z.string().trim().min(1, v("validation.dispatchName")).max(80),
  /** Planned route it comes from; with it, the stops and the path may be omitted. */
  planId: z.uuid().nullable().default(null),
  vehicleId: z.uuid(),
  driver: fleetText(80),
  startsAt: z.coerce.date(v("validation.departureNeeded")),
  line: routeLineSchema.optional(),
  toleranceM: z.number().int().min(30).max(2000).optional(),
  stops: z
    .array(routeStopSchema.omit({ etaMin: true, stayMin: true }).extend({ plannedAt: z.coerce.date().nullable().default(null) }))
    .max(ROUTE_STOPS_MAX)
    .optional(),
});
export type RouteTripInput = z.input<typeof routeTripSchema>;
/** What is recorded for a stop: from dispatch or from the driver's link. */
export const routeStopUpdateSchema = z.object({ status: z.enum(ROUTE_STOP_STATUSES), recipient: fleetText(80), note: fleetText(300) });
export const routeTokenSchema = z.object({ token: z.string().min(20).max(100) });
export const routeDriverStopSchema = routeTokenSchema.extend({ stopId: z.uuid(), status: z.enum(["arrived", "done", "failed"]), recipient: fleetText(80), note: fleetText(300) });
export const routeDriverStatusSchema = routeTokenSchema.extend({ status: z.enum(["in_progress", "done"]) });
/** A vehicle as a candidate for a destination. */
export interface NearbyVehicle {
  vehicleId: string;
  name: string;
  /** In a straight line, from its last position. Null if it has not reported. */
  distanceM: number | null;
  lat: number | null;
  lon: number | null;
  lastSeenAt: string | null;
  /** Is reporting and has no other route in progress. */
  available: boolean;
  /** Why not: its route in progress, or that it is not reporting. */
  busy: string | null;
}
/** What the driver sees with their link, without an account. */
export interface DriverTripView {
  account: string;
  name: string;
  vehicleName: string;
  driver: string | null;
  status: RouteTripStatus;
  startsAt: string;
  line: [number, number][];
  stops: RouteTripStop[];
}
/** What whoever is waiting for a delivery sees, with the link to their stop. */
export interface DeliveryView {
  account: string;
  stopName: string;
  status: RouteStopStatus;
  tripStatus: RouteTripStatus;
  plannedAt: string | null;
  arrivedAt: string | null;
  doneAt: string | null;
  /** Stops the vehicle has before this one. */
  stopsBefore: number;
  destination: { lat: number; lon: number };
  /** Where the vehicle is; only while the route is in progress and the delivery pending. */
  vehicle: { lat: number; lon: number; course: number | null; fixTime: string | null; moving: boolean } | null;
}

// ─── Module F · Fuel ─────────────────────────────────────────────────────────

/** How the level arrives from the device: as a percentage, in liters, or as a sensor value translated with a table. */
export const FUEL_KINDS = ["percent", "liters", "raw"] as const;
export type FuelKind = (typeof FUEL_KINDS)[number];

/** Unit in which the device counts fuel spent, and how many liters it is worth. */
export const FUEL_COUNTER_LITERS = { l: 1, dl: 0.1, ml: 0.001 } as const;
export type FuelCounterUnit = keyof typeof FUEL_COUNTER_LITERS;

export interface FuelTank {
  capacityL: number;
  /** Device value that carries the level: "fuel", "adc1"… Null if the vehicle has no sensor. */
  attr: string | null;
  kind: FuelKind;
  /** Pairs [sensor value, liters], from lowest to highest. Only with `kind` "raw". */
  calibration: [number, number][] | null;
  /**
   * Device value with the counter of fuel spent by the engine, and its
   * unit. Null: the device's standard counter is used, if it sends it.
   */
  counterAttr: string | null;
  counterUnit: FuelCounterUnit;
  /** Consumption norm while driving, liters per 100 km. */
  normL100km: number | null;
  /** Consumption norm while idling, liters per hour. */
  normIdleLh: number | null;
}
export interface FuelStatus {
  tank: FuelTank | null;
  level: { liters: number; percent: number; at: string } | null;
  /** Numeric values the device sends, to choose which one is the level. */
  attrs: { name: string; value: number }[];
}
/** A jump in the level: when, how many liters and where the vehicle was. */
export interface FuelJump {
  at: string;
  liters: number;
  lat: number | null;
  lon: number | null;
}
export interface FuelReport {
  from: string;
  to: string;
  distanceM: number;
  idleS: number;
  /** Filtered level over the period; `t` in seconds, `l` in liters. */
  series: { t: number; l: number }[];
  /** By norm: what it should have used given the kilometers and idling. */
  estimated: { liters: number; byDistanceL: number; byIdleL: number } | null;
  /** By sensor: from the engine counter, or from the level difference plus what was loaded and minus what was drained. */
  real: { liters: number; method: "ecu" | "level"; refueledL: number; drainedL: number } | null;
  /** Each refueling detected in the tank level. */
  refuels: FuelJump[];
  /** Each drain: fuel that left the tank while stopped, more than the engine could have used. */
  drains: (FuelJump & { /** With the engine off: possible theft. */ engineOff: boolean })[];
  /** Idling: how long it was so, what it should have used by norm and what it used according to the sensor. */
  idle: { seconds: number; estimatedL: number | null; realL: number | null };
  /** What was paid in the recorded fills of the period, by currency. */
  costs: { currency: string; spent: number; liters: number; fills: number }[];
  /** Cost of what was consumed per kilometer, with the most recent known price per liter. */
  costPerKm: { currency: string; value: number; pricePerL: number; basis: "real" | "estimated" } | null;
  efficiency: { kmPerL: number; lPer100km: number; basis: "real" | "estimated" } | null;
  /** Performance per driver, if the account has the drivers module. */
  drivers: { driverId: string; name: string; distanceM: number; liters: number | null; kmPerL: number | null; lPer100km: number | null }[];
}

/** Where a recorded fill comes from. */
export const FUEL_FILL_SOURCES = ["manual", "imported", "detected"] as const;
export type FuelFillSource = (typeof FUEL_FILL_SOURCES)[number];

/** A fill: recorded, or detected by the sensor and not yet recorded (`id` null). */
export interface FuelFill {
  id: string | null;
  vehicleId: string;
  at: string;
  /** Liters recorded; for one only detected, those the sensor saw. */
  liters: number;
  /** Liters the tank level rose according to the sensor, if that refueling was detected. */
  detectedL: number | null;
  /** What was paid in total, and in which currency. */
  total: number | null;
  currency: string | null;
  pricePerL: number | null;
  odometerKm: number | null;
  station: string | null;
  note: string | null;
  source: FuelFillSource;
}
/** Difference between what was recorded and what the tank rose by, beyond which it is worth reviewing: liters, or this share of what was recorded. */
export const FUEL_FILL_MISMATCH_L = 3;
export const FUEL_FILL_MISMATCH_SHARE = 0.1;
export const fuelFillMismatch = (fill: Pick<FuelFill, "liters" | "detectedL" | "id">): boolean =>
  fill.id !== null && fill.detectedL !== null && fill.liters - fill.detectedL > Math.max(FUEL_FILL_MISMATCH_L, fill.liters * FUEL_FILL_MISMATCH_SHARE);

/** Module settings in the account. */
export interface FuelSettings {
  /** Currency in which fills are recorded if none other is given: three-letter code. */
  currency: string;
  /** Time zone used to write times in its notifications. */
  zone: string;
}
/** Currencies offered to choose from. Any other three-letter code is accepted. */
export const CURRENCIES: readonly {
  code: string;
  /** @deprecated Spanish only. Use the catalog: "currency.<code>". */
  name: string;
}[] = [
  { code: "HNL", name: es.currency.HNL },
  { code: "USD", name: es.currency.USD },
  { code: "GTQ", name: es.currency.GTQ },
  { code: "NIO", name: es.currency.NIO },
  { code: "CRC", name: es.currency.CRC },
  { code: "PAB", name: es.currency.PAB },
  { code: "BZD", name: es.currency.BZD },
  { code: "MXN", name: es.currency.MXN },
  { code: "DOP", name: es.currency.DOP },
  { code: "COP", name: es.currency.COP },
  { code: "VES", name: es.currency.VES },
  { code: "PEN", name: es.currency.PEN },
  { code: "BOB", name: es.currency.BOB },
  { code: "CLP", name: es.currency.CLP },
  { code: "ARS", name: es.currency.ARS },
  { code: "UYU", name: es.currency.UYU },
  { code: "PYG", name: es.currency.PYG },
  { code: "BRL", name: es.currency.BRL },
  { code: "EUR", name: es.currency.EUR },
  { code: "CAD", name: es.currency.CAD },
];
/** Rows a fill import accepts. */
export const FUEL_IMPORT_MAX_ROWS = 2000;
export interface FuelImportResult {
  imported: number;
  /** Were already recorded: same vehicle, same time and same liters. */
  repeated: number;
  /** Rows that could not be read, with the line number in the file. */
  errors: { line: number; message: string }[];
}

// ─── Module G · Reports and dashboards ───────────────────────────────────────

export const REPORT_TYPES = ["trips", "stops", "mileage", "speed", "geofences", "alarms", "utilization", "drivers", "fuel", "maintenance"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
/** Each report, with the module needed in addition to the reports module for it to appear. */
export const REPORT_INFO: Record<
  ReportType,
  {
    /** @deprecated Spanish only. Use the catalog: "report.<type>". */
    label: string;
    /** @deprecated Spanish only. Use the catalog: "reportNote.<type>". */
    note: string;
    requires?: ModuleKey;
  }
> = {
  trips: { label: es.report.trips, note: es.reportNote.trips },
  stops: { label: es.report.stops, note: es.reportNote.stops },
  mileage: { label: es.report.mileage, note: es.reportNote.mileage },
  speed: { label: es.report.speed, note: es.reportNote.speed },
  geofences: { label: es.report.geofences, note: es.reportNote.geofences },
  alarms: { label: es.report.alarms, note: es.reportNote.alarms },
  utilization: { label: es.report.utilization, note: es.reportNote.utilization },
  drivers: { label: es.report.drivers, note: es.reportNote.drivers, requires: "B" },
  fuel: { label: es.report.fuel, note: es.reportNote.fuel, requires: "F" },
  maintenance: { label: es.report.maintenance, note: es.reportNote.maintenance, requires: "E" },
};

/**
 * What each value in a report is, so it is written the same on screen, in Excel
 * and in PDF. Dates are in ISO, durations in seconds, distances
 * in meters, speeds in km/h and percentages from 0 to 100.
 */
export type ReportCell = "text" | "datetime" | "date" | "duration" | "distance" | "speed" | "integer" | "decimal" | "liters" | "percent" | "place";
export interface ReportPlace {
  lat: number;
  lon: number;
  /** Approximate address, if already known. */
  address: string | null;
}
export type ReportValue = string | number | null | ReportPlace;
export interface ReportColumn {
  label: string;
  type: ReportCell;
}
export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: ReportValue[][];
  /** Totals row, with one value per column; null if the table has none. */
  totals: ReportValue[] | null;
  /** Total rows that exist; if more than the ones that came, the table arrived truncated. */
  total: number;
}
export interface ReportStat {
  label: string;
  type: ReportCell;
  value: ReportValue;
}
export interface ReportChart {
  title: string;
  /** Unit of the values. */
  unit: ReportCell;
  /** One label per bar: days ("2026-11-21") or names. */
  labels: string[];
  labelType: "date" | "text";
  /** With more than one series, the bars are stacked. */
  series: { name: string; values: number[] }[];
}
export interface ReportDocument {
  type: ReportType;
  title: string;
  from: string;
  to: string;
  zone: string;
  generatedAt: string;
  /** Which vehicles it refers to: "Todos los vehículos", "Grupo Reparto"… */
  scope: string;
  /** Options it was generated with: "Límite: 100 km/h". */
  options: string[];
  stats: ReportStat[];
  chart: ReportChart | null;
  tables: ReportTable[];
  notes: string[];
}
/** Maximum rows in each table of a report. */
export const REPORT_MAX_ROWS = 5000;
export const REPORT_FORMATS = ["xlsx", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** Which vehicles and with what options a report is generated. */
export interface ReportParams {
  /** Only one group; null = all the person can see. */
  groupId: string | null;
  /** Only these vehicles; null = all. */
  vehicleIds: string[] | null;
  /** Speed report: the speed above which it counts as excess. */
  speedLimitKmh: number;
  /** Stops report: stops shorter than this are not listed. */
  minStopMin: number;
}
export const REPORT_PARAMS_DEFAULT: ReportParams = { groupId: null, vehicleIds: null, speedLimitKmh: 100, minStopMin: 5 };

export const REPORT_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];
/** Scheduled reports an account can have, and people who receive each one. */
export const SCHEDULES_MAX = 20;
export const SCHEDULE_RECIPIENTS_MAX = 10;

export interface ReportSchedule {
  id: string;
  name: string;
  type: ReportType;
  params: ReportParams;
  frequency: ReportFrequency;
  /** Time of delivery, in minutes since midnight in `zone`. */
  atMinute: number;
  /** Day of the week (0 = Sunday) for weekly ones, and day of the month (1 to 28) for monthly ones. */
  weekday: number;
  monthDay: number;
  zone: string;
  format: ReportFormat;
  /** People in the account who receive it. */
  recipients: { userId: string; name: string; email: string }[];
  active: boolean;
  nextRunAt: string | null;
  lastRun: { at: string; ok: boolean; error: string | null } | null;
  createdByName: string;
}

export const ALL_DASHBOARD_WIDGETS = ["totals", "fleet", "distance_by_day", "usage_by_day", "top_distance", "least_used", "alerts_by_type", "alerts_by_day", "driver_scores"] as const;
export type DashboardWidget = (typeof ALL_DASHBOARD_WIDGETS)[number];
export const DASHBOARD_WIDGETS: Record<
  DashboardWidget,
  {
    /** @deprecated Spanish only. Use the catalog: "dashboardWidget.<widget>". */
    label: string;
    /** @deprecated Spanish only. Use the catalog: "dashboardWidgetNote.<widget>". */
    note: string;
    requires?: ModuleKey;
  }
> = {
  totals: { label: es.dashboardWidget.totals, note: es.dashboardWidgetNote.totals },
  fleet: { label: es.dashboardWidget.fleet, note: es.dashboardWidgetNote.fleet },
  distance_by_day: { label: es.dashboardWidget.distance_by_day, note: es.dashboardWidgetNote.distance_by_day },
  usage_by_day: { label: es.dashboardWidget.usage_by_day, note: es.dashboardWidgetNote.usage_by_day },
  top_distance: { label: es.dashboardWidget.top_distance, note: es.dashboardWidgetNote.top_distance },
  least_used: { label: es.dashboardWidget.least_used, note: es.dashboardWidgetNote.least_used },
  alerts_by_type: { label: es.dashboardWidget.alerts_by_type, note: es.dashboardWidgetNote.alerts_by_type },
  alerts_by_day: { label: es.dashboardWidget.alerts_by_day, note: es.dashboardWidgetNote.alerts_by_day },
  driver_scores: { label: es.dashboardWidget.driver_scores, note: es.dashboardWidgetNote.driver_scores, requires: "B" },
};
export const DASHBOARD_PERIODS = ["today", "7d", "30d", "month"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
/** Dashboards each person can have in an account. */
export const DASHBOARDS_MAX = 10;
export const DASHBOARD_DEFAULT_WIDGETS: DashboardWidget[] = ["totals", "fleet", "distance_by_day", "usage_by_day", "top_distance", "alerts_by_type"];

export interface Dashboard {
  id: string;
  name: string;
  period: DashboardPeriod;
  groupId: string | null;
  /** Vehicles it shows, chosen one by one; null = it goes by the group. */
  vehicleIds: string[] | null;
  /** Indicators it shows, in order. */
  widgets: DashboardWidget[];
}
export interface DashboardTotals {
  distanceM: number;
  trips: number;
  /** Time on trips, with their short pauses. */
  drivingS: number;
  idleS: number;
  alerts: number;
  /** Vehicles that made at least one trip. */
  activeVehicles: number;
}
export interface DashboardData {
  from: string;
  to: string;
  vehicles: number;
  totals: DashboardTotals;
  /** The same over the previous period of equal length. */
  previous: DashboardTotals;
  days: { date: string; distanceM: number; trips: number; movingS: number; idleS: number; alerts: number }[];
  byVehicle: { id: string; name: string; distanceM: number; drivingS: number; idleS: number; trips: number }[];
  alertTypes: { type: EventType; count: number }[];
  /** Driver ranking, if the account has that module. */
  drivers: DriverRank[] | null;
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export const ALERT_TYPES = [
  "speeding",
  "ignition_off_hours",
  "signal_lost",
  "parked_movement",
  "sos",
  "power_cut",
  "tow",
  "harsh_driving",
  "geofence",
  "custom",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
/** Alerts that depend on the installed device having that function. */
export const ALERT_NEEDS_DEVICE: readonly AlertType[] = ["sos", "power_cut", "harsh_driving"];

/** Condition of a custom alert. All the conditions of an alert must be met at once. */
export type AlertCondition =
  | { field: "speed"; op: "gt" | "lt"; value: number }
  | { field: "ignition"; value: boolean }
  | { field: "geofence"; inside: boolean; geofenceId: string }
  | { field: "power"; op: "gt" | "lt"; value: number }
  | { field: "battery"; op: "lt"; value: number };

// ─── Visible state of a vehicle ──────────────────────────────────────────────

export type VehicleStatus = "no_device" | "pending" | "moving" | "idle" | "stopped" | "offline";

/**
 * With the engine on a device reports every few seconds: if it was
 * driving or idling and goes silent for this long, it lost its connection.
 */
export const MOVING_STALE_MS = 5 * 60 * 1000;
/** When off, the device reports only occasionally: it waits longer before being considered disconnected. */
export const OFFLINE_AFTER_MS = 2 * 60 * 60 * 1000;
/** Below this speed it is considered stopped. */
export const MOVING_SPEED_KMH = 3;

export function vehicleStatus(v: Pick<Vehicle, "device" | "state">, now: number = Date.now()): VehicleStatus {
  if (!v.device) return "no_device";
  if (v.device.status === "pending" || !v.state) return "pending";
  const silence = now - Date.parse(v.state.lastSeenAt);
  const moving = v.state.motion ?? (v.state.speedKmh ?? 0) >= MOVING_SPEED_KMH;
  if (moving) return silence > MOVING_STALE_MS ? "offline" : "moving";
  // Idling: engine on without moving.
  if (v.state.ignition === true) return silence > MOVING_STALE_MS ? "offline" : "idle";
  return silence > OFFLINE_AFTER_MS ? "offline" : "stopped";
}


/** Color of each state, the same in the list and on the map. */
export const VEHICLE_STATUS_COLOR: Record<VehicleStatus, string> = {
  moving: "#12a065",
  idle: "#d08700",
  stopped: "#3f7fd1",
  offline: "#8a94a6",
  pending: "#7c6cf0",
  no_device: "#8a94a6",
};

// ─── Optional modules ────────────────────────────────────────────────────────

/** Modules enabled per account, without touching the core. Their names are in the catalog: "module.<key>". */
const MODULE_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];
export const ALL_MODULES: ModuleKey[] = [...MODULE_KEYS];

// ─── Platform admin console ──────────────────────────────────────────────────

export interface AccountLimits {
  /** null = no limit. */
  maxVehicles: number | null;
  maxUsers: number | null;
}

export interface AdminAccount {
  id: string;
  name: string;
  ownerName: string | null;
  ownerEmail: string | null;
  /** How the owner last signed in; null if never seen. */
  ownerSignInMethod: SignInMethod | null;
  /** When the owner last used the platform. */
  ownerLastAccessAt: string | null;
  createdAt: string;
  users: number;
  vehicles: number;
  /** Devices that have already reported. */
  activeDevices: number;
  lastSeenAt: string | null;
  suspended: boolean;
  suspendedReason: string | null;
  limits: AccountLimits;
  modules: ModuleKey[];
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  /** Administers the whole platform: they are neither suspended nor deleted. */
  platformOwner: boolean;
  /** How they last signed in; null if never seen. */
  signInMethod: SignInMethod | null;
  /** When they last used the platform. */
  lastAccessAt: string | null;
}

export interface AdminAccountDetail extends AdminAccount {
  members: AdminUser[];
  /** Its owner administers the whole platform: the account is not deleted. */
  ownedByPlatformOwner: boolean;
}

/** What the administration panel shows of one account at a glance. */
export interface AccountSummary {
  vehicles: number;
  /** Vehicles whose device reported in the last 10 minutes. */
  reportingNow: number;
  users: number;
  /** Events of the last 24 hours. */
  events24h: number;
}

export interface PlatformStats {
  accounts: number;
  suspendedAccounts: number;
  users: number;
  vehicles: number;
  activeDevices: number;
  pendingDevices: number;
  /** Devices that reported in the last 10 minutes. */
  reportingNow: number;
  positionsToday: number;
  diskUsedPercent: number | null;
}

export const accountAdminSchema = z.object({
  suspended: z.boolean().optional(),
  suspendedReason: z.string().trim().max(200).optional(),
  maxVehicles: z.number().int().min(0).max(100_000).nullable().optional(),
  maxUsers: z.number().int().min(1).max(10_000).nullable().optional(),
  modules: z.array(z.enum(ALL_MODULES as [ModuleKey, ...ModuleKey[]])).optional(),
});
export type AccountAdminInput = z.input<typeof accountAdminSchema>;

// ─── Platform settings ───────────────────────────────────────────────────────
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
  /** Sender: "OpenGPS <avisos@ejemplo.com>". */
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
/** How the restore of a backup is going. The restore helper does it, not the platform, which stops while it lasts. */
export interface RestoreInfo {
  /** "requested": asked for, the helper has not started yet. "running": in progress. "done" and "failed": how the last one ended. */
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
  /** The restore helper is running: a backup can be restored from the console. */
  canRestore: boolean;
  /** The restore requested or in progress, or how the last one ended; null if there has never been one. */
  restore: RestoreInfo | null;
}

// ─── Roles and permissions ───────────────────────────────────────────────────

/** What a role can do in addition to seeing the vehicles in its scope. What each one allows is in the catalog: "permission.<permission>". */
const PERMISSION_KEYS = [
  "vehicles.manage",
  "geofences.manage",
  "alerts.manage",
  "links.share",
  "commands.send",
  "incidents.manage",
  "drivers.manage",
  "reports.schedule",
  "members.manage",
  "audit.view",
  "notifications.manage",
  "integrations.manage",
] as const;
export type Permission = (typeof PERMISSION_KEYS)[number];
export const ALL_PERMISSIONS: Permission[] = [...PERMISSION_KEYS];

export interface RoleInfo {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  builtin: boolean;
}

/**
 * Roles the platform comes with. The owner is whoever created the account and is not assigned.
 * Their `name` and `description` are Spanish only and will go: use the catalog, "role.<id>" and "roleDescription.<id>".
 */
export const BUILTIN_ROLES: RoleInfo[] = [
  { id: "admin", name: es.role.admin, description: es.roleDescription.admin, permissions: ALL_PERMISSIONS, builtin: true },
  { id: "operator", name: es.role.operator, description: es.roleDescription.operator, permissions: ["vehicles.manage", "geofences.manage", "alerts.manage", "links.share", "incidents.manage", "drivers.manage", "reports.schedule"], builtin: true },
  { id: "viewer", name: es.role.viewer, description: es.roleDescription.viewer, permissions: [], builtin: true },
];
/** Its `name` and `description` are Spanish only and will go: use the catalog, "role.owner" and "roleDescription.owner". */
export const OWNER_ROLE: RoleInfo = { id: "owner", name: es.role.owner, description: es.roleDescription.owner, permissions: ALL_PERMISSIONS, builtin: true };

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  roleName: string;
  /** Groups it can see; null = all. */
  groups: string[] | null;
  /** Vehicles it sees one by one, besides those of its groups. */
  vehicles: string[];
  disabled: boolean;
  joinedAt: string;
  isYou: boolean;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  roleName: string;
  groups: string[] | null;
  vehicles: string[];
  expiresAt: string;
}

export interface InvitationPreview {
  accountName: string;
  email: string;
  inviterName: string;
  roleName: string;
  status: "pending" | "expired" | "accepted" | "canceled";
}

export interface AuditEntry {
  id: number;
  at: string;
  userName: string | null;
  action: string;
  entity: string | null;
  detail: Record<string, unknown>;
}

// ─── Requests ────────────────────────────────────────────────────────────────

/** Device identifier: 15-digit IMEI or the short ID of some models. */
export const uniqueIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z]{6,20}$/, v("validation.deviceId"));

const nameSchema = z.string().trim().min(1, v("validation.aNameNeeded")).max(60);
const plateSchema = z
  .string()
  .trim()
  .max(20)
  .transform((s) => (s === "" ? null : s.toUpperCase()))
  .nullable()
  .optional();

/** The model of the family's list, if the person found theirs. */
const modelNameSchema = z.string().trim().min(1).max(60).nullable().default(null);
export const createVehicleSchema = z.object({
  name: nameSchema,
  plate: plateSchema,
  uniqueId: uniqueIdSchema,
  modelId: z.string().min(1),
  modelName: modelNameSchema,
});
export type CreateVehicleInput = z.input<typeof createVehicleSchema>;

export const updateVehicleSchema = z.object({
  name: nameSchema.optional(),
  plate: plateSchema,
  /** Vehicle's group; null leaves it without a group. */
  groupId: z.uuid().nullable().optional(),
});
export type UpdateVehicleInput = z.input<typeof updateVehicleSchema>;

export const attachDeviceSchema = z.object({
  uniqueId: uniqueIdSchema,
  modelId: z.string().min(1),
  modelName: modelNameSchema,
});
export type AttachDeviceInput = z.input<typeof attachDeviceSchema>;

const scopeSchema = z.array(z.uuid()).max(100).nullable();
/** Vehicles a person sees one by one, besides those of their groups. */
const vehicleScopeSchema = z.array(z.uuid()).max(500);

export const inviteSchema = z.object({
  email: z.email(v("validation.emailNeeded")).transform((s) => s.trim().toLowerCase()),
  role: z.string().min(1),
  /** Groups it will be able to see; null = all. */
  groups: scopeSchema.default(null),
  /** Vehicles it will see one by one; only counts when `groups` is not null. */
  vehicles: vehicleScopeSchema.default([]),
});
export type InviteInput = z.input<typeof inviteSchema>;

export const memberUpdateSchema = z.object({
  role: z.string().min(1).optional(),
  groups: scopeSchema.optional(),
  vehicles: vehicleScopeSchema.optional(),
  disabled: z.boolean().optional(),
});
export type MemberUpdateInput = z.input<typeof memberUpdateSchema>;

export const roleSchema = z.object({
  name: z.string().trim().min(1, v("validation.roleName")).max(40),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])).default([]),
});
export type RoleInput = z.input<typeof roleSchema>;

const lonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const geometrySchema = z
  .discriminatedUnion("shape", [
    z.object({ shape: z.literal("circle"), center: lonLat, radiusM: z.number().positive() }),
    z.object({ shape: z.literal("polygon"), ring: z.array(lonLat).max(GEOFENCE_LIMITS.maxVertices) }),
    z.object({ shape: z.literal("corridor"), line: z.array(lonLat).max(GEOFENCE_LIMITS.maxVertices), widthM: z.number().positive() }),
  ])
  .superRefine((geometry, ctx) => {
    const problem = geometryProblem(geometry as GeofenceGeometry);
    if (problem) ctx.addIssue(issueOf(problem));
  });

const dayWindow = z.tuple([z.number().int().min(0).max(1439), z.number().int().min(0).max(1440)]);
export const scheduleSchema = z.object({
  zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")),
  days: z.array(dayWindow.nullable()).length(7).refine((days) => days.some((d) => d !== null), v("validation.dayNeeded")),
});

const stayMinutes = z.number().int().min(1, v("validation.stayMin")).max(30 * 24 * 60, v("validation.stayMax")).nullable().default(null);
export const geofenceSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.geofenceName")).max(60),
    geometry: geometrySchema,
    kind: z.enum(GEOFENCE_KINDS).default("notify"),
    schedule: scheduleSchema.nullable().default(null),
    minStayMin: stayMinutes,
    maxStayMin: stayMinutes,
    groupIds: z.array(z.uuid()).max(200).nullable().default(null),
    vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(500).nullable().default(null),
    active: z.boolean().default(true),
  })
  .refine((g) => g.minStayMin === null || g.maxStayMin === null || g.minStayMin < g.maxStayMin, v("validation.stayOrder"))
  .refine((g) => g.groupIds === null || g.vehicleIds === null, v("validation.groupsOrVehicles"));
export type GeofenceInput = z.input<typeof geofenceSchema>;

const alertBase = {
  name: z.string().trim().min(1, v("validation.alertName")).max(60),
  /** Days and hours when the alert watches; null = always. */
  schedule: scheduleSchema.nullable().default(null),
  /** Vehicles it applies to. With this and groups both null, it applies to all. */
  vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(500).nullable().default(null),
  groupIds: z.array(z.uuid()).min(1, v("validation.groupNeeded")).max(200).nullable().default(null),
  active: z.boolean().default(true),
  /** Time zone used to write times in its notifications. */
  zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")).default("UTC"),
};
const noParams = z.object({}).default({});
const conditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("speed"), op: z.enum(["gt", "lt"]), value: z.number().min(0).max(300) }),
  z.object({ field: z.literal("ignition"), value: z.boolean() }),
  z.object({ field: z.literal("geofence"), inside: z.boolean(), geofenceId: z.uuid() }),
  z.object({ field: z.literal("power"), op: z.enum(["gt", "lt"]), value: z.number().min(0).max(60) }),
  z.object({ field: z.literal("battery"), op: z.literal("lt"), value: z.number().min(1).max(100) }),
]);
export const alertRuleSchema = z.discriminatedUnion("type", [
  z.object({
    ...alertBase,
    type: z.literal("speeding"),
    params: z.object({
      limitKmh: z.number().int().min(10, v("validation.speedLimitMin10")).max(250),
      /** Consecutive time above the limit before notifying. */
      seconds: z.number().int().min(0).max(600).default(20),
      /** If given, the limit only applies inside that geofence. */
      geofenceId: z.uuid().nullable().default(null),
    }),
  }),
  z.object({ ...alertBase, type: z.literal("ignition_off_hours"), params: z.object({ allowed: scheduleSchema }) }),
  z.object({ ...alertBase, type: z.literal("signal_lost"), params: z.object({ minutes: z.number().int().min(5, v("validation.signalLostMin")).max(7 * 24 * 60) }) }),
  z.object({ ...alertBase, type: z.literal("parked_movement"), params: z.object({ meters: z.number().int().min(50).max(2000).default(150) }).default({ meters: 150 }) }),
  z.object({ ...alertBase, type: z.literal("sos"), params: noParams }),
  z.object({ ...alertBase, type: z.literal("power_cut"), params: noParams }),
  z.object({ ...alertBase, type: z.literal("tow"), params: noParams }),
  z.object({ ...alertBase, type: z.literal("harsh_driving"), params: noParams }),
  z.object({
    ...alertBase,
    type: z.literal("geofence"),
    params: z.object({ geofenceIds: z.array(z.uuid()).min(1).max(200).nullable().default(null) }).default({ geofenceIds: null }),
  }),
  z.object({
    ...alertBase,
    type: z.literal("custom"),
    params: z.object({
      conditions: z.array(conditionSchema).min(1, v("validation.conditionNeeded")).max(6),
      /** Consecutive time being met before notifying. */
      seconds: z.number().int().min(0).max(3600).default(0),
    }),
  }),
]);
export type AlertRuleInput = z.input<typeof alertRuleSchema>;
export type AlertRuleData = z.output<typeof alertRuleSchema>;
export type AlertRule = AlertRuleData & { id: string; createdAt: string };

export const parkSchema = z.object({ parked: z.boolean() });

export const lockPrepareSchema = z.object({ action: z.enum(["lock", "unlock"]) });
export const lockSchema = z.object({
  action: z.enum(["lock", "unlock"]),
  confirmToken: z.string().min(10).max(400),
  /** The word typed by the person: the one of the action, in any language (see `isConfirmWord`). */
  word: z.string().trim().max(20),
});
export const recoverySchema = z.object({ on: z.boolean() });
export const incidentCreateSchema = z.object({ vehicleId: z.uuid(), note: z.string().trim().min(1, v("validation.incidentDescription")).max(1000) });
export const incidentNoteSchema = z.object({ text: z.string().trim().min(1, v("validation.noteNeeded")).max(2000) });
export const incidentCloseSchema = z.object({ resolution: z.enum(INCIDENT_RESOLUTIONS), note: z.string().trim().max(2000).default("") });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => v || null);
export const driverSchema = z.object({
  name: z.string().trim().min(1, v("validation.driverName")).max(80),
  license: optionalText(40),
  phone: optionalText(30),
  keyId: optionalText(40).refine((v) => v === null || /^[0-9A-Fa-f]{4,32}$/.test(v), v("validation.driverKey")),
  notes: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
});
export type DriverInput = z.input<typeof driverSchema>;
export const assignDriverSchema = z.object({ driverId: z.uuid().nullable() });
export const driverSettingsSchema = z.object({
  speedLimitKmh: z.number().int().min(20).max(200),
  speedingSeconds: z.number().int().min(0).max(300),
  maxContinuousMin: z.number().int().min(30).max(720),
  minRestMin: z.number().int().min(5).max(240),
  maxDailyMin: z.number().int().min(60).max(1440),
});

export const fuelTankSchema = z
  .object({
    capacityL: z.number().min(5, v("validation.tankCapacityMin")).max(5000),
    attr: z
      .string()
      .trim()
      .max(40)
      .regex(/^[A-Za-z0-9_]*$/, v("validation.attrInvalid"))
      .nullable()
      .default(null)
      .transform((v) => v || null),
    kind: z.enum(FUEL_KINDS).default("percent"),
    calibration: z
      .array(z.tuple([z.number(), z.number().min(0)]))
      .min(2, v("validation.calibrationPoints"))
      .max(60)
      .nullable()
      .default(null),
    counterAttr: z
      .string()
      .trim()
      .max(40)
      .regex(/^[A-Za-z0-9_]*$/, v("validation.attrInvalid"))
      .nullable()
      .default(null)
      .transform((v) => v || null),
    counterUnit: z.enum(["l", "dl", "ml"]).default("l"),
    normL100km: z.number().min(0.5).max(200).nullable().default(null),
    normIdleLh: z.number().min(0.1).max(50).nullable().default(null),
  })
  .refine((t) => t.attr !== null || t.counterAttr !== null || t.normL100km !== null || t.normIdleLh !== null, v("validation.tankSource"))
  .refine((t) => t.attr === null || t.kind !== "raw" || t.calibration !== null, v("validation.calibrationNeeded"))
  .refine((t) => t.calibration === null || t.calibration.every((row, i, all) => i === 0 || row[0] > (all[i - 1] as [number, number])[0]), v("validation.calibrationOrder"));
export type FuelTankInput = z.input<typeof fuelTankSchema>;
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, v("validation.currencyCode"));
const shortText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => v || null);
export const fuelFillSchema = z
  .object({
    at: z.coerce.date(v("validation.fillDateNeeded")).refine((d) => d.getTime() <= Date.now() + 86_400_000, v("validation.dateInFuture")),
    liters: z.number(v("validation.litersNeeded")).gt(0, v("validation.litersPositive")).max(5000),
    total: z.number().min(0).max(100_000_000).nullable().default(null),
    currency: currencySchema.nullable().default(null),
    odometerKm: z.number().min(0).max(5_000_000).nullable().default(null),
    station: shortText(80),
    note: shortText(200),
    /** "detected" when recording a refueling the sensor saw. */
    source: z.enum(["manual", "detected"]).default("manual"),
  })
  .refine((f) => f.total === null || f.currency !== null, v("validation.totalCurrency"));
export type FuelFillInput = z.input<typeof fuelFillSchema>;
export const fuelImportSchema = z.object({
  csv: z.string().min(1, v("validation.fileEmpty")).max(1_000_000, v("validation.fileTooBig")),
  /** Time zone for the file's dates that do not carry their own. */
  zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")),
});
export const fuelSettingsSchema = z.object({
  currency: currencySchema,
  zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")),
});
const zoneSchema = z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone"));
export const reportParamsSchema = z.object({
  groupId: z.uuid().nullable().default(null),
  vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(300).nullable().default(null),
  speedLimitKmh: z.number().int().min(20, v("validation.speedLimitMin20")).max(200).default(REPORT_PARAMS_DEFAULT.speedLimitKmh),
  minStopMin: z.number().int().min(3, v("validation.stopMin")).max(1440).default(REPORT_PARAMS_DEFAULT.minStopMin),
});
export const reportScheduleSchema = z.object({
  name: z.string().trim().min(1, v("validation.reportName")).max(60),
  type: z.enum(REPORT_TYPES),
  params: reportParamsSchema,
  frequency: z.enum(REPORT_FREQUENCIES),
  atMinute: z.number().int().min(0).max(1439),
  weekday: z.number().int().min(0).max(6).default(1),
  monthDay: z.number().int().min(1).max(28).default(1),
  zone: zoneSchema,
  format: z.enum(REPORT_FORMATS),
  recipients: z.array(z.string().min(1).max(64)).min(1, v("validation.recipientNeeded")).max(SCHEDULE_RECIPIENTS_MAX),
  active: z.boolean().default(true),
});
export type ReportScheduleInput = z.input<typeof reportScheduleSchema>;
export const dashboardSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.dashboardName")).max(40),
    period: z.enum(DASHBOARD_PERIODS),
    groupId: z.uuid().nullable().default(null),
    vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(300).nullable().default(null),
    widgets: z
      .array(z.enum(ALL_DASHBOARD_WIDGETS))
      .min(1, v("validation.widgetNeeded"))
      .max(ALL_DASHBOARD_WIDGETS.length)
      .refine((list) => new Set(list).size === list.length, v("validation.widgetRepeated")),
  })
  .refine((d) => d.groupId === null || d.vehicleIds === null, v("validation.groupOrVehicles"));
export type DashboardInput = z.input<typeof dashboardSchema>;

const optionalCount = z.number().int().min(1).max(100_000).nullable().default(null);
const optionalEmail = z.union([z.literal(""), z.email(v("validation.emailInvalid"))]).default("");
export const generalSettingsSchema = z.object({
  registrationOpen: z.boolean(),
  newAccountMaxVehicles: optionalCount,
  newAccountMaxUsers: optionalCount,
  newAccountModules: z.array(z.enum(ALL_MODULES as [ModuleKey, ...ModuleKey[]])).max(ALL_MODULES.length).default([]),
  mapStyleUrl: z.url(v("validation.mapUrl")).max(500),
  geocoderUrl: z.union([z.literal(""), z.url(v("validation.geocoderUrl")).max(500)]).default(""),
  geocoderUserAgent: z.string().trim().max(200).default(""),
  geocoderIntervalMs: z.number().int().min(0).max(60_000).default(1100),
  routingUrl: z.union([z.literal(""), z.url(v("validation.routingUrl")).max(500)]).default(""),
  claimWindowMinutes: z.number().int().min(5, v("validation.claimWindowMin")).max(24 * 60),
  maxPendingDevices: z.number().int().min(1).max(1000).default(20),
  historyRetentionDays: z
    .number()
    .int()
    .min(0)
    .max(3650)
    .refine((n) => n === 0 || n >= HISTORY_RETENTION_MIN_DAYS, { message: v("validation.historyRetention"), params: { days: HISTORY_RETENTION_MIN_DAYS } }),
  traccarRetentionDays: z.number().int().min(2).max(90),
  alertEmail: optionalEmail,
  diskAlertPercent: z.number().int().min(50).max(99),
  defaultLanguage: z.enum(LANGUAGES).default("es"),
  alertEmailsPerHour: z.number().int().min(1).max(1000),
  maxUploadMb: z.number().int().min(1).max(UPLOAD_MAX_MB),
  legalEntity: z.string().trim().max(120).default(""),
  legalCountry: z.string().trim().max(80).default(""),
  legalContactEmail: optionalEmail,
});
export type GeneralSettingsInput = z.input<typeof generalSettingsSchema>;
export const passwordPolicySchema = z.object({
  minLength: z
    .number()
    .int()
    .refine((n) => n >= PASSWORD_MIN, { message: v("validation.passwordMinLength"), params: { min: PASSWORD_MIN } })
    .max(64),
  number: z.boolean(),
  symbol: z.boolean(),
  lowercase: z.boolean(),
  uppercase: z.boolean(),
});
export const mailSettingsSchema = z
  .object({
    custom: z.boolean(),
    host: z.string().trim().max(200).default(""),
    port: z.number().int().min(1).max(65535).default(587),
    security: z.enum(MAIL_SECURITIES).default("starttls"),
    user: z.string().trim().max(200).default(""),
    /** Without this value, or empty, the saved key is kept. */
    password: z.string().max(500).optional(),
    from: z.string().trim().max(200).default(""),
  })
  .refine((m) => !m.custom || (m.host !== "" && m.from !== ""), v("validation.mailServer"));
export type MailSettingsInput = z.input<typeof mailSettingsSchema>;

/**
 * The emails the platform writes with words of its own, which the console can
 * rewrite. The notices of alerts and events are written from what happened, by
 * whoever sets them up, and are not here.
 */
export const MAIL_TEMPLATES = ["verifyEmail", "resetPassword", "existingAccount", "invitation", "panic", "panicUnattended", "scheduledReport", "mailTest"] as const;
export type MailTemplateId = (typeof MAIL_TEMPLATES)[number];
/** What each one may say with `{{variable}}`: the platform fills it in when it sends. `app` is the platform's name. */
export const MAIL_TEMPLATE_VARIABLES = {
  verifyEmail: ["app"],
  resetPassword: ["app"],
  existingAccount: ["app"],
  invitation: ["app", "inviter", "account", "role", "days"],
  panic: ["app", "vehicle"],
  panicUnattended: ["app", "vehicle", "minutes"],
  scheduledReport: ["app", "schedule", "headline", "title", "summary", "every", "who"],
  mailTest: ["app", "host"],
} as const satisfies Record<MailTemplateId, readonly string[]>;
export type MailTemplateVariable = (typeof MAIL_TEMPLATE_VARIABLES)[MailTemplateId][number];
/** Whether the email carries a button. The test only says the mail server works. */
export const mailTemplateHasAction = (id: MailTemplateId): boolean => id !== "mailTest";
/** The words of an email: its subject, the heading inside it, its text and the label of its button (empty when it has none). */
export interface MailTemplateText {
  subject: string;
  heading: string;
  body: string;
  action: string;
}
/** What the console rewrote, by email and language. What is not here goes as the platform writes it. */
export type MailTemplates = Partial<Record<MailTemplateId, Partial<Record<Language, MailTemplateText>>>>;
/** An email as the console shows it to be rewritten: what it may say and how the platform writes it in each language. */
export interface MailTemplateInfo {
  id: MailTemplateId;
  variables: readonly MailTemplateVariable[];
  action: boolean;
  defaults: Record<Language, MailTemplateText>;
}

/** What is wrong with an email's words: an empty field, or a `{{variable}}` the email does not have. Null if nothing. */
export function mailTemplateProblem(id: MailTemplateId, text: MailTemplateText): SharedSay | null {
  const action = mailTemplateHasAction(id);
  if (!text.subject.trim() || !text.heading.trim() || !text.body.trim() || (action && !text.action.trim())) return { key: "validation.mailTemplateField" };
  const known: readonly string[] = MAIL_TEMPLATE_VARIABLES[id];
  for (const field of [text.subject, text.heading, text.body, ...(action ? [text.action] : [])]) {
    for (const m of field.matchAll(/\{\{([^{}]*)\}\}/g)) {
      if (!known.includes((m[1] ?? "").trim())) return { key: "validation.mailTemplateVariable", params: { variable: m[0] } };
    }
  }
  return null;
}
const mailTemplateTextSchema = z.object({
  subject: z
    .string()
    .max(200)
    .transform((s) => s.replace(/\s+/g, " ").trim()),
  heading: z
    .string()
    .max(200)
    .transform((s) => s.replace(/\s+/g, " ").trim()),
  body: z
    .string()
    .max(4000)
    .transform((s) => s.replace(/\r\n?/g, "\n").trim()),
  action: z
    .string()
    .max(80)
    .transform((s) => s.trim())
    .default(""),
});
export const mailTemplatesSchema = z.partialRecord(z.enum(MAIL_TEMPLATES), z.partialRecord(z.enum(LANGUAGES), mailTemplateTextSchema)).superRefine((all, ctx) => {
  for (const id of MAIL_TEMPLATES) {
    for (const language of LANGUAGES) {
      const text = all[id]?.[language];
      const problem = text && mailTemplateProblem(id, text);
      if (problem) ctx.addIssue({ ...issueOf(problem), path: [id, language] });
    }
  }
});
export type MailTemplatesInput = z.input<typeof mailTemplatesSchema>;
export const storageSettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider: z
      .string()
      .refine((id) => STORAGE_PROVIDERS.some((p) => p.id === id), v("validation.storageProvider"))
      .default(STORAGE_PROVIDER_DEFAULT),
    endpoint: z.union([z.literal(""), z.url(v("validation.storageEndpoint")).max(300)]).default(""),
    region: z.string().trim().max(60).default("us-east-1"),
    bucket: z
      .string()
      .trim()
      .max(63)
      .refine((b) => b === "" || /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b), v("validation.bucketName"))
      .default(""),
    prefix: z
      .string()
      .trim()
      .max(200)
      .transform((p) => p.replace(/^\/+|\/+$/g, ""))
      .refine((p) => /^[A-Za-z0-9._\-/]*$/.test(p) && !p.includes("//"), v("validation.storagePrefix"))
      .default(""),
    accessKeyId: z.string().trim().max(200).default(""),
    /** Without this value, or empty, the saved key is kept. */
    secretAccessKey: z.string().max(500).optional(),
    /** Additional arguments for rclone. Empty lines are discarded. */
    flags: z
      .array(z.string().max(STORAGE_FLAG_MAX_LENGTH * 2))
      .max(STORAGE_FLAGS_MAX * 2)
      .default([])
      .transform((list) => list.map((f) => f.trim()).filter((f) => f !== ""))
      .superRefine((list, ctx) => {
        if (list.length > STORAGE_FLAGS_MAX) ctx.addIssue(issueOf({ key: "validation.storageFlagsMax", params: { max: STORAGE_FLAGS_MAX } }));
        for (const flag of list) {
          const problem = storageFlagProblem(flag);
          if (problem) ctx.addIssue(issueOf(problem));
        }
      }),
  })
  .refine((v) => !v.enabled || (v.bucket !== "" && v.accessKeyId !== ""), v("validation.storageBucketAndKey"))
  .refine((v) => !v.enabled || v.endpoint !== "" || !storageNeedsEndpoint(v.provider), v("validation.storageEndpointNeeded"));
export type StorageSettingsInput = z.input<typeof storageSettingsSchema>;
export const backupSettingsSchema = z.object({
  scheduled: z.boolean(),
  cron: z
    .string()
    .trim()
    .max(100)
    .transform((text) => text.replace(/\s+/g, " "))
    .superRefine((text, ctx) => {
      const problem = cronProblem(text, BACKUP_MIN_GAP_MIN);
      if (problem) ctx.addIssue(issueOf(problem));
    }),
  retentionDays: z.number().int().min(1).max(365),
  upload: z.boolean().default(false),
});
/** The word goes as the screen shows it, in capitals; the one of any language confirms. */
export const restoreSchema = z.object({ word: z.literal(confirmWords("restore"), v("validation.confirmRestore")) });
export type BackupSettingsInput = z.input<typeof backupSettingsSchema>;

export const shareSchema = z.object({
  hours: z.number().int().min(1, v("validation.shareMin")).max(SHARE_MAX_HOURS, v("validation.shareMax")),
  note: z.string().trim().max(60).default(""),
});
export type ShareInput = z.input<typeof shareSchema>;
/** The link is long and random; anything else is not even looked up. */
export const shareViewSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
/** Color mode of the interface: the device's, or one chosen by the person. */
export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
/** Only what is sent changes; `language: null` goes back to the platform's default. */
export const userSettingsSchema = z.object({
  /** How the person is called, everywhere: in every account they are in. */
  name: z.string().trim().min(2, v("validation.personName")).max(60).optional(),
  /** Where SMS notifications reach this person, with its country code; null = none. */
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, v("validation.phone"))
    .nullable()
    .optional(),
  theme: z.enum(THEME_MODES).optional(),
  language: z.enum(LANGUAGES).nullable().optional(),
});
/** The person's photo: the web app sends it already cut to a small square. */
export const USER_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type UserPhotoType = (typeof USER_PHOTO_TYPES)[number];
export const USER_PHOTO_MAX_BYTES = 512 * 1024;

/** The account's own name, as its people and the platform's console see it. */
export const accountNameSchema = z.object({
  name: z.string().trim().min(2, v("validation.accountName")).max(60),
});

export const groupSchema = z.object({
  name: z.string().trim().min(1, v("validation.groupName")).max(40),
});

// ─── Responses ───────────────────────────────────────────────────────────────

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

// ─── Live channel ────────────────────────────────────────────────────────────

export type LiveMessage =
  | { type: "hello"; serverTime: string }
  | { type: "position"; vehicleId: string; state: VehicleState }
  | { type: "device"; vehicleId: string; device: VehicleDevice | null }
  | { type: "vehicles_changed" }
  | { type: "geofences_changed" }
  /** Module A: an incident changed, or a vehicle's security state. */
  | { type: "incidents_changed" }
  | { type: "drivers_changed" }
  | { type: "security_changed"; vehicleId: string }
  | { type: "event"; event: VehicleEvent };

// ─── Module I · Integrations ─────────────────────────────────────────────────

/** Requests per minute each API key allows. */
export const API_RATE_PER_MINUTE = 120;
export const API_KEYS_MAX = 20;
/** A public API key. The full key is shown only when it is created. */
export interface ApiKey {
  id: string;
  name: string;
  /** Its first characters, to recognize it. */
  prefix: string;
  /** In addition to reading, it can record: a dispatch, a fill. */
  canWrite: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}
export const apiKeySchema = z.object({ name: z.string().trim().min(1, v("validation.apiKeyName")).max(60), canWrite: z.boolean().default(false) });

export const WEBHOOKS_MAX = 20;
/** Attempts made to deliver a notification before giving it up as lost. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
export interface Webhook {
  id: string;
  name: string;
  url: string;
  /** Event types it is interested in; null = all. */
  events: EventType[] | null;
  active: boolean;
  /** Names of the custom headers each delivery carries; their values are not shown. */
  headerNames: string[];
  createdAt: string;
  /** How the last delivery went. */
  last: { status: WebhookDeliveryStatus; at: string; code: number | null } | null;
}
export type WebhookDeliveryStatus = "pending" | "ok" | "failed";
export interface WebhookDelivery {
  id: number;
  topic: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  /** Code the other system responded with, and the failure if there was one. */
  code: number | null;
  error: string | null;
  createdAt: string;
  doneAt: string | null;
  /** When it is retried, if still pending. */
  nextAt: string | null;
}
/** Headers of its own that a message to another system carries, such as the key that system asks for. Their values are not shown again. */
export const CUSTOM_HEADERS_MAX = 8;
export const customHeadersSchema = z
  .array(z.object({ name: z.string().trim().regex(/^[A-Za-z0-9-]{1,60}$/, v("validation.headerName")), value: z.string().trim().min(1).max(1000) }))
  .max(CUSTOM_HEADERS_MAX);
export type CustomHeader = z.output<typeof customHeadersSchema>[number];

export const webhookSchema = z.object({
  name: z.string().trim().min(1, v("validation.giveName")).max(60),
  url: z
    .url(v("validation.urlInvalid"))
    .max(500)
    .refine((u) => /^https?:\/\//i.test(u), v("validation.urlHttps")),
  events: z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length).nullable().default(null),
  active: z.boolean().default(true),
  /** Custom headers, such as the key the other system requires. Without the field, the existing ones are left untouched. */
  headers: customHeadersSchema.optional(),
});
export type WebhookInput = z.input<typeof webhookSchema>;

// The channels a message can leave through. Their settings and the notifications that use them are further down.
// SMS go through Twilio, which is how the owner knows the channel. The custom channel calls another system the way
// its owner wrote it: an address, headers and a body, with variables. Push reaches the mobile app: it is planned,
// and starts delivering once the app exists and people sign in on it.
export const NOTIFY_CHANNELS = ["email", "sms", "webhook", "push"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];
/** Channels an account can also send to addresses written by hand: an email, a phone. */
export const WRITTEN_CHANNELS: readonly NotifyChannel[] = ["email", "sms"];
/**
 * Channels the platform's own notifications and the automations send to a destination written by hand. In the
 * custom one the destination is optional: an email or a phone that fills its variables.
 */
export const ADDRESS_CHANNELS = ["email", "sms", "webhook"] as const satisfies readonly NotifyChannel[];
export type AddressChannel = (typeof ADDRESS_CHANNELS)[number];
/** Channels charged per message: each account has a monthly cap on them. */
export const PAID_CHANNELS: readonly NotifyChannel[] = ["sms"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Why an address written by hand does not serve for a channel, as a text to say, or null if it does. */
export function addressProblem(channel: NotifyChannel, address: string): SharedSay | null {
  const value = address.trim();
  if (channel === "email") return EMAIL_PATTERN.test(value) ? null : { key: "validation.emailInvalid" };
  if (channel === "sms") return PHONE_PATTERN.test(value) ? null : { key: "validation.phone" };
  if (channel === "webhook") return EMAIL_PATTERN.test(value) || PHONE_PATTERN.test(value) ? null : { key: "validation.emailOrPhone" };
  return { key: "validation.peopleOnly" };
}

/** An address as the logs show it: enough to recognise it, without the part that is a secret. */
export function addressLabel(_channel: NotifyChannel, address: string): string {
  if (PHONE_PATTERN.test(address)) return `${address.slice(0, 4)}…${address.slice(-3)}`;
  return address;
}

/** What the custom channel fills in its address, headers and body: `{{name}}` is replaced by its value. */
export const CUSTOM_VARIABLES = ["type", "event", "title", "body", "message", "vehicle", "time", "latitude", "longitude", "speed", "link", "app", "name", "email", "phone", "phone_digits", "language"] as const;
export type CustomVariable = (typeof CUSTOM_VARIABLES)[number];
/** The ones about whoever receives it: with any of them, each person gets a message of their own. */
export const PERSON_VARIABLES: readonly CustomVariable[] = ["name", "email", "phone", "phone_digits", "language"];
export const CUSTOM_METHODS = ["POST", "GET", "PUT"] as const;
export type CustomMethod = (typeof CUSTOM_METHODS)[number];
/** A variable as it is written; spaces inside the braces are allowed. */
export const CUSTOM_VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** The variables a text uses, in order and without repeats. */
export function variablesIn(text: string): string[] {
  return [...new Set([...text.matchAll(CUSTOM_VARIABLE_PATTERN)].map((m) => m[1] as string))];
}

/**
 * Why a text of the custom channel does not serve, or null if it does: a variable that does not exist or, in the
 * address, one that would change the server it goes to.
 */
export function templateProblem(text: string, part: "url" | "header" | "body"): SharedSay | null {
  const unknown = variablesIn(text).find((name) => !(CUSTOM_VARIABLES as readonly string[]).includes(name));
  if (unknown) return { key: "validation.unknownVariable", params: { name: `{{${unknown}}}` } };
  if (part !== "url") return null;
  const server = /^https?:\/\/([^/?#]+)/i.exec(text)?.[1];
  // Spaces are allowed only inside the braces of a variable.
  if (!server || /\s/.test(text.replace(CUSTOM_VARIABLE_PATTERN, "x"))) return { key: "validation.urlInvalid" };
  return server.includes("{{") ? { key: "validation.variableInHost" } : null;
}

/** Whether the custom channel's texts speak of whoever receives it: then each person gets their own message. */
export const usesPerson = (texts: string[]): boolean => texts.some((text) => variablesIn(text).some((name) => (PERSON_VARIABLES as readonly string[]).includes(name)));

export const AUTOMATIONS_MAX = 50;
/** What an automation does when it is triggered. */
export type AutomationAction =
  /** Notifies some addresses through a channel: emails or phones. In the custom one they are optional and fill its variables. */
  | { type: "notify"; channel: AddressChannel; to: string[] }
  /** Notifies one of the account's webhooks, even if it is not subscribed to that event. */
  | { type: "webhook"; webhookId: string }
  /** Opens a corrective work order for the vehicle. Needs the maintenance module. */
  | { type: "order"; title: string | null };
export interface Automation {
  id: string;
  name: string;
  active: boolean;
  /** Events that trigger it. */
  triggers: EventType[];
  /** Which vehicles it applies to: a group, some vehicles, or all if both are null. */
  groupId: string | null;
  vehicleIds: string[] | null;
  /** Days and hours when it applies; null = always. */
  schedule: WeekSchedule | null;
  /** Minutes it waits before acting again for the same vehicle. */
  cooldownMin: number;
  action: AutomationAction;
  runs: number;
  lastRunAt: string | null;
}
export interface AutomationRun {
  id: number;
  at: string;
  vehicleName: string | null;
  eventType: EventType;
  ok: boolean;
  detail: string | null;
}
export const automationSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.giveName")).max(60),
    active: z.boolean().default(true),
    triggers: z.array(z.enum(EVENT_TYPES)).min(1, v("validation.triggerNeeded")).max(EVENT_TYPES.length),
    groupId: z.uuid().nullable().default(null),
    vehicleIds: z.array(z.uuid()).min(1).max(500).nullable().default(null),
    schedule: scheduleSchema.nullable().default(null),
    cooldownMin: z.number().int().min(0).max(1440).default(0),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("notify"), channel: z.enum(ADDRESS_CHANNELS), to: z.array(z.string().trim().min(1).max(500)).max(5) }),
      z.object({ type: z.literal("webhook"), webhookId: z.uuid() }),
      z.object({ type: z.literal("order"), title: z.string().trim().max(120).nullable().default(null) }),
    ]),
  })
  .refine((a) => a.groupId === null || a.vehicleIds === null, v("validation.groupOrVehicles"))
  .superRefine((a, ctx) => {
    if (a.action.type !== "notify") return;
    if (a.action.to.length === 0 && a.action.channel !== "webhook") ctx.addIssue({ code: "custom", message: v("validation.destinationNeeded") });
    for (const address of a.action.to) {
      const problem = addressProblem(a.action.channel, address);
      if (problem) ctx.addIssue(issueOf(problem));
    }
  });
export type AutomationInput = z.input<typeof automationSchema>;

export const SENSORS_MAX = 100;
export const SENSOR_KINDS = ["temperature", "humidity", "door", "level", "weight", "other"] as const;
export type SensorKind = (typeof SENSOR_KINDS)[number];
/** Unit proposed for each class of sensor. */
export const SENSOR_UNIT: Record<SensorKind, string> = { temperature: "°C", humidity: "%", door: "", level: "%", weight: "kg", other: "" };
/** A sensor that is not a GPS and sends its readings over HTTP with its own key. */
export interface Sensor {
  id: string;
  name: string;
  kind: SensorKind;
  unit: string | null;
  /** Vehicle it is on, if it is on one. */
  vehicleId: string | null;
  vehicleName: string | null;
  /** Outside this range, it notifies. */
  minValue: number | null;
  maxValue: number | null;
  keyPrefix: string;
  lastValue: number | null;
  lastAt: string | null;
  /** Its latest reading is out of range. */
  alerting: boolean;
}
export const sensorSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.sensorName")).max(60),
    kind: z.enum(SENSOR_KINDS).default("other"),
    unit: fleetText(12),
    vehicleId: z.uuid().nullable().default(null),
    minValue: z.number().min(-1e9).max(1e9).nullable().default(null),
    maxValue: z.number().min(-1e9).max(1e9).nullable().default(null),
  })
  .refine((v) => v.minValue === null || v.maxValue === null || v.minValue < v.maxValue, v("validation.minBelowMax"));
export type SensorInput = z.input<typeof sensorSchema>;
/** Maximum readings in one delivery. */
export const SENSOR_BATCH_MAX = 500;
const sensorReading = z.object({ value: z.number().min(-1e12).max(1e12), at: z.coerce.date().optional() });
/** What a sensor sends: one reading or several. */
export const sensorPushSchema = z.union([sensorReading, z.array(sensorReading).min(1).max(SENSOR_BATCH_MAX)]);
export interface SensorSeries {
  sensor: Sensor;
  /** Pairs [time in ms, value], from oldest to newest. */
  points: [number, number][];
}

export const TRANSFER_KINDS = ["vehicles", "drivers", "geofences"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];
/** What can be imported and exported, and the module needed for each. */
export const TRANSFER_INFO: Record<
  TransferKind,
  {
    /** @deprecated Spanish only. Use the catalog: "transfer.<kind>". */
    label: string;
    /** @deprecated Spanish only. Use the catalog: "transferColumns.<kind>". */
    columns: string;
    requires?: ModuleKey;
  }
> = {
  vehicles: { label: es.transfer.vehicles, columns: es.transferColumns.vehicles },
  drivers: { label: es.transfer.drivers, columns: es.transferColumns.drivers, requires: "B" },
  geofences: { label: es.transfer.geofences, columns: es.transferColumns.geofences },
};
export const TRANSFER_FORMATS = ["csv", "xlsx"] as const;
export type TransferFormat = (typeof TRANSFER_FORMATS)[number];
/** Maximum rows imported at once. */
export const IMPORT_MAX_ROWS = 2000;
export interface ImportResult {
  created: number;
  /** Rows that already existed and were left as they were. */
  skipped: number;
  errors: { row: number; message: string }[];
}
export const importSchema = z.object({ csv: z.string().min(1, v("validation.fileEmpty")).max(2_000_000, v("validation.fileTooBig")) });

// ─── Signing in with another service ─────────────────────────────────────────

/** Services people can sign in and sign up with, besides email and password. `custom` is any other that speaks OpenID Connect. */
export const OAUTH_PROVIDERS = ["google", "github", "facebook", "apple", "custom"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
/** How someone signs in: with their email and password, or with one of those services. */
export const SIGN_IN_METHODS = ["email", ...OAUTH_PROVIDERS] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];
/** Each one as the owner of the platform connected it. Secrets never come back: only whether one is stored. */
export interface OAuthSettings {
  google: { enabled: boolean; clientId: string; hasSecret: boolean };
  github: { enabled: boolean; clientId: string; hasSecret: boolean };
  facebook: { enabled: boolean; clientId: string; hasSecret: boolean };
  /** Apple signs its secret with a key: the Services ID, the team, the key's id and, as the secret, the key itself (.p8). */
  apple: { enabled: boolean; clientId: string; teamId: string; keyId: string; hasSecret: boolean };
  /** Another service, with the name its button shows and the address of its OpenID Connect issuer. */
  custom: { enabled: boolean; name: string; issuer: string; clientId: string; hasSecret: boolean; scopes: string };
}
export const OAUTH_DEFAULT: OAuthSettings = {
  google: { enabled: false, clientId: "", hasSecret: false },
  github: { enabled: false, clientId: "", hasSecret: false },
  facebook: { enabled: false, clientId: "", hasSecret: false },
  apple: { enabled: false, clientId: "", teamId: "", keyId: "", hasSecret: false },
  custom: { enabled: false, name: "", issuer: "", clientId: "", hasSecret: false, scopes: "openid email profile" },
};
/** A secret that is not sent stays as it is. */
const oauthSecret = z.string().trim().max(5000).optional();
const oauthClient = z.string().trim().max(300);
const oauthPlain = z.object({ enabled: z.boolean(), clientId: oauthClient, secret: oauthSecret });
export const oauthSettingsSchema = z.object({
  google: oauthPlain,
  github: oauthPlain,
  facebook: oauthPlain,
  apple: z.object({ enabled: z.boolean(), clientId: oauthClient, teamId: z.string().trim().max(20), keyId: z.string().trim().max(20), secret: oauthSecret }),
  custom: z.object({
    enabled: z.boolean(),
    name: z.string().trim().max(40),
    issuer: z
      .string()
      .trim()
      .max(500)
      .refine((url) => url === "" || /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(url), v("validation.urlInvalid")),
    clientId: oauthClient,
    secret: oauthSecret,
    scopes: z.string().trim().max(300).default("openid email profile"),
  }),
});
export type OAuthSettingsInput = z.input<typeof oauthSettingsSchema>;

// ─── Notifications by channel ────────────────────────────────────────────────

/** The channels as the platform owner connects them. Keys never come back: only whether one is stored. */
export interface ChannelSettings {
  email: { enabled: boolean };
  /** Twilio. */
  sms: {
    enabled: boolean;
    accountSid: string;
    hasToken: boolean;
    /** The sending number, or the identifier of a messaging service (starts with MG). */
    from: string;
    /** Messages each account can send per month; null = no cap. */
    monthlyCap: number | null;
  };
  /**
   * Another system, called the way the owner wrote it: its method, its address, its headers and its body, with
   * variables. Header values never come back: only their names.
   */
  webhook: { enabled: boolean; method: CustomMethod; url: string; headerNames: string[]; body: string };
  /** The mobile app. */
  push: { enabled: boolean };
}
export const CHANNELS_DEFAULT: ChannelSettings = {
  email: { enabled: true },
  sms: { enabled: false, accountSid: "", hasToken: false, from: "", monthlyCap: 500 },
  webhook: { enabled: false, method: "POST", url: "", headerNames: [], body: "" },
  push: { enabled: true },
};
const channelToggle = z.object({ enabled: z.boolean() });
const monthlyCap = z.number().int().min(1).max(1_000_000).nullable();
/** A key that is not sent stays as it is. */
const optionalKey = z.string().trim().max(600).optional();
export const channelSettingsSchema = z.object({
  email: channelToggle,
  sms: z.object({ enabled: z.boolean(), accountSid: z.string().trim().max(60), token: optionalKey, from: z.string().trim().max(40), monthlyCap }),
  webhook: z
    .object({
      enabled: z.boolean(),
      method: z.enum(CUSTOM_METHODS).default("POST"),
      url: z.string().trim().max(1000).default(""),
      /** Without the field, the saved ones stay: their values do not come back to the screen. */
      headers: customHeadersSchema.optional(),
      body: z.string().max(4000).default(""),
    })
    .superRefine((w, ctx) => {
      const parts: [string, "url" | "header" | "body", string][] = [
        ...(w.url ? [[w.url, "url", "url"] as [string, "url", string]] : []),
        ...(w.headers ?? []).map((h) => [h.value, "header", "headers"] as [string, "header", string]),
        [w.body, "body", "body"],
      ];
      for (const [text, part, path] of parts) {
        const problem = templateProblem(text, part);
        if (problem) ctx.addIssue({ ...issueOf(problem), path: [path] });
      }
    }),
  push: channelToggle,
});
export type ChannelSettingsInput = z.input<typeof channelSettingsSchema>;

/** A notification of an account: whom it tells, about what and through which channel. */
export interface AccountNotification {
  id: string;
  name: string;
  channel: NotifyChannel;
  active: boolean;
  /** To whom: everyone in the account, some roles, some people. Each receives only what is about vehicles they see. */
  everyone: boolean;
  roles: string[];
  userIds: string[];
  /** Addresses written by hand: emails or phones. */
  addresses: string[];
  /** About what: event types (null = every alert) and, if given, only the events of those alerts. */
  events: EventType[] | null;
  ruleIds: string[] | null;
  /** Of which vehicles: some groups, some vehicles or, with both null, all. */
  groupIds: string[] | null;
  vehicleIds: string[] | null;
  /** Time zone its messages write times in. */
  zone: string;
  /** How its latest message went. */
  last: { status: DeliveryStatus; at: string } | null;
}
export const NOTIFICATIONS_MAX = 50;
export const accountNotificationSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.notificationName")).max(60),
    channel: z.enum(NOTIFY_CHANNELS),
    active: z.boolean().default(true),
    everyone: z.boolean().default(false),
    roles: z.array(z.string().min(1).max(60)).max(30).default([]),
    userIds: z.array(z.string().min(1).max(80)).max(200).default([]),
    addresses: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    events: z
      .array(z.enum(EVENT_TYPES).refine((type) => ALERT_EVENTS.includes(type), v("validation.eventNotAlert")))
      .min(1, v("validation.alertTypeNeeded"))
      .nullable()
      .default(null),
    ruleIds: z.array(z.uuid()).min(1, v("validation.alertNeeded")).max(100).nullable().default(null),
    groupIds: z.array(z.uuid()).min(1, v("validation.groupNeeded")).max(200).nullable().default(null),
    vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(500).nullable().default(null),
    zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")).default("UTC"),
  })
  .refine((n) => n.groupIds === null || n.vehicleIds === null, v("validation.groupsOrVehicles"))
  .refine((n) => n.everyone || n.roles.length > 0 || n.userIds.length > 0 || n.addresses.length > 0, v("validation.whoNeeded"))
  .refine((n) => WRITTEN_CHANNELS.includes(n.channel) || n.addresses.length === 0, v("validation.peopleOnly"))
  .superRefine((n, ctx) => {
    for (const address of n.addresses) {
      const problem = addressProblem(n.channel, address);
      if (problem) ctx.addIssue({ ...issueOf(problem), path: ["addresses"] });
    }
  });
export type AccountNotificationInput = z.input<typeof accountNotificationSchema>;

/** Things of the platform itself that whoever runs it wants to hear about. */
export const SYSTEM_EVENTS = ["backup_ok", "backup_failed", "restore_done", "disk_high", "ingest_stalled", "channel_failing", "account_created"] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];
export interface SystemNotification {
  id: string;
  name: string;
  channel: AddressChannel;
  /** Where it goes: an email or a phone. In the custom channel it is optional and fills its variables. */
  target: string;
  events: SystemEvent[];
  active: boolean;
  last: { status: DeliveryStatus; at: string } | null;
}
export const SYSTEM_NOTIFICATIONS_MAX = 20;
export const systemNotificationSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.notificationName")).max(60),
    channel: z.enum(ADDRESS_CHANNELS),
    target: z.string().trim().max(500).default(""),
    events: z.array(z.enum(SYSTEM_EVENTS)).min(1, v("validation.systemEventNeeded")),
    active: z.boolean().default(true),
  })
  .superRefine((n, ctx) => {
    if (!n.target) {
      if (n.channel !== "webhook") ctx.addIssue({ code: "custom", message: v("validation.targetNeeded"), path: ["target"] });
      return;
    }
    const problem = addressProblem(n.channel, n.target);
    if (problem) ctx.addIssue({ ...issueOf(problem), path: ["target"] });
  });
export type SystemNotificationInput = z.input<typeof systemNotificationSchema>;

export type DeliveryStatus = "pending" | "ok" | "failed";
/** A message in the log: where it went, why and how it ended. */
export interface Delivery {
  id: number;
  at: string;
  channel: NotifyChannel;
  /** Where it went, as it can be shown: without what is a secret. */
  to: string;
  /** The message's first line. */
  title: string;
  /** What produced it: an account's notification, the platform's, an automation or a test. */
  source: "notification" | "system" | "automation" | "test";
  /** Name of the notification that produced it, if it still exists. */
  name: string | null;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  /** When it will be tried again, while it is pending. */
  nextAt: string | null;
}

/** What the notifications screen of an account needs besides its list. */
export interface NotificationOptions {
  /** Channels the platform has connected and allows. */
  channels: NotifyChannel[];
  people: { userId: string; name: string; role: string; roleName: string; hasPhone: boolean }[];
  roles: { id: string; name: string }[];
  /** The alerts of the account, to notify only about some. */
  rules: { id: string; name: string }[];
  /** Whether this person can write addresses by hand: only who sees the whole account. */
  canAddress: boolean;
  /** Whether the custom channel sends one message per person (its owner used their details) or one for everyone. */
  customPerPerson: boolean;
  /** How many messages the account has sent this month through each capped channel, and its cap. */
  usage: { channel: NotifyChannel; sent: number; cap: number | null }[];
}

export * from "./text";
export * from "./locales";
export * from "./geo";
export * from "./cron";
export * from "./schedule";
export * from "./storage";
export * from "./csv";
export * from "./simulator";
