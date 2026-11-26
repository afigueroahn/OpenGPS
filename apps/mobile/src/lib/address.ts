// The platform's address, as the person types it on the first screen.

/**
 * The base the app talks to, from what the person typed: "demo.com/" → "https://demo.com".
 * Only the scheme and the host are kept: the API is always at <address>/api (ADR-0012).
 * null when it is not an address.
 */
export function normalizeServer(input: string): string | null {
  const typed = input.trim();
  if (typed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  const match = /^(https?):\/\/([^/?#\s@]+)(?:[/?#][^\s]*)?$/i.exec(withScheme);
  if (!match) return null;
  const scheme = (match[1] as string).toLowerCase();
  const host = (match[2] as string).toLowerCase();
  // A name, an IPv4 or a bracketed IPv6, with an optional port.
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/.test(host)) return null;
  return `${scheme}://${host}`;
}

/** Address of the live channel of a platform. */
export const liveUrl = (server: string) => `${server.replace(/^http/, "ws")}/api/live`;

/** The page that shows a shared location, the same as the web app gives (apps/web/src/lib/api.ts). */
export const shareLink = (server: string, token: string) => `${server}/shared#${token}`;
