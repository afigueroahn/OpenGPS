// Client for the external, S3-compatible storage: upload, download, delete,
// list and test the connection. The work is done by rclone, the program used by
// other backup tools: this way its providers and its
// arguments, which are written in the platform's admin console, apply here.
//
// The keys reach it through environment variables and never on the command
// line, which is visible in the server's process list.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { storageFlagArgs } from "@opengps/shared";
import type { S3Target } from "../config";
import { type Say, render, say } from "../i18n";

/**
 * A problem of the storage, as the administration screens show it: `text` is said in the reader's
 * language; `message`, like that of an `AppError`, is in the reference language.
 */
export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly text: Say,
  ) {
    super(render("es", text));
    this.name = "S3Error";
  }
}

/** Name rclone gives the destination. Its settings go in RCLONE_CONFIG_GPS_… variables */
const REMOTE = "gps";
const QUICK_TIMEOUT_MS = 2 * 60_000;
const TRANSFER_TIMEOUT_MS = 6 * 3_600_000;
/** For what must answer quickly, such as the connection test: without the patience rclone ships with. They go before the console's arguments, which take precedence. */
const QUICK = ["--retries=1", "--low-level-retries=3", "--contimeout=20s"];
const BLOCKED = say("core.storage.blocked");
const NOT_S3 = say("core.storage.notS3");
const NO_ANSWER = say("core.storage.noAnswer");
const NO_ETAG = say("core.storage.noEtag");

const rclone = () => process.env.RCLONE_BIN || "rclone";

/** Full name of an object: the platform's folder plus its name. */
export const keyOf = (target: Pick<S3Target, "prefix">, name: string) => (target.prefix ? `${target.prefix}/${name}` : name);

/** Plain-words explanation of the service's most common errors. */
const KNOWN: Record<string, Say> = {
  SignatureDoesNotMatch: say("core.storage.badSignature"),
  InvalidAccessKeyId: say("core.storage.unknownKey"),
  AccessDenied: say("core.storage.denied"),
  NoSuchBucket: say("core.storage.noBucket"),
  AuthorizationHeaderMalformed: say("core.storage.badRegion"),
  PermanentRedirect: say("core.storage.moved"),
  NoSuchKey: say("core.storage.noFile"),
  RequestTimeTooSkewed: say("core.storage.clock"),
};

/** What rclone needs to know about the destination. It inherits nothing else from this process beyond the essentials. */
function envOf(target: S3Target | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { RCLONE_CONFIG: "/dev/null" };
  for (const name of ["PATH", "HOME", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (!target) return env;
  const set = (option: string, value: string) => {
    env[`RCLONE_CONFIG_${REMOTE.toUpperCase()}_${option}`] = value;
  };
  set("TYPE", "s3");
  set("PROVIDER", target.provider || "Other");
  set("ACCESS_KEY_ID", target.accessKeyId);
  set("SECRET_ACCESS_KEY", target.secretAccessKey);
  if (target.endpoint) set("ENDPOINT", target.endpoint);
  if (target.region) set("REGION", target.region);
  // The bucket must already exist: no attempt is made to create it, which fails with a minimally permissioned key.
  set("NO_CHECK_BUCKET", "true");
  // Accept-Encoding is left out of the signature: some services and intermediaries change it along the way, and signed it breaks the request.
  set("SIGN_ACCEPT_ENCODING", "false");
  return env;
}

/** Where an object, or a folder, ends up, as rclone writes it. */
const remotePath = (target: S3Target, key: string) => `${REMOTE}:${[target.bucket, key.replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/")}`;

interface Result {
  code: number;
  stdout: Buffer;
  stderr: string;
}

const missing = (err: NodeJS.ErrnoException) =>
  err.code === "ENOENT"
    ? new S3Error(0, "no_rclone", say("core.storage.noRclone"))
    : new S3Error(0, "rclone", say("core.storage.rcloneFailed", { reason: err.message }));

/** Runs rclone and waits for it to finish. The console's arguments go last: if they repeat one of its own, they take precedence. */
function run(target: S3Target | null, args: string[], opts: { input?: Buffer; timeoutMs?: number } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(rclone(), [...args, ...storageFlagArgs(target?.flags ?? [])], { env: envOf(target), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? QUICK_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-64_000);
    });
    child.stdin.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(missing(err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (late) reject(new S3Error(0, "network", say("core.storage.tooSlow")));
      else resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr });
    });
    child.stdin.end(opts.input ?? Buffer.alloc(0));
  });
}

