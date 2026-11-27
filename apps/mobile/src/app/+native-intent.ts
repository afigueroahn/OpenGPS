// Addresses the system opens the app with. On Android the way back from the sign-in window (opengps://oauth,
// opengps://passkey) also reaches the router, which has no screen for it: the window already gave it to the screen
// that opened it, so the router stays where it is. On iPhone the window keeps those addresses to itself.
import { isWindowReturn } from "../lib/oauth";

export function redirectSystemPath(event: { path: string; initial: boolean }): string | null {
  if (!isWindowReturn(event.path)) return event.path;
  // If the app was closed meanwhile, nobody waits for that return any more: it opens as usual.
  return event.initial ? "/" : null;
}
