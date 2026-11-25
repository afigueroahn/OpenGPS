// What a fault code (DTC) means. The catalog has the most common generic
// ones, which mean the same in any make; for the rest, the system they belong
// to is given by the shape of the code. Those starting with P1, high P3, C1,
// B1 or U1 are defined by each manufacturer: their exact meaning is in the
// vehicle manual. The descriptions are in the catalogs (`diagnostics.dtc`).
import type { Language } from "@opengps/shared";
import { tr } from "../../i18n";
import es from "../../locales/es/diagnostics";

type DtcCode = keyof typeof es.dtc;
const isKnown = (code: string): code is DtcCode => Object.hasOwn(es.dtc, code);

/** The systems a code can belong to, by its first letter. */
const SYSTEMS = ["P", "C", "B", "U"] as const;
type SystemLetter = (typeof SYSTEMS)[number];
const isSystem = (letter: string): letter is SystemLetter => (SYSTEMS as readonly string[]).includes(letter);

/** What engine and transmission codes refer to, by their third character. */
const P_FAMILIES: Record<string, keyof typeof es.dtcFamily> = {
  "0": "fuelAir",
  "1": "fuelAir",
  "2": "injection",
  "3": "ignition",
  "4": "emissions",
  "5": "speedIdle",
  "6": "computer",
  "7": "transmission",
  "8": "transmission",
  "9": "transmission",
  A: "hybrid",
  B: "hybrid",
  C: "hybrid",
};

export interface DtcInfo {
  description: string;
  /** With its own description, and not just that of its family. */
  specific: boolean;
  system: string;
}

/** What a fault code means, or at least which system it belongs to, in a language. */
export function describeDtc(code: string, language: Language): DtcInfo {
  const letter = code.charAt(0).toUpperCase();
  const system = isSystem(letter) ? tr(language, `shared.dtcSystem.${letter}`) : tr(language, "diagnostics.dtcSystemOther");
  const upper = code.toUpperCase();
  if (isKnown(upper)) return { description: tr(language, `diagnostics.dtc.${upper}`), specific: true, system };
  // The second character says who defines the code: 0 is standard; 1, the manufacturer; 2 and 3 depend on the letter.
  const second = code.charAt(1);
  const maker = second === "1" || (second === "3" && letter !== "P" && letter !== "U") || (second === "2" && letter !== "P");
  if (maker) return { description: tr(language, "diagnostics.dtcGeneric.maker", { system: system.toLowerCase() }), specific: false, system };
  if (letter === "P") {
    const family = P_FAMILIES[code.charAt(2).toUpperCase()];
    return { description: tr(language, `diagnostics.dtcFamily.${family ?? "other"}`), specific: false, system };
  }
  return { description: tr(language, "diagnostics.dtcGeneric.system", { system: system.toLowerCase() }), specific: false, system };
}

export const DTC_CATALOG_SIZE = Object.keys(es.dtc).length;
