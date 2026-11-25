// Module F · Fuel.
import { es } from "./locales/es";

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
