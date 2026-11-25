// Where a simulated vehicle is at each second of its trip, and what its device
// has to say there. A route and a scenario compile into a plan: stretches of
// driving and of standing still on a trip clock, with what happens along the
// way. Pure: the same second always gives the same answer, so a simulation
// resumes where it was and a past trip can be written at once.
import { type LonLat, type SimAction, type SimAlarm, type SimScenario, bearing, isClosedLine, metersBetween } from "@opengps/shared";

/** A line with the meters and the driving seconds accumulated up to each of its points. */
export interface TimedLine {
  points: LonLat[];
  cumM: number[];
  cumS: number[];
}

/**
 * `secs` are the driving seconds the routing service gave up to each point;
 * without them the vehicle goes at its cruising speed.
 */
export function timedLine(line: LonLat[], secs: number[] | null, cruiseKmh: number): TimedLine {
  const cumM = [0];
  for (let i = 1; i < line.length; i++) cumM.push((cumM[i - 1] as number) + metersBetween(line[i - 1] as LonLat, line[i] as LonLat));
  const speed = cruiseKmh / 3.6;
  const usable = secs !== null && secs.length === line.length && secs.every((s, i) => Number.isFinite(s) && s >= (i === 0 ? 0 : (secs[i - 1] as number)));
  // A stretch the service gave no time for (two points at the same second) is driven at cruising speed.
  const cumS = [0];
  for (let i = 1; i < line.length; i++) {
    const meters = (cumM[i] as number) - (cumM[i - 1] as number);
    const given = usable ? (secs[i] as number) - (secs[i - 1] as number) : 0;
    cumS.push((cumS[i - 1] as number) + (given > 0 ? given : meters / speed));
  }
  return { points: line, cumM, cumS };
}

const lastOf = <T>(list: T[]): T => list[list.length - 1] as T;

function reversed(line: TimedLine): TimedLine {
  const last = line.points.length - 1;
  const totalM = line.cumM[last] as number;
  const totalS = line.cumS[last] as number;
  return {
    points: [...line.points].reverse(),
    cumM: line.cumM.map((_, i) => totalM - (line.cumM[last - i] as number)),
    cumS: line.cumS.map((_, i) => totalS - (line.cumS[last - i] as number)),
  };
}

/** The point of a line at that many meters from its start, and the driving seconds up to it. */
function pointAt(line: TimedLine, meters: number): { point: LonLat; seconds: number; index: number } {
  const last = line.points.length - 1;
  if (meters <= 0) return { point: line.points[0] as LonLat, seconds: 0, index: 0 };
  if (meters >= (line.cumM[last] as number)) return { point: line.points[last] as LonLat, seconds: line.cumS[last] as number, index: last - 1 };
  let low = 0;
  let high = last - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((line.cumM[mid] as number) <= meters) low = mid;
    else high = mid - 1;
  }
  const a = line.points[low] as LonLat;
  const b = line.points[low + 1] as LonLat;
  const m0 = line.cumM[low] as number;
  const m1 = line.cumM[low + 1] as number;
  const part = m1 > m0 ? (meters - m0) / (m1 - m0) : 0;
  const s0 = line.cumS[low] as number;
  return { point: [a[0] + (b[0] - a[0]) * part, a[1] + (b[1] - a[1]) * part], seconds: s0 + ((line.cumS[low + 1] as number) - s0) * part, index: low };
}

/** The piece of a line between two distances from its start, with its meters and seconds counted from zero. At `kmh`, if given, instead of its own pace. */
function slice(line: TimedLine, fromM: number, toM: number, kmh: number | null): TimedLine {
  const from = pointAt(line, fromM);
  const to = pointAt(line, toM);
  const points: LonLat[] = [from.point];
  const cumM = [0];
  const cumS = [0];
  const push = (point: LonLat, meters: number, seconds: number) => {
    // A point on top of the previous one adds nothing.
    if (meters - lastOf(cumM) < 1e-6) return;
    points.push(point);
    cumM.push(meters);
    cumS.push(seconds);
  };
  for (let i = from.index + 1; i <= to.index; i++) push(line.points[i] as LonLat, (line.cumM[i] as number) - fromM, (line.cumS[i] as number) - from.seconds);
  push(to.point, toM - fromM, to.seconds - from.seconds);
  if (points.length === 1) {
    // Nothing between the two: a line of no length, at that place.
    points.push(from.point);
    cumM.push(0);
    cumS.push(0);
  }
  return kmh === null ? { points, cumM, cumS } : { points, cumM, cumS: cumM.map((m) => m / (kmh / 3.6)) };
}

