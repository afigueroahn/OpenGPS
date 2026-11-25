// Device simulator of the admin console: simulated GPS devices that connect
// to the gateway like real ones, to test the whole platform without hardware.
// What the console and the backend say to each other about them.
import { z } from "zod";
import { type LonLat, metersBetween } from "./geo";
import type { SharedKey, SharedSay } from "./locales";

const v = <K extends SharedKey>(key: K): K => key;

/** Alarms a simulated device can send with a position, if its brand carries them. */
export const SIM_ALARMS = ["sos", "powerCut", "tow", "jamming", "harshAcceleration", "harshBraking", "harshCornering"] as const;
export type SimAlarm = (typeof SIM_ALARMS)[number];

/** What a brand's protocol can carry or obey. The console only offers what the chosen brand has. */
export const SIM_CAPABILITIES = [
  "ignition",
  "voltage",
  ...SIM_ALARMS,
  "fuel",
  "driverKey",
  "engineData",
  "dtc",
  /** Obeys the command that cuts the engine start. */
  "engineCut",
  /** Reports whether the start is cut, so the platform confirms its command. */
  "lockState",
  /** Obeys the command that changes how often it reports. */
  "interval",
  /** Uploads positions it stored while it had no connection. */
  "stored",
  /** Has numbered parameters: any of them can be written as it is. */
  "extraIo",
] as const;
export type SimCapability = (typeof SIM_CAPABILITIES)[number];

/** How a brand writes the identifier of its devices. */
export type SimIdFormat = { kind: "imei" } | { kind: "digits"; length: number };

/** What the vehicle does at the end of the route: go around again, come back the same way, or stay parked. */
export const SIM_ENDS = ["loop", "return", "stay"] as const;
export type SimEnd = (typeof SIM_ENDS)[number];
/** How several devices of one simulation share the route: spread evenly, or one after another. */
export const SIM_SPREADS = ["even", "convoy"] as const;
export type SimSpread = (typeof SIM_SPREADS)[number];

export const SIM_LIMITS = {
  identifiers: 5000,
  linePoints: 5000,
  waypoints: 25,
  /** A route shorter than this goes nowhere. */
  routeMinM: 20,
  /** Driving seconds a route can bring: a week. */
  routeSeconds: 7 * 86_400,
  /** Places an address search returns. */
  places: 6,
  /** Things that can happen along a route. */
  actions: 40,
  extraIo: 20,
  /** How far back a past trip can end, in hours: a month. */
  backfillHours: 720,
  /** Reports a past trip can have. */
  backfillReports: 5000,
  /** A route whose ends are this close is a circuit: the vehicle can go around it. */
  loopCloseM: 50,
  logEntries: 200,
  /** Devices of one simulation sent to the console, the ones with problems first. */
  devicesShown: 300,
} as const;

// ─── Identifiers ─────────────────────────────────────────────────────────────

/** Check digit of an IMEI: the one that makes its 15 digits pass the Luhn test. */
export function luhnDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return (10 - (sum % 10)) % 10;
}

export const isImei = (id: string): boolean => /^\d{15}$/.test(id) && luhnDigit(id.slice(0, 14)) === Number(id[14]);

/** What is wrong with an identifier for a brand, or null. */
export function simIdProblem(format: SimIdFormat, id: string): SharedSay | null {
  if (format.kind === "imei") return isImei(id) ? null : { key: "validation.simImei" };
  return new RegExp(`^\\d{${format.length}}$`).test(id) ? null : { key: "validation.simDigits", params: { length: format.length } };
}

/**
 * An identifier a device of that brand could have, to add it to the platform
 * and simulate it. `random` returns a number in [0, 1).
 */
