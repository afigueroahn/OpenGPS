// How dates, amounts and labels are written and read in the fleet section.
import { SHARED_TEXT, isSharedKey, parseAmount } from "@opengps/shared";
import i18n, { currentLanguage, sayShared } from "../../lib/i18n";

/** "22 nov 2026" from "2026-11-22", without the time zone shifting it by a day. */
export const dayLabel = (date: string) => new Intl.DateTimeFormat(currentLanguage(), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date.slice(0, 10)}T00:00:00Z`));

export const money = (amount: number, currency: string) => `${new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" }).format(amount)} ${currency}`;

export const whole = (n: number) => new Intl.NumberFormat(currentLanguage(), { useGrouping: "always" }).format(Math.round(n));

/** The name of a currency in the language of the interface, or its code when it is not one of those offered. */
export function currencyName(code: string): string {
  const key = `currency.${code}`;
  return isSharedKey(key) ? sayShared({ key }) : code;
}

/**
 * Kinds of vehicle offered in the fleet profile. The profile stores the
 * Spanish text itself, so that text is the value and what is shown follows the
 * language of the interface.
 */
const KINDS = SHARED_TEXT.es.fleetKind;
export const FLEET_KIND_VALUES: readonly string[] = Object.values(KINDS);
/** What a stored kind of vehicle is called in the language of the interface; one typed by hand stays as it is. */
export function kindLabel(stored: string): string {
  const kind = (Object.keys(KINDS) as (keyof typeof KINDS)[]).find((k) => KINDS[k] === stored);
  return kind ? i18n.t(`shared.fleetKind.${kind}`) : stored;
}

/** Today's date in this browser: "2026-11-22". */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Days remaining until a date; negative if it has already passed. */
export const daysUntil = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);

/**
 * An amount or kilometers typed by hand: "450,000", "450.000", "2.750,50"
 * or "2750.5". Empty is null; what is not a number, NaN.
 */
export function amountOf(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  // A single dot followed by three digits separates thousands, not decimals.
  if (/^\d{1,3}\.\d{3}$/.test(t)) return Number(t.replace(".", ""));
  return parseAmount(t) ?? Number.NaN;
}
