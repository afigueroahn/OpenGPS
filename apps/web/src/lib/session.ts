// Session and data shared across the whole web app.
import type { Me, PublicConfig } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiRequestError, getConfig, getMe } from "./api";

/** User and account of the session; `null` if there is no session. */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await getMe();
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export function useConfig() {
  return useQuery<PublicConfig>({ queryKey: ["config"], queryFn: getConfig, staleTime: Number.POSITIVE_INFINITY });
}

/** Current time that refreshes itself, for text such as "hace 2 minutos" ("2 minutes ago"). */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
