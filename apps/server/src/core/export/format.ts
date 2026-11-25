// Common texts for exported files: times in the exporting person's time zone,
// durations and distances.
import type { Language } from "@opengps/shared";
import { badRequest } from "../../errors";
import { say, tr } from "../../i18n";
import type exportTexts from "../../locales/es/exports";

const MONTHS: Record<Language, string[]> = {
  es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};
/** A number written with a point, with the decimal mark of the language: "12,3" in Spanish, "12.3" in English. */
export const decimalMark = (language: Language, value: string | number) => (language === "es" ? String(value).replace(".", ",") : String(value));
const pad = (n: number) => String(n).padStart(2, "0");

export interface Clock {
  zone: string;
  /** The language its dates in words are written in. */
  language: Language;
  /** "2026-11-21" */
  date(ms: number): string;
  /** "14:05:09" */
  time(ms: number): string;
  /** "2026-11-21 14:05:09" */
  dateTime(ms: number): string;
  /** "21 nov 2026, 14:05" */
  human(ms: number): string;
  /** "14:05" */
  hour(ms: number): string;
  /** Date-time serial number for spreadsheets. */
  serial(ms: number): number;
  /** "UTC-06:00" */
  offset(ms: number): string;
  /** "21 nov, 14:05" */
  short(ms: number): string;
  /** Milliseconds to add to the UTC time to get the local time. */
  offsetMs(ms: number): number;
  /** Instant at which the zone shows that date and that minute of the day. `month` runs from 1 to 12; a day outside the month rolls into the next. */
  at(year: number, month: number, day: number, minute?: number): number;
  /** Local date of an instant, in numbers, and its day of the week (0 = Sunday). */
  parts(ms: number): { year: number; month: number; day: number; weekday: number; minute: number };
}

/**
 * Clock for a time zone ("America/Tegucigalpa"), which writes its dates in the
 * reader's language. Rejects zones that do not exist.
 */
export function createClock(zone: string, language: Language): Clock {
  const months = MONTHS[language];
  let parts: Intl.DateTimeFormat;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw badRequest(say("shared.validation.zone"));
  }
  // The offset only changes at daylight-saving changes, which fall on quarter
  // hours: it is calculated once per quarter hour, not for every position.
  const QUARTER = 900_000;
  const offsets = new Map<number, number>();
  function offsetMs(ms: number): number {
    const bucket = Math.floor(ms / QUARTER);
    let value = offsets.get(bucket);
    if (value === undefined) {
      const p: Record<string, number> = {};
      for (const part of parts.formatToParts(new Date(bucket * QUARTER))) p[part.type] = Number(part.value);
      value = Date.UTC(p.year as number, (p.month as number) - 1, p.day as number, p.hour as number, p.minute as number, p.second as number) - bucket * QUARTER;
      offsets.set(bucket, value);
    }
    return value;
  }
  // The local time, stored as if it were UTC to read its parts.
  const local = (ms: number) => new Date(ms + offsetMs(ms));
  const date = (ms: number) => {
    const d = local(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const hour = (ms: number) => {
    const d = local(ms);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const time = (ms: number) => `${hour(ms)}:${pad(local(ms).getUTCSeconds())}`;
  return {
    zone,
    language,
    date,
    hour,
    time,
    dateTime: (ms) => `${date(ms)} ${time(ms)}`,
    human(ms) {
      const d = local(ms);
      return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hour(ms)}`;
    },
    serial: (ms) => (ms + offsetMs(ms)) / 86_400_000 + 25_569,
    short(ms) {
      const d = local(ms);
      return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${hour(ms)}`;
    },
    offsetMs,
    at(year, month, day, minute = 0) {
      const wall = Date.UTC(year, month - 1, day, 0, minute);
      // The offset is checked at the instant itself; two passes are enough even if it falls on a time change.
      const guess = wall - offsetMs(wall);
      return wall - offsetMs(guess);
    },
    parts(ms) {
      const d = local(ms);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
    },
    offset(ms) {
      const minutes = Math.round(offsetMs(ms) / 60_000);
      const abs = Math.abs(minutes);
      return `UTC${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    },
  };
}

/** A clock that only reads and writes dates and times in numbers: none of it depends on a language. */
export type NumberClock = Omit<Clock, "language" | "human" | "short">;
/**
 * Clock for a time zone when nothing it gives is written in words: the day of an
 * instant, the instant of a day. The language it is made with is never read.
 */
export const numberClock = (zone: string): NumberClock => createClock(zone, "es");

/** "21 nov 2026" ("21 Nov 2026") from "2026-11-21". */
export function dateLabel(date: string, language: Language): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[language][(month ?? 1) - 1]} ${year}`;
}

/** Period in words: one day, several whole days, or from one time to another. The end is not part of the period. */
export function periodLabel(clock: Clock, from: number, to: number): string {
  const whole = clock.time(from) === "00:00:00" && clock.time(to) === "00:00:00";
  if (!whole) return `${clock.human(from)} — ${clock.human(to)}`;
  const first = clock.date(from);
  const last = clock.date(to - 1);
  return first === last ? dateLabel(first, clock.language) : `${dateLabel(first, clock.language)} — ${dateLabel(last, clock.language)}`;
}

/** "2 h 05 min", "12 min", "45 s"; from two days on, "5 d 17 h". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
  const hours = Math.round(minutes / 60);
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** A label of the exported files: a sheet name, a column header or a total. */
export type ExportLabel = keyof typeof exportTexts.labels;
/** That label in a language. */
export const exportLabel = (language: Language, key: ExportLabel) => tr(language, `exports.labels.${key}`);

/** "12,3 km" in Spanish, "12.3 km" in English. */
export const km = (meters: number, decimals: number, language: Language) => `${decimalMark(language, (meters / 1000).toFixed(decimals))} km`;

export const coords = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/** Text safe inside XML. Also removes the control characters that XML does not allow. */
export const xml = (text: string) =>
  text
    // oxlint-disable-next-line no-control-regex -- removed on purpose
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** File name without accents or odd symbols; one with no letters left is named "vehicle" in the reader's language. */
export const slug = (text: string, language: Language) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || tr(language, "exports.files.vehicle");
