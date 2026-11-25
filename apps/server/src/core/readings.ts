// What the device reads from the vehicle: RPM, temperature, odometer,
// fault codes. Each protocol delivers it in its own way: the device
// receiver names some data and leaves others with their parameter number.
// Here we say where to look for each one and in what unit it comes.
//
// The Teltonika names and numbers were checked against Traccar 6.17 with
// test frames (2026-11-22): OBD and CAN data arrive as "ioNN",
// and fault codes as "dtcs".
import type { DiagParam } from "@opengps/shared";

interface Source {
  attr: string;
  /** What it is multiplied by to bring it to the parameter's unit. */
  scale?: number;
  /** Only valid for that protocol: parameter numbers mean something else in the others. */
  protocol?: string;
}

const t = (attr: string, scale = 1): Source => ({ attr, scale, protocol: "teltonika" });

/** Where to look for each datum, in order of preference: first the one from the vehicle's network (CAN), then OBD. */
const SOURCES: Record<DiagParam, Source[]> = {
  rpm: [{ attr: "rpm" }, t("io85"), t("io36")],
  coolantTemp: [{ attr: "coolantTemp" }, { attr: "engineTemp" }, t("io115", 0.1), t("io32")],
  engineLoad: [{ attr: "engineLoad" }, t("io114"), t("io31")],
  throttle: [{ attr: "throttle" }, t("io82"), t("io41")],
  obdSpeed: [{ attr: "obdSpeed" }, t("io81"), t("io37")],
  power: [{ attr: "power" }],
  fuelLevel: [{ attr: "fuelLevel" }, t("io89"), t("io48")],
  fuelLevelL: [{ attr: "fuel" }, t("io84", 0.1)],
  fuelUsed: [{ attr: "fuelUsed" }, t("io83", 0.1), t("io107", 0.1)],
  fuelRate: [{ attr: "fuelConsumption" }, t("io110", 0.1), t("io60", 0.01)],
  intakeTemp: [{ attr: "intakeTemp" }, t("io39")],
  oilTemp: [{ attr: "oilTemp" }, t("io58")],
  // Meters → kilometers; minutes → hours.
  ecuOdometer: [{ attr: "obdOdometer", scale: 0.001 }, t("io87", 0.001), t("io105", 0.001)],
  ecuHours: [t("io102", 1 / 60), t("io103", 1 / 60)],
  moduleVoltage: [t("io51", 0.001)],
  engineRuntime: [t("io42", 1 / 60)],
  deviceBattery: [{ attr: "battery" }],
};

/** Data that already has its place in the platform and does not need repeating among "other data". */
const KNOWN_ELSEWHERE = new Set(["ignition", "motion", "sat", "rssi", "priority", "event", "distance", "totalDistance", "hours", "odometer", "batteryLevel", "out1", "out2", "alarm", "dtcs", "io30"]);

const numberOf = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** The value of a datum in a position, already in its unit; `null` if the device did not send it. */
export function readParam(param: DiagParam, attributes: Record<string, unknown>, protocol: string | null): number | null {
  for (const source of SOURCES[param]) {
    if (source.protocol && source.protocol !== protocol) continue;
    const raw = numberOf(attributes[source.attr]);
    if (raw !== null) return raw * (source.scale ?? 1);
  }
  return null;
}

/** The attributes a datum can come from, to request them from the database. */
export const attrsOf = (param: DiagParam, protocol: string | null): { attr: string; scale: number }[] =>
  SOURCES[param].filter((s) => !s.protocol || s.protocol === protocol).map((s) => ({ attr: s.attr, scale: s.scale ?? 1 }));

/** All the known data a position carries. */
export function readAll(attributes: Record<string, unknown>, protocol: string | null): Partial<Record<DiagParam, number>> {
  const out: Partial<Record<DiagParam, number>> = {};
  for (const param of Object.keys(SOURCES) as DiagParam[]) {
    const value = readParam(param, attributes, protocol);
    if (value !== null) out[param] = value;
  }
  return out;
}

/** Numeric data the device sends and the platform cannot name: shown as is. */
export function unknownAttrs(attributes: Record<string, unknown>, protocol: string | null): { name: string; value: number }[] {
  const used = new Set<string>();
  for (const sources of Object.values(SOURCES)) for (const s of sources) if (!s.protocol || s.protocol === protocol) used.add(s.attr);
  const out: { name: string; value: number }[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (used.has(name) || KNOWN_ELSEWHERE.has(name) || typeof value === "boolean") continue;
    const n = numberOf(value);
    if (n !== null) out.push({ name, value: n });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Fault codes a position carries. `null` if the position says nothing
 * about faults; an empty list if it says there are none.
 */
export function readFaults(attributes: Record<string, unknown>, protocol: string | null): string[] | null {
  const text = attributes.dtcs;
  if (typeof text === "string") return [...new Set(text.toUpperCase().match(/[PCBU][0-9A-F]{4}/g) ?? [])];
  // Teltonika: parameter 30 is how many codes there are. At zero, there are no faults.
  if (protocol === "teltonika" && numberOf(attributes.io30) === 0) return [];
  return null;
}
