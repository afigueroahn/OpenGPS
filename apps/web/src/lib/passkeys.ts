// Passkeys in the web app (ADR-0020): the browser's own WebAuthn, through
// SimpleWebAuthn, with the platform's routes under /api/auth/passkey/. The
// browser or the system shows Face ID, Touch ID, Windows Hello, the fingerprint,
// a security key or the QR code to use another phone.
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";
import { api, ApiRequestError, authMessage } from "./api";
import i18n from "./i18n";

/** A passkey of the person, as the platform lists it. Only its public key is kept there. */
export interface Passkey {
  id: string;
  name?: string | null;
  createdAt: string;
  /** "multiDevice" when it can be synced (iCloud Keychain, Google Password Manager). */
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
}

/** Whether this browser can use passkeys at all. */
export const passkeysInBrowser = (): boolean => browserSupportsWebAuthn();

export const listPasskeys = () => api<Passkey[]>("/api/auth/passkey/list-user-passkeys");
export const renamePasskey = (id: string, name: string) => api("/api/auth/passkey/update-passkey", { method: "POST", body: { id, name } });
export const deletePasskey = (id: string) => api("/api/auth/passkey/delete-passkey", { method: "POST", body: { id } });

/** Creates a passkey for the person signed in: the browser asks for Face ID or whatever the device has. */
export async function createPasskey(name: string): Promise<void> {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>("/api/auth/passkey/generate-register-options");
  const response = await startRegistration({ optionsJSON });
  await api("/api/auth/passkey/verify-registration", { method: "POST", body: { response, ...(name.trim() ? { name: name.trim() } : {}) } });
}

/**
 * Signs in with a passkey, without an email. `autofill`: waits for the person to choose one in the browser's
 * suggestions on the email field, and does nothing if the browser has no such suggestions.
 */
export async function signInWithPasskey(opts: { autofill?: boolean } = {}): Promise<boolean> {
  if (opts.autofill && !(await browserSupportsWebAuthnAutofill())) return false;
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>("/api/auth/passkey/generate-authenticate-options");
  const response = await startAuthentication({ optionsJSON, useBrowserAutofill: opts.autofill ?? false });
  await api("/api/auth/passkey/verify-authentication", { method: "POST", body: { response } });
  return true;
}

/**
 * What to tell the person when a passkey does not work; null when there is nothing to say, as when another passkey
 * request replaced this one.
 */
export function passkeyMessage(err: unknown): string | null {
  if (err instanceof WebAuthnError) {
    if (err.code === "ERROR_CEREMONY_ABORTED") return null;
    if (err.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return i18n.t("passkeys.errors.already");
    // The person closed the browser's window, or it took too long.
    if ((err.cause as Error | undefined)?.name === "NotAllowedError") return i18n.t("passkeys.errors.cancelled");
    return i18n.t("passkeys.errors.device");
  }
  if (err instanceof ApiRequestError) {
    if (err.code === "SESSION_NOT_FRESH") return i18n.t("passkeys.errors.notFresh");
    if (err.code === "PASSKEY_NOT_FOUND") return i18n.t("passkeys.errors.unknown");
    if (err.code === "AUTHENTICATION_FAILED") return i18n.t("passkeys.errors.failed");
    if (err.code === "passkeys_off") return err.message;
  }
  return authMessage(err);
}
