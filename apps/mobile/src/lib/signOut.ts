// Ending the session: the platform is told, and the app forgets the cookie and
// everything it had loaded, even if the platform does not answer.
import type { QueryClient } from "@tanstack/react-query";
import { clearAlerts } from "./alerts";
import { auth } from "./api";
import { select } from "./selection";
import { save } from "./storage";

export async function signOut(queryClient: QueryClient, opts: { forgetServer?: boolean } = {}): Promise<void> {
  try {
    await auth.signOut();
  } catch {
    /* without an answer, the session is forgotten here anyway */
  }
  select(null);
  clearAlerts();
  save(opts.forgetServer ? { cookie: "", server: null } : { cookie: "" });
  queryClient.clear();
}
