// Text for dates, speeds and coordinates, in the language of the interface.
import i18n, { currentLanguage } from "./i18n";

/** The formatters of one language. They are costly to build, so each language builds them once. */
const build = (language: string) => ({
  relative: new Intl.RelativeTimeFormat(language, { numeric: "auto" }),
  dateTime: new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }),
  km: new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  clock: new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  clockSeconds: new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }),
  day: new Intl.DateTimeFormat(language, { weekday: "short", day: "numeric", month: "short" }),
});
const built = new Map<string, ReturnType<typeof build>>();
function formats(): ReturnType<typeof build> {
  const language = currentLanguage();
  let found = built.get(language);
  if (!found) {
    found = build(language);
    built.set(language, found);
  }
  return found;
}

/** "hace 3 minutos", "ahora" ("3 minutes ago", "now"). */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return i18n.t("format.noData");
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 20) return i18n.t("format.now");
  const { relative } = formats();
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86_400), "day");
}

export const formatDateTime = (iso: string | null | undefined) => (iso ? formats().dateTime.format(new Date(iso)) : "—");

export const formatSpeed = (kmh: number | null | undefined) => (kmh === null || kmh === undefined ? "—" : String(Math.round(kmh)));

export const formatCoords = (lat: number | null | undefined, lon: number | null | undefined) =>
  lat === null || lat === undefined || lon === null || lon === undefined ? "—" : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

const COMPASS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export const formatCourse = (course: number | null | undefined) =>
  course === null || course === undefined ? "—" : i18n.t(`format.compass.${COMPASS[Math.round(course / 45) % 8] as (typeof COMPASS)[number]}`);

/** A number as written by hand, with the decimal mark of the language and no grouping: "1,5" ("1.5"). */
export const decimalMark = (n: number | string) => (currentLanguage() === "es" ? String(n).replace(".", ",") : String(n));

/** Minutes remaining until a date, never negative. */
export const minutesUntil = (iso: string | null | undefined, now: number = Date.now()) =>
  iso ? Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000)) : 0;

// ─── History ─────────────────────────────────────────────────────────────────

/** "2 h 05 min", "12 min", "45 s"; from two days on, "5 d 17 h". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  const hours = Math.round(minutes / 60);
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** Kilometers with one decimal: "12,3". */
export const formatKm = (meters: number) => formats().km.format(meters / 1000);

/** "08:05" */
export const formatClock = (ms: number) => formats().clock.format(ms);
/** "08:05:09" */
export const formatClockSeconds = (ms: number) => formats().clockSeconds.format(ms);
/** "sáb, 21 nov" (Sat, 21 Nov) */
export const formatDay = (ms: number) => formats().day.format(ms);
