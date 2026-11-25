// Languages of the interface. Texts live in src/locales/<language>/, one file
// per area of the app (its name is the first part of the key: "fleet.title"
// is in fleet.json), plus web.json for what is common. The texts the web shares
// with the backend come from the shared package, under "shared". Components
// ask for them with `useTranslation()`.
//
// Until every screen is translated, the interface stays in the default
// language: a platform half in one language and half in another helps nobody.
// A language saved in this browser (localStorage "language") still applies, so
// what is already translated can be checked.
import { LANGUAGES, type Language, SHARED_TEXT, type SharedSay } from "@opengps/shared";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enMap from "../locales/en/map.json";
import enGeofences from "../locales/en/geofences.json";
import enAlerts from "../locales/en/alerts.json";
import enHistory from "../locales/en/history.json";
import enSecurity from "../locales/en/security.json";
import enDrivers from "../locales/en/drivers.json";
import enFuel from "../locales/en/fuel.json";
import enDiag from "../locales/en/diag.json";
import enFleet from "../locales/en/fleet.json";
import enMaintenance from "../locales/en/maintenance.json";
import enReports from "../locales/en/reports.json";
import enRoutes from "../locales/en/routes.json";
import enIntegrations from "../locales/en/integrations.json";
import enPages from "../locales/en/pages.json";
import enActivity from "../locales/en/activity.json";
import enSimulator from "../locales/en/simulator.json";
import esMap from "../locales/es/map.json";
import esGeofences from "../locales/es/geofences.json";
import esAlerts from "../locales/es/alerts.json";
import esHistory from "../locales/es/history.json";
import esSecurity from "../locales/es/security.json";
import esDrivers from "../locales/es/drivers.json";
import esFuel from "../locales/es/fuel.json";
import esDiag from "../locales/es/diag.json";
import esFleet from "../locales/es/fleet.json";
import esMaintenance from "../locales/es/maintenance.json";
import esReports from "../locales/es/reports.json";
import esRoutes from "../locales/es/routes.json";
import esIntegrations from "../locales/es/integrations.json";
import esPages from "../locales/es/pages.json";
import esActivity from "../locales/es/activity.json";
import esSimulator from "../locales/es/simulator.json";
import enWeb from "../locales/en/web.json";
import esWeb from "../locales/es/web.json";

const es = { ...esWeb, shared: SHARED_TEXT.es, map: esMap, geofences: esGeofences, alerts: esAlerts, history: esHistory, security: esSecurity, drivers: esDrivers, fuel: esFuel, diag: esDiag, fleet: esFleet, maintenance: esMaintenance, reports: esReports, routes: esRoutes, integrations: esIntegrations, pages: esPages, activity: esActivity, simulator: esSimulator };
const en = { ...enWeb, shared: SHARED_TEXT.en, map: enMap, geofences: enGeofences, alerts: enAlerts, history: enHistory, security: enSecurity, drivers: enDrivers, fuel: enFuel, diag: enDiag, fleet: enFleet, maintenance: enMaintenance, reports: enReports, routes: enRoutes, integrations: enIntegrations, pages: enPages, activity: enActivity, simulator: enSimulator };

/**
 * Some languages have a plural form the catalogs do not write: Spanish says
 * "many" for a million or more. It reads like "other", so it is filled in
 * from it; without it the screen would show the key.
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

/** Texts by language. The first language is the reference: the others must have its same keys (a test compares them). */
export const resources = {
  es: { web: withMany(es) },
  en: { web: withMany(en) },
} satisfies Record<Language, { web: object }>;

export const DEFAULT_LANGUAGE: Language = LANGUAGES[0];
/** Whether people may choose their language. */
export const LANGUAGE_CHOICE_OPEN = true;

const KEY = "language";
const known = (value: string | null | undefined): Language | null => LANGUAGES.find((l) => l === value) ?? null;

function storedLanguage(): Language | null {
  try {
    return known(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** The language to start with: this browser's, the device's once the choice is open, or the default. */
function initialLanguage(): Language {
  const stored = storedLanguage();
  if (stored) return stored;
  if (!LANGUAGE_CHOICE_OPEN) return DEFAULT_LANGUAGE;
  return known(navigator.language.slice(0, 2)) ?? DEFAULT_LANGUAGE;
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  defaultNS: "web",
  // React already escapes what it renders.
  interpolation: { escapeValue: false },
});
document.documentElement.lang = i18n.language;
i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
});

/** The language in use. */
export const currentLanguage = (): Language => known(i18n.language) ?? DEFAULT_LANGUAGE;

/** Changes the language of the interface and remembers it in this browser. */
export function setLanguage(language: Language): void {
  try {
    localStorage.setItem(KEY, language);
  } catch {
    // Without storage the choice lasts until the page is closed.
  }
  void i18n.changeLanguage(language);
}

/**
 * Takes the language saved in the person's settings when this browser has
 * none of its own. The page loads again in it, so every date and number
 * follows. Returns whether it is about to reload.
 */
export function adoptLanguage(saved: Language | null): boolean {
  if (!saved || storedLanguage() !== null || saved === currentLanguage()) return false;
  setLanguage(saved);
  window.location.reload();
  return true;
}

/** Says a text of the shared package (a validation problem, a label) in the language of the interface. */
export const sayShared = (text: SharedSay): string => i18n.t(`shared.${text.key}`, text.params ?? {});

export default i18n;
