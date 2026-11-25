// The IP of the device gateway, for the GPS devices that only take a number:
// where the gateway's name points, as the DNS answers it. Nobody has to write
// it down, and it follows the record when that changes.
import { lookup } from "node:dns/promises";
import type { Config } from "../config";

/** How long an answer is good for. */
const FRESH_MS = 5 * 60_000;

/** The IPv4 a name points to. Null: it points nowhere. */
export type HostLookup = (host: string) => Promise<string | null>;

const systemLookup: HostLookup = (host) =>
  lookup(host, { family: 4 }).then(
    (found) => found.address,
    () => null,
  );

export interface GatewayAddress {
  /** Looks the name up now, and leaves the answer in the configuration. */
  refresh(): Promise<void>;
  /** Looks it up again when the last answer is old, without making anybody wait. */
  touch(): void;
}

export function createGatewayAddress(config: Pick<Config, "gatewayHost" | "gatewayIp">, find: HostLookup = systemLookup, now: () => number = Date.now): GatewayAddress {
  let lookedAt: number | null = null;
  let looking: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    looking ??= find(config.gatewayHost)
      .then(
        (ip) => {
          config.gatewayIp = ip;
        },
        () => {
          /* Without an answer, the last one stays. */
        },
      )
      .finally(() => {
        lookedAt = now();
        looking = null;
      });
    return looking;
  };

  return {
    refresh,
    touch() {
      if (lookedAt === null || now() - lookedAt >= FRESH_MS) void refresh();
    },
  };
}
