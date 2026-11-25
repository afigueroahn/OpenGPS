// What the backend says, in the language of whoever reads it: an error of a
// request, an email, a notification, a report. Its own texts live in
// src/locales; the labels it shares with the web, in the shared package.
import { LANGUAGES, type Language, SHARED_TEXT, type SharedKey, type SharedSay, type TextKey, type TextParams, type TextTree, lookupText, translate } from "@opengps/shared";
import { en } from "./locales/en";
import { es } from "./locales/es";

const TREES: Record<Language, TextTree> = {
  es: { ...es, shared: SHARED_TEXT.es },
  en: { ...en, shared: SHARED_TEXT.en },
};

/** A path to a text: one of the backend's ("fleet.errors.notFound") or a shared one ("shared.channel.email"). */
export type ServerKey = TextKey<typeof es> | `shared.${SharedKey}`;

/** The text of a key in a language. */
export const tr = (language: Language, key: ServerKey, params?: TextParams): string => translate(TREES[language], key, params);

/** A text to be said later, in the language of whoever ends up reading it. */
export interface Say {
  key: ServerKey;
  params?: TextParams;
}
export const say = (key: ServerKey, params?: TextParams): Say => (params ? { key, params } : { key });
/** A text the shared package says (a validation problem, a label), as the backend says it. */
export const shared = (text: SharedSay): Say => say(`shared.${text.key}`, text.params);
/** Says it. A text that was already written in a language goes out as it is. */
export const render = (language: Language, text: Say | string): string => (typeof text === "string" ? text : tr(language, text.key, text.params));
/** Whether a text is the key of one of the backend's texts, as a schema of its own writes its message (a counted one goes by its base name). */
export const isServerKey = (text: string): text is ServerKey => (lookupText(TREES.es, text) ?? lookupText(TREES.es, `${text}_other`)) !== undefined;

export const knownLanguage = (value: unknown): Language | null => LANGUAGES.find((l) => l === value) ?? null;

/** The first language of an Accept-Language header that the platform speaks, or null. */
export function headerLanguage(header: unknown): Language | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(",")) {
    const found = knownLanguage(part.split(";")[0]?.trim().slice(0, 2).toLowerCase());
    if (found) return found;
  }
  return null;
}