export function generateSimId(format: SimIdFormat, random: () => number = Math.random): string {
  const digits = (count: number) => Array.from({ length: count }, () => Math.floor(random() * 10)).join("");
  if (format.kind === "imei") {
    // 35 is a reporting body that exists; the rest is made up.
    const body = `35${digits(12)}`;
    return `${body}${luhnDigit(body)}`;
  }
  // Without a leading zero, which some gateways drop.
  return `${1 + Math.floor(random() * 9)}${digits(format.length - 1)}`;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** A point the person marked to build the route: an address, or a tap on the map. */
export interface SimWaypoint {
  lon: number;
  lat: number;
  label: string;
}

export interface SimRouteSummary {
  id: string;
  name: string;
  lengthM: number;
  /** Its ends meet: the vehicle can go around it. */
  closed: boolean;
  /** Simulations that travel it. */
  inUse: number;
  /** It brings the driving time of each stretch: the vehicle goes at the speed of each street, not at one cruising speed. */
  timed: boolean;
}

export interface SimRoute extends SimRouteSummary {
  waypoints: SimWaypoint[];
  /** Traced along streets by the routing service; otherwise, straight lines between its points. */
  snapped: boolean;
  line: LonLat[];
  /** Driving seconds accumulated up to each point of the line, as the routing service gave them; null = cruising speed. */
  secs: number[] | null;
}

export function lineLengthM(line: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += metersBetween(line[i - 1] as LonLat, line[i] as LonLat);
  return total;
}

export const isClosedLine = (line: LonLat[]): boolean => line.length >= 3 && metersBetween(line[0] as LonLat, line[line.length - 1] as LonLat) <= SIM_LIMITS.loopCloseM;

const lon = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);

export const simRouteSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.giveName")).max(80),
    waypoints: z
      .array(z.object({ lon, lat, label: z.string().trim().max(200).default("") }))
      .min(2, v("validation.simWaypoints"))
      .max(SIM_LIMITS.waypoints),
    snapped: z.boolean().default(false),
    /** The path as it was traced: by the routing service, from a real trip, or straight between the points. */
    line: z.array(z.tuple([lon, lat])).min(2, v("validation.simLine")).max(SIM_LIMITS.linePoints, v("validation.simLine")),
    secs: z.array(z.number().min(0).max(SIM_LIMITS.routeSeconds)).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const secs = value.secs;
    // One time per point, and time does not go back.
    if (secs && (secs.length !== value.line.length || secs.some((s, i) => i > 0 && s < (secs[i - 1] as number)))) ctx.addIssue({ code: "custom", path: ["secs"], message: v("validation.simLine") });
    if (value.line.length >= 2 && lineLengthM(value.line) < SIM_LIMITS.routeMinM) ctx.addIssue({ code: "custom", path: ["line"], message: v("validation.simLineShort") });
  });
export type SimRouteInput = z.input<typeof simRouteSchema>;

/** The points a route along streets must go through, in order. */
export const simTraceSchema = z.object({
  points: z.array(z.object({ lon, lat })).min(2, v("validation.simWaypoints")).max(SIM_LIMITS.waypoints),
});

/** A path along streets, as the routing service traced it. */
export interface SimTrace {
  line: LonLat[];
  /** Driving seconds accumulated up to each point. */
  secs: number[];
  lengthM: number;
  seconds: number;
}

/** A place found by its written address. */
export interface SimPlace {
  label: string;
  lon: number;
  lat: number;
}

export const simPlacesQuery = z.object({ q: z.string().trim().min(3, v("validation.simPlaceQuery")).max(200) });

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Something that happens along the route, on the way out. Each one is anchored
 * to a point of the route by its meters from the start; past the end, it
 * happens at the end.
 */
export const SIM_ACTION_KINDS = ["stop", "refuel", "drain", "speeding", "engineLock", "towing", "alarm", "signalLoss", "driverKey", "dtc"] as const;
export type SimActionKind = (typeof SIM_ACTION_KINDS)[number];

const atM = z.number().min(0).max(5_000_000);
const seconds = z.number().int().min(1, v("validation.simSeconds")).max(86_400, v("validation.simSeconds"));
const lengthM = z.number().min(50, v("validation.simStretch")).max(5_000_000);
const percent = z.number().min(1, v("validation.simPercent")).max(100, v("validation.simPercent"));
/** A driver key (iButton) as devices send it: 4 to 16 hexadecimal digits, like the ones a driver is given in the platform. */
const driverKey = z.string().trim().toUpperCase().regex(/^[0-9A-F]{4,16}$/, v("validation.simDriverKey"));
/** An engine fault code as OBD names it: P0300, U0100. */
const faultCode = z.string().trim().toUpperCase().regex(/^[PCBU][0-9A-F]{4}$/, v("validation.simFaultCode"));

