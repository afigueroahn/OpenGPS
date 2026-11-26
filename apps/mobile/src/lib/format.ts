// Text for times, speeds and coordinates, in the language of the app.
// Hermes has no Intl.RelativeTimeFormat: "hace 3 min" is written by hand.
import i18n, { currentLanguage } from "./i18n";

/** "hace 3 min", "ahora" ("3 min ago", "now"). */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return i18n.t("format.noData");
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 20) return i18n.t("format.now");
  if (seconds < 60) return i18n.t("format.seconds", { n: seconds });
  if (seconds < 3600) return i18n.t("format.minutes", { n: Math.round(seconds / 60) });
  if (seconds < 86_400) return i18n.t("format.hours", { n: Math.round(seconds / 3600) });
  return i18n.t("format.days", { count: Math.round(seconds / 86_400) });
}

export const formatSpeed = (kmh: number | null | undefined) =>
  kmh === null || kmh === undefined ? "—" : i18n.t("format.kmh", { n: Math.round(kmh) });

export const formatCoords = (lat: number | null | undefined, lon: number | null | undefined) =>
  lat === null || lat === undefined || lon === null || lon === undefined ? "—" : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

const COMPASS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export const formatCourse = (course: number | null | undefined) =>
  course === null || course === undefined ? "—" : i18n.t(`format.compass.${COMPASS[Math.round(course / 45) % 8] as (typeof COMPASS)[number]}`);

/** "2 h 05 min", "12 min", "45 s"; from two days on, "5 d 17 h". Same as the web app's. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  const hours = Math.round(minutes / 60);
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** The formatters of one language. They are costly to build, so each language builds them once. */
const build = (language: string) => ({
  dateTime: new Intl.DateTimeFormat(language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  km: new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  clock: new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  clockSeconds: new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }),
  day: new Intl.DateTimeFormat(language, { weekday: "short", day: "numeric", month: "short" }),
  count: new Intl.NumberFormat(language),
  /** With 0, 1 and 2 decimals: the engine's readings. */
  fixed: [0, 1, 2].map((d) => new Intl.NumberFormat(language, { minimumFractionDigits: d, maximumFractionDigits: d })),
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

/** "26 nov, 14:05" in the language of the app. */
export const formatDateTime = (iso: string | null | undefined) => (iso ? formats().dateTime.format(new Date(iso)) : "—");
/** Kilometers with one decimal: "12,3". */
export const formatKm = (meters: number) => formats().km.format(meters / 1000);
/** "08:05" */
export const formatClock = (ms: number) => formats().clock.format(ms);
/** "08:05:09" */
export const formatClockSeconds = (ms: number) => formats().clockSeconds.format(ms);
/** "sáb, 21 nov" (Sat, 21 Nov) */
export const formatDay = (ms: number) => formats().day.format(ms);
/** "1.234" with the grouping of the language. */
export const formatCount = (n: number) => formats().count.format(n);
/** A value with that many decimals (0 to 2) and the language's marks: "123.456" or "13,9". */
export const formatNumber = (n: number, decimals: number) => (formats().fixed[Math.max(0, Math.min(2, decimals))] as Intl.NumberFormat).format(n);

/** A number as written by hand, with the decimal mark of the language: "12,6" ("12.6"). */
export const decimalMark = (n: number | string) => (currentLanguage() === "es" ? String(n).replace(".", ",") : String(n));
