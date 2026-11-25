// Routes of the device simulator: traced along streets by a routing service,
// from one written address to another, or taken from a real trip; saved,
// changed and deleted from the admin console.
import { type LonLat, SIM_LIMITS, type SimPlace, type SimRoute, type SimRouteSummary, type SimTrace, type SimulationDetail, type SimulatorMeta, generateSimId, metersBetween } from "@opengps/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createGeocoder } from "../src/core/geocode";
import { AppError } from "../src/errors";
import { type RoutingFetch, createRouting, readTrace, thin } from "../src/simulator/routing";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";
import { closeGateways, gateway, until } from "./sim-gateway";

let h: Harness;
let boss: TestUser; // administers the platform
let customer: TestUser; // any account

const as = (user: TestUser) => ({ cookie: user.cookie });
const admin = (method: string, url: string, body?: unknown) => h.request(method, url, body === undefined ? as(boss) : { ...as(boss), body });
const BASE = "/api/admin/simulator";
const saved: string[] = [];

// Two corners of Tegucigalpa, about 1.5 km apart.
const A = { lon: -87.2068, lat: 14.1057, label: "Parque Central" };
const B = { lon: -87.1935, lat: 14.1012, label: "Bulevar Morazán" };
const straight = (over: Record<string, unknown> = {}) => ({ name: "Ruta de prueba recta", waypoints: [A, B], snapped: false, line: [[A.lon, A.lat], [B.lon, B.lat]], secs: null, ...over });

async function save(body: Record<string, unknown>): Promise<SimRoute> {
  const res = await admin("POST", `${BASE}/routes`, body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const route = res.json.route as SimRoute;
  saved.push(route.id);
  return route;
}
const listed = async () => (await admin("GET", `${BASE}/routes`)).json.routes as SimRouteSummary[];

/** A routing service that answers what the test says and records what it was asked. */
function service(answer: (url: string) => { status?: number; body: unknown } | Error) {
  const calls: { url: string; at: number; agent: string | undefined }[] = [];
  const fetch: RoutingFetch = async (url, init) => {
    calls.push({ url, at: Date.now(), agent: init.headers["User-Agent"] });
    const reply = answer(url);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body };
  };
  const config = { routing: { url: "https://rutas.prueba" }, geocoder: { url: "", userAgent: "OpenGPS de prueba (https://gps.prueba)", minIntervalMs: 0 } };
  return { calls, config, routing: createRouting({ config, fetch, minIntervalMs: 60 }) };
}
/** What the routing service answers for a path through those points, with the seconds of each stretch. */
const osrm = (coordinates: LonLat[], legs: number[][], duration?: number) => ({
  code: "Ok",
  routes: [{ duration: duration ?? legs.flat().reduce((a, b) => a + b, 0), geometry: { coordinates }, legs: legs.map((d) => ({ annotation: { duration: d } })) }],
});
const failure = async (work: Promise<unknown>) => (await work.then(() => null, (err: unknown) => err)) as AppError;

beforeAll(async () => {
  h = await createHarness();
  boss = await h.signUp("Jefa de Rutas");
  customer = await h.signUp("Cliente de Rutas");
  await h.makeOwner(boss);
});

afterEach(async () => {
  h.simulator.stop();
  await h.simulator.idle();
  await closeGateways();
  await h.db.core.query(`DELETE FROM gps.simulations`);
  // The routes of a test are its own: the platform's examples stay.
  await h.db.core.query(`DELETE FROM gps.sim_routes WHERE id = ANY($1::uuid[])`, [saved.splice(0)]);
});

afterAll(async () => {
  await h.close();
});