/** What rclone said about an argument it does not accept, or `null` if the failure is not about arguments. */
function flagTrouble(text: string): Say | null {
  const unknown = text.match(/unknown (?:shorthand )?flag: '?(-{1,2}[^\s']*|.)'?/);
  if (unknown) return say("core.storage.unknownFlag", { flag: String(unknown[1]) });
  const value = text.match(/invalid argument "([^"]*)" for "([^"]+)" flag/);
  if (value) return say("core.storage.badValue", { value: String(value[1]), flag: String((value[2] as string).split(", ").pop()) });
  const needs = text.match(/flag needs an argument: '?(-{1,2}[^\s']*)'?/);
  if (needs) return say("core.storage.missingValue", { flag: String(needs[1]) });
  return null;
}

/** The last line of what rclone wrote, without the date or the level. */
const lastLine = (text: string) =>
  (text.trim().split("\n").pop() ?? "")
    .replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s+(?:ERROR|NOTICE|CRITICAL|INFO)\s*:\s*/, "")
    .slice(0, 300);

/**
 * If something other than the storage responds at that address, it says so: something
 * in front that does not let requests through, or an address that belongs to something else. It is
 * asked with the same additional headers the destination carries.
 */
async function whoAnswers(target: S3Target): Promise<S3Error | null> {
  if (!target.endpoint) return null;
  const headers: Record<string, string> = {};
  for (const arg of storageFlagArgs(target.flags)) {
    const m = arg.match(/^--header=([^:]+):\s*(.*)$/);
    if (m) headers[(m[1] as string).trim()] = m[2] as string;
  }
  try {
    const response = await fetch(target.endpoint, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const text = (await response.text()).slice(0, 20_000);
    const where = response.headers.get("location") ?? "";
    if (/cloudflare access/i.test(text) || /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(where)) return new S3Error(response.status, "blocked", BLOCKED);
    // Only a page served normally counts: some storages respond with a short page to whoever arrives without a signature.
    if (response.ok && /^\s*<(!doctype html|html[\s>])/i.test(text)) return new S3Error(response.status, "not_s3", NOT_S3);
  } catch {
    // If it does not respond, what counts is what rclone said.
  }
  return null;
}

/** Why rclone failed, in words. */
async function failure(target: S3Target, result: Result): Promise<S3Error> {
  const text = result.stderr;
  const flag = flagTrouble(text);
  if (flag) return new S3Error(0, "flag", flag);
  const status = Number(text.match(/StatusCode: (\d+)/)?.[1] ?? 0);
  const code = text.match(/api error (\w+)/)?.[1] ?? null;
  if (code && KNOWN[code]) return new S3Error(status, code, KNOWN[code]);
  if (/has no ETag/.test(text)) return new S3Error(0, "multipart", NO_ETAG);
  if (/no such host/.test(text)) return new S3Error(0, "network", say("core.storage.noHost"));
  if (/x509:|tls: /.test(text)) return new S3Error(0, "certificate", say("core.storage.certificate"));
  if (/connection refused|i\/o timeout|deadline exceeded|no route to host|network is unreachable|connection reset/.test(text)) return new S3Error(0, "network", NO_ANSWER);
  // The storage did not explain the failure: whoever answered may not have been it.
  const other = await whoAnswers(target);
  if (other) return other;
  if (/corrupted on transfer/.test(text)) return new S3Error(0, "mismatch", say("core.storage.notSaved"));
  if (status === 403) return new S3Error(403, code ?? "HTTP 403", KNOWN.AccessDenied as Say);
  if (/directory not found/.test(text)) return new S3Error(404, "NoSuchBucket", KNOWN.NoSuchBucket as Say);
  if (status === 404 || /object not found/.test(text)) return new S3Error(404, code ?? "HTTP 404", say("core.storage.notFound"));
  const said = lastLine(text);
  return new S3Error(status, code ?? "rclone", said ? say("core.storage.rejected", { reason: said }) : say("core.storage.rejectedExit", { code: result.code }));
}

async function must(target: S3Target, args: string[], opts: { input?: Buffer; timeoutMs?: number } = {}): Promise<Result> {
  const result = await run(target, args, opts);
  if (result.code !== 0) throw await failure(target, result);
  return result;
}

/**
 * Checks with rclone itself that it knows the arguments and accepts their
 * values. Returns what is wrong with them, or `null`. Without rclone on this machine there is nothing
 * to check with and they are taken as good: they will fail when used.
 */
export async function checkFlags(flags: string[]): Promise<Say | null> {
  if (flags.length === 0) return null;
  const result = await run(null, ["version", ...storageFlagArgs(flags)]).catch((err: S3Error) => (err.code === "no_rclone" ? null : err));
  if (result === null) return null;
  if (result instanceof S3Error) return result.text;
  if (result.code === 0) return null;
  return flagTrouble(result.stderr) ?? say("core.storage.flagsRejected", { reason: lastLine(result.stderr) });
}

/** The rclone version on this machine, or `null` if it is not there. */
export async function rcloneVersion(): Promise<string | null> {
  const result = await run(null, ["version"]).catch(() => null);
  return result?.code === 0 ? (result.stdout.toString("utf8").match(/rclone (v[\w.-]+)/)?.[1] ?? null) : null;
}

export async function putObject(target: S3Target, key: string, body: Buffer): Promise<void> {
  await must(target, ["rcat", remotePath(target, key), ...QUICK], { input: body, timeoutMs: TRANSFER_TIMEOUT_MS });
}

/** Size of an object, or `null` if it does not exist. */
async function sizeOf(target: S3Target, key: string): Promise<number | null> {
  const result = await must(target, ["lsjson", "--stat", "--no-mimetype", "--no-modtime", remotePath(target, key), ...QUICK]);
  const info = JSON.parse(result.stdout.toString("utf8")) as { IsDir?: boolean; Size?: number };
  // What is not a file, rclone reports as a folder.
  return info.IsDir ? null : Number(info.Size ?? 0);
}

/** The content of an object, as a stream: whoever requests it reads or forwards it. */
export async function getObject(target: S3Target, key: string): Promise<{ bytes: number; stream: Readable }> {
  const bytes = await sizeOf(target, key);
  if (bytes === null) throw new S3Error(404, "NoSuchKey", KNOWN.NoSuchKey as Say);
  const child = spawn(rclone(), ["cat", remotePath(target, key), ...storageFlagArgs(target.flags)], { env: envOf(target), stdio: ["ignore", "pipe", "pipe"] });
  const stream = new PassThrough();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
  });
  child.stdout.pipe(stream, { end: false });
  child.on("error", (err: NodeJS.ErrnoException) => stream.destroy(missing(err)));
  child.on("close", (code) => {
    if (code === 0) stream.end();
    else stream.destroy(new S3Error(0, "download", stderr ? say("core.storage.downloadCutBecause", { reason: lastLine(stderr) }) : say("core.storage.downloadCut")));
  });
  // If whoever reads stops halfway, rclone does not keep downloading.
  stream.on("close", () => {
    if (child.exitCode === null) child.kill();
  });
  return { bytes, stream };
}

