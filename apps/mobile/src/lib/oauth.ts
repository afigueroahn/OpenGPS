// Signing in with another service from the app (ADR-0013): what the platform
// says when it sends the person back to the app's address, and how to tell
// the person what happened. Same reasons as the web app's (routes/auth.tsx).
// React Native's URL cannot read an address's parts, so they are read by hand.
import { APP_PASSKEY_RETURN, APP_SCHEME } from "@opengps/shared";

/** What came back to the app: a pass to exchange for the session, or why there is none. */
export type AppReturn = { token: string } | { error: string; description: string | null };

/** The values of a query, decoded: "a=1&b=x%20y" → { a: "1", b: "x y" }. */
export function readQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const [key = "", value = ""] = part.split("=", 2);
    try {
      out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      /* a badly written value is left out */
    }
  }
  return out;
}

/** A query from values, each one encoded. */
export const writeQuery = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

/** Reads the app's address the platform sent the person to; null if it is not one. */
export function readAppReturn(url: string): AppReturn | null {
  const prefix = `${APP_SCHEME}://oauth`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (rest !== "" && !rest.startsWith("?") && !rest.startsWith("/?")) return null;
  const query = readQuery(rest.slice(rest.indexOf("?") + 1));
  if (query.token) return { token: query.token };
  return { error: query.error ?? "failed", description: query.error_description ?? null };
}

/** What the platform's page for creating a passkey says when it sends the person back (ADR-0023); null if it is not that address. */
export function readPasskeyReturn(url: string): { created: true } | { error: string } | null {
  if (!url.startsWith(APP_PASSKEY_RETURN)) return null;
  const rest = url.slice(APP_PASSKEY_RETURN.length);
  if (rest !== "" && !rest.startsWith("?") && !rest.startsWith("/?")) return null;
  const query = readQuery(rest.slice(rest.indexOf("?") + 1));
  return query.created === "1" ? { created: true } : { error: query.error ?? "failed" };
}

/**
 * The text to say about a reason: a catalog key, or the platform's own words, which already come in the app's
 * language (the terms, registration closed).
 */
export function problemOf(error: string, description: string | null): { key: string } | { text: string } {
  if ((error === "LEGAL_NOT_ACCEPTED" || error === "REGISTRATION_CLOSED") && description) return { text: description };
  if (error === "account_not_linked") return { key: "services.notLinked" };
  if (error === "email_not_found") return { key: "services.noEmail" };
  if (error === "access_denied") return { key: "services.cancelled" };
  return { key: "services.failed" };
}
