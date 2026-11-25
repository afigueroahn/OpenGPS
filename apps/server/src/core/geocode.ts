// Approximate address of a coordinate, cached in the database.
//
// The external service is Nominatim (OpenStreetMap) compatible and is
// configured with GEOCODER_URL; without that variable, the function is off.
// Lookups go one at a time and spaced out, because those services limit the
// rate, and each response is stored per cell of about 11 m to avoid repeating it.
import type { Config } from "../config";
import type { Queryable } from "../db";

export interface Place {
  label: string;
  lat: number;
  lon: number;
}

export interface Geocoder {
  enabled: boolean;
  /** Short address in Spanish, or null if there is no service or nothing was found. */
  reverse(lat: number, lon: number): Promise<string | null>;
  /** The service also finds a place by its written address. */
  canSearch: boolean;
  /**
   * Places that match a written address, the most likely first. Only when
   * someone asks for it: these services forbid searching while a person types.
   */
  search(query: string, language: string, limit: number): Promise<Place[]>;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const CELL = 10_000; // ten-thousandths of a degree
const MAX_WAITING = 30;

interface NominatimReply {
  display_name?: string;
  name?: string;
  lat?: string | number;
  lon?: string | number;
  address?: Record<string, string | undefined>;
  error?: unknown;
}

/** Builds "Calle 12, Colonia, Ciudad" from the service's response. */
export function shortAddress(reply: NominatimReply): string | null {
  const a = reply.address;
  if (!a) return reply.display_name?.split(",").slice(0, 3).join(",").trim() || null;
  const street = a.road ?? a.pedestrian ?? a.footway ?? a.path ?? a.residential;
  const first = street ? (a.house_number ? `${street} ${a.house_number}` : street) : (a.amenity ?? a.building ?? a.shop);
  const area = a.neighbourhood ?? a.suburb ?? a.quarter ?? a.hamlet ?? a.city_district;
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county;
  const parts = [first, area, city].filter((p): p is string => Boolean(p));
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  if (unique.length > 0) return unique.join(", ");
  return a.state ?? a.country ?? null;
}

/**
 * Addresses that are already stored, without querying the external service.
 * Returns one per point, in the same order; null if not yet known.
 */
export async function knownAddresses(db: Queryable, points: { lat: number; lon: number }[]): Promise<(string | null)[]> {
  if (points.length === 0) return [];
  const lats = points.map((p) => Math.round(p.lat * CELL));
  const lons = points.map((p) => Math.round(p.lon * CELL));
  const r = await db.query<{ lat_key: number; lon_key: number; address: string | null }>(
    `SELECT c.lat_key, c.lon_key, c.address
       FROM gps.geocode_cache c
       JOIN (SELECT DISTINCT * FROM unnest($1::int[], $2::int[]) AS k(lat_key, lon_key)) k USING (lat_key, lon_key)`,
    [lats, lons],
  );
  const found = new Map(r.rows.map((row) => [`${row.lat_key}:${row.lon_key}`, row.address]));
  return points.map((_, i) => found.get(`${lats[i]}:${lons[i]}`) ?? null);
}

export function createGeocoder(config: Pick<Config, "geocoder">, db: Queryable, fetchImpl: Fetch = fetch as unknown as Fetch): Geocoder {
  // The service can be changed or turned off from the console: it is checked on every lookup.
  const service = () => config.geocoder;

  // Single-step queue: lookups to the service go out one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  let lastCall = 0;
  const inFlight = new Map<string, Promise<string | null>>();

  /** One query to the service, no sooner after the last one than it allows. */
  async function call(url: string, query: Record<string, string>): Promise<unknown> {
    const { userAgent, minIntervalMs } = service();
    const wait = lastCall + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetchImpl(`${url}?${new URLSearchParams({ format: "jsonv2", addressdetails: "1", ...query })}`, {
      headers: { "User-Agent": userAgent, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`the address service answered ${res.status}`);
    return res.json();
  }

  async function ask(lat: number, lon: number): Promise<string | null> {
    const reply = (await call(service().url, { lat: lat.toFixed(5), lon: lon.toFixed(5), zoom: "18", "accept-language": "es" })) as NominatimReply;
    return reply.error ? null : shortAddress(reply);
  }

  // The same service finds places at the address beside the one that names them.
  const searchUrl = () => (service().url.endsWith("/reverse") ? `${service().url.slice(0, -"/reverse".length)}/search` : null);
  const searched = new Map<string, Place[]>();

  return {
    get enabled() {
      return Boolean(service().url);
    },
    async reverse(lat, lon) {
      if (!service().url) return null;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      const latKey = Math.round(lat * CELL);
      const lonKey = Math.round(lon * CELL);
      const key = `${latKey}:${lonKey}`;

      const cached = await db.query<{ address: string | null }>(`SELECT address FROM gps.geocode_cache WHERE lat_key = $1 AND lon_key = $2`, [latKey, lonKey]);
      if (cached.rows[0]) return cached.rows[0].address;

      const pending = inFlight.get(key);
      if (pending) return pending;
      // With a long queue it is better not to answer than to make everyone wait.
      if (waiting >= MAX_WAITING) return null;

      waiting++;
      const job = chain
        .then(() => ask(latKey / CELL, lonKey / CELL))
        .then(async (address) => {
          await db.query(
            `INSERT INTO gps.geocode_cache (lat_key, lon_key, address) VALUES ($1, $2, $3) ON CONFLICT (lat_key, lon_key) DO NOTHING`,
            [latKey, lonKey, address],
          );
          return address;
        })
        .catch((err: Error) => {
          console.warn("[geocode]", err.message);
          return null;
        })
        .finally(() => {
          waiting--;
          inFlight.delete(key);
        });
      chain = job;
      inFlight.set(key, job);
      return job;
    },
    get canSearch() {
      return searchUrl() !== null;
    },
    async search(query, language, limit) {
      const url = searchUrl();
      const q = query.trim();
      if (!url || !q) return [];
      const key = `${url}|${language}|${limit}|${q.toLowerCase()}`;
      const known = searched.get(key);
      if (known) return known;

      const job = chain.then(() => call(url, { q, limit: String(limit), "accept-language": language }));
      chain = job.catch(() => undefined);
      const replies = (await job) as NominatimReply[];
      const places = (Array.isArray(replies) ? replies : []).flatMap((reply): Place[] => {
        const lat = Number(reply.lat);
        const lon = Number(reply.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
        const address = shortAddress(reply);
        // A place with a name of its own (an airport, a market) says it first.
        const label = reply.name && !address?.includes(reply.name) ? [reply.name, address].filter(Boolean).join(", ") : (address ?? reply.display_name ?? "");
        return label ? [{ label: label.slice(0, 200), lat, lon }] : [];
      });
      searched.set(key, places);
      if (searched.size > 100) searched.delete(searched.keys().next().value as string);
      return places;
    },
  };
}
