// Languages the platform is available in.

/** Languages the platform is available in. The first one is the default. */
export const LANGUAGES = ["es", "en"] as const;
export type Language = (typeof LANGUAGES)[number];
/** Each language, written in that language. */
export const LANGUAGE_NAME: Record<Language, string> = { es: "Español", en: "English" };
