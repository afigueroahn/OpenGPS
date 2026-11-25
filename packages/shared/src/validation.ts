// What the schemas of several files share: the key of a rule's message and
// a few fields. The package does not export it.
import type { SharedKey, SharedSay } from "./locales";
import { z } from "zod";

/**
 * The message of a validation rule: zod carries a plain text, so the schemas
 * write the key of the shared text ("validation.zone") and whoever shows the
 * issue says it in the reader's language (see `issueSay`).
 */
export const v = <K extends SharedKey>(key: K): K => key;
/** The issue of a rule whose text has variables, or comes from a helper of this package: the key as the message, the variables in `params`. */
export const issueOf = (problem: SharedSay) => ({ code: "custom" as const, message: problem.key, params: problem.params });

export const fleetText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => v || null);
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, v("validation.dateFormat"));
export const moneyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, v("validation.currencyCode"));