describe("routing service", () => {
  it("asks for the path through the points and keeps the time of each stretch", async () => {
    const path: LonLat[] = [
      [-87.2068, 14.1057],
      [-87.2031, 14.1049],
      [-87.1989, 14.1031],
      [-87.1935, 14.1012],
    ];
    const { routing, calls, config } = service(() => ({ body: osrm(path, [[40, 55.44, 61]]) }));
    expect(routing.enabled).toBe(true);
    const trace = await routing.trace([path[0] as LonLat, path[3] as LonLat]);
    expect(trace.line).toEqual(path);
    expect(trace.secs).toEqual([0, 40, 95.4, 156.4]);
    expect(trace.seconds).toBe(156);
    expect(trace.lengthM).toBe(Math.round(path.reduce((m, p, i) => (i === 0 ? 0 : m + metersBetween(path[i - 1] as LonLat, p)), 0)));

    // As the service wants it: longitude first, the whole path, and the seconds of each stretch.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://rutas.prueba/route/v1/driving/-87.206800,14.105700;-87.193500,14.101200?overview=full&geometries=geojson&annotations=duration&steps=false");
    // It says who is asking, as with the address service.
    expect(calls[0]?.agent).toBe(config.geocoder.userAgent);
  });

  it("a point where two legs meet stays once, and a path without times shares out the whole trip", () => {
    // Through a middle point the service gives two legs, and repeats the point where they meet.
    const twoLegs = readTrace(
      osrm(
        [
          [-87.2, 14.1],
          [-87.19, 14.1],
          [-87.19, 14.1],
          [-87.18, 14.1],
        ],
        [[30], [0, 50]],
      ),
    ) as SimTrace;
    expect(twoLegs.line).toEqual([
      [-87.2, 14.1],
      [-87.19, 14.1],
      [-87.18, 14.1],
    ]);
    expect(twoLegs.secs).toEqual([0, 30, 80]);

    // Without the seconds of each stretch, the time of the whole trip goes by distance.
    const plain = readTrace({ code: "Ok", routes: [{ duration: 200, geometry: { coordinates: [[-87.2, 14.1], [-87.19, 14.1], [-87.17, 14.1]] }, legs: [{}] }] }) as SimTrace;
    expect(plain.secs[0]).toBe(0);
    expect(plain.secs[1]).toBeCloseTo(200 / 3, 0);
    expect(plain.secs[2]).toBe(200);
    expect(readTrace({ code: "Ok", routes: [] })).toBeNull();
  });

  it("queries go out one at a time and spaced; what it already answered is not asked again", async () => {
    const { routing, calls } = service((url) => ({ body: osrm(url.includes("-87.300000") ? [[-87.3, 14.1], [-87.29, 14.1]] : [[-87.2, 14.1], [-87.19, 14.1]], [[20]]) }));
    const first: LonLat[] = [[-87.2, 14.1], [-87.19, 14.1]];
    const second: LonLat[] = [[-87.3, 14.1], [-87.29, 14.1]];
    const [a, b] = await Promise.all([routing.trace(first), routing.trace(second)]);
    expect(a.line[0]).toEqual([-87.2, 14.1]);
    expect(b.line[0]).toEqual([-87.3, 14.1]);
    expect(calls).toHaveLength(2);
    expect((calls[1]?.at as number) - (calls[0]?.at as number)).toBeGreaterThanOrEqual(55);

    expect(await routing.trace(first)).toBe(a);
    expect(calls).toHaveLength(2);
  });

  it("says there is no way, that the service failed, or that it is off", async () => {
    const none = service(() => ({ status: 400, body: { code: "NoRoute", message: "Impossible route between points" } }));
    const noWay = await failure(none.routing.trace([[-87.2, 14.1], [-60, 30]]));
    expect(noWay).toBeInstanceOf(AppError);
    expect(noWay).toMatchObject({ status: 400, code: "no_route" });

    for (const broken of [service(() => ({ status: 503, body: {} })), service(() => new Error("timeout")), service(() => ({ body: { code: "InvalidQuery" } }))]) {
      expect(await failure(broken.routing.trace([[-87.2, 14.1], [-87.19, 14.1]]))).toMatchObject({ status: 502, code: "routing_failed" });
    }
    // A failure is not remembered: the next try asks again.
    let healthy = false;
    const flaky = service(() => (healthy ? { body: osrm([[-87.2, 14.1], [-87.19, 14.1]], [[20]]) } : { status: 500, body: {} }));
    expect(await failure(flaky.routing.trace([[-87.2, 14.1], [-87.19, 14.1]]))).toMatchObject({ status: 502 });
    healthy = true;
    expect((await flaky.routing.trace([[-87.2, 14.1], [-87.19, 14.1]])).secs).toEqual([0, 20]);

    const off = service(() => ({ body: {} }));
    off.config.routing.url = "";
    expect(off.routing.enabled).toBe(false);
    expect(await failure(off.routing.trace([[-87.2, 14.1], [-87.19, 14.1]]))).toMatchObject({ status: 400, code: "routing_off" });
    expect(off.calls).toHaveLength(0);
  });

  it("a path with more points than fit is thinned, and each point that stays keeps its time", () => {
    // A long road with a gentle wave: 20 000 points.
    const line: LonLat[] = Array.from({ length: 20_000 }, (_, i) => [-87 + i * 0.0001, 14 + Math.sin(i / 300) * 0.002]);
    const secs = line.map((_, i) => i * 1.5);
    const fitted = thin(line, secs, SIM_LIMITS.linePoints);
    expect(fitted.line.length).toBeLessThanOrEqual(SIM_LIMITS.linePoints);
    expect(fitted.line.length).toBeGreaterThan(50);
    expect(fitted.secs).toHaveLength(fitted.line.length);
    expect(fitted.line[0]).toEqual(line[0]);
    expect(fitted.line.at(-1)).toEqual(line.at(-1));
    expect(fitted.secs[0]).toBe(0);
    expect(fitted.secs.at(-1)).toBe(secs.at(-1));
    // Each point that stays is one of the original ones, with the time it had.
    fitted.line.forEach((point, i) => {
      const original = Math.round((point[0] + 87) / 0.0001);
      expect(fitted.secs[i]).toBe(original * 1.5);
    });
    // A short one is left as it is.
    expect(thin(line.slice(0, 10), secs.slice(0, 10), 100).line).toHaveLength(10);
  });
});

