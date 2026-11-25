// Module H · Routes and logistics: points of interest, planned routes,
// dispatch, arrivals and deviations, driver link with proof of delivery and
// public tracking of a delivery.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryView, DriverTripView, NearbyVehicle, Poi, RoutePlan, RouteTrip, VehicleEvent } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { poiNames, simplify } from "../src/modules/routes/plans";
import { type Harness, ORIGIN, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser; // owner, with routes
let otherAccount: TestUser; // another account, without the module
let bea: TestUser; // with routes and fleet

const KNOTS = 1 / 1.852;
const MIN = 60_000;
const HOUR = 3_600_000;
const LAT = 14.0818;
const LON0 = -87.2068;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const as = (user: TestUser) => ({ cookie: user.cookie });
/** A point `km` kilometres east of the origin and `north` metres north of the road. */
const at = (km: number, north = 0) => ({ lon: LON0 + (km * 1000) / M_PER_DEG_LON, lat: LAT + north / 111_320 });
const stopAt = (name: string, km: number, extra: Record<string, unknown> = {}) => ({ name, ...at(km), radiusM: 100, ...extra });
const FIVE = [1, 2, 3, 4, 5].map((km) => stopAt(`Cliente ${km}`, km, { etaMin: km * 10, stayMin: 5 }));
const LINE = [at(0), at(5.5)].map((p) => [p.lon, p.lat]);

interface Car {
  id: string;
  deviceId: number;
}
async function addVehicle(user: TestUser, name: string): Promise<Car> {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId: "h02" } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { id: res.json.vehicle.id as string, deviceId: h.traccar.devices.get(uniqueId) as number };
}
/** Positions of a vehicle: each with its time, its kilometre along the road and how far it strays north. */
async function feed(car: Car, points: { t: number; km: number; north?: number }[]) {
  await h
    .ingestFrom(
      points.map((p) => {
        const here = at(p.km, p.north ?? 0);
        return traccarRow(car.deviceId, { fix: new Date(p.t), lon: here.lon, lat: here.lat, knots: 60 * KNOTS, attributes: { ignition: true } });
      }),
    )
    .tick();
  await h.settle();
}
/** Travels the road from one kilometre to another, one position every half kilometre and half minute. */
const along = (start: number, fromKm: number, toKm: number) => {
  const out = [];
  let t = start;
  for (let km = fromKm; km <= toKm + 1e-9; km += 0.5) out.push({ t: (t += 30_000), km });
  return out;
};
const tripOf = async (user: TestUser, id: string) => (await h.request("GET", `/api/routes/trips/${id}`, as(user))).json.trip as RouteTrip;
const eventsOf = async (user: TestUser, car: Car) => ((await h.request("GET", `/api/events?limit=200&vehicleId=${car.id}`, as(user))).json.events as VehicleEvent[]).reverse();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1200, 9)]);

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Rutas");
  otherAccount = await h.signUp("Otra Cuenta");
  bea = await h.signUp("Bea Completa");
  await h.enableModules(ana.orgId, ["H"]);
  await h.enableModules(bea.orgId, ["H", "D"]);
});
afterAll(async () => {
  await h?.close();
});

