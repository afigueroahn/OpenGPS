// Outbound requests: to addresses each account writes and to the services the
// channels go through. The platform must not serve as a bridge into its own
// network: internal addresses are not called (the server itself, the database,
// the local network), not even when a public name resolves to one of them.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { type Say, render, say } from "../i18n";

/** Whether an IP address is internal: of the machine itself, a private or reserved network. */
export function isInternalAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const text = ip.toLowerCase();
  // An IPv4 written as IPv6.
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isInternalAddress(mapped[1] as string);
  return text === "::" || text === "::1" || text.startsWith("fc") || text.startsWith("fd") || text.startsWith("fe8") || text.startsWith("fe9") || text.startsWith("fea") || text.startsWith("feb") || text.startsWith("ff") || text.startsWith("::ffff:");
}

export interface OutboundOptions {
  /** Allows internal addresses. Only for tests, which call a server on the machine itself. */
  allowInternal: boolean;
  timeoutMs?: number;
}

/**
 * Why a request could not go out. It ends up in a delivery log that a person reads: `text` is said
 * in the reader's language; `message`, like that of an `AppError`, is in the reference language.
 */
export class OutboundError extends Error {
  constructor(readonly text: Say | string) {
    super(render("es", text));
  }
}

export interface OutboundResponse {
  code: number;
  /** The start of what the other side answered: enough to read its error. */
  body: string;
}
/** How much of a response is read. */
const RESPONSE_BYTES = 4096;

/** Sends a JSON body by POST and returns the response code. */
export const postJson = (target: string, body: string, headers: Record<string, string>, opts: OutboundOptions): Promise<number> =>
  post(target, body, { ...headers, "Content-Type": "application/json" }, opts).then((r) => r.code);

/**
 * Sends a body by POST (or the method given; GET carries none) and returns the
 * response code and its first bytes. It does not follow redirects. Throws
 * `OutboundError`, with a text for the log, if the address is not valid, does
 * not respond in time or the connection fails.
 */
export function post(target: string, body: string, headers: Record<string, string>, opts: OutboundOptions, method: "POST" | "GET" | "PUT" = "POST"): Promise<OutboundResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return reject(new OutboundError(say("core.outbound.invalidAddress")));
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return reject(new OutboundError(say("core.outbound.httpsOnly")));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!opts.allowInternal && (host === "localhost" || (net.isIP(host) !== 0 && isInternalAddress(host)))) return reject(new OutboundError(say("core.outbound.internal")));
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method,
        timeout: opts.timeoutMs ?? 10_000,
        headers: method === "GET" ? headers : { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
        // Each address the name resolves to is checked, and the connection uses exactly that one.
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err) return callback(err, "", 4);
            const list = Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: 4 }];
            const allowed = opts.allowInternal ? list : list.filter((a) => !isInternalAddress(a.address));
            if (allowed.length === 0) return callback(new OutboundError(say("core.outbound.internal")), "", 4);
            // Depending on how the caller asks: a list or a single address.
            if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof allowed) => void)(null, allowed);
            const first = allowed[0] as { address: string; family: number };
            callback(null, first.address, first.family);
          });
        },
      },
      (response) => {
        // Only the start of the response is kept; the rest is discarded without storing it.
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size < RESPONSE_BYTES) chunks.push(chunk.subarray(0, RESPONSE_BYTES - size));
          size += chunk.length;
        });
        const done = () => resolve({ code: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        response.on("end", done);
        response.on("error", done);
      },
    );
    request.on("timeout", () => request.destroy(new OutboundError(say("core.outbound.timeout"))));
    request.on("error", (err) => reject(err instanceof OutboundError ? err : new OutboundError(connectionProblem(err))));
    request.end(method === "GET" ? undefined : body);
  });
}

/** Why the connection failed: in words when it is a known case, as the system said it otherwise. */
function connectionProblem(err: Error): Say | string {
  const code = (err as NodeJS.ErrnoException).code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return say("core.outbound.notFound");
  if (code === "ECONNREFUSED") return say("core.outbound.refused");
  if (code === "ECONNRESET" || code === "EPIPE") return say("core.outbound.reset");
  if (code.startsWith("CERT_") || code.includes("CERT") || code === "DEPTH_ZERO_SELF_SIGNED_CERT") return say("core.outbound.certificate");
  return err.message.slice(0, 200) || say("core.outbound.failed");
}
