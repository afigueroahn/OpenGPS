// Converts a Traccar position to the platform's format.
import { createHash } from "node:crypto";

/** Row of tc_positions, with the times already converted to UTC instants. */
export interface TraccarPosition {
  id: number;
  deviceid: number;
  protocol: string | null;
  servertime: Date;
  fixtime: Date;
  valid: boolean;
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;
  course: number | null;
  accuracy: number | null;
  attributes: string | null;
}

export interface NormalizedPosition {
  fixTime: Date;
  receivedAt: Date;
  /** Checksum of the content, as a 64-bit integer in text form. */
  hash: string;
  valid: boolean;
  lat: number;
  lon: number;
  altitude: number | null;
  speedKmh: number | null;
  course: number | null;
  accuracy: number | null;
  protocol: string | null;
  attributes: Record<string, unknown>;
  ignition: boolean | null;
  /** The ignition was deduced from the vehicle's voltage; the device did not report it. */
  ignitionInferred: boolean;
  motion: boolean | null;
  /** Vehicle battery voltage. */
  powerV: number | null;
  /** Device's internal battery. */
  batteryV: number | null;
  batteryPct: number | null;
  satellites: number | null;
  /** Cellular signal, from 0 to 4 bars. */
  signalBars: number | null;
}

/** Traccar stores speed in knots. */
export const KNOTS_TO_KMH = 1.852;

const EARLIEST_FIX = Date.UTC(2015, 0, 1);
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

const round = (n: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};
const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

function parseAttributes(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const numberOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Ignition deduced from the vehicle's voltage: with the engine running the
 * alternator raises the battery above 13.2 V (26.4 V on 24 V systems).
 * Below 6 V there is no vehicle battery to measure.
 */
export function ignitionFromVoltage(powerV: number | null): boolean | null {
  if (powerV === null || powerV < 6) return null;
  return powerV >= (powerV > 18 ? 26.4 : 13.2);
}

/**
 * Cellular signal in bars (0 to 4). Each protocol reports it in its own way:
 * short scale, CSQ from 0 to 31, percentage or dBm.
 */
export function signalBars(rssi: number | null, protocol: string | null): number | null {
  if (rssi === null) return null;
  const clamp = (n: number) => Math.max(0, Math.min(4, Math.round(n)));
  if (rssi < 0) return rssi >= -70 ? 4 : rssi >= -85 ? 3 : rssi >= -100 ? 2 : rssi >= -110 ? 1 : 0;
  if (protocol === "gt06" && rssi <= 4) return clamp(rssi);
  if (rssi <= 5) return clamp((rssi * 4) / 5);
  if (rssi === 99) return null; // CSQ 99: unknown
  if (rssi <= 31) return rssi >= 20 ? 4 : rssi >= 15 ? 3 : rssi >= 10 ? 2 : rssi >= 5 ? 1 : 0;
  if (rssi <= 100) return clamp(rssi / 25);
  return null;
}

/**
 * Returns the normalized position, or null if it cannot be used: impossible
 * coordinates or an absurd GPS time (devices with an unset clock).
 */
export function normalize(row: TraccarPosition): NormalizedPosition | null {
  const { latitude: lat, longitude: lon } = row;
  if (!finite(lat) || !finite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const fix = row.fixtime.getTime();
  const received = row.servertime.getTime();
  if (!Number.isFinite(fix) || !Number.isFinite(received)) return null;
  if (fix < EARLIEST_FIX || fix > received + MAX_FUTURE_MS) return null;

  const attributes = parseAttributes(row.attributes);
  // Without signal, many devices report the coordinate 0,0.
  const valid = row.valid && !(lat === 0 && lon === 0);
  const speedKmh = finite(row.speed) ? round(Math.max(0, row.speed) * KNOTS_TO_KMH, 1) : null;
  const course = finite(row.course) ? round(((row.course % 360) + 360) % 360, 1) : null;
  const altitude = finite(row.altitude) ? round(row.altitude, 1) : null;
  const accuracy = finite(row.accuracy) && row.accuracy > 0 ? round(row.accuracy, 1) : null;
  const motion = typeof attributes.motion === "boolean" ? attributes.motion : null;
  const powerRaw = numberOf(attributes.power);
  const batteryRaw = numberOf(attributes.battery);
  const levelRaw = numberOf(attributes.batteryLevel);
  const satRaw = numberOf(attributes.sat);
  const powerV = powerRaw !== null && powerRaw >= 0 && powerRaw < 100 ? round(powerRaw, 1) : null;
  const reported = typeof attributes.ignition === "boolean" ? attributes.ignition : null;
  const inferred = reported === null ? ignitionFromVoltage(powerV) : null;
  const ignition = reported ?? inferred;

  // The checksum uses only what the device sends. The attributes Traccar
  // calculates (distance, hours) change if the device resends the same datum.
  const fingerprint = [
    lat.toFixed(6),
    lon.toFixed(6),
    speedKmh ?? "",
    course ?? "",
    altitude ?? "",
    valid ? 1 : 0,
    reported ?? "",
    typeof attributes.alarm === "string" ? attributes.alarm : "",
    typeof attributes.event === "number" || typeof attributes.event === "string" ? attributes.event : "",
  ].join("|");
  const hash = createHash("sha1").update(fingerprint).digest().readBigInt64BE(0).toString();

  return {
    fixTime: row.fixtime,
    receivedAt: row.servertime,
    hash,
    valid,
    lat,
    lon,
    altitude,
    speedKmh,
    course,
    accuracy,
    protocol: row.protocol,
    attributes,
    ignition,
    ignitionInferred: reported === null && inferred !== null,
    motion,
    powerV,
    batteryV: batteryRaw !== null && batteryRaw >= 0 && batteryRaw < 100 ? round(batteryRaw, 2) : null,
    batteryPct: levelRaw !== null && levelRaw >= 0 && levelRaw <= 100 ? Math.round(levelRaw) : null,
    satellites: satRaw !== null && satRaw >= 0 && satRaw < 100 ? Math.round(satRaw) : null,
    signalBars: signalBars(numberOf(attributes.rssi), row.protocol),
  };
}

/**
 * Parameters with which a Teltonika reports something. Traccar only translates them
 * to an alarm if it knows the exact device model, so they are translated here.
 */
const TELTONIKA_ALARMS: Record<string, string> = { io249: "jamming", io246: "tow", io252: "powerCut" };

/** Alarms the device sent with a position, with Traccar's names: "sos", "powerCut", "tow"… */
export function alarmsOf(protocol: string | null, attributes: Record<string, unknown>): string[] {
  const alarm = attributes.alarm;
  // Traccar joins several alarms into a comma-separated text.
  const alarms = typeof alarm === "string" ? alarm.split(",").map((a) => a.trim()).filter(Boolean) : [];
  if (protocol !== "teltonika") return alarms;
  // A Teltonika's panic input arrives as a "general" alarm.
  const named = alarms.map((a) => (a === "general" ? "sos" : a));
  for (const [io, name] of Object.entries(TELTONIKA_ALARMS)) {
    const value = attributes[io];
    if (typeof value === "number" && value >= 1 && !named.includes(name)) named.push(name);
  }
  return named;
}