export type Leg =
  /** Driving a whole line, from its first point to its last. With the engine off, it is being towed. */
  | { kind: "drive"; t0: number; t1: number; line: TimedLine; m0: number; ignition: boolean }
  /** Standing still: idling with the engine on, or parked with it off. */
  | { kind: "hold"; t0: number; t1: number; at: LonLat; course: number; ignition: boolean; m0: number; /** The device cut the engine start by itself. */ locked: boolean };

/** The tank level changing over a while standing still: a fill or a siphoning. */
interface FuelChange {
  t0: number;
  t1: number;
  /** Points of the level, up or down. */
  pct: number;
}

export interface Plan {
  legs: Leg[];
  /** Seconds a lap takes, with its pauses. */
  lapS: number;
  /** Meters driven in a lap. */
  lapM: number;
  /** After a lap it starts another; otherwise the vehicle stays parked where the route ends. */
  repeats: boolean;
  /** Alarms the device sends, at the second of the lap it passes their place. */
  alarms: { t: number; alarm: SimAlarm }[];
  /** Whiles without signal: the device stores what it would send. */
  silences: { t0: number; t1: number }[];
  /** Who is at the wheel from each second of the lap on; "" = nobody. */
  drivers: { t: number; key: string }[];
  /** The fault codes the engine reports from each second of the lap on. */
  faults: { t: number; codes: string[] }[];
  /** The tank: its level when the lap starts, what it burns, and its fills and siphonings. Null = the device says nothing about fuel. */
  fuel: { startPct: number; burnPerM: number; changes: FuelChange[] } | null;
}

export interface SimState {
  lon: number;
  lat: number;
  /** Heading in degrees, 0 = north. */
  course: number;
  speedKmh: number;
  ignition: boolean;
  /** Meters driven since the trip began. */
  meters: number;
  /** The device cut the engine start by itself. */
  locked: boolean;
  /** Without signal: what the device would send now, it stores. */
  silent: boolean;
  /** Tank level, 0 to 100; null if the device says nothing about fuel. */
  fuelPct: number | null;
  /** The driver key the device reads; "" = nobody. */
  driverKey: string;
  /** Fault codes the engine reports. */
  dtc: string[];
}

const HOLDS = new Set<SimAction["kind"]>(["stop", "refuel", "drain", "engineLock"]);

