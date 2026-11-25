// Schedules written as a five-field cron expression: minute, hour, day of the
// month, month and day of the week. Times are UTC. Used by the scheduling of
// backups, on the server and in the admin console.
//
// Each field accepts a number, a list (1,15), a range (1-5), a step (*/6,
// 0-23/2) or an asterisk, which stands for all. In the day of the week, 0 and 7
// are Sunday. If both the day of the month and the day of the week are set, it is enough
// for either one to match, as in cron.
import type { SharedSay } from "./locales";

export interface Cron {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  /** The day of the month or the day of the week was left as an asterisk. */
  anyDay: boolean;
  anyWeekday: boolean;
}

/** The five fields, in order. `key` is the field's name in the catalog: "cron.unreadable.minute". */
const FIELDS = [
  { key: "minute", min: 0, max: 59 },
  { key: "hour", min: 0, max: 23 },
  { key: "day", min: 1, max: 31 },
  { key: "month", min: 1, max: 12 },
  { key: "weekday", min: 0, max: 7 },
] as const;

/** Values of a field, or the reason it is not understood, as a text to say. */
function parseField(text: string, field: (typeof FIELDS)[number]): number[] | SharedSay {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d{1,2})(?:-(\d{1,2}))?(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return { key: `cron.unreadable.${field.key}`, params: { part } };
    const [, first, last, stepText] = match as unknown as [string, string, string | undefined, string | undefined];
    if (first === "*" && last !== undefined) return { key: `cron.unreadable.${field.key}`, params: { part } };
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return { key: `cron.step.${field.key}` };
    const from = first === "*" ? field.min : Number(first);
    // A number with a step ("5/15") runs from that number to the end.
    const to = first === "*" ? field.max : last !== undefined ? Number(last) : stepText !== undefined ? field.max : from;
    if (from < field.min || to > field.max || from > to) return { key: `cron.range.${field.key}`, params: { min: field.min, max: field.max } };
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return [...values].sort((a, b) => a - b);
}

/** The expression already parsed, or what is wrong with it, as a text to say. `isCron` tells them apart. */
export function parseCron(expression: string): Cron | SharedSay {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return { key: "cron.fields" };
  const parsed: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const values = parseField(parts[i] as string, FIELDS[i] as (typeof FIELDS)[number]);
    if (!Array.isArray(values)) return values;
    parsed.push(values);
  }
  const [minutes, hours, days, months, rawWeekdays] = parsed as [number[], number[], number[], number[], number[]];
  const weekdays = [...new Set(rawWeekdays.map((d) => d % 7))].sort((a, b) => a - b);
  return { minutes, hours, days, months, weekdays, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

/** Whether what `parseCron` answered is the schedule, and not what is wrong with the expression. */
export const isCron = (parsed: Cron | SharedSay): parsed is Cron => "minutes" in parsed;

const MINUTE = 60_000;
/** Five years of minutes ahead is more than enough to find the next time, or to know there is none. */
const SEARCH_LIMIT_MS = 5 * 366 * 86_400_000;

/** First time after `after` that it is due; null if that schedule never comes. All in UTC and milliseconds. */
export function cronNext(cron: Cron, after: number): number | null {
  const limit = after + SEARCH_LIMIT_MS;
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  while (t <= limit) {
    const d = new Date(t);
    if (!cron.months.includes(d.getUTCMonth() + 1)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    const byDay = cron.days.includes(d.getUTCDate());
    const byWeekday = cron.weekdays.includes(d.getUTCDay());
    const dayMatches = cron.anyDay && cron.anyWeekday ? true : cron.anyDay ? byWeekday : cron.anyWeekday ? byDay : byDay || byWeekday;
    if (!dayMatches) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!cron.hours.includes(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!cron.minutes.includes(d.getUTCMinutes())) {
      t += MINUTE;
      continue;
    }
    return t;
  }
  return null;
}

/** The next `count` times it is due. */
export function cronUpcoming(cron: Cron, after: number, count: number): number[] {
  const out: number[] = [];
  let t: number | null = after;
  while (out.length < count) {
    t = cronNext(cron, t);
    if (t === null) break;
    out.push(t);
  }
  return out;
}

/**
 * Why a schedule is not valid, as a text to say, or null if it is. `minGapMinutes`
 * is the most frequent allowed: a backup every minute makes no sense and
 * would not let the server work.
 */
export function cronProblem(expression: string, minGapMinutes = 0): SharedSay | null {
  const cron = parseCron(expression);
  if (!isCron(cron)) return cron;
  // From a fixed point, so the answer does not depend on the moment it is asked.
  const times = cronUpcoming(cron, Date.UTC(2024, 0, 1), 60);
  if (times.length === 0) return { key: "cron.never" };
  for (let i = 1; i < times.length; i++) {
    if ((times[i] as number) - (times[i - 1] as number) < minGapMinutes * MINUTE) {
      return minGapMinutes >= 60 ? { key: "cron.tooOftenHours", params: { n: minGapMinutes / 60 } } : { key: "cron.tooOftenMinutes", params: { n: minGapMinutes } };
    }
  }
  return null;
}
