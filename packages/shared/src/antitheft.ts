// Module A · Anti-theft and commands.

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
