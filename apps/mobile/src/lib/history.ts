// Trip history: the period asked for, where the vehicle was at each instant
// and how fast the player goes. Same rules as the web app's
// (apps/web/src/app/history/range.ts, geo.ts and Player.tsx).
import { HISTORY_MAX_DAYS, type HistoryPoint, metersBetween } from "@opengps/shared";

// ─── Period ──────────────────────────────────────────────────────────────────

export type Preset = "today" | "yesterday" | "7d" | "30d" | "custom";
export const PRESETS: readonly Preset[] = ["today", "yesterday", "7d", "30d", "custom"];

export interface Range {
  preset: Preset;
  from: Date;
  /** Not included. */
  to: Date;
}

const DAY = 86_400_000;

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function presetRange(preset: Exclude<Preset, "custom">, now = new Date()): Range {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  if (preset === "today") return { preset, from: today, to: tomorrow };
  if (preset === "yesterday") return { preset, from: addDays(today, -1), to: today };
  return { preset, from: addDays(today, preset === "7d" ? -6 : -29), to: tomorrow };
}

/** Full days it spans, or null if it does not start and end at midnight. */
export function wholeDays(range: Pick<Range, "from" | "to">): number | null {
  const midnight = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  if (!midnight(range.from) || !midnight(range.to)) return null;
  return Math.round((range.to.getTime() - range.from.getTime()) / DAY);
}

/** The same period, shifted backward or forward. */
export function shiftRange(range: Range, direction: -1 | 1): Range {
  const days = wholeDays(range);
  if (days !== null) return { preset: "custom", from: addDays(range.from, days * direction), to: addDays(range.to, days * direction) };
  const span = range.to.getTime() - range.from.getTime();
  return { preset: "custom", from: new Date(range.from.getTime() + span * direction), to: new Date(range.to.getTime() + span * direction) };
}

/** The shortcut a period is, if it is one: shifting back from today lands on yesterday. */
export function matchPreset(range: Range, now = new Date()): Range {
  for (const preset of ["today", "yesterday", "7d", "30d"] as const) {
    const p = presetRange(preset, now);
    if (p.from.getTime() === range.from.getTime() && p.to.getTime() === range.to.getTime()) return p;
  }
  return { ...range, preset: "custom" };
}

export const reachesFuture = (range: Pick<Range, "to">, now = Date.now()) => range.to.getTime() > now;

/** A period of whole days, from the first to the last day, both included. */
export function daysRange(first: Date, last: Date): Range {
  return { preset: "custom", from: startOfDay(first), to: addDays(startOfDay(last), 1) };
}

/** Why a period is not valid, or null if it is fine. */
export function rangeProblem(range: Pick<Range, "from" | "to">): "endBeforeStart" | "tooLong" | null {
  if (range.to.getTime() <= range.from.getTime()) return "endBeforeStart";
  if (range.to.getTime() - range.from.getTime() > HISTORY_MAX_DAYS * DAY) return "tooLong";
  return null;
}

// ─── Where it was ────────────────────────────────────────────────────────────

/** With no reports for longer than this, it is not known where the vehicle went. */
export const GAP_S = 600;

/** Index of the last point whose time does not exceed `t`. */
export function indexAt(points: HistoryPoint[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((points[mid] as HistoryPoint).t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Moment {
  lat: number;
  lon: number;
  speed: number;
  course: number | null;
  ignition: boolean | null;
}

/** Where the vehicle was at instant `t` (seconds), between two points if needed. */
export function momentAt(points: HistoryPoint[], t: number): Moment | null {
  if (points.length === 0) return null;
  const i = indexAt(points, t);
  const a = points[i] as HistoryPoint;
  const b = points[i + 1];
  const here = { lat: a.lat, lon: a.lon, speed: a.s, course: a.c, ignition: a.i };
  // In a gap without data the path is not invented: it waits at the last known point.
  if (!b || t <= a.t || b.t - a.t > GAP_S) return here;
  const k = (t - a.t) / (b.t - a.t);
  return {
    lat: a.lat + (b.lat - a.lat) * k,
    lon: a.lon + (b.lon - a.lon) * k,
    speed: a.s + (b.s - a.s) * k,
    course: b.c ?? a.c,
    ignition: a.i,
  };
}

/** Points between two times (seconds), both included. */
export const between = (points: HistoryPoint[], from: number, to: number) => points.filter((p) => p.t >= from && p.t <= to);

/** The segment between two points is a wait: no progress, or no data. */
export function isWait(a: HistoryPoint, b: HistoryPoint): boolean {
  const seconds = b.t - a.t;
  if (seconds > GAP_S) return true;
  return seconds >= 60 && metersBetween([a.lon, a.lat], [b.lon, b.lat]) < 30;
}

/** The trip as lines, cut where data is missing so two places are not joined by a straight line. */
export function routeLines(points: HistoryPoint[]): [number, number][][] {
  const lines: [number, number][][] = [];
  let current: [number, number][] = [];
  points.forEach((p, i) => {
    const prev = points[i - 1];
    if (prev && p.t - prev.t > GAP_S && metersBetween([prev.lon, prev.lat], [p.lon, p.lat]) > 300) {
      if (current.length > 1) lines.push(current);
      current = [];
    }
    current.push([p.lon, p.lat]);
  });
  if (current.length > 1) lines.push(current);
  return lines;
}

// ─── Player ──────────────────────────────────────────────────────────────────

/** Times faster than real life the player can go. */
export const RATES = [10, 30, 60, 120, 300, 600] as const;
/** Seconds a whole trip should take to play, to choose the starting rate. */
const TARGET_SECONDS = 40;

/** The rate that plays the moving part of the trip in about forty seconds. */
export function pickRate(points: HistoryPoint[]): number {
  let moving = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as HistoryPoint;
    const b = points[i + 1] as HistoryPoint;
    if (!isWait(a, b)) moving += b.t - a.t;
  }
  const ideal = moving / TARGET_SECONDS;
  return RATES.reduce<number>((best, r) => (Math.abs(r - ideal) < Math.abs(best - ideal) ? r : best), RATES[0]);
}

/** The next instant to show: `elapsed` real seconds later at `rate`, skipping stops and stretches without data. */
export function advance(points: HistoryPoint[], time: number, elapsed: number, rate: number): number {
  const end = points[points.length - 1]?.t ?? time;
  let next = time + elapsed * rate;
  // Nobody wants to watch a still point.
  for (let guard = 0; guard < 200 && next < end; guard++) {
    const i = indexAt(points, next);
    const a = points[i] as HistoryPoint;
    const b = points[i + 1];
    if (!b || !isWait(a, b)) break;
    next = b.t;
  }
  return Math.min(next, end);
}
