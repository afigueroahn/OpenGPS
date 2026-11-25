// Weekly schedule of a rule: on which days and hours it applies, in a time zone.

/** Span of a day, in minutes since midnight. If `to` does not exceed `from`, it ends the next day. */
export type DayWindow = [from: number, to: number];

export interface WeekSchedule {
  /** Time zone: "America/Tegucigalpa". */
  zone: string;
  /** One span per day, from Sunday (0) to Saturday (6); null = the rule does not apply that day. */
  days: (DayWindow | null)[];
}

/** The days of the week from Sunday (0) to Saturday (6), as the catalog names them: "weekday.monday". */
export const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Day of the week and minute of the day in the given time zone. */
export function localTime(zone: string, ms: number): { weekday: number; minute: number } {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(zone, format);
  }
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of format.formatToParts(new Date(ms))) {
    if (part.type === "weekday") weekday = WEEKDAY_INDEX[part.value] ?? 0;
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  return { weekday, minute: hour * 60 + minute };
}

/**
 * If the schedule applies at that instant, since when (in milliseconds); if not,
 * null. With no schedule, the rule always applies.
 */
export function activeSince(schedule: WeekSchedule | null, ms: number): number | null {
  if (!schedule) return Number.NEGATIVE_INFINITY;
  const { weekday, minute } = localTime(schedule.zone, ms);
  const today = schedule.days[weekday];
  if (today) {
    const [from, to] = today;
    if (to > from ? minute >= from && minute < to : minute >= from) return ms - (minute - from) * 60_000;
  }
  // A span from yesterday that ends early today.
  const yesterday = schedule.days[(weekday + 6) % 7];
  if (yesterday && yesterday[1] <= yesterday[0] && minute < yesterday[1]) return ms - (minute + 1440 - yesterday[0]) * 60_000;
  return null;
}

export const isActive = (schedule: WeekSchedule | null, ms: number) => activeSince(schedule, ms) !== null;

/** "08:30" */
export const minuteLabel = (minute: number) => `${String(Math.floor((minute % 1440) / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
