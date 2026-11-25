// Alerts.

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
