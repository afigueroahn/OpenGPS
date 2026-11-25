// Looks for a newer version of the platform: the latest release of its GitHub
// repository against the version running (ADR-0003). The platform's owner sees
// the result. It is looked for on a clock and when the owner opens the
// platform, at most once an hour unless the owner asks; one answer serves
// everyone, and a failed look says so instead of passing for "up to date".
import { type UpdateCheckError, type UpdateStatus, compareVersions } from "@opengps/shared";
import type { Config } from "../config";

type Fetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

export interface Updates {
  /** What is known now, without looking. */
  status(): UpdateStatus;
  /** Looks, unless the last look is younger than `maxAgeMs`, and says what is known. Simultaneous calls share one look. */
  check(opts?: { maxAgeMs?: number }): Promise<UpdateStatus>;
  /** Looks every few hours while started. */
  start(): void;
  stop(): void;
}

/** How often the platform looks by itself. */
const EVERY_MS = 6 * 60 * 60_000;
/** First look after starting: once the rest is up. */
const FIRST_MS = 2 * 60_000;

export function createUpdates(deps: { config: Pick<Config, "appVersion" | "updateRepository">; fetch?: Fetch; now?: () => number }): Updates {
  const { config } = deps;
  const fetchImpl = deps.fetch ?? (fetch as unknown as Fetch);
  const now = deps.now ?? Date.now;
  const repository = /^[\w.-]+\/[\w.-]+$/.test(config.updateRepository) ? config.updateRepository : null;

  let latest: UpdateStatus["latest"] = null;
  let checkedAt: number | null = null;
  let error: UpdateCheckError | null = null;
  let etag: string | null = null;
  let inFlight: Promise<UpdateStatus> | null = null;
  const timers: NodeJS.Timeout[] = [];

  const status = (): UpdateStatus => ({
    current: config.appVersion,
    repository,
    latest,
    // A pre-release (1.3.0-beta.1) is never offered, even if GitHub calls it the latest.
    available: latest !== null && !latest.version.includes("-") && compareVersions(latest.version, config.appVersion) === 1,
    checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
    error,
  });

  const text = (v: unknown) => (typeof v === "string" ? v : "");

  async function look(): Promise<void> {
    if (!repository) return;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": `OpenGPS/${config.appVersion}`,
    };
    if (etag) headers["If-None-Match"] = etag;
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, { headers, signal: AbortSignal.timeout(8000) });
      if (res.status === 304) {
        error = null;
      } else if (res.status === 404) {
        // No release published yet: nothing newer, and nothing wrong.
        latest = null;
        etag = null;
        error = null;
      } else if (res.status === 403 || res.status === 429) {
        error = "rate_limited";
      } else if (res.status === 200) {
        const r = (await res.json()) as GitHubRelease;
        const version = text(r.tag_name).replace(/^v/, "");
        // A tag that is not a version cannot be compared with this one.
        if (compareVersions(version, "0.0.0") === null) {
          error = "unexpected";
        } else {
          latest = { version, name: text(r.name) || `v${version}`, notes: text(r.body), url: text(r.html_url), publishedAt: text(r.published_at) };
          etag = res.headers.get("etag");
          error = null;
        }
      } else {
        error = "unexpected";
      }
    } catch {
      error = "unreachable";
    }
    checkedAt = now();
  }

  const updates: Updates = {
    status,
    check({ maxAgeMs = 0 } = {}) {
      if (!repository) return Promise.resolve(status());
      if (checkedAt !== null && now() - checkedAt < maxAgeMs) return Promise.resolve(status());
      inFlight ??= look().then(
        () => {
          inFlight = null;
          return status();
        },
        () => {
          inFlight = null;
          return status();
        },
      );
      return inFlight;
    },
    start() {
      if (!repository) return;
      const run = () => void updates.check({ maxAgeMs: 60_000 });
      timers.push(setTimeout(run, FIRST_MS), setInterval(run, EVERY_MS));
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
  return updates;
}
