// Routes along streets, for the simulator: a path through the points the
// person marked, with the driving time of each stretch.
//
// The external service speaks OSRM's API and is configured in the console;
// without its address, routes are straight lines. The public one admits one query per
// second and promises nothing, so queries go one at a time, spaced out, and
// what it already answered is remembered.
import { type LonLat, SIM_LIMITS, type SimTrace, distanceToSegmentM, metersBetween } from "@opengps/shared";
import type { Config } from "../config";
import { AppError, badRequest } from "../errors";
import { say } from "../i18n";

export interface Routing {
  readonly enabled: boolean;
  /** The path along streets through those points, in order. */
  trace(points: LonLat[]): Promise<SimTrace>;
}

export type RoutingFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RoutingDeps {
  config: Pick<Config, "routing" | "geocoder">;
  fetch?: RoutingFetch | undefined;
  /** Milliseconds between two queries. */
  minIntervalMs?: number | undefined;
}

const MAX_WAITING = 5;
const REMEMBERED = 100;

interface OsrmReply {
  code?: string;
  message?: string;
  routes?: {
    duration?: number;
    geometry?: { coordinates?: [number, number][] };
    legs?: { annotation?: { duration?: number[] } }[];
  }[];
}

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/** Which points to keep so the drawing of the line changes by no more than `toleranceM` meters. */
function keptAt(line: LonLat[], toleranceM: number): Uint8Array {
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop() as [number, number];
    let far = -1;
    let max = toleranceM;
    for (let i = from + 1; i < to; i++) {
      const d = distanceToSegmentM(line[i] as LonLat, line[from] as LonLat, line[to] as LonLat);
      if (d > max) {
        max = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([from, far], [far, to]);
    }
  }
  return keep;
}

/**
 * At most `max` points of a line: the ones that change its drawing the least
 * go first. Each point that stays keeps the seconds it had.
 */
export function thin(line: LonLat[], secs: number[], max: number): { line: LonLat[]; secs: number[] } {
  if (line.length <= max) return { line, secs };
  for (let tolerance = 2; ; tolerance *= 2) {
    const keep = keptAt(line, tolerance);
    let count = 0;
    for (const k of keep) count += k;
    if (count <= max) return { line: line.filter((_, i) => keep[i] === 1), secs: secs.filter((_, i) => keep[i] === 1) };
  }
}

/** What the service answered, as a path with its times. */
export function readTrace(reply: OsrmReply): SimTrace | null {
  const route = reply.routes?.[0];
  const coordinates = route?.geometry?.coordinates;
  if (!route || !coordinates || coordinates.length < 2) return null;
  const durations = (route.legs ?? []).flatMap((leg) => leg.annotation?.duration ?? []);
  const perSegment = durations.length === coordinates.length - 1;

  // Where two legs meet the service repeats the point: it stays once, with its time.
  const line: LonLat[] = [];
  const secs: number[] = [];
  const meters: number[] = [];
  let seconds = 0;
  coordinates.forEach((c, i) => {
    const point: LonLat = [round(c[0], 6), round(c[1], 6)];
    if (i > 0 && perSegment) seconds += Math.max(0, durations[i - 1] ?? 0);
    const last = line[line.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) {
      secs[secs.length - 1] = seconds;
      return;
    }
    meters.push(last ? (meters[meters.length - 1] as number) + metersBetween(last, point) : 0);
    line.push(point);
    secs.push(seconds);
  });
  if (line.length < 2) return null;

  const lengthM = meters[meters.length - 1] as number;
  if (!perSegment) {
    // Without a time for each stretch, the whole trip's time is shared out by distance.
    const total = route.duration && route.duration > 0 ? route.duration : lengthM / (40 / 3.6);
    for (let i = 0; i < secs.length; i++) secs[i] = lengthM > 0 ? (total * (meters[i] as number)) / lengthM : 0;
  }
  const fitted = thin(line, secs, SIM_LIMITS.linePoints);
  const rounded = fitted.secs.map((s) => round(s, 1));
  return { line: fitted.line, secs: rounded, lengthM: Math.round(lengthM), seconds: Math.round(rounded[rounded.length - 1] as number) };
}

export function createRouting(deps: RoutingDeps): Routing {
  const { config } = deps;
  const fetchImpl = deps.fetch ?? (fetch as unknown as RoutingFetch);
  const minIntervalMs = deps.minIntervalMs ?? 1100;
  const failed = () => new AppError(502, "routing_failed", say("simulator.errors.routingFailed"));

  // Single-step queue: queries to the service go out one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  let lastCall = 0;
  const remembered = new Map<string, SimTrace>();

  async function ask(base: string, path: string): Promise<SimTrace> {
    const wait = lastCall + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    let reply: OsrmReply;
    try {
      const res = await fetchImpl(`${base}/route/v1/driving/${path}?overview=full&geometries=geojson&annotations=duration&steps=false`, {
        headers: { "User-Agent": config.geocoder.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      // The service says "there is no route" with an error status and its reason in the body.
      reply = (await res.json().catch(() => ({}))) as OsrmReply;
      if (!res.ok && !reply.code) throw new Error(`the routing service answered ${res.status}`);
    } catch (err) {
      console.warn("[routing]", (err as Error).message);
      throw failed();
    }
    if (reply.code === "NoRoute" || reply.code === "NoSegment") throw badRequest(say("simulator.errors.noRoute"), "no_route");
    const trace = reply.code === "Ok" ? readTrace(reply) : null;
    if (!trace) {
      console.warn("[routing]", `the routing service answered ${reply.code ?? "nothing"}: ${reply.message ?? ""}`);
      throw failed();
    }
    return trace;
  }

  return {
    get enabled() {
      return Boolean(config.routing.url);
    },
    async trace(points) {
      // The service can be changed or turned off from the console: it is checked on every query.
      const base = config.routing.url;
      if (!base) throw badRequest(say("simulator.errors.routingOff"), "routing_off");
      const path = points.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(";");
      const key = `${base}|${path}`;
      const known = remembered.get(key);
      if (known) return known;
      // With a long queue it is better to say so than to keep everyone waiting.
      if (waiting >= MAX_WAITING) throw new AppError(429, "too_many_requests", say("simulator.errors.routingBusy"));

      waiting++;
      const job = chain.then(() => ask(base, path));
      chain = job.catch(() => undefined);
      try {
        const trace = await job;
        remembered.set(key, trace);
        if (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value as string);
        return trace;
      } finally {
        waiting--;
      }
    },
  };
}
