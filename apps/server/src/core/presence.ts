// When each person last used the platform and how they last signed in, for
// the platform's console. Kept with the person's settings, one row each.
import { OAUTH_PROVIDERS, type SignInMethod } from "@opengps/shared";
import type { Queryable } from "../db";

/** A person's use of the platform is written down at most this often. */
const TOUCH_EVERY_MS = 5 * 60 * 1000;

/** What the session library says about the request that opened a session. */
interface OpenedBy {
  path?: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}

/** How a session was opened, from the route that opened it; null when the route does not say (changing the password, for example). */
export function signInMethodOf(ctx: OpenedBy | null): SignInMethod | null {
  const path = ctx?.path ?? "";
  if (path === "/sign-in/email" || path === "/sign-up/email" || path === "/verify-email") return "email";
  // Back from another service, or a mobile app that brings the token it got from one.
  const provider = path.startsWith("/callback/") ? (ctx?.params?.id ?? path.slice("/callback/".length)) : path === "/sign-in/social" ? ctx?.body?.provider : undefined;
  return OAUTH_PROVIDERS.find((p) => p === provider) ?? null;
}

/** A session was just opened: the person is here now, and this is how they came in (if the route says it). */
export async function recordSignIn(db: Queryable, userId: string, method: SignInMethod | null): Promise<void> {
  await db.query(
    `INSERT INTO gps.user_settings (user_id, last_seen_at, sign_in_method) VALUES ($1, now(), $2)
     ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now(), sign_in_method = COALESCE($2, gps.user_settings.sign_in_method)`,
    [userId, method],
  );
}

/** Notes that each person is using the platform, without writing on every request. */
export function createPresence(db: Queryable) {
  const written = new Map<string, number>();
  return {
    /** Does not wait: a failure here never stops the request. */
    touch(userId: string): void {
      const now = Date.now();
      if (now - (written.get(userId) ?? 0) < TOUCH_EVERY_MS) return;
      if (written.size > 50_000) written.clear();
      written.set(userId, now);
      db.query(
        `INSERT INTO gps.user_settings (user_id, last_seen_at) VALUES ($1, now())
         ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now()
          WHERE gps.user_settings.last_seen_at IS NULL OR gps.user_settings.last_seen_at < now() - interval '5 minutes'`,
        [userId],
      ).catch((err: Error) => console.error("[session] could not note the last access:", err.message));
    },
  };
}