describe("address search", () => {
  it("finds places by a written address, at the address beside the one that names them", async () => {
    const calls: string[] = [];
    const geocoder = createGeocoder({ geocoder: { url: "https://direcciones.prueba/reverse", userAgent: "pruebas", minIntervalMs: 0 } }, h.db.core, async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => [
          { lat: "14.0608", lon: "-87.2172", name: "Aeropuerto Toncontín", display_name: "Aeropuerto Toncontín, Comayagüela, Honduras", address: { aeroway: "Aeropuerto Toncontín", suburb: "Colonia 15 de Septiembre", city: "Tegucigalpa" } },
          { lat: "14.1012", lon: "-87.1935", name: "", display_name: "Bulevar Morazán, Tegucigalpa", address: { road: "Bulevar Morazán", city: "Tegucigalpa" } },
          { lat: "no", lon: "-87", display_name: "Sin coordenadas" },
        ],
      };
    });
    expect(geocoder.canSearch).toBe(true);
    const places = await geocoder.search("  aeropuerto toncontín ", "es", 6);
    expect(places).toEqual([
      { label: "Aeropuerto Toncontín, Colonia 15 de Septiembre, Tegucigalpa", lat: 14.0608, lon: -87.2172 },
      { label: "Bulevar Morazán, Tegucigalpa", lat: 14.1012, lon: -87.1935 },
    ]);
    const url = new URL(calls[0] as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://direcciones.prueba/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: "aeropuerto toncontín", limit: "6", format: "jsonv2", addressdetails: "1", "accept-language": "es" });

    // The same search is answered from memory; in another language it is asked again.
    await geocoder.search("Aeropuerto Toncontín", "es", 6);
    expect(calls).toHaveLength(1);
    await geocoder.search("Aeropuerto Toncontín", "en", 6);
    expect(calls).toHaveLength(2);
    expect(await geocoder.search("   ", "es", 6)).toEqual([]);

    // A service that is off, or whose address does not name places, searches nothing.
    for (const url of ["", "https://direcciones.prueba/lookup"]) {
      const other = createGeocoder({ geocoder: { url, userAgent: "pruebas", minIntervalMs: 0 } }, h.db.core, async () => {
        throw new Error("it should not be asked");
      });
      expect(other.canSearch).toBe(false);
      expect(await other.search("Bulevar Morazán", "es", 6)).toEqual([]);
    }
  });
});

