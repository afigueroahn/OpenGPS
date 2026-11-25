// Signing in with another service.
import { v } from "./validation";
import { z } from "zod";

/** Services people can sign in and sign up with, besides email and password. `custom` is any other that speaks OpenID Connect. */
export const OAUTH_PROVIDERS = ["google", "github", "facebook", "apple", "custom"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
/** How someone signs in: with their email and password, or with one of those services. */
export const SIGN_IN_METHODS = ["email", ...OAUTH_PROVIDERS] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];
/** Each one as the owner of the platform connected it. Secrets never come back: only whether one is stored. */
export interface OAuthSettings {
  google: { enabled: boolean; clientId: string; hasSecret: boolean };
  github: { enabled: boolean; clientId: string; hasSecret: boolean };
  facebook: { enabled: boolean; clientId: string; hasSecret: boolean };
  /** Apple signs its secret with a key: the Services ID, the team, the key's id and, as the secret, the key itself (.p8). */
  apple: { enabled: boolean; clientId: string; teamId: string; keyId: string; hasSecret: boolean };
  /** Another service, with the name its button shows and the address of its OpenID Connect issuer. */
  custom: { enabled: boolean; name: string; issuer: string; clientId: string; hasSecret: boolean; scopes: string };
}
export const OAUTH_DEFAULT: OAuthSettings = {
  google: { enabled: false, clientId: "", hasSecret: false },
  github: { enabled: false, clientId: "", hasSecret: false },
  facebook: { enabled: false, clientId: "", hasSecret: false },
  apple: { enabled: false, clientId: "", teamId: "", keyId: "", hasSecret: false },
  custom: { enabled: false, name: "", issuer: "", clientId: "", hasSecret: false, scopes: "openid email profile" },
};
/** A secret that is not sent stays as it is. */
const oauthSecret = z.string().trim().max(5000).optional();
const oauthClient = z.string().trim().max(300);
const oauthPlain = z.object({ enabled: z.boolean(), clientId: oauthClient, secret: oauthSecret });
export const oauthSettingsSchema = z.object({
  google: oauthPlain,
  github: oauthPlain,
  facebook: oauthPlain,
  apple: z.object({ enabled: z.boolean(), clientId: oauthClient, teamId: z.string().trim().max(20), keyId: z.string().trim().max(20), secret: oauthSecret }),
  custom: z.object({
    enabled: z.boolean(),
    name: z.string().trim().max(40),
    issuer: z
      .string()
      .trim()
      .max(500)
      .refine((url) => url === "" || /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(url), v("validation.urlInvalid")),
    clientId: oauthClient,
    secret: oauthSecret,
    scopes: z.string().trim().max(300).default("openid email profile"),
  }),
});
export type OAuthSettingsInput = z.input<typeof oauthSettingsSchema>;
