// History periods: today, yesterday, last days or a manual range.
import { HISTORY_MAX_DAYS } from "@opengps/shared";
import { formatClock, formatDay } from "../../lib/format";
import i18n from "../../lib/i18n";

export type Preset = "today" | "yesterday" | "7d" | "30d" | "custom";

export interface Range {
  preset: Preset;
  from: Date;
  /** Not included. */
  to: Date;
}

const PRESET_IDS = ["today", "yesterday", "7d", "30d", "custom"] as const satisfies readonly Preset[];
/** The shortcuts. Each label is said in the language of the interface when it is read. */
export const PRESETS: { id: Preset; label: string }[] = PRESET_IDS.map((id) => ({
  id,
  get label() {
    return i18n.t(`history.presets.${id}`);
  },
}));

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
function wholeDays(range: Range): number | null {
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

export const reachesFuture = (range: Range, now = Date.now()) => range.to.getTime() > now;

/** "sáb, 21 nov" or "15 nov – 21 nov". */
export function rangeLabel(range: Range): string {
  const days = wholeDays(range);
  if (days === 1) return formatDay(range.from.getTime());
  if (days !== null) return `${formatDay(range.from.getTime())} – ${formatDay(range.to.getTime() - 1)}`;
  const sameDay = startOfDay(range.from).getTime() === startOfDay(new Date(range.to.getTime() - 1)).getTime();
  const end = sameDay ? formatClock(range.to.getTime()) : `${formatDay(range.to.getTime())} ${formatClock(range.to.getTime())}`;
  return `${formatDay(range.from.getTime())} ${formatClock(range.from.getTime())} – ${end}`;
}

/** Value for a browser date and time field: "2026-11-21T08:30". */
export function toInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Why a manually typed range is not valid, or null if it is fine. */
export function rangeProblem(from: Date, to: Date): string | null {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return i18n.t("history.range.needDates");
  if (to.getTime() <= from.getTime()) return i18n.t("history.range.endBeforeStart");
  if (to.getTime() - from.getTime() > HISTORY_MAX_DAYS * DAY) return i18n.t("history.range.tooLong", { days: HISTORY_MAX_DAYS });
  return null;
}