describe("module H: points of interest and planned routes", () => {
  it("without the module enabled, its routes do not exist for that account", async () => {
    for (const path of ["/api/routes/pois", "/api/routes/plans", "/api/routes/trips", "/api/routes/nearest?lat=14&lon=-87"]) {
      expect((await h.request("GET", path, as(otherAccount))).status, path).toBe(404);
      expect((await h.request("GET", path)).status, path).toBe(401);
    }
  });

  it("stores points of interest with their category, and says which one a place falls in", async () => {
    const made = await h.request("POST", "/api/routes/pois", { ...as(ana), body: { name: "Bodega central", category: "warehouse", ...at(0), radiusM: 150, address: "Bulevar del Norte" } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json.pois).toMatchObject([{ name: "Bodega central", category: "warehouse", radiusM: 150, address: "Bulevar del Norte", phone: null }]);
    const list = (await h.request("POST", "/api/routes/pois", { ...as(ana), body: { name: "Cliente Aurora", category: "client", ...at(3) } })).json.pois as Poi[];
    expect(list.map((p) => [p.name, p.category, p.radiusM])).toEqual([
      ["Bodega central", "warehouse", 150],
      ["Cliente Aurora", "client", 100],
    ]);
    expect((await h.request("POST", "/api/routes/pois", { ...as(ana), body: { name: "Sin lugar", lat: 120, lon: 0 } })).status).toBe(400);
    const edited = await h.request("PUT", `/api/routes/pois/${list[1]?.id}`, { ...as(ana), body: { name: "Cliente Aurora", category: "client", ...at(3), phone: "9911-2233" } });
    expect((edited.json.pois as Poi[])[1]).toMatchObject({ phone: "9911-2233" });
    expect((await h.request("GET", "/api/routes/pois", as(bea))).json.pois).toEqual([]);
    expect((await h.request("DELETE", `/api/routes/pois/${list[1]?.id}`, as(bea))).status).toBe(404);
    // A place within the radius carries the point's name; one far away, none.
    expect(await poiNames(h.db.core, ana.orgId, [at(0, 100), at(3, 60), at(1.5)])).toEqual(["Bodega central", "Cliente Aurora", null]);
  });

  it("a route is planned with its road, its tolerance and its stops with schedule", async () => {
    expect((await h.request("POST", "/api/routes/plans", { ...as(ana), body: { name: "Sin paradas", stops: [] } })).status).toBe(400);
    expect((await h.request("POST", "/api/routes/plans", { ...as(ana), body: { name: "Camino de un punto", line: [LINE[0]], stops: FIVE } })).status).toBe(400);
    const made = await h.request("POST", "/api/routes/plans", { ...as(ana), body: { name: "Reparto norte", line: LINE, toleranceM: 150, stops: FIVE } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const plan = (made.json.plans as RoutePlan[])[0] as RoutePlan;
    expect(plan).toMatchObject({ name: "Reparto norte", toleranceM: 150 });
    expect(plan.stops.map((s) => [s.name, s.etaMin, s.stayMin])).toEqual(FIVE.map((s, i) => [s.name, (i + 1) * 10, 5]));
    expect(plan.lengthM).toBeGreaterThan(5400);
    expect(plan.lengthM).toBeLessThan(5600);
    const renamed = await h.request("PUT", `/api/routes/plans/${plan.id}`, { ...as(ana), body: { name: "Reparto del norte", line: LINE, toleranceM: 200, stops: FIVE } });
    expect((renamed.json.plans as RoutePlan[])[0]).toMatchObject({ name: "Reparto del norte", toleranceM: 200 });
    expect((await h.request("PUT", `/api/routes/plans/${plan.id}`, { ...as(bea), body: { name: "x", stops: FIVE } })).status).toBe(404);
  });

  it("a route's road is taken from a real track, thinned", async () => {
    // A straight line with a bend: of a thousand points, those that draw the road remain.
    const zig = Array.from({ length: 1000 }, (_, i) => [LON0 + i * 1e-5, LAT + (i < 500 ? 0 : (i - 500) * 1e-5)] as [number, number]);
    const light = simplify(zig, 12);
    expect(light.length).toBeLessThan(10);
    expect(light[0]).toEqual(zig[0]);
    expect(light.at(-1)).toEqual(zig.at(-1));

    const car = await addVehicle(ana, "Camión explorador");
    const start = Date.now() - 6 * HOUR;
    await feed(car, along(start, 0, 4));
    const query = new URLSearchParams({ vehicleId: car.id, from: new Date(start).toISOString(), to: new Date(start + HOUR).toISOString() }).toString();
    const res = await h.request("GET", `/api/routes/line?${query}`, as(ana));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.line.length).toBeGreaterThanOrEqual(2);
    expect(res.json.line.length).toBeLessThan(10);
    expect(res.json.lengthM).toBeGreaterThan(3900);
    expect(res.json.lengthM).toBeLessThan(4100);
    expect((await h.request("GET", `/api/routes/line?${query}`, as(bea))).status).toBe(404);
    const empty = new URLSearchParams({ vehicleId: car.id, from: new Date(start - 3 * HOUR).toISOString(), to: new Date(start - 2 * HOUR).toISOString() }).toString();
    expect((await h.request("GET", `/api/routes/line?${empty}`, as(ana))).status).toBe(400);
  });
});

describe("module H: dispatch and tracking", () => {
  it("a five-stop route is dispatched, followed automatically from the positions and closed", async () => {
    const car = await addVehicle(ana, "Camión de reparto");
    const plan = ((await h.request("GET", "/api/routes/plans", as(ana))).json.plans as RoutePlan[])[0] as RoutePlan;
    const start = Date.now() - 4 * HOUR;
    const made = await h.request("POST", "/api/routes/trips", { ...as(ana), body: { name: "Reparto del lunes", planId: plan.id, vehicleId: car.id, driver: "Carlos Mejía", startsAt: new Date(start).toISOString() } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    let trip = made.json.trip as RouteTrip;
    expect(trip).toMatchObject({ name: "Reparto del lunes", status: "assigned", vehicleName: "Camión de reparto", driver: "Carlos Mejía", planId: plan.id, offRoute: false, toleranceM: 200 });
    expect(trip.stops.map((s) => [s.seq, s.name, s.status])).toEqual(FIVE.map((s, i) => [i + 1, s.name, "pending"]));
    // Each stop, with the time it is expected to arrive.
    expect(trip.stops.map((s) => (Date.parse(s.plannedAt as string) - start) / MIN)).toEqual([10, 20, 30, 40, 50]);
    expect(trip.line).toHaveLength(2);

    // It leaves and reaches the first stop.
    await feed(car, along(start, 0, 1));
    trip = await tripOf(ana, trip.id);
    expect(trip.status).toBe("in_progress");
    expect(trip.startedAt).not.toBeNull();
    expect(trip.stops.map((s) => s.status)).toEqual(["arrived", "pending", "pending", "pending", "pending"]);
    expect(trip.stops[0]?.arrivedAt).not.toBeNull();
    // It continues: it left the first one (it is visited) and is at the third.
    await feed(car, along(start + 5 * MIN, 1.5, 3));
    trip = await tripOf(ana, trip.id);
    expect(trip.stops.map((s) => s.status)).toEqual(["done", "done", "arrived", "pending", "pending"]);
    // The road ends: the dispatch closes by itself.
    await feed(car, along(start + 10 * MIN, 3.5, 5.5));
    trip = await tripOf(ana, trip.id);
    expect(trip.stops.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(trip).toMatchObject({ status: "done", offRoute: false });
    expect(trip.finishedAt).not.toBeNull();
    // It followed its road: no deviation notification.
    expect(await eventsOf(ana, car)).toEqual([]);
    // Another account does not see it, nor does whoever has no session.
    expect((await h.request("GET", `/api/routes/trips/${trip.id}`, as(bea))).status).toBe(404);
    expect(((await h.request("GET", "/api/routes/trips", as(ana))).json.trips as RouteTrip[]).some((t) => t.id === trip.id)).toBe(true);
    expect((await h.request("GET", "/api/routes/trips", as(bea))).json.trips).toEqual([]);
  });

  it("notifies when the vehicle strays from its route's road and when it returns", async () => {
    const car = await addVehicle(ana, "Camión curioso");
    const plan = ((await h.request("GET", "/api/routes/plans", as(ana))).json.plans as RoutePlan[])[0] as RoutePlan;
    const start = Date.now() - 3 * HOUR;
    const trip = (await h.request("POST", "/api/routes/trips", { ...as(ana), body: { name: "Reparto con desvío", planId: plan.id, vehicleId: car.id, startsAt: new Date(start).toISOString() } })).json.trip as RouteTrip;
    await feed(car, along(start, 0, 1.5));
    // A single position outside may be a GPS jump: it does not notify.
    await feed(car, [
      { t: start + 5 * MIN, km: 1.6, north: 700 },
      { t: start + 5.5 * MIN, km: 1.7 },
    ]);
    expect(await eventsOf(ana, car)).toEqual([]);
    expect((await tripOf(ana, trip.id)).offRoute).toBe(false);
    // Two in a row, 600 metres from the road: it deviated.
    await feed(car, [
      { t: start + 6 * MIN, km: 1.8, north: 600 },
      { t: start + 6.5 * MIN, km: 1.9, north: 600 },
      { t: start + 7 * MIN, km: 1.9, north: 620 },
    ]);
    let events = await eventsOf(ana, car);
    expect(events.map((e) => e.type)).toEqual(["route_deviation"]);
    expect(events[0]?.geofenceName).toBe("Reparto con desvío");
    expect(events[0]?.detail.meters).toBeGreaterThan(550);
    expect(events[0]?.detail.meters).toBeLessThan(650);
    expect((await tripOf(ana, trip.id)).offRoute).toBe(true);
    // It returns to the road.
    await feed(car, [
      { t: start + 8 * MIN, km: 2.2, north: 50 },
      { t: start + 8.5 * MIN, km: 2.5 },
    ]);
    events = await eventsOf(ana, car);
    expect(events.map((e) => e.type)).toEqual(["route_deviation", "route_return"]);
    const after = await tripOf(ana, trip.id);
    expect(after).toMatchObject({ offRoute: false, status: "in_progress" });
    // What was cancelled is no longer followed.
    const cancelled = await h.request("PUT", `/api/routes/trips/${trip.id}/status`, { ...as(ana), body: { status: "cancelled" } });
    expect(cancelled.json.trip).toMatchObject({ status: "cancelled" });
    await feed(car, [
      { t: start + 10 * MIN, km: 3, north: 900 },
      { t: start + 10.5 * MIN, km: 3, north: 900 },
    ]);
    expect((await eventsOf(ana, car)).map((e) => e.type)).toEqual(["route_deviation", "route_return"]);
    expect((await h.request("PUT", `/api/routes/trips/${trip.id}/status`, { ...as(ana), body: { status: "done" } })).status).toBe(400);
  });

  it("proposes the nearest available vehicle to a destination", async () => {
    const near = await addVehicle(bea, "Pickup cercana");
    const far = await addVehicle(bea, "Camión lejano");
    const busy = await addVehicle(bea, "Furgón ocupado");
    const shop = await addVehicle(bea, "Moto en taller");
    await addVehicle(bea, "Sedán sin reportar");
    const now = Date.now() - 2 * MIN;
    await feed(near, [{ t: now, km: 1 }]);
    await feed(far, [{ t: now, km: 9 }]);
    await feed(busy, [{ t: now, km: 0.2 }]);
    await feed(shop, [{ t: now, km: 0.1 }]);
    await h.request("POST", "/api/routes/trips", { ...as(bea), body: { name: "Entrega urgente", vehicleId: busy.id, startsAt: new Date(now - HOUR).toISOString(), stops: [stopAt("Lejos", 30)] } });
    expect((await h.request("PUT", `/api/vehicles/${shop.id}/fleet/status`, { ...as(bea), body: { status: "workshop" } })).status).toBe(200);
    const res = await h.request("GET", `/api/routes/nearest?lat=${at(0).lat}&lon=${at(0).lon}`, as(bea));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const list = res.json.vehicles as NearbyVehicle[];
    expect(list.map((v) => [v.name, v.available, v.busy])).toEqual([
      ["Pickup cercana", true, null],
      ["Camión lejano", true, null],
      ["Moto en taller", false, "En taller"],
      ["Furgón ocupado", false, "En la ruta «Entrega urgente»"],
      ["Sedán sin reportar", false, "No está reportando"],
    ]);
    expect(list[0]?.distanceM).toBeGreaterThan(950);
    expect(list[0]?.distanceM).toBeLessThan(1050);
    expect(list.at(-1)?.distanceM).toBeNull();
    expect((await h.request("GET", "/api/routes/nearest?lat=99&lon=0", as(bea))).status).toBe(400);
  });
});

describe("module H: the driver and whoever awaits the delivery", () => {
  it("with their link, the driver handles their stops and leaves the proof of delivery", async () => {
    const car = await addVehicle(ana, "Moto de mensajería");
    const body = { name: "Mensajería de la tarde", vehicleId: car.id, driver: "Rosa Díaz", startsAt: new Date(Date.now() + HOUR).toISOString(), stops: [stopAt("Farmacia Kielsa", 40, { contact: "Doña Marta" }), stopAt("Oficina Banpaís", 41), stopAt("Tienda La Colonia", 42)] };
    const trip = (await h.request("POST", "/api/routes/trips", { ...as(ana), body })).json.trip as RouteTrip;
    expect(trip.stops[0]).toMatchObject({ contact: "Doña Marta", status: "pending", hasPhoto: false, hasSignature: false });
    // Only whoever dispatches creates the link.
    expect((await h.request("POST", `/api/routes/trips/${trip.id}/link`, as(bea))).status).toBe(404);
    const token = (await h.request("POST", `/api/routes/trips/${trip.id}/link`, as(ana))).json.token as string;
    expect(token.length).toBeGreaterThan(20);

    // Without an account: the link key is enough. A made-up key shows nothing.
    const seen = await h.request("POST", "/api/routes/driver/view", { body: { token } });
    expect(seen.status, JSON.stringify(seen.json)).toBe(200);
    const view = seen.json.view as DriverTripView;
    expect(view).toMatchObject({ account: "Ana Rutas", name: "Mensajería de la tarde", vehicleName: "Moto de mensajería", driver: "Rosa Díaz", status: "assigned" });
    expect(view.stops.map((s) => s.name)).toEqual(["Farmacia Kielsa", "Oficina Banpaís", "Tienda La Colonia"]);
    expect((await h.request("POST", "/api/routes/driver/view", { body: { token: "x".repeat(32) } })).status).toBe(404);
    expect((await h.request("POST", "/api/routes/driver/view", { body: {} })).status).toBe(404);

    // It reaches the first one: the route starts.
    const first = view.stops[0]?.id as string;
    const arrived = await h.request("POST", "/api/routes/driver/stop", { body: { token, stopId: first, status: "arrived" } });
    expect((arrived.json.view as DriverTripView).status).toBe("in_progress");
    expect((arrived.json.view as DriverTripView).stops[0]).toMatchObject({ status: "arrived" });
    // Photo and signature of whoever receives.
    const proof = (kind: string, key: string, type = "image/png", payload = PNG) =>
      h.fastify.inject({ method: "POST", url: `/api/routes/driver/proof?stopId=${first}&kind=${kind}`, headers: { origin: ORIGIN, "content-type": type, "x-route-token": key }, payload });
    expect((await proof("photo", token)).statusCode).toBe(201);
    expect((await proof("signature", token)).statusCode).toBe(201);
    expect((await proof("photo", "y".repeat(32))).statusCode).toBe(404);
    expect((await proof("photo", token, "image/png", Buffer.alloc(0))).statusCode).toBe(400);
    expect((await proof("video", token)).statusCode).toBe(400);
    const done = await h.request("POST", "/api/routes/driver/stop", { body: { token, stopId: first, status: "done", recipient: "Marta López", note: "Recibió en caja" } });
    expect((done.json.view as DriverTripView).stops[0]).toMatchObject({ status: "done", recipient: "Marta López", note: "Recibió en caja", hasPhoto: true, hasSignature: true });
    // The second could not be delivered.
    const second = view.stops[1]?.id as string;
    const failed = await h.request("POST", "/api/routes/driver/stop", { body: { token, stopId: second, status: "failed", note: "Oficina cerrada" } });
    expect((failed.json.view as DriverTripView).stops[1]).toMatchObject({ status: "failed", note: "Oficina cerrada" });
    // A stop of another dispatch is not touched with this link.
    expect((await h.request("POST", "/api/routes/driver/stop", { body: { token, stopId: "01a20100-e157-7b84-b90a-7bc47908ba04", status: "done" } })).status).toBe(404);

    // Whoever dispatches sees the proof of delivery; another account does not.
    const file = join(h.config.filesDir, "routes", ana.orgId, trip.id, `${first}-photo`);
    expect(existsSync(file)).toBe(true);
    const photo = await h.fastify.inject({ method: "GET", url: `/api/routes/stops/${first}/proof/photo`, headers: { cookie: ana.cookie } });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers["content-type"]).toBe("image/png");
    expect(photo.rawPayload.equals(PNG)).toBe(true);
    expect((await h.fastify.inject({ method: "GET", url: `/api/routes/stops/${first}/proof/photo`, headers: { cookie: bea.cookie } })).statusCode).toBe(404);
    expect((await h.fastify.inject({ method: "GET", url: `/api/routes/stops/${second}/proof/photo`, headers: { cookie: ana.cookie } })).statusCode).toBe(404);

    // A new link voids the previous one.
    const fresh = (await h.request("POST", `/api/routes/trips/${trip.id}/link`, as(ana))).json.token as string;
    expect((await h.request("POST", "/api/routes/driver/view", { body: { token } })).status).toBe(404);
    // The route ends: what was not handled is left as skipped.
    const ended = await h.request("POST", "/api/routes/driver/status", { body: { token: fresh, status: "done" } });
    expect((ended.json.view as DriverTripView).status).toBe("done");
    expect((ended.json.view as DriverTripView).stops.map((s) => s.status)).toEqual(["done", "failed", "skipped"]);
    expect(await tripOf(ana, trip.id)).toMatchObject({ status: "done" });
    // When the dispatch is deleted, its files go.
    expect((await h.request("DELETE", `/api/routes/trips/${trip.id}`, as(bea))).status).toBe(404);
    expect((await h.request("DELETE", `/api/routes/trips/${trip.id}`, as(ana))).status).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect((await h.request("POST", "/api/routes/driver/view", { body: { token: fresh } })).status).toBe(404);
  });

  it("whoever awaits a delivery follows it with their link, and sees the vehicle only while it is on its way", async () => {
    const car = await addVehicle(ana, "Furgón de entregas");
    const start = Date.now() - 90 * MIN;
    const trip = (await h.request("POST", "/api/routes/trips", { ...as(ana), body: { name: "Entregas a domicilio", vehicleId: car.id, startsAt: new Date(start).toISOString(), stops: [stopAt("Casa de Luis", 61), stopAt("Casa de Elena", 62)] } })).json.trip as RouteTrip;
    const elena = trip.stops[1]?.id as string;
    expect((await h.request("POST", `/api/routes/stops/${elena}/link`, as(bea))).status).toBe(404);
    const token = (await h.request("POST", `/api/routes/stops/${elena}/link`, as(ana))).json.token as string;
    const view = async () => {
      const res = await h.request("POST", "/api/routes/track/view", { body: { token } });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return res.json.view as DeliveryView;
    };
    // Before leaving: pending, with one stop ahead, and without showing where the vehicle is.
    expect(await view()).toMatchObject({ account: "Ana Rutas", stopName: "Casa de Elena", status: "pending", tripStatus: "assigned", stopsBefore: 1, vehicle: null });
    // On its way: the vehicle is seen.
    await feed(car, [{ t: start + MIN, km: 60.5 }]);
    let now = await view();
    expect(now).toMatchObject({ tripStatus: "in_progress", status: "pending", stopsBefore: 1 });
    expect(now.vehicle?.lat).toBeCloseTo(LAT, 3);
    expect(now.vehicle?.moving).toBe(true);
    expect(now.destination.lon).toBeCloseTo(at(62).lon, 5);
    // It passes the first and reaches this one.
    await feed(car, [
      { t: start + 2 * MIN, km: 61 },
      { t: start + 3 * MIN, km: 61.5 },
      { t: start + 4 * MIN, km: 62 },
    ]);
    now = await view();
    expect(now).toMatchObject({ status: "arrived", stopsBefore: 0 });
    expect(now.arrivedAt).not.toBeNull();
    // Delivered from the dispatch: the vehicle is no longer shown.
    const closed = await h.request("PUT", `/api/routes/stops/${elena}`, { ...as(ana), body: { status: "done", recipient: "Elena", note: null } });
    expect(closed.json.trip).toMatchObject({ status: "done" });
    expect(await view()).toMatchObject({ status: "done", tripStatus: "done", vehicle: null });
    expect((await h.request("POST", "/api/routes/track/view", { body: { token: "z".repeat(32) } })).status).toBe(404);
    expect((await h.request("PUT", `/api/routes/stops/${elena}`, { ...as(bea), body: { status: "pending" } })).status).toBe(404);
  });
});
