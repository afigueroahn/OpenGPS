// What is known about a newer version of the platform, and its install. Only
// its owner asks, when they open the platform: the server looks at GitHub
// once an hour at most.
import type { UpdateStatus } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { getUpdates } from "./api";

export const UPDATES_KEY = ["admin", "updates"] as const;

/** An install asked from the console is under way. */
export const installing = (updates: UpdateStatus | undefined) => {
  const state = updates?.install.last?.state;
  return state === "preparing" || state === "requested" || state === "running";
};

/** With `follow`, while an install is under way it asks every few seconds, also while the platform restarts. */
export function useUpdates(platformAdmin: boolean, { follow = false } = {}) {
  return useQuery({
    queryKey: UPDATES_KEY,
    queryFn: getUpdates,
    enabled: platformAdmin,
    staleTime: 60 * 60_000,
    refetchInterval: (query) => (follow && installing(query.state.data) ? 4000 : false),
    // While it restarts the platform does not answer for a while.
    retry: follow ? 30 : 1,
    retryDelay: 4000,
  });
}

/** The newer version, when there is one. */
export function useNewVersion(platformAdmin: boolean): string | null {
  const updates = useUpdates(platformAdmin).data;
  return updates?.available && updates.latest ? updates.latest.version : null;
}
