// Texts of the app in the person's language: the app's own, plus the shared
// ones under "shared" (the same as the web app's and the platform's).
import { type Language, LANGUAGES, SHARED_TEXT } from "@opengps/shared";
import { getLocales } from "expo-localization";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import es from "../locales/es.json";
import { getSaved } from "./storage";

/**
 * Some languages have a plural form the catalogs do not write: Spanish says
 * "many" for a million or more. It reads like "other", so it is filled in from it.
 */
function withMany<T extends object>(tree: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tree)) {
    out[key] = value !== null && typeof value === "object" ? withMany(value as object) : value;
    const many = key.endsWith("_other") ? `${key.slice(0, -"_other".length)}_many` : null;
    if (many && typeof value === "string" && !(many in tree)) out[many] = value;
  }
  return out as T;
}

export const resources = {
  es: { mobile: withMany({ ...es, shared: SHARED_TEXT.es }) },
  en: { mobile: withMany({ ...en, shared: SHARED_TEXT.en }) },
} satisfies Record<Language, { mobile: object }>;

export const DEFAULT_LANGUAGE: Language = LANGUAGES[0];
const known = (value: string | null | undefined): Language | null => LANGUAGES.find((l) => l === value) ?? null;

/** The language the person chose, if not the device's, if not the default. */
export const deviceLanguage = (): Language => known(getLocales()[0]?.languageCode) ?? DEFAULT_LANGUAGE;
export const preferredLanguage = (): Language => getSaved().language ?? deviceLanguage();

void i18n.use(initReactI18next).init({
  resources,
  lng: preferredLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  defaultNS: "mobile",
  interpolation: { escapeValue: false },
});

export const currentLanguage = (): Language => known(i18n.language) ?? DEFAULT_LANGUAGE;

export default i18n;
