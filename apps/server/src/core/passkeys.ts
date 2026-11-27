// Passkeys (FIDO2/WebAuthn, ADR-0020): where they belong and whether the
// platform has them. The keys themselves, their table and their routes are the
// session library's passkey plugin, under /api/auth/passkey/.
import { isIP } from "node:net";
import { passkey } from "@better-auth/passkey";
import type { Config } from "../config";

/**
 * The relying party of a platform: its own domain (the RP ID) and the origin pages ask from. A passkey belongs to
 * that domain, so it only works there. WebAuthn needs HTTPS and a domain name, or `localhost` for development;
 * null when the address cannot have passkeys, as with plain HTTP or an IP.
 */
export function passkeyParty(publicUrl: string): { rpID: string; origin: string } | null {
  const url = new URL(publicUrl);
  const host = url.hostname;
  if (host === "localhost") return { rpID: host, origin: url.origin };
  if (url.protocol !== "https:" || isIP(host.replace(/^\[|\]$/g, "")) !== 0 || !host.includes(".")) return null;
  return { rpID: host, origin: url.origin };
}

/** Whether people can register passkeys and sign in with them: the address allows it and the console did not turn them off. */
export const passkeysAvailable = (config: Pick<Config, "publicUrl" | "passkeysEnabled">): boolean =>
  config.passkeysEnabled && passkeyParty(config.publicUrl) !== null;

/** The routes of the plugin, which only answer while the platform has passkeys. */
export const isPasskeyRoute = (authPath: string): boolean => authPath.startsWith("/passkey/");

/**
 * The plugin, for the platform's address. A passkey has to be discoverable, so the person signs in without typing
 * their email, and asks for Face ID, a fingerprint or a PIN every time: it replaces the password, not just adds to it.
 */
export function passkeyPlugin(config: Pick<Config, "publicUrl" | "appName">) {
  const party = passkeyParty(config.publicUrl);
  const url = new URL(config.publicUrl);
  return passkey({
    rpID: party?.rpID ?? url.hostname,
    rpName: config.appName,
    origin: party?.origin ?? url.origin,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
}
