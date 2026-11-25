// History through the API: period, isolation between accounts, group scope,
// late data, addresses and export.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser;
let beto: TestUser;
let vehicle: { id: string; uniqueId: string };

const HOUR = 3_600_000;
/** The tests happen "today first thing": three hours before now. */
const base = Date.now() - 3 * HOUR;
const KMH_TO_KNOTS = 1 / 1.852;

const as = (user: TestUser) => ({ cookie: user.cookie });
const traccarIdOf = (uniqueId: string) => h.traccar.devices.get(uniqueId) as number;
const range = (fromMs: number, toMs: number) => `from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}`;

/** Positions every 10 seconds: stretches of driving, idling or engine off. */
function drive(deviceId: number, startMs: number, legs: { minutes: number; kmh: number; ignition: boolean }[], lat0 = 14.08) {
  const rows = [];
  let t = startMs;
  let lat = lat0;
  for (const leg of legs) {
    for (let s = 0; s < leg.minutes * 60; s += 10) {
      t += 10_000;
      lat += ((leg.kmh / 3.6) * 10) / 111_320;
      rows.push(traccarRow(deviceId, { fix: new Date(t), lat, lon: -87.2, knots: leg.kmh * KMH_TO_KNOTS, attributes: { ignition: leg.ignition } }));
    }
  }
  return rows;
}

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Historial");
  beto = await h.signUp("Beto Ajeno");
  const uniqueId = h.uniqueId();
  const created = await h.request("POST", "/api/vehicles", { ...as(ana), body: { name: "Camión de reparto", plate: "HAA-1234", uniqueId, modelId: "h02" } });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  vehicle = { id: created.json.vehicle.id, uniqueId };

  // A morning: 10 min driving, 2 idling, 6 off and 5 driving.
  const feed = drive(traccarIdOf(uniqueId), base, [
    { minutes: 10, kmh: 36, ignition: true },
    { minutes: 2, kmh: 0, ignition: true },
    { minutes: 6, kmh: 0, ignition: false },
    { minutes: 5, kmh: 72, ignition: true },
  ]);
  expect(await h.ingestFrom(feed).tick()).toBe(feed.length);
});
afterAll(async () => {
  await h?.close();
});