export const simActionSchema = z.discriminatedUnion("kind", [
  /** Stops there, with the engine running or off. */
  z.object({ kind: z.literal("stop"), atM, seconds, engineOn: z.boolean().default(false) }),
  /** Stops with the engine off while the tank fills by that many points of its level. */
  z.object({ kind: z.literal("refuel"), atM, seconds, pct: percent }),
  /** Stops with the engine off while the tank loses that many points: a siphoning. */
  z.object({ kind: z.literal("drain"), atM, seconds, pct: percent }),
  /** Drives a stretch at that speed. */
  z.object({ kind: z.literal("speeding"), atM, lengthM, kmh: z.number().min(5, v("validation.simSpeed")).max(250, v("validation.simSpeed")) }),
  /** The device cuts the engine start by itself: stopped, off, and reporting the cut. */
  z.object({ kind: z.literal("engineLock"), atM, seconds }),
  /** Moves a stretch with the engine off: on a tow truck. */
  z.object({ kind: z.literal("towing"), atM, lengthM }),
  /** The device sends that alarm when it passes. */
  z.object({ kind: z.literal("alarm"), atM, alarm: z.enum(SIM_ALARMS) }),
  /** Stops transmitting for a while, keeps moving, and uploads what it stored when the signal is back. */
  z.object({ kind: z.literal("signalLoss"), atM, seconds }),
  /** From there on, the driver with that key is at the wheel; empty = nobody. */
  z.object({ kind: z.literal("driverKey"), atM, key: z.union([z.literal(""), driverKey]) }),
  /** From there on, the engine reports those fault codes; none = they clear. */
  z.object({ kind: z.literal("dtc"), atM, codes: z.array(faultCode).max(8) }),
]);
export type SimAction = z.output<typeof simActionSchema>;
export type SimActionInput = z.input<typeof simActionSchema>;

/** What a brand's protocol must carry for an action to reach the platform; null = every brand can. */
export function simActionNeeds(action: Pick<SimAction, "kind"> & { alarm?: SimAlarm }): SimCapability | null {
  switch (action.kind) {
    case "refuel":
    case "drain":
      return "fuel";
    case "engineLock":
      return "lockState";
    case "alarm":
      return action.alarm ?? null;
    case "signalLoss":
      return "stored";
    case "driverKey":
      return "driverKey";
    case "dtc":
      return "dtc";
    default:
      return null;
  }
}

/** Something done by hand to a simulated device that is running, to see how the platform takes it right then. */
export const simInjectSchema = z.discriminatedUnion("kind", [
  /** It sends that alarm with its next report. */
  z.object({ kind: z.literal("alarm"), alarm: z.enum(SIM_ALARMS) }),
  /** Its start is cut, or given back, as a command would do. */
  z.object({ kind: z.literal("engineLock"), on: z.boolean() }),
  /** A theft: its power is cut and for a while it moves with the engine off, with a jammer on along the way. */
  z.object({ kind: z.literal("theft"), seconds: seconds.default(300) }),
  /** It stops with the engine off while its tank gains (or, negative, loses) that many points of its level. */
  z.object({ kind: z.literal("fuel"), pct: z.number().min(-100).max(100).refine((n) => Math.abs(n) >= 1, v("validation.simPercent")), seconds: seconds.default(300) }),
  /** It loses its signal for that long: it stores its reports and uploads them when it is back. */
  z.object({ kind: z.literal("disconnect"), seconds }),
]);
export type SimInject = z.output<typeof simInjectSchema>;
export type SimInjectInput = z.input<typeof simInjectSchema>;

/** What a brand's protocol must carry for something done by hand to reach the platform; null = every brand can. */
export function simInjectNeeds(action: Pick<SimInject, "kind"> & { alarm?: SimAlarm }): SimCapability | null {
  switch (action.kind) {
    case "alarm":
      return action.alarm ?? null;
    case "engineLock":
      return "lockState";
    case "fuel":
      return "fuel";
    case "disconnect":
      return "stored";
    default:
      return null;
  }
}

/** The whole route sent as a trip of the past, as a device uploads what it stored: when that trip ended, in hours before now. */
export const simBackfillSchema = z.object({ hoursAgo: z.number().min(0).max(SIM_LIMITS.backfillHours, v("validation.simBackfill")).default(24) });

/** Ready-made sets of things along a route, each one to see something of the platform at work. */
export const SIM_PRESETS = ["trip", "theft", "fuel", "speeding", "signalLoss"] as const;
export type SimPreset = (typeof SIM_PRESETS)[number];

