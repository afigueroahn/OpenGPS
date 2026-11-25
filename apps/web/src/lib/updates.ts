// What is known about a newer version of the platform. Only its owner asks,
// when they open the platform: the server looks at GitHub once an hour at most.
import { useQuery } from "@tanstack/react-query";
import { getUpdates } from "./api";

export const UPDATES_KEY = ["admin", "updates"] as const;

export function useUpdates(platformAdmin: boolean) {
  return useQuery({ queryKey: UPDATES_KEY, queryFn: getUpdates, enabled: platformAdmin, staleTime: 60 * 60_000 });
}

/** The newer version, when there is one. */
export function useNewVersion(platformAdmin: boolean): string | null {
  const updates = useUpdates(platformAdmin).data;
  return updates?.available && updates.latest ? updates.latest.version : null;
}