export function compile(scenario: SimScenario, route: { line: LonLat[]; secs: number[] | null }): Plan {
  const forward = timedLine(route.line, scenario.roadSpeeds ? route.secs : null, scenario.cruiseKmh);
  const lengthM = lastOf(forward.cumM);
  // Going around only makes sense on a circuit: on an open route the vehicle would jump from the end to the start.
  const end = scenario.end === "loop" && !isClosedLine(route.line) ? "return" : scenario.end;

  const legs: Leg[] = [];
  const alarms: Plan["alarms"] = [];
  const silences: Plan["silences"] = [];
  const drivers: Plan["drivers"] = [{ t: 0, key: scenario.driverKey }];
  const faults: Plan["faults"] = [{ t: 0, codes: [] }];
  const changes: FuelChange[] = [];
  let t = 0;
  let m = 0;

  const drive = (line: TimedLine, ignition = true) => {
    const seconds = lastOf(line.cumS);
    if (seconds <= 0) return;
    legs.push({ kind: "drive", t0: t, t1: t + seconds, line, m0: m, ignition });
    t += seconds;
    m += lastOf(line.cumM);
  };
  const hold = (at: LonLat, course: number, seconds: number, ignition: boolean, locked = false) => {
    if (seconds <= 0) return;
    legs.push({ kind: "hold", t0: t, t1: t + seconds, at, course, ignition, m0: m, locked });
    t += seconds;
  };
  const courseAt = (line: TimedLine, meters: number): number => {
    const { index } = pointAt(line, meters);
    return bearing(line.points[index] as LonLat, line.points[Math.min(index + 1, line.points.length - 1)] as LonLat);
  };
  const pause = (line: TimedLine) => {
    const at = lastOf(line.points);
    const course = line.points.length >= 2 ? bearing(line.points[line.points.length - 2] as LonLat, at) : 0;
    hold(at, course, scenario.idleS, true);
    hold(at, course, scenario.restS, false);
  };

  // ── The way out, with what happens along it ──
  // Each action sits at a place; a stretch (speeding, towing) also ends at one.
  const within = (meters: number) => Math.min(Math.max(0, meters), lengthM);
  const actions = scenario.actions.map((action, order) => ({ action, order, at: within(action.atM), to: "lengthM" in action ? within(action.atM + action.lengthM) : null }));
  const cuts = [...new Set([0, lengthM, ...actions.flatMap((a) => (a.to === null ? [a.at] : [a.at, a.to]))])].sort((a, b) => a - b);
  /** The stretch of that kind a piece of road falls in, if any: the last one written wins. */
  const stretchOver = <K extends "speeding" | "towing">(kind: K, fromM: number, toM: number) =>
    actions.findLast((a): a is typeof a & { action: Extract<SimAction, { kind: K }> } => a.action.kind === kind && a.to !== null && a.at <= fromM && a.to >= toM && a.to > a.at)?.action;

  cuts.forEach((cut, i) => {
    // What happens on arriving here: first what the device says in passing, then the stops, in the order they were written.
    const here = actions.filter((a) => a.at === cut).sort((a, b) => Number(HOLDS.has(a.action.kind)) - Number(HOLDS.has(b.action.kind)) || a.order - b.order);
    for (const { action } of here) {
      const at = pointAt(forward, cut).point;
      const course = courseAt(forward, cut);
      if (action.kind === "alarm") alarms.push({ t, alarm: action.alarm });
      else if (action.kind === "signalLoss") silences.push({ t0: t, t1: t + action.seconds });
      else if (action.kind === "driverKey") drivers.push({ t, key: action.key });
      else if (action.kind === "dtc") faults.push({ t, codes: action.codes });
      else if (action.kind === "stop") hold(at, course, action.seconds, action.engineOn);
      else if (action.kind === "engineLock") hold(at, course, action.seconds, false, true);
      else if (action.kind === "refuel" || action.kind === "drain") {
        changes.push({ t0: t, t1: t + action.seconds, pct: action.kind === "refuel" ? action.pct : -action.pct });
        hold(at, course, action.seconds, false);
      }
    }
    const next = cuts[i + 1];
    if (next === undefined) return;
    const speeding = stretchOver("speeding", cut, next);
    drive(slice(forward, cut, next, speeding ? speeding.kmh : null), !stretchOver("towing", cut, next));
  });
  pause(forward);

  if (end === "return") {
    const back = reversed(forward);
    drive(back);
    pause(back);
  }

  let fuel: Plan["fuel"] = null;
  if (scenario.fuel) {
    const burnPerM = scenario.fuel.burnPer100Km / 100_000;
    // Each lap starts with the tank where the scenario says: what was burned and moved along the way comes back
    // while it is parked at the end, as if it filled up at its base.
    const drift = changes.reduce((sum, c) => sum + c.pct, 0) - burnPerM * m;
    const rest = legs.findLast((leg) => leg.kind === "hold" && !leg.ignition);
    if (end !== "stay" && Math.abs(drift) > 1e-9) changes.push(rest && rest.t1 === t ? { t0: rest.t0, t1: rest.t1, pct: -drift } : { t0: t, t1: t, pct: -drift });
    fuel = { startPct: scenario.fuel.startPct, burnPerM, changes };
  }
  const byTime = <T extends { t: number }>(list: T[]) => list.sort((a, b) => a.t - b.t);
  return { legs, lapS: t, lapM: m, repeats: end !== "stay", alarms: byTime(alarms), silences, drivers: byTime(drivers), faults: byTime(faults), fuel };
}

