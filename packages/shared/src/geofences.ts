// Geofences and events.
import type { GeofenceGeometry } from "./geo";
import type { WeekSchedule } from "./schedule";

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
