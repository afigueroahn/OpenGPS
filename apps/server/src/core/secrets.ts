// Encryption of the keys entered in the platform's admin console (the
// mail one, the storage one). The key comes from the server's secret: if
// that secret changes, the stored keys can no longer be read and must be
// entered again.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** How the key is derived. The tag goes at the start of every sealed value. */
const CURRENT = { tag: "v2", salt: "opengps", info: "platform settings secrets" };

export interface Vault {
  seal(plain: string): string;
  /** The original text, or null if it cannot be read with the current key. */
  open(sealed: string | null | undefined): string | null;
}

export function createVault(serverSecret: string): Vault {
  const key = Buffer.from(hkdfSync("sha256", serverSecret, CURRENT.salt, CURRENT.info, 32));
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return [CURRENT.tag, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(":");
    },
    open(sealed) {
      if (!sealed) return null;
      const [tag, iv, authTag, body] = sealed.split(":");
      if (tag !== CURRENT.tag || !iv || !authTag || body === undefined) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        decipher.setAuthTag(Buffer.from(authTag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
