// The shared package's texts by language: labels of types and states,
// validation messages and whatever both the backend and the web say.
import { type SameShape, type TextKey, type TextParams, lookupText, translate } from "../text";
import { en } from "./en";
import { es } from "./es";

export type SharedText = SameShape<typeof es>;
/** A path to one of the shared texts, such as "channel.email". */
export type SharedKey = TextKey<typeof es>;
/** Says a shared text in some language. */
export type Translate = (key: SharedKey, params?: TextParams) => string;

export const SHARED_TEXT: { es: SharedText; en: SharedText } = { es, en };

/** The shared texts in one language. */
export const sharedText =
  (language: keyof typeof SHARED_TEXT): Translate =>
  (key, params) =>
    translate(SHARED_TEXT[language], key, params);

/**
 * What to say, without saying it yet: the key of a shared text and its
 * variables. The helpers of this package answer with one, and whoever shows it
 * says it in the reader's language.
 */
export interface SharedSay {
  key: SharedKey;
  params?: TextParams;
}

/** Whether a text is the key of a shared text (a counted one goes by its base name). */
export const isSharedKey = (text: string): text is SharedKey => (lookupText(es, text) ?? lookupText(es, `${text}_other`)) !== undefined;

/**
 * What a validation issue of a shared schema says. Zod carries a plain message:
 * the schemas write there the key of the text, and its variables go in the
 * issue's `params`. Null when the message is not a key, as with the messages
 * zod writes on its own.
 */
export function issueSay(issue: { message: string; params?: Record<string, unknown> | undefined }): SharedSay | null {
  if (!isSharedKey(issue.message)) return null;
  const params: TextParams = {};
  for (const [name, value] of Object.entries(issue.params ?? {})) if (typeof value === "string" || typeof value === "number") params[name] = value;
  return Object.keys(params).length > 0 ? { key: issue.message, params } : { key: issue.message };
}
