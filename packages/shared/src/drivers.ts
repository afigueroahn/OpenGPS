// Module B · Driver.

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