describe("simulator routes", () => {
  it("exist only for whoever administers the platform", async () => {
    const id = "019ab000-0000-7000-8000-000000000000";
    for (const [method, url] of [
      ["POST", `${BASE}/routes`],
      ["GET", `${BASE}/routes/${id}`],
      ["PUT", `${BASE}/routes/${id}`],
      ["DELETE", `${BASE}/routes/${id}`],
      ["POST", `${BASE}/route-line`],
      ["GET", `${BASE}/trip-line?vehicleId=${id}&from=2026-01-01T00:00:00Z&to=2026-01-01T06:00:00Z`],
      ["GET", `${BASE}/places?q=Bulevar`],
    ] as const) {
      const body = method === "GET" || method === "DELETE" ? {} : { body: {} };
      expect((await h.request(method, url, { ...as(customer), ...body })).status, `${method} ${url}`).toBe(404);
      expect((await h.request(method, url, body)).status, `${method} ${url} without a session`).toBe(401);
    }
  });

  it("says whether routes can be traced along streets and addresses searched", async () => {
    const meta = (await admin("GET", `${BASE}/meta`)).json.meta as SimulatorMeta;
    expect(meta).toMatchObject({ routing: true, placeSearch: true });
  });

  it("from one address to another along streets: finds the places, traces the path and saves it", async () => {
    const places = (await admin("GET", `${BASE}/places?q=${encodeURIComponent("Bulevar Morazán")}`)).json.places as SimPlace[];
    expect(places).toEqual([{ label: "Bulevar Morazán, Centro", lat: 14.1, lon: -87.2 }]);
    expect((await admin("GET", `${BASE}/places?q=nada%20de%20nada`)).json.places).toEqual([]);
    expect((await admin("GET", `${BASE}/places?q=ab`)).status).toBe(400);

    const before = h.routed.length;
    const res = await admin("POST", `${BASE}/route-line`, { points: [A, B] });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const trace = res.json.trace as SimTrace;
    expect(h.routed.slice(before)).toEqual([[[A.lon, A.lat], [B.lon, B.lat]]]);
    expect(trace.line).toHaveLength(3);
    expect(trace.secs).toHaveLength(3);
    expect((await admin("POST", `${BASE}/route-line`, { points: [A] })).status).toBe(400);

    const route = await save({ name: "  Centro a Morazán  ", waypoints: [A, B], snapped: true, line: trace.line, secs: trace.secs });
    expect(route).toMatchObject({ name: "Centro a Morazán", snapped: true, timed: true, closed: false, inUse: 0, waypoints: [A, B], line: trace.line, secs: trace.secs });
    expect(route.lengthM).toBe(trace.lengthM);
    expect(await listed()).toContainEqual({ id: route.id, name: "Centro a Morazán", lengthM: trace.lengthM, closed: false, inUse: 0, timed: true });
    expect((await admin("GET", `${BASE}/routes/${route.id}`)).json.route).toEqual(route);
  });

  it("a route with straight lines, or one that closes on itself, is saved too", async () => {
    const open = await save(straight());
    expect(open).toMatchObject({ snapped: false, timed: false, closed: false, secs: null });
    expect(open.lengthM).toBe(Math.round(metersBetween([A.lon, A.lat], [B.lon, B.lat])));
    // Back where it started: a circuit, which a vehicle can go around.
    const circuit = await save(straight({ name: "Ruta de prueba cerrada", waypoints: [A, B, A], line: [[A.lon, A.lat], [B.lon, B.lat], [A.lon, A.lat]] }));
    expect(circuit).toMatchObject({ closed: true });
  });

  it("rejects a route that is not one", async () => {
    const bad = async (over: Record<string, unknown>) => (await admin("POST", `${BASE}/routes`, straight(over))).status;
    expect(await bad({ name: "  " })).toBe(400);
    expect(await bad({ waypoints: [A] })).toBe(400);
    expect(await bad({ line: [[A.lon, A.lat]] })).toBe(400);
    expect(await bad({ line: [[A.lon, 95], [B.lon, B.lat]] })).toBe(400);
    // One time per point, and time does not go back.
    expect(await bad({ secs: [0] })).toBe(400);
    expect(await bad({ line: [[A.lon, A.lat], [B.lon, B.lat], [A.lon, A.lat]], secs: [0, 60, 30] })).toBe(400);
    // Two points on top of each other go nowhere.
    expect(await bad({ line: [[A.lon, A.lat], [A.lon + 0.00001, A.lat]] })).toBe(400);
    expect(await bad({ waypoints: Array.from({ length: SIM_LIMITS.waypoints + 1 }, () => A) })).toBe(400);
    expect((await admin("GET", `${BASE}/routes/no-es-un-id`)).status).toBe(404);
    expect((await admin("PUT", `${BASE}/routes/019ab000-0000-7000-8000-000000000000`, straight())).status).toBe(404);
  });

  it("a simulated device travels a route traced along streets at the pace of its streets", async () => {
    const trace = (await admin("POST", `${BASE}/route-line`, { points: [A, B] })).json.trace as SimTrace;
    const route = await save({ name: "Ruta de prueba por calles", waypoints: [A, B], snapped: true, line: trace.line, secs: trace.secs });
    const gw = await gateway((data) => (data.length === 17 ? Buffer.from([0x01]) : null));
    const made = (await admin("POST", `${BASE}/simulations`, { name: "Por calles", modelId: "teltonika", identifiers: [generateSimId({ kind: "imei" })], routeId: route.id, host: "127.0.0.1", port: gw.port, intervalS: 1, scenario: { cruiseKmh: 120 } })).json.simulation as SimulationDetail;
    expect(made.route).toMatchObject({ lengthM: route.lengthM, closed: false });
    expect((await admin("POST", `${BASE}/simulations/${made.id}/run`, { run: true })).status).toBe(200);
    h.simulator.tick();
    await until(() => gw.frames.length >= 1, "the handshake");
    await until(async () => {
      h.simulator.tick();
      return ((await admin("GET", `${BASE}/simulations/${made.id}`)).json.simulation as SimulationDetail).devices[0]?.sent === 1;
    }, "the first report");
    const live = (await admin("GET", `${BASE}/simulations/${made.id}`)).json.simulation as SimulationDetail;
    // The simulated service drives at 36 km/h: that, and not the cruising speed, is the vehicle's.
    expect(live.devices[0]?.speedKmh).toBeGreaterThanOrEqual(35);
    expect(live.devices[0]?.speedKmh).toBeLessThanOrEqual(37);
  });

  it("changing a route starts over whoever travels it; one in use is not deleted", async () => {
    const route = await save(straight());
    const made = (await admin("POST", `${BASE}/simulations`, { name: "En ruta", modelId: "teltonika", identifiers: [generateSimId({ kind: "imei" })], routeId: route.id, host: "127.0.0.1", port: 9 })).json.simulation as SimulationDetail;
    expect((await admin("POST", `${BASE}/simulations/${made.id}/run`, { run: true })).json.simulation).toMatchObject({ running: true });
    await h.db.core.query(`UPDATE gps.simulations SET trip_s = 500, state = '{"x":{"cut":true}}' WHERE id = $1`, [made.id]);
    expect((await listed()).find((r) => r.id === route.id)).toMatchObject({ inUse: 1 });

    const C = { lon: -87.185, lat: 14.095, label: "" };
    const changed = await admin("PUT", `${BASE}/routes/${route.id}`, straight({ name: "Ruta de prueba cambiada", waypoints: [A, B, C], line: [[A.lon, A.lat], [B.lon, B.lat], [C.lon, C.lat]] }));
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    expect(changed.json.route).toMatchObject({ name: "Ruta de prueba cambiada", inUse: 1 });
    expect((changed.json.route as SimRoute).line).toHaveLength(3);
    // It keeps running, on the new path and from its start.
    const after = (await admin("GET", `${BASE}/simulations/${made.id}`)).json.simulation as SimulationDetail;
    expect(after).toMatchObject({ running: true, routeName: "Ruta de prueba cambiada" });
    expect(after.route.line).toHaveLength(3);
    expect(after.log.filter((e) => e.code === "started")).toHaveLength(2);
    const kept = await h.db.core.query<{ trip_s: number; state: object; desired: string }>(`SELECT trip_s, state, desired FROM gps.simulations WHERE id = $1`, [made.id]);
    expect(kept.rows[0]).toMatchObject({ state: {}, desired: "running" });
    expect(kept.rows[0]?.trip_s).toBeLessThan(5);

    const refused = await admin("DELETE", `${BASE}/routes/${route.id}`);
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: "route_in_use" } });
    expect((await admin("DELETE", `${BASE}/simulations/${made.id}`)).status).toBe(204);
    expect((await admin("DELETE", `${BASE}/routes/${route.id}`)).status).toBe(204);
    expect((await admin("GET", `${BASE}/routes/${route.id}`)).status).toBe(404);
    expect((await admin("DELETE", `${BASE}/routes/${route.id}`)).status).toBe(404);

    const log = await h.db.core.query<{ action: string; detail: { name: string } }>(`SELECT action, detail FROM gps.audit_log WHERE user_id = $1 AND entity = 'sim_route' AND entity_id = $2 ORDER BY id`, [boss.userId, route.id]);
    expect(log.rows.map((r) => r.action)).toEqual(["admin.simulator.route.create", "admin.simulator.route.update", "admin.simulator.route.delete"]);
    expect(log.rows[2]?.detail).toMatchObject({ name: "Ruta de prueba cambiada" });
  });

  it("takes the path of a real trip of one of the owner's own vehicles", async () => {
    const uniqueId = h.uniqueId();
    const added = await h.request("POST", "/api/vehicles", { ...as(boss), body: { name: "Camioneta real", uniqueId, modelId: "h02" } });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    const vehicleId = added.json.vehicle.id as string;
    const traccarId = h.traccar.devices.get(uniqueId) as number;
    const start = Date.now() - 60 * 60_000;
    // Twenty positions going east, one every 30 seconds.
    await h.ingestFrom(Array.from({ length: 20 }, (_, i) => traccarRow(traccarId, { fix: new Date(start + i * 30_000), lat: 14.1 + (i % 2) * 0.0004, lon: -87.2 + i * 0.002, knots: 20 }))).tick();

    const range = `from=${encodeURIComponent(new Date(start - 60_000).toISOString())}&to=${encodeURIComponent(new Date(start + 20 * 30_000).toISOString())}`;
    const res = await admin("GET", `${BASE}/trip-line?vehicleId=${vehicleId}&${range}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const taken = res.json as { line: LonLat[]; lengthM: number };
    expect(taken.line.length).toBeGreaterThanOrEqual(2);
    expect(taken.line[0]).toEqual([-87.2, 14.1]);
    expect(taken.lengthM).toBeGreaterThan(4000);
    // It serves as a route as it comes.
    const route = await save({ name: "Ruta de prueba real", waypoints: [{ lon: -87.2, lat: 14.1, label: "" }, { lon: (taken.line.at(-1) as LonLat)[0], lat: (taken.line.at(-1) as LonLat)[1], label: "" }], line: taken.line });
    expect(route).toMatchObject({ timed: false, snapped: false });

    // A period with nothing in it, or a vehicle of another account, gives no path.
    expect((await admin("GET", `${BASE}/trip-line?vehicleId=${vehicleId}&from=2020-01-01T00:00:00Z&to=2020-01-01T06:00:00Z`)).status).toBe(400);
    const foreign = await h.request("POST", "/api/vehicles", { ...as(customer), body: { name: "De otro", uniqueId: h.uniqueId(), modelId: "h02" } });
    expect((await admin("GET", `${BASE}/trip-line?vehicleId=${foreign.json.vehicle.id}&${range}`)).status).toBe(404);
  });
});
