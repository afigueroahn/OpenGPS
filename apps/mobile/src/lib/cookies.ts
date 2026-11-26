// The session cookie, kept by the app itself: the platform signs people in with a
// cookie, and the app sends it on every request instead of leaving it to the
// system, so it lives in the Keychain and goes only to the platform that gave it.

/** The session library names its cookies with the platform's prefix; on https they also carry __Secure-. */
const SESSION_PREFIX = "gps.";
const isSessionCookie = (name: string) => name.replace(/^__(Secure|Host)-/, "").startsWith(SESSION_PREFIX);

interface SetCookie {
  name: string;
  value: string;
  /** The server asks to forget it: empty, Max-Age 0 or an expiry already past. */
  removed: boolean;
}

/**
 * The cookies in a Set-Cookie header. React Native joins several headers with ", ", and a date in
 * Expires also has a comma: a new cookie starts only where a comma is followed by "name=".
 */
export function parseSetCookie(header: string, now: number = Date.now()): SetCookie[] {
  return header
    .split(/,\s*(?=[^;,=\s]+=)/)
    .map((part) => {
      const [pair = "", ...attributes] = part.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) return null;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let removed = value === "";
      for (const attribute of attributes) {
        const [key = "", ...rest] = attribute.split("=");
        const v = rest.join("=").trim();
        const k = key.trim().toLowerCase();
        if (k === "max-age" && Number(v) <= 0) removed = true;
        if (k === "expires" && Date.parse(v) <= now) removed = true;
      }
      return { name, value, removed };
    })
    .filter((c): c is SetCookie => c !== null);
}

/** The Cookie header to send from now on: what was being sent, with what the server set or removed. */
export function mergeCookies(current: string, setCookie: string, now: number = Date.now()): string {
  const jar = new Map<string, string>();
  for (const pair of current.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  for (const cookie of parseSetCookie(setCookie, now)) {
    if (!isSessionCookie(cookie.name)) continue;
    if (cookie.removed) jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
