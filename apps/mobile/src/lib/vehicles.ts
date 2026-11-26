// The account's vehicles, shared by the map, the list and the sheet. The live
// channel updates this same list; the request repeats in case it misses something.
import { useQuery } from "@tanstack/react-query";
import { getAddress, getGroups, getVehicles } from "./api";
import { useConfig } from "./session";
import { useThrottled } from "./throttled";

export const useVehicles = () => useQuery({ queryKey: ["vehicles"], queryFn: getVehicles, refetchInterval: 60_000 });
/** The account's vehicle groups. The live channel asks for them again when the vehicles change. */
export const useGroups = () => useQuery({ queryKey: ["groups"], queryFn: getGroups, staleTime: 60_000 });

/** While the vehicle moves, its address is asked at most this often. */
const ADDRESS_EVERY_MS = 20_000;

/**
 * Approximate address of where a vehicle is, when the platform looks addresses up.
 * Asked again when it moves to another zone (`at`, about 110 m), and while it moves
 * at most every 20 seconds. Until the new one arrives the previous one of the same
 * vehicle stays, so what is below it does not jump. Same as the web app's.
 */
export function useAddress(id: string | null, at: string | null, moving: boolean) {
  const geocoding = useConfig().data?.geocoding ?? false;
  const zone = useThrottled(at, moving ? ADDRESS_EVERY_MS : 0);
  return useQuery({
    queryKey: ["address", id, zone],
    queryFn: () => getAddress(id as string),
    enabled: geocoding && id !== null && zone !== null,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === id ? previous : undefined),
    retry: false,
  });
}