/**
 * What a ready-made scenario puts along a route of that length. The times are
 * the ones the platform needs to notice each thing: a stop long enough to be
 * one, a siphoning inside a stop, a silence longer than the shortest alert.
 */
export function simPreset(preset: SimPreset, routeM: number): { actions: SimActionInput[]; fuel?: { startPct: number; burnPer100Km: number } } {
  const at = (share: number) => Math.round((routeM * share) / 10) * 10;
  switch (preset) {
    case "trip":
      return {
        actions: [
          { kind: "stop", atM: at(0.3), seconds: 120, engineOn: true },
          { kind: "stop", atM: at(0.65), seconds: 300, engineOn: false },
        ],
      };
    case "theft":
      // Its power is cut, it leaves on a tow truck with the engine off, and a jammer is turned on along the way.
      return {
        actions: [
          { kind: "stop", atM: at(0.2), seconds: 240, engineOn: false },
          { kind: "towing", atM: at(0.2), lengthM: Math.max(50, at(0.5)) },
          // A few meters on, already moving: that is when the device notices.
          { kind: "alarm", atM: at(0.2) + 20, alarm: "powerCut" },
          { kind: "alarm", atM: at(0.2) + 20, alarm: "tow" },
          { kind: "alarm", atM: at(0.4), alarm: "jamming" },
        ],
      };
    case "fuel":
      return {
        fuel: { startPct: 60, burnPer100Km: 12 },
        actions: [
          { kind: "refuel", atM: at(0.3), seconds: 240, pct: 30 },
          { kind: "drain", atM: at(0.7), seconds: 360, pct: 20 },
        ],
      };
    case "speeding":
      return { actions: [{ kind: "speeding", atM: at(0.3), lengthM: Math.max(50, Math.min(3000, at(0.3))), kmh: 130 }] };
    case "signalLoss":
      return { actions: [{ kind: "signalLoss", atM: at(0.3), seconds: 600 }] };
  }
}

/** How the vehicle travels its route. Every field has a starting value, so a scenario saved before a field existed still reads. */
export const simScenarioSchema = z.object({
  /** Speed where the route brings no road times. */
  cruiseKmh: z.number().min(5).max(200).default(45),
  /** Follow the time of each street when the route brings it; off, the whole route goes at cruising speed. */
  roadSpeeds: z.boolean().default(true),
  end: z.enum(SIM_ENDS).default("return"),
  /** Seconds stopped with the engine on at each end of the route. */
  idleS: z.number().int().min(0).max(86_400).default(20),
  /** Seconds parked with the engine off at each end of the route. */
  restS: z.number().int().min(0).max(86_400).default(240),
  /** The device says whether the engine is on; off, it only gives the voltage and the platform works it out. */
  reportIgnition: z.boolean().default(true),
  /** The tank, if the device reports its level: where it starts each lap and how much it burns. */
  fuel: z
    .object({
      startPct: z.number().min(0).max(100).default(70),
      /** Points of the level burned every 100 km. */
      burnPer100Km: z.number().min(0).max(100).default(12),
    })
    .nullable()
    .default(null),
  /** The driver at the wheel from the start, by the key the device reads; empty = nobody. */
  driverKey: z.union([z.literal(""), driverKey]).default(""),
  /** Numbered parameters written as they are in every report, in the brands that have them. */
  extraIo: z
    .array(z.object({ id: z.number().int().min(1).max(65_535), value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }))
    .max(SIM_LIMITS.extraIo)
    .default([]),
  actions: z.array(simActionSchema).max(SIM_LIMITS.actions).default([]),
});
export type SimScenario = z.output<typeof simScenarioSchema>;
export type SimScenarioInput = z.input<typeof simScenarioSchema>;

// ─── Simulations ─────────────────────────────────────────────────────────────