/** Deletes an object. If it was already gone, nothing happens. */
export async function deleteObject(target: S3Target, key: string): Promise<void> {
  const result = await run(target, ["deletefile", remotePath(target, key), ...QUICK]);
  if (result.code !== 0 && !/object not found|doesn't exist/.test(result.stderr)) throw await failure(target, result);
}

/**
 * Removes a folder that was left empty. Some services store each folder
 * as such and leave it visible when its last file goes; in the others
 * there is nothing to remove. First it checks that it is really empty: with something
 * inside it is not touched. It is a cleanup: if it cannot be done, it is not an error.
 */
export async function removeEmptyFolder(target: S3Target, key: string): Promise<void> {
  const dir = key.replace(/^\/+|\/+$/g, "");
  // Never on the root: there rclone would understand that the bucket is to be removed.
  if (dir === "") return;
  try {
    // Depending on the service, the empty folder looks like a folder, with or without its own marker, or like an empty file carrying its name.
    const seen = await run(target, ["lsjson", "--stat", "--no-mimetype", "--no-modtime", remotePath(target, dir), ...QUICK]);
    if (seen.code !== 0) return;
    const info = JSON.parse(seen.stdout.toString("utf8")) as { IsDir?: boolean; Size?: number };
    const asFile = !info.IsDir;
    if (asFile && Number(info.Size) !== 0) return;
    const listed = await run(target, ["lsjson", "--no-mimetype", "--no-modtime", remotePath(target, dir), ...QUICK]);
    if (listed.code !== 0) return;
    // When listing what is inside something that looks like a file, rclone may return that same file: it does not count.
    const name = dir.split("/").pop();
    const inside = (JSON.parse(listed.stdout.toString("utf8") || "[]") as { Path: string; IsDir?: boolean }[]).filter((entry) => !(asFile && !entry.IsDir && entry.Path === name));
    if (inside.length > 0) return;
    if (asFile) await run(target, ["deletefile", remotePath(target, dir), ...QUICK]);
    else await run(target, ["rmdir", remotePath(target, dir), "--s3-directory-markers", ...QUICK]);
  } catch {
    // The empty folder stays, which does no harm.
  }
}

export interface S3Object {
  key: string;
  bytes: number;
  modifiedAt: string | null;
}

/** The files inside a folder, with everything hanging from it, up to `max`. */
export async function listObjects(target: S3Target, folder: string, opts: { max?: number } = {}): Promise<S3Object[]> {
  const dir = folder.replace(/^\/+|\/+$/g, "");
  const result = await must(target, ["lsjson", "--recursive", "--files-only", "--no-mimetype", "--use-server-modtime", remotePath(target, dir), ...QUICK]);
  const entries = JSON.parse(result.stdout.toString("utf8") || "[]") as { Path: string; Size: number; ModTime?: string }[];
  return entries.slice(0, opts.max ?? 20_000).map((entry) => {
    const at = entry.ModTime ? Date.parse(entry.ModTime) : Number.NaN;
    return { key: dir ? `${dir}/${entry.Path}` : entry.Path, bytes: Number(entry.Size), modifiedAt: Number.isNaN(at) ? null : new Date(at).toISOString() };
  });
}

/** Uploads a file from disk. A large one goes in parts: rclone decides when, or the console's arguments say so. */
export async function uploadFile(target: S3Target, key: string, path: string): Promise<void> {
  await must(target, ["copyto", path, remotePath(target, key)], { timeoutMs: TRANSFER_TIMEOUT_MS });
}

/** Checks that with that data it is possible to write, read and delete: leaves the bucket as it was. */
export async function testStorage(target: S3Target): Promise<void> {
  const key = keyOf(target, `connection-test-${randomBytes(6).toString("hex")}.txt`);
  const content = `Connection test of the platform, ${new Date().toISOString()}`;
  await putObject(target, key, Buffer.from(content, "utf8"));
  const read = async () => {
    const back = (await buffer((await getObject(target, key)).stream)).toString("utf8");
    if (back !== content) throw (await whoAnswers(target)) ?? new S3Error(0, "mismatch", say("core.storage.notReturned"));
  };
  const failed = await read().then(
    () => null,
    (err: Error) => err,
  );
  // The test file is always removed; if the read failed, that is the failure that gets reported.
  const left = await deleteObject(target, key).then(
    () => null,
    (err: Error) => err,
  );
  if (failed ?? left) throw failed ?? left;
}
