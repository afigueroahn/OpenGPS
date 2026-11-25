// Confirmation words.
import { LANGUAGES, type Language } from "./languages";
import { SHARED_TEXT } from "./locales";
import { es } from "./locales/es";

// What is dangerous is confirmed by typing a word. The screen asks for the word
// of the reader's language, and the backend accepts the word of any language.

/** What is confirmed by typing a word: locking or unlocking a vehicle remotely, restoring a backup, deleting an account. */
export type ConfirmAction = keyof typeof es.confirmWord;
/** The word to type, in a language. */
export const confirmWord = (action: ConfirmAction, language: Language): string => SHARED_TEXT[language].confirmWord[action];
/** The words that confirm an action: one per language. */
export const confirmWords = (action: ConfirmAction): string[] => LANGUAGES.map((language) => confirmWord(action, language));
/** Whether what the person typed is the word of the action in some language. Capitals and the spaces around do not matter. */
export const isConfirmWord = (action: ConfirmAction, typed: string): boolean => confirmWords(action).some((word) => word.toUpperCase() === typed.trim().toUpperCase());