export const simulationSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.giveName")).max(80),
    /** The device family of the catalog: it sets the protocol and the port. */
    modelId: z.string().trim().min(1).max(40),
    identifiers: z.array(z.string().trim().regex(/^\d{4,20}$/, v("validation.deviceId"))).min(1, v("validation.simIdentifierNeeded")).max(SIM_LIMITS.identifiers),
    /** The server and the port it reports to, written by hand as on a real GPS. */
    host: z
      .string(v("validation.simTargetNeeded"))
      .trim()
      .min(1, v("validation.simTargetNeeded"))
      .max(253)
      .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, v("validation.simHost")),
    port: z.number(v("validation.simTargetNeeded")).int().min(1, v("validation.simTargetNeeded")).max(65_535, v("validation.simTargetNeeded")),
    /** Seconds between two reports. */
    intervalS: z.number().int().min(1).max(3600).default(5),
    routeId: z.uuid(),
    scenario: simScenarioSchema.default(() => simScenarioSchema.parse({})),
    spread: z.enum(SIM_SPREADS).default("even"),
    /** Seconds between one device and the next, in a convoy. */
    gapS: z.number().int().min(0).max(3600).default(30),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.identifiers).size !== value.identifiers.length) ctx.addIssue({ code: "custom", path: ["identifiers"], message: v("validation.simIdentifierRepeated") });
  });
export type SimulationInput = z.input<typeof simulationSchema>;

export const simRunSchema = z.object({ run: z.boolean() });

/** How a simulated device is doing. */
export const SIM_STATUSES = ["stopped", "connecting", "online", "rejected", "silent", "unreachable", "offline", "noSignal"] as const;
export type SimStatus = (typeof SIM_STATUSES)[number];

export interface SimDeviceView {
  identifier: string;
  status: SimStatus;
  /** There is a device with this identifier in the platform. */
  registered: boolean;
  lat: number | null;
  lon: number | null;
  course: number | null;
  speedKmh: number | null;
  ignition: boolean | null;
  /** The engine start is cut: by a command it received, or by itself at that point of its route. */
  engineCut: boolean;
  /** Tank level it reports, 0 to 100; null if it says nothing about fuel. */
  fuelPct: number | null;
  /** Reports it is keeping for lack of signal. */
  stored: number;
  /** Reports sent since it started. */
  sent: number;
  lastSentAt: string | null;
  /** The last time the platform stored a position of this device. */
  lastReceivedAt: string | null;
  /** Milliseconds from sending that position until the platform had it. */
  latencyMs: number | null;
}

/** Something that happened to a simulated device. The console says it in the reader's language. */
export const SIM_LOG_CODES = ["started", "stopped", "resumed", "connected", "rejected", "unreachable", "closed", "command", "engineCut", "engineResume", "interval", "alarm", "signalLost", "signalBack", "theft", "fuelChange", "disconnect", "backfill"] as const;
export type SimLogCode = (typeof SIM_LOG_CODES)[number];
export interface SimLogEntry {
  at: string;
  identifier: string | null;
  code: SimLogCode;
  params: Record<string, string | number>;
}

export interface SimulationSummary {
  id: string;
  name: string;
  modelId: string;
  identifiers: string[];
  /** The server and the port it connects to. */
  host: string;
  port: number;
  /** That server is this platform: what it sends is expected to arrive here. */
  toPlatform: boolean;
  intervalS: number;
  routeId: string;
  routeName: string;
  scenario: SimScenario;
  spread: SimSpread;
  gapS: number;
  running: boolean;
  /** The worst status among its devices: what needs attention shows first. */
  status: SimStatus;
  online: number;
  /** Devices rejected, silent or unable to connect. */
  problems: number;
  /** Identifiers that are not added to the platform. */
  unregistered: number;
  lastSentAt: string | null;
  lastReceivedAt: string | null;
}

export interface SimulationDetail extends SimulationSummary {
  route: { line: LonLat[]; lengthM: number; closed: boolean; marks: { kind: SimActionKind; lon: number; lat: number }[] };
  devices: SimDeviceView[];
  log: SimLogEntry[];
  /** Milliseconds from sending until the platform had it, over the last minutes. */
  latency: { p50: number; p95: number; max: number; samples: number } | null;
}

/** A brand the simulator speaks. */
export interface SimBrand {
  modelId: string;
  brand: string;
  name: string;
  protocol: string;
  port: number;
  idLabel: string;
  idFormat: SimIdFormat;
  capabilities: SimCapability[];
}

export interface SimulatorMeta {
  brands: SimBrand[];
  /** The address real devices are given to reach this platform: what a new simulated device starts with. */
  host: string;
  running: number;
  /** There is a routing service: routes can be traced along streets. */
  routing: boolean;
  /** The address service finds places by their written address. */
  placeSearch: boolean;
}
