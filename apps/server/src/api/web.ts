// The web app, served by the backend itself: the web app and the API share one
// port. One address for both is what the session cookie and the API calls of
// the web app expect.
//
// Hashed assets are cached for a year, the entry page is revalidated every
// time, text is compressed, the security headers go out, and any address of
// the app (/routes, /driver…) answers with its entry page.
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};
/** What is worth compressing: text. Images and fonts already are. */
const TEXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".webmanifest", ".txt", ".xml", ".svg"]);

/** Security headers: the map needs inline styles and a worker of its own, and its tiles come from outside. */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(self), camera=(), microphone=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss:; worker-src 'self' blob:; child-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function registerWeb(app: FastifyInstance, dir: string): void {
  const root = resolve(dir);
  const entry = resolve(root, "index.html");
  // Compressed copies, made once: the files do not change while the backend runs.
  const compressed = new Map<string, Buffer>();

  /** The file an address points to inside the web app's folder, or null if there is none. */
  async function fileOf(pathname: string): Promise<string | null> {
    const path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(root + sep)) return null;
    const info = await stat(path).catch(() => null);
    return info?.isFile() ? path : null;
  }

  async function send(request: FastifyRequest, reply: FastifyReply, path: string, cache: string) {
    const ext = extname(path).toLowerCase();
    const body = await readFile(path);
    reply.header("Content-Type", TYPES[ext] ?? "application/octet-stream").header("Cache-Control", cache);
    if (!TEXT.has(ext) || body.length < 1024) return reply.send(body);
    reply.header("Vary", "Accept-Encoding");
    const accepts = String(request.headers["accept-encoding"] ?? "");
    const encoding = /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gzip" : null;
    if (!encoding) return reply.send(body);
    const key = `${encoding}:${path}`;
    let packed = compressed.get(key);
    if (!packed) {
      packed = encoding === "br" ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }) : gzipSync(body, { level: 9 });
      compressed.set(key, packed);
    }
    return reply.header("Content-Encoding", encoding).send(packed);
  }

  // The security headers go with every answer, the API's too.
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(name)) reply.header(name, value);
    return payload;
  });

  app.get("/*", async (request, reply) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://web").pathname);
    } catch {
      return reply.callNotFound();
    }
    // An address of the API that does not exist is answered by the API, not by the web app.
    if (pathname === "/api" || pathname.startsWith("/api/")) return reply.callNotFound();
    const file = await fileOf(pathname);
    if (file) return send(request, reply, file, pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    // A missing asset is missing; any other address is a screen of the app.
    if (pathname.startsWith("/assets/")) return reply.callNotFound();
    return send(request, reply, entry, "no-cache");
  });
}
