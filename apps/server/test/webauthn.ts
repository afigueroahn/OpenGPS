// A passkey for the tests: an authenticator in software, as a phone or a
// security key would answer WebAuthn. The keys and signatures are Node's own
// (ES256 on P-256); only the few CBOR values WebAuthn sends are encoded here.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

type Cbor = number | string | Uint8Array | CborMap | CborObject;
interface CborMap extends Map<Cbor, Cbor> {}
interface CborObject {
  [key: string]: Cbor;
}

/** CBOR (RFC 8949): only unsigned and negative integers, byte and text strings, and maps. */
function cbor(value: Cbor): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

/** Flags of the authenticator data: the person was present and verified (Face ID, a fingerprint, a PIN). */
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface SoftPasskey {
  /** The registration answer for options from `/passkey/generate-register-options`. */
  register(options: { challenge: string; rp: { id?: string } }, origin: string): Record<string, unknown>;
  /** The sign-in answer for options from `/passkey/generate-authenticate-options`. `verified: false` = without Face ID. */
  authenticate(options: { challenge: string; rpId?: string }, origin: string, opts?: { verified?: boolean }): Record<string, unknown>;
}

export function softPasskey(): SoftPasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  // COSE_Key of an EC2 key for ES256: kty 2, alg -7, crv 1 (P-256), x, y.
  const cose = cbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x as string, "base64url")],
      [-3, Buffer.from(jwk.y as string, "base64url")],
    ]),
  );
  const credentialId = randomBytes(16);
  let counter = 0;
  const authData = (rpId: string, flags: number, attested?: Buffer) => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  };
  const clientData = (type: string, challenge: string, origin: string) => JSON.stringify({ type, challenge, origin, crossOrigin: false });

  return {
    register(options, origin) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      // AAGUID all zeros, as an authenticator that does not say its model.
      const attested = Buffer.concat([Buffer.alloc(16), idLength, credentialId, cose]);
      const attestationObject = cbor({ fmt: "none", attStmt: {}, authData: authData(options.rp.id ?? "localhost", UP | UV | AT, attested) });
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        response: { clientDataJSON: b64url(clientData("webauthn.create", options.challenge, origin)), attestationObject: b64url(attestationObject), transports: ["internal"] },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    authenticate(options, origin, opts = {}) {
      const data = authData(options.rpId ?? "localhost", opts.verified === false ? UP : UP | UV);
      const client = clientData("webauthn.get", options.challenge, origin);
      const signature = sign("sha256", Buffer.concat([data, sha256(client)]), privateKey);
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        response: { clientDataJSON: b64url(client), authenticatorData: b64url(data), signature: b64url(signature) },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}
