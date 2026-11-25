// Signing in with another service: Google, GitHub, Facebook, Apple or any
// other that speaks OpenID Connect. The owner of the platform connects each
// one in the console; this says which are ready, what their buttons are
// called and, for Apple, how to make the secret it asks for.
import { createPrivateKey, sign } from "node:crypto";
import { OAUTH_PROVIDERS, type OAuthProvider, type PublicConfig } from "@opengps/shared";
import type { Config } from "../config";

/** The names of the services, as their own buttons say them. The custom one has the name its owner gave it. */
export const PROVIDER_NAME: Record<Exclude<OAuthProvider, "custom">, string> = { google: "Google", github: "GitHub", facebook: "Facebook", apple: "Apple" };

/** Whether a service is on and has everything it needs to be used. */
export function oauthReady(config: Pick<Config, "oauth">, provider: OAuthProvider): boolean {
  const o = config.oauth;
  if (provider === "apple") return o.apple.enabled && Boolean(o.apple.clientId && o.apple.teamId && o.apple.keyId && o.apple.secret);
  if (provider === "custom") return o.custom.enabled && Boolean(o.custom.name && o.custom.issuer && o.custom.clientId && o.custom.secret);
  return o[provider].enabled && Boolean(o[provider].clientId && o[provider].secret);
}

/** The buttons the sign-in screens show, in their order. */
export const signInButtons = (config: Pick<Config, "oauth">): PublicConfig["signIn"] =>
  OAUTH_PROVIDERS.filter((p) => oauthReady(config, p)).map((id) => ({ id, name: id === "custom" ? config.oauth.custom.name : PROVIDER_NAME[id] }));

/** Where an OpenID Connect issuer describes itself. */
export const discoveryOf = (issuer: string): string => (issuer.endsWith("/.well-known/openid-configuration") ? issuer : `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);

/** Whether a text is a private key Apple's secret can be signed with (the contents of the .p8 file). */
export function isAppleKey(text: string): boolean {
  try {
    return createPrivateKey(text).asymmetricKeyType === "ec";
  } catch {
    return false;
  }
}

/**
 * The secret Apple asks for: a token the team signs with its key, valid for up
 * to six months. It is made again every day, so it never gets that old.
 */
export function appleClientSecret(apple: Config["oauth"]["apple"], now = Date.now()): string {
  const part = (value: string | Buffer) => Buffer.from(value).toString("base64url");
  const iat = Math.floor(now / 1000);
  const head = part(JSON.stringify({ alg: "ES256", kid: apple.keyId }));
  const body = part(JSON.stringify({ iss: apple.teamId, iat, exp: iat + 150 * 86_400, aud: "https://appleid.apple.com", sub: apple.clientId }));
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey(apple.secret), dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${part(signature)}`;
}
