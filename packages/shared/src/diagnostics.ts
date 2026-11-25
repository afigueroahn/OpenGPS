// Module C · Diagnostics.
import { es } from "./locales/es";
import type { VehicleMeters } from "./meters";
import { isValidZone } from "./schedule";
import { v } from "./validation";
import { z } from "zod";

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