describe("track history", () => {
  it("returns trips, stops, totals and the track for the period", async () => {
    const res = await h.request("GET", `/api/vehicles/${vehicle.id}/history?${range(base - HOUR, Date.now())}`, as(ana));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { summary, trips, stops, points } = res.json.history;

    expect(trips).toHaveLength(2);
    expect(stops).toHaveLength(1);
    expect(summary).toMatchObject({ trips: 2, stops: 1, positions: 138, maxSpeedKmh: 72 });
    // 10 min at 36 km/h and 5 min at 72 km/h: 6 km each stretch.
    expect(summary.distanceM).toBeGreaterThan(11_800);
    expect(summary.distanceM).toBeLessThan(12_200);
    expect(Math.round(summary.movingS / 60)).toBe(15);
    expect(Math.abs(summary.idleS - 120)).toBeLessThanOrEqual(10);
    expect(Math.abs(summary.stoppedS - 360)).toBeLessThanOrEqual(10);
    expect(trips[0]).toMatchObject({ maxSpeedKmh: 36, avgSpeedKmh: 36 });
    expect(Math.abs(stops[0].durationS - 480)).toBeLessThanOrEqual(10);
    expect(Math.abs(stops[0].idleS - 120)).toBeLessThanOrEqual(10);

    // The track for the map summarises the stop, but keeps the ends.
    expect(points.length).toBeGreaterThan(90);
    expect(points.length).toBeLessThan(138);
    expect(points[0]).toMatchObject({ lon: -87.2, s: 36, i: true });
    expect(points[0].t).toBe(Math.round((base + 10_000) / 1000));
    expect(points.at(-1).s).toBe(72);
  });

  it("only counts what falls inside the requested period", async () => {
    // The first 5 minutes: half a trip.
    const res = await h.request("GET", `/api/vehicles/${vehicle.id}/history?${range(base, base + 5 * 60_000)}`, as(ana));
    expect(res.json.history.summary).toMatchObject({ trips: 1, stops: 0 });
    expect(res.json.history.summary.distanceM).toBeLessThan(3_100);
    const empty = await h.request("GET", `/api/vehicles/${vehicle.id}/history?${range(base - 48 * HOUR, base - 24 * HOUR)}`, as(ana));
    expect(empty.status).toBe(200);
    expect(empty.json.history).toMatchObject({ trips: [], stops: [], points: [], summary: { positions: 0, distanceM: 0 } });
  });

  it("another account cannot see or export the history", async () => {
    const query = range(base - HOUR, Date.now());
    expect((await h.request("GET", `/api/vehicles/${vehicle.id}/history?${query}`, as(beto))).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${vehicle.id}/history/export?${query}&format=csv`, as(beto))).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${vehicle.id}/history?${query}`, {})).status).toBe(401);
    expect((await h.request("GET", `/api/vehicles/${vehicle.id}/history/export?${query}&format=csv`, {})).status).toBe(401);
  });

  it("whoever sees only one group does not see the history of a vehicle in another group", async () => {
    const mine = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: "Reparto" } })).json.group.id as string;
    const theirs = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: "Ventas" } })).json.group.id as string;
    expect((await h.request("PATCH", `/api/vehicles/${vehicle.id}`, { ...as(ana), body: { groupId: mine } })).status).toBe(200);

    const join = async (name: string, groups: string[]) => {
      const person = await h.signUp(name);
      const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role: "viewer", groups } });
      expect(invited.status, JSON.stringify(invited.json)).toBe(201);
      expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
      return person;
    };
    const inside = await join("Lector de Reparto", [mine]);
    const outside = await join("Lector de Ventas", [theirs]);
    const query = range(base - HOUR, Date.now());
    const seen = await h.request("GET", `/api/vehicles/${vehicle.id}/history?${query}`, as(inside));
    expect(seen.status).toBe(200);
    expect(seen.json.history.trips).toHaveLength(2);
    expect((await h.request("GET", `/api/vehicles/${vehicle.id}/history?${query}`, as(outside))).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${vehicle.id}/history/export?${query}&format=gpx`, as(outside))).status).toBe(404);
  });

  it("data the device uploads late shows up in the next query", async () => {
    const query = range(base - 6 * HOUR, Date.now());
    const before = await h.request("GET", `/api/vehicles/${vehicle.id}/history?${query}`, as(ana));
    expect(before.json.history.trips).toHaveLength(2);

    // The device recovers its connection and uploads a trip from five hours earlier.
    const late = drive(traccarIdOf(vehicle.uniqueId), base - 5 * HOUR, [{ minutes: 8, kmh: 54, ignition: true }], 14.2);
    expect(await h.ingestFrom(late).tick()).toBe(late.length);

    const after = await h.request("GET", `/api/vehicles/${vehicle.id}/history?${query}`, as(ana));
    expect(after.json.history.trips).toHaveLength(3);
    expect(after.json.history.trips[0]).toMatchObject({ maxSpeedKmh: 54 });
    expect(after.json.history.summary.distanceM).toBeGreaterThan(before.json.history.summary.distanceM + 7_000);
  });

  it("rejects malformed or overly long periods", async () => {
    const get = (query: string) => h.request("GET", `/api/vehicles/${vehicle.id}/history?${query}`, as(ana));
    expect((await get("")).status).toBe(400);
    expect((await get("from=ayer&to=hoy")).status).toBe(400);
    expect((await get(range(base, base - HOUR))).status).toBe(400);
    const long = await get(range(base - 40 * 24 * HOUR, base));
    expect(long.status).toBe(400);
    expect(long.json.error.code).toBe("history_range_too_long");
    expect((await get(range(base - 31 * 24 * HOUR, base))).status).toBe(200);
  });

  it("brings the addresses already known and gives the rest separately", async () => {
    const query = range(base - HOUR, Date.now());
    const first = (await h.request("GET", `/api/vehicles/${vehicle.id}/history?${query}`, as(ana))).json.history;
    expect(first.trips[0].startAddress).toBeNull();
    expect(first.stops[0].address).toBeNull();

    const stop = first.stops[0];
    await h.db.core.query(`INSERT INTO gps.geocode_cache (lat_key, lon_key, address) VALUES ($1, $2, $3) ON CONFLICT (lat_key, lon_key) DO UPDATE SET address = EXCLUDED.address`, [
      Math.round(stop.lat * 10_000),
      Math.round(stop.lon * 10_000),
      "Mercado de Prueba, Comayagüela",
    ]);
    const second = (await h.request("GET", `/api/vehicles/${vehicle.id}/history?${query}`, as(ana))).json.history;
    expect(second.stops[0].address).toBe("Mercado de Prueba, Comayagüela");
    // The first trip ends where the stop begins.
    expect(second.trips[0].endAddress).toBe("Mercado de Prueba, Comayagüela");
    await h.db.core.query(`DELETE FROM gps.geocode_cache WHERE address = 'Mercado de Prueba, Comayagüela'`);

    const asked = await h.request("POST", "/api/geocode", { ...as(ana), body: { lat: first.trips[0].startLat, lon: first.trips[0].startLon } });
    expect(asked.json).toEqual({ address: "Bulevar de Prueba 123, Centro" });
    expect((await h.request("POST", "/api/geocode", { body: { lat: 14, lon: -87 } })).status).toBe(401);
    expect((await h.request("POST", "/api/geocode", { ...as(ana), body: { lat: 140, lon: -87 } })).status).toBe(400);
  });
});

describe("export through the API", () => {
  const download = (format: string, user: TestUser, extra = "") =>
    h.fastify.inject({
      method: "GET",
      url: `/api/vehicles/${vehicle.id}/history/export?${range(base - HOUR, Date.now())}&format=${format}&zone=America%2FTegucigalpa${extra}`,
      headers: { cookie: user.cookie },
    });

  it("downloads the track in the five formats", async () => {
    const expected: Record<string, [string, (body: Buffer) => void]> = {
      xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", (b) => expect(b.subarray(0, 2).toString()).toBe("PK")],
      pdf: ["application/pdf", (b) => expect(b.subarray(0, 5).toString()).toBe("%PDF-")],
      // One row per position in the period, plus the header.
      csv: ["text/csv; charset=utf-8", (b) => expect(b.toString("utf8").trimEnd().split("\r\n")).toHaveLength(139)],
      gpx: ["application/gpx+xml", (b) => expect(b.toString("utf8").match(/<trk>/g)).toHaveLength(2)],
      kml: ["application/vnd.google-earth.kml+xml", (b) => expect(b.toString("utf8")).toContain("<name>Recorrido de Camión de reparto</name>")],
    };
    for (const [format, [type, check]] of Object.entries(expected)) {
      const res = await download(format, ana);
      expect(res.statusCode, `${format}: ${res.body.slice(0, 200)}`).toBe(200);
      expect(res.headers["content-type"]).toBe(type);
      // If the period crosses midnight, the name carries the first day and the last.
      expect(String(res.headers["content-disposition"])).toMatch(
        new RegExp(`^attachment; filename="recorrido-camion-de-reparto-\\d{4}-\\d{2}-\\d{2}(_\\d{4}-\\d{2}-\\d{2})?\\.${format}"$`),
      );
      expect(res.headers["cache-control"]).toBe("private, no-store");
      check(res.rawPayload);
    }
  });

  it("rejects a format or a time zone that do not exist", async () => {
    expect((await download("docx", ana)).statusCode).toBe(400);
    const res = await h.fastify.inject({
      method: "GET",
      url: `/api/vehicles/${vehicle.id}/history/export?${range(base - HOUR, Date.now())}&format=csv&zone=Marte%2FOlimpo`,
      headers: { cookie: ana.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("each export is recorded in the activity log", async () => {
    const audit = await h.request("GET", "/api/audit?limit=50", as(ana));
    const exports = audit.json.entries.filter((e: { action: string }) => e.action === "history.export");
    expect(exports).toHaveLength(5);
    expect(exports.map((e: { detail: { format: string } }) => e.detail.format).sort()).toEqual(["csv", "gpx", "kml", "pdf", "xlsx"]);
    expect(exports[0].detail.name).toBe("Camión de reparto");
  });
});