/** The segment of a line being driven at `seconds` of driving: its index, by bisection. */
function segmentAt(line: TimedLine, seconds: number): number {
  let low = 0;
  let high = line.cumS.length - 2;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((line.cumS[mid] as number) <= seconds) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** What the device has to say besides where it is, at that second of the lap after that many meters of it. */
function extras(plan: Plan, inLap: number, lapMeters: number): Pick<SimState, "silent" | "fuelPct" | "driverKey" | "dtc"> {
  let fuelPct: number | null = null;
  if (plan.fuel) {
    let level = plan.fuel.startPct - plan.fuel.burnPerM * lapMeters;
    for (const change of plan.fuel.changes) {
      if (inLap >= change.t1) level += change.pct;
      else if (inLap > change.t0) level += (change.pct * (inLap - change.t0)) / (change.t1 - change.t0);
    }
    fuelPct = Math.min(100, Math.max(0, level));
  }
  return {
    silent: plan.silences.some((s) => inLap >= s.t0 && inLap < s.t1),
    fuelPct,
    driverKey: plan.drivers.findLast((d) => d.t <= inLap)?.key ?? "",
    dtc: plan.faults.findLast((f) => f.t <= inLap)?.codes ?? [],
  };
}

/** Where the vehicle is at that second of its trip. Past seconds (negative) are valid in a plan that repeats. */
export function stateAt(plan: Plan, tripS: number): SimState {
  const lap = plan.repeats ? Math.floor(tripS / plan.lapS) : 0;
  const inLap = plan.repeats ? tripS - lap * plan.lapS : Math.max(0, tripS);
  const done = !plan.repeats && inLap >= plan.lapS;
  const leg = done ? lastOf(plan.legs) : (plan.legs.find((l) => inLap < l.t1) ?? lastOf(plan.legs));
  const base = lap * plan.lapM;
  const at = Math.min(inLap, plan.lapS);
  if (leg.kind === "hold") {
    return { lon: leg.at[0], lat: leg.at[1], course: leg.course, speedKmh: 0, ignition: done ? false : leg.ignition, meters: base + leg.m0, locked: !done && leg.locked, ...extras(plan, at, leg.m0) };
  }

  const { line } = leg;
  if (done) {
    // The route ended on the road, with no pause after it: parked at its last point.
    const end = lastOf(line.points);
    const course = line.points.length >= 2 ? bearing(line.points[line.points.length - 2] as LonLat, end) : 0;
    const meters = leg.m0 + lastOf(line.cumM);
    return { lon: end[0], lat: end[1], course, speedKmh: 0, ignition: false, meters: base + meters, locked: false, ...extras(plan, at, meters) };
  }
  const seconds = Math.min(Math.max(0, inLap - leg.t0), lastOf(line.cumS));
  const i = segmentAt(line, seconds);
  const a = line.points[i] as LonLat;
  const b = line.points[i + 1] as LonLat;
  const s0 = line.cumS[i] as number;
  const s1 = line.cumS[i + 1] as number;
  const m0 = line.cumM[i] as number;
  const m1 = line.cumM[i + 1] as number;
  const part = s1 > s0 ? (seconds - s0) / (s1 - s0) : 0;
  const meters = leg.m0 + m0 + (m1 - m0) * part;
  return {
    lon: a[0] + (b[0] - a[0]) * part,
    lat: a[1] + (b[1] - a[1]) * part,
    course: bearing(a, b),
    speedKmh: s1 > s0 ? ((m1 - m0) / (s1 - s0)) * 3.6 : 0,
    ignition: leg.ignition,
    meters: base + meters,
    locked: false,
    ...extras(plan, at, meters),
  };
}

/**
 * The alarms whose moment falls after `fromS` and up to `toS` on the trip
 * clock: each one is sent once every lap, with the first report after the
 * vehicle passes its place.
 */
export function alarmsBetween(plan: Plan, fromS: number, toS: number): SimAlarm[] {
  if (plan.alarms.length === 0 || toS <= fromS) return [];
  if (!plan.repeats) return plan.alarms.filter((a) => a.t > fromS && a.t <= toS).map((a) => a.alarm);
  const found: SimAlarm[] = [];
  // A report can be late by more than a lap only if the device was held for long: a few laps are enough.
  const firstLap = Math.floor(fromS / plan.lapS);
  const lastLap = Math.min(Math.floor(toS / plan.lapS), firstLap + 3);
  for (let lap = firstLap; lap <= lastLap; lap++) {
    for (const a of plan.alarms) {
      const at = lap * plan.lapS + a.t;
      if (at > fromS && at <= toS) found.push(a.alarm);
    }
  }
  return found;
}

/** The place of a route at that many meters from its start; past its end, its end. */
export function placeOn(line: LonLat[], meters: number): { lon: number; lat: number } {
  const [lon, lat] = pointAt(timedLine(line, null, 36), meters).point;
  return { lon, lat };
}
