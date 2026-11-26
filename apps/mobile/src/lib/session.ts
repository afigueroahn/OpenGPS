// Session and data shared across the whole app.
import type { Me, Permission, PublicConfig } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiRequestError, getConfig, getMe } from "./api";
import { save, useSaved } from "./storage";

/** User and account of the session; `null` if there is no session. */
export function useMe() {
  const server = useSaved((s) => s.server);
  const cookie = useSaved((s) => s.cookie);
  return useQuery<Me | null>({
    queryKey: ["me"],
    enabled: server !== null && cookie !== "",
    queryFn: async () => {
      try {
        return await getMe();
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) {
          // The session ended on the server: what the app kept is no longer of use.
          save({ cookie: "" });
          return null;
        }
        throw err;
      }
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export function useConfig() {
  const server = useSaved((s) => s.server);
  return useQuery<PublicConfig>({ queryKey: ["config"], queryFn: () => getConfig(), enabled: server !== null, staleTime: Number.POSITIVE_INFINITY });
}

/** Whether the person may do something in the account they are using. */
export function useCan(permission: Permission): boolean {
  return useMe().data?.account.permissions.includes(permission) ?? false;
}

/** Current time that refreshes itself, for text such as "hace 2 min" ("2 min ago"). */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
