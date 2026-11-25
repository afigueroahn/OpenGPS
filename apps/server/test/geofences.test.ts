// Geofences through the API and the event engine: creation, permissions, entries and
// exits, forbidden and authorised zones, schedules, dwell times, routes and
// geofences shared with groups.
import { type LonLat, type VehicleEvent, type WeekSchedule, offset } from "@opengps/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser; // owner
let otherAccount: TestUser; // another account

const center: LonLat = [-87.2068, 14.0818];
/** Point so many metres east and north of the centre. */
const at = (east: number, north = 0): LonLat => offset(offset(center, east, 90), north, 0);
const MIN = 60_000;
/** Everything happens a few hours ago, minute by minute. */
const T0 = Date.now() - 6 * 60 * MIN;
const ALWAYS: WeekSchedule = { zone: "UTC", days: Array.from({ length: 7 }, () => [0, 1440] as [number, number]) };
/** Schedule that only applies on a day of the week other than today and yesterday. */
const NEVER_NOW: WeekSchedule = { zone: "UTC", days: Array.from({ length: 7 }, (_, d) => (d === (new Date(T0).getUTCDay() + 3) % 7 ? ([0, 1440] as [number, number]) : null)) };

const as = (user: TestUser) => ({ cookie: user.cookie });
const circle = (east: number, radiusM = 200) => ({ shape: "circle" as const, center: at(east), radiusM });

async function addVehicle(user: TestUser, name: string, groupId?: string) {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId: "h02" } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const id = res.json.vehicle.id as string;
  if (groupId) expect((await h.request("PATCH", `/api/vehicles/${id}`, { ...as(user), body: { groupId } })).status).toBe(200);
  return { id, deviceId: h.traccar.devices.get(uniqueId) as number };
}
async function addGeofence(user: TestUser, body: Record<string, unknown>) {
  const res = await h.request("POST", "/api/geofences", { ...as(user), body });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.geofence as { id: string; name: string };
}
const addGroup = async (name: string) => (await h.request("POST", "/api/groups", { ...as(ana), body: { name } })).json.group.id as string;

/** The vehicle reports from those points, one per minute starting at the given minute. */
async function report(vehicle: { deviceId: number }, fromMinute: number, points: LonLat[]) {
  const rows = points.map((p, i) => traccarRow(vehicle.deviceId, { fix: new Date(T0 + (fromMinute + i) * MIN), lon: p[0], lat: p[1], knots: 10 }));
  await h.ingestFrom(rows).tick();
  await h.events.idle();
}
const eventsOf = async (user: TestUser, query = "") => (await h.request("GET", `/api/events?limit=200${query}`, as(user))).json.events as VehicleEvent[];
const typesFor = async (vehicleId: string) => (await eventsOf(ana, `&vehicleId=${vehicleId}`)).map((e) => e.type).reverse();

async function join(name: string, role: string, groups: string[] | null, vehicles: string[] = []) {
  const person = await h.signUp(name);
  const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role, groups, vehicles } });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);
  expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
  return person;
}

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Geocercas");
  otherAccount = await h.signUp("Otra Cuenta");
});
afterAll(async () => {
  await h?.close();
});
// Each test starts with no geofences, so that one's do not affect another's.
beforeEach(async () => {
  await h.db.core.query(`DELETE FROM gps.geofences WHERE org_id = $1`, [ana.orgId]);
  h.bus.emit("geofences_changed", { orgId: ana.orgId });
});

describe("geofences: creation and permissions", () => {
  it("creates, lists, edits and deletes a circular zone and a polygonal one", async () => {
    const yard = await addGeofence(ana, { name: "Patio", geometry: circle(0, 150) });
    const square = { shape: "polygon", ring: [at(1000, 0), at(1400, 0), at(1400, 400), at(1000, 400)] };
    const depot = await addGeofence(ana, { name: "Bodega", geometry: square, kind: "authorized", minStayMin: 5, maxStayMin: 120 });

    const listed = await h.request("GET", "/api/geofences", as(ana));
    expect(listed.json.geofences.map((g: { name: string }) => g.name)).toEqual(["Bodega", "Patio"]);
    expect(listed.json.geofences[0]).toMatchObject({ kind: "authorized", minStayMin: 5, maxStayMin: 120, groupIds: null, active: true, inside: 0, geometry: square });

    const edited = await h.request("PUT", `/api/geofences/${yard.id}`, { ...as(ana), body: { name: "Patio central", geometry: circle(0, 300), kind: "forbidden", schedule: ALWAYS } });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect(edited.json.geofence).toMatchObject({ name: "Patio central", kind: "forbidden", schedule: ALWAYS });
    expect(edited.json.geofence.geometry.radiusM).toBe(300);

    expect((await h.request("DELETE", `/api/geofences/${depot.id}`, as(ana))).status).toBe(204);
    expect((await h.request("GET", "/api/geofences", as(ana))).json.geofences).toHaveLength(1);
    const audit = await h.request("GET", "/api/audit?limit=20", as(ana));
    expect(audit.json.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["geofence.create", "geofence.update", "geofence.delete"]));
  });

  it("rejects invalid shapes", async () => {
    const post = (geometry: unknown) => h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Mala", geometry } });
    expect((await post({ shape: "circle", center: at(0), radiusM: 3 })).json.error.message).toContain("radio mínimo");
    expect((await post({ shape: "polygon", ring: [at(0, 0), at(200, 200), at(200, 0), at(0, 200)] })).json.error.message).toContain("se cruzan");
    expect((await post({ shape: "corridor", line: [at(0)], widthM: 100 })).status).toBe(400);
    expect((await post({ shape: "triangle" })).status).toBe(400);
    expect((await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "", geometry: circle(0) } })).status).toBe(400);
  });

  it("another account cannot see or touch them, and a reader cannot create them", async () => {
    const yard = await addGeofence(ana, { name: "Patio", geometry: circle(0) });
    expect((await h.request("GET", "/api/geofences", as(otherAccount))).json.geofences).toEqual([]);
    expect((await h.request("PUT", `/api/geofences/${yard.id}`, { ...as(otherAccount), body: { name: "Robada", geometry: circle(0) } })).status).toBe(404);
    expect((await h.request("DELETE", `/api/geofences/${yard.id}`, as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", "/api/geofences", {})).status).toBe(401);

    const reader = await join("Lector de Geocercas", "viewer", null);
    expect((await h.request("GET", "/api/geofences", as(reader))).json.geofences).toHaveLength(1);
    expect((await h.request("POST", "/api/geofences", { ...as(reader), body: { name: "No", geometry: circle(0) } })).status).toBe(403);
    expect((await h.request("DELETE", `/api/geofences/${yard.id}`, as(reader))).status).toBe(403);
    const operator = await join("Operador de Geocercas", "operator", null);
    expect((await h.request("POST", "/api/geofences", { ...as(operator), body: { name: "Sí", geometry: circle(500) } })).status).toBe(201);
  });
});

describe("geofences: entries and exits", () => {
  it("records the entry and the exit, without being fooled by the edge", async () => {
    const yard = await addGeofence(ana, { name: "Patio", geometry: circle(0, 200) });
    const truck = await addVehicle(ana, "Camión 1");
    const heard: VehicleEvent[] = [];
    const off = h.bus.on("event", (e) => heard.push(e.event));

    // Arrives from afar: the first position only records where it is.
    await report(truck, 0, [at(900), at(500)]);
    expect(await typesFor(truck.id)).toEqual([]);
    // Enters, moves inside and brushes the edge from outside (at 10 m): still inside.
    await report(truck, 2, [at(150), at(50), at(210)]);
    expect(await typesFor(truck.id)).toEqual(["geofence_enter"]);
    expect((await h.request("GET", "/api/geofences", as(ana))).json.geofences[0].inside).toBe(1);
    // Really moves away.
    await report(truck, 8, [at(260), at(600)]);
    off();

    const events = await eventsOf(ana, `&vehicleId=${truck.id}`);
    expect(events.map((e) => e.type)).toEqual(["geofence_exit", "geofence_enter"]);
    expect(events[0]).toMatchObject({ vehicleName: "Camión 1", geofenceId: yard.id, geofenceName: "Patio", detail: { stayedMin: 6 } });
    expect(events[1]?.at).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect(events[1]?.lon).toBeCloseTo(at(150)[0], 5);
    expect(heard.map((e) => e.type)).toEqual(["geofence_enter", "geofence_exit"]);
    expect((await h.request("GET", "/api/geofences", as(ana))).json.geofences[0].inside).toBe(0);

    // Filters and isolation.
    expect(await eventsOf(ana, `&geofenceId=${yard.id}`)).toHaveLength(2);
    expect(await eventsOf(ana, `&vehicleId=${truck.id}&alerts=1`)).toEqual([]);
    expect(await eventsOf(otherAccount)).toEqual([]);
    expect((await h.request("GET", "/api/events", {})).status).toBe(401);
  });

  it("late data does not trigger notifications from the past", async () => {
    await addGeofence(ana, { name: "Patio", geometry: circle(0, 200) });
    const truck = await addVehicle(ana, "Camión con atraso");
    await report(truck, 20, [at(900), at(800)]);
    // The device now uploads an old position that fell inside the zone.
    await report(truck, 5, [at(0)]);
    expect(await typesFor(truck.id)).toEqual([]);
  });

  it("a device that was offline delivers what it stored and the events keep their real time", async () => {
    const yard = await addGeofence(ana, { name: "Patio", geometry: circle(0, 200), minStayMin: 30 });
    const truck = await addVehicle(ana, "Camión sin cobertura");
    await report(truck, 30, [at(900)]);
    // Half an hour without coverage. On return, the device uploads at once what it stored: it entered, stayed 15 minutes and left.
    const stored = [
      [40, at(0)],
      [48, at(20)],
      [55, at(900)],
      [58, at(1500)],
    ] as const;
    const rows = stored.map(([minute, p]) => traccarRow(truck.deviceId, { fix: new Date(T0 + minute * MIN), lon: p[0], lat: p[1], knots: 10 }));
    expect(await h.ingestFrom(rows).tick()).toBe(4);
    await h.events.idle();

    const events = (await eventsOf(ana, `&vehicleId=${truck.id}`)).reverse();
    expect(events.map((e) => [e.type, e.at])).toEqual([
      ["geofence_enter", new Date(T0 + 40 * MIN).toISOString()],
      ["geofence_exit", new Date(T0 + 55 * MIN).toISOString()],
      ["stay_short", new Date(T0 + 55 * MIN).toISOString()],
    ]);
    expect(events[2]).toMatchObject({ geofenceId: yard.id, detail: { stayedMin: 15, minimumMin: 30 } });
    // The track for that stretch also appears in the history, with its times.
    const from = encodeURIComponent(new Date(T0 + 25 * MIN).toISOString());
    const to = encodeURIComponent(new Date(T0 + 65 * MIN).toISOString());
    const history = (await h.request("GET", `/api/vehicles/${truck.id}/history?from=${from}&to=${to}`, as(ana))).json.history;
    expect(history.summary.positions).toBe(5);
    expect(history.points[0].t).toBe(Math.round((T0 + 30 * MIN) / 1000));
  });

  it("forbidden zone: notifies on entry, but not outside its schedule", async () => {
    await addGeofence(ana, { name: "Zona roja", geometry: circle(0, 200), kind: "forbidden" });
    await addGeofence(ana, { name: "Zona roja nocturna", geometry: circle(3000, 200), kind: "forbidden", schedule: NEVER_NOW });
    const truck = await addVehicle(ana, "Camión 2");
    await report(truck, 0, [at(900), at(0), at(900), at(3000), at(900)]);
    expect(await typesFor(truck.id)).toEqual(["zone_forbidden", "geofence_exit", "geofence_enter", "geofence_exit"]);
    const alerts = await eventsOf(ana, `&vehicleId=${truck.id}&alerts=1`);
    expect(alerts.map((e) => [e.type, e.geofenceName])).toEqual([["zone_forbidden", "Zona roja"]]);
  });

  it("authorised zone: notifies on exit", async () => {
    await addGeofence(ana, { name: "Ciudad", geometry: circle(0, 500), kind: "authorized", schedule: ALWAYS });
    const truck = await addVehicle(ana, "Camión 3");
    await report(truck, 0, [at(100), at(300), at(900), at(100)]);
    expect(await typesFor(truck.id)).toEqual(["zone_left", "geofence_enter"]);
  });

  it("route with tolerance: notifies about the deviation and the return", async () => {
    const route = { shape: "corridor", line: [at(0, 0), at(2000, 0), at(2000, 1500)], widthM: 120 };
    await addGeofence(ana, { name: "Ruta al puerto", geometry: route });
    const truck = await addVehicle(ana, "Camión 4");
    // It follows the route (30 m from the line), deviates 300 m and returns.
    await report(truck, 0, [at(200, 30), at(900, -20), at(1200, 300), at(1900, 10), at(2010, 700)]);
    const events = await eventsOf(ana, `&vehicleId=${truck.id}`);
    expect(events.map((e) => e.type).reverse()).toEqual(["route_deviation", "route_return"]);
    expect(events[1]).toMatchObject({ geofenceName: "Ruta al puerto" });
    // The geofence was saved as authorised: its type is not chosen on a route.
    expect((await h.request("GET", "/api/geofences", as(ana))).json.geofences[0].kind).toBe("authorized");
  });

  it("changing a geofence's shape does not invent entries", async () => {
    const yard = await addGeofence(ana, { name: "Patio", geometry: circle(0, 100) });
    const truck = await addVehicle(ana, "Camión 5");
    await report(truck, 0, [at(400)]);
    // The zone grows and now covers the truck, which did not move.
    expect((await h.request("PUT", `/api/geofences/${yard.id}`, { ...as(ana), body: { name: "Patio", geometry: circle(0, 800) } })).status).toBe(200);
    await report(truck, 1, [at(400), at(300)]);
    expect(await typesFor(truck.id)).toEqual([]);
    expect((await h.request("GET", "/api/geofences", as(ana))).json.geofences[0].inside).toBe(1);
    // When it leaves, that is recorded; the dwell time is not invented because it was never seen entering.
    await report(truck, 3, [at(1200)]);
    const events = await eventsOf(ana, `&vehicleId=${truck.id}`);
    expect(events.map((e) => e.type)).toEqual(["geofence_exit"]);
    expect(events[0]?.detail).toEqual({});
  });

  it("when the geofence is deleted its events can still be understood", async () => {
    const yard = await addGeofence(ana, { name: "Patio viejo", geometry: circle(0, 200) });
    const truck = await addVehicle(ana, "Camión 6");
    await report(truck, 0, [at(900), at(0)]);
    expect((await h.request("DELETE", `/api/geofences/${yard.id}`, as(ana))).status).toBe(204);
    const events = await eventsOf(ana, `&vehicleId=${truck.id}`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "geofence_enter", geofenceId: null, geofenceName: "Patio viejo" });
    // Without geofences, the following positions generate nothing.
    await report(truck, 5, [at(900)]);
    expect(await typesFor(truck.id)).toEqual(["geofence_enter"]);
  });
});

describe("geofences: dwell time and schedules", () => {
  it("minimum dwell: notifies if the vehicle leaves too soon", async () => {
    await addGeofence(ana, { name: "Cliente", geometry: circle(0, 200), minStayMin: 10 });
    const truck = await addVehicle(ana, "Camión 7");
    // Enters at minute 1 and leaves at 4: a three-minute visit.
    await report(truck, 0, [at(900), at(0), at(0), at(0), at(900)]);
    const events = await eventsOf(ana, `&vehicleId=${truck.id}`);
    expect(events.map((e) => e.type).reverse()).toEqual(["geofence_enter", "geofence_exit", "stay_short"]);
    expect(events[0]?.detail).toEqual({ stayedMin: 3, minimumMin: 10 });
    // A long visit does not notify.
    await report(truck, 10, [at(0), ...Array.from({ length: 12 }, () => at(10)), at(900)]);
    expect((await typesFor(truck.id)).slice(3)).toEqual(["geofence_enter", "geofence_exit"]);
  });

  it("maximum dwell: notifies only once when the time is exceeded", async () => {
    await addGeofence(ana, { name: "Taller", geometry: circle(0, 200), maxStayMin: 30 });
    const truck = await addVehicle(ana, "Camión 8");
    await report(truck, 0, [at(900), at(0)]);
    const entered = T0 + 1 * MIN;
    expect(await h.events.sweep(entered + 20 * MIN, ana.orgId)).toBe(0);
    expect(await h.events.sweep(entered + 45 * MIN, ana.orgId)).toBe(1);
    expect(await h.events.sweep(entered + 50 * MIN, ana.orgId)).toBe(0);
    const events = await eventsOf(ana, `&vehicleId=${truck.id}&alerts=1`);
    expect(events.map((e) => e.type)).toEqual(["stay_long"]);
    expect(events[0]).toMatchObject({ geofenceName: "Taller", detail: { stayedMin: 45, maximumMin: 30 } });
    expect(events[0]?.lon).toBeCloseTo(center[0], 5);
  });

  it("schedule: notifies at the start if the vehicle is already where it should not be", async () => {
    // The schedule starts an hour after the reports and lasts an hour.
    const opens = T0 + 70 * MIN;
    const minute = new Date(opens).getUTCHours() * 60 + new Date(opens).getUTCMinutes();
    const window: WeekSchedule = { zone: "UTC", days: Array.from({ length: 7 }, () => [minute, (minute + 60) % 1440] as [number, number]) };
    await addGeofence(ana, { name: "Base nocturna", geometry: circle(0, 200), kind: "authorized", schedule: window });
    await addGeofence(ana, { name: "Zona vedada", geometry: circle(3000, 200), kind: "forbidden", schedule: window });
    const outside = await addVehicle(ana, "Fuera de base");
    const inside = await addVehicle(ana, "En zona vedada");
    const fine = await addVehicle(ana, "En la base");
    await report(outside, 0, [at(900), at(950)]);
    await report(inside, 0, [at(3000), at(3010)]);
    await report(fine, 0, [at(0), at(10)]);

    // Before the schedule opens nothing happens.
    expect(await h.events.sweep(opens - 5 * MIN, ana.orgId)).toBe(0);
    // On opening: two are outside the base, and one of them is also inside the forbidden zone.
    expect(await h.events.sweep(opens + 5 * MIN, ana.orgId)).toBe(3);
    expect(await h.events.sweep(opens + 10 * MIN, ana.orgId)).toBe(0);
    expect((await eventsOf(ana, `&vehicleId=${outside.id}`)).map((e) => [e.type, e.geofenceName, e.detail])).toEqual([["zone_left", "Base nocturna", { bySchedule: true }]]);
    const forbidden = (await eventsOf(ana, `&vehicleId=${inside.id}`)).map((e) => `${e.type}: ${e.geofenceName}`).sort();
    expect(forbidden).toEqual(["zone_forbidden: Zona vedada", "zone_left: Base nocturna"]);
    expect(await typesFor(fine.id)).toEqual([]);
  });
});

describe("geofences shared with groups", () => {
  it("applies only to the vehicles of its groups and only those who see those groups see it", async () => {
    const northGroup = await addGroup(`Norte ${Date.now()}`);
    const south = await addGroup(`Sur ${Date.now()}`);
    const fromNorth = await addVehicle(ana, "Del norte", northGroup);
    const fromSouth = await addVehicle(ana, "Del sur", south);
    const ungrouped = await addVehicle(ana, "Sin grupo");

    const northOnly = await addGeofence(ana, { name: "Bodega norte", geometry: circle(0, 200), groupIds: [northGroup] });
    const general = await addGeofence(ana, { name: "Peaje", geometry: circle(3000, 200) });
    for (const v of [fromNorth, fromSouth, ungrouped]) await report(v, 0, [at(900), at(0), at(900), at(3000)]);
    expect(await typesFor(fromNorth.id)).toEqual(["geofence_enter", "geofence_exit", "geofence_enter"]);
    expect(await typesFor(fromSouth.id)).toEqual(["geofence_enter"]);
    expect(await typesFor(ungrouped.id)).toEqual(["geofence_enter"]);

    // Whoever sees only the south: does not see the northern warehouse or the events of its vehicles.
    const southReader = await join("Lector del Sur", "viewer", [south]);
    expect((await h.request("GET", "/api/geofences", as(southReader))).json.geofences.map((g: { name: string }) => g.name)).toEqual(["Peaje"]);
    expect((await eventsOf(southReader)).map((e) => e.vehicleName)).toEqual(["Del sur"]);
    expect(await eventsOf(southReader, `&geofenceId=${northOnly.id}`)).toEqual([]);

    // A northern operator creates geofences only for the north and does not touch those for the whole account.
    const northOperator = await join("Operador del Norte", "operator", [northGroup]);
    const ownFence = await h.request("POST", "/api/geofences", { ...as(northOperator), body: { name: "Cliente norte", geometry: circle(6000) } });
    expect(ownFence.status, JSON.stringify(ownFence.json)).toBe(201);
    expect(ownFence.json.geofence.groupIds).toEqual([northGroup]);
    expect((await h.request("POST", "/api/geofences", { ...as(northOperator), body: { name: "Ajena", geometry: circle(6000), groupIds: [south] } })).status).toBe(403);
    expect((await h.request("PUT", `/api/geofences/${general.id}`, { ...as(northOperator), body: { name: "Peaje", geometry: circle(3000, 900) } })).status).toBe(403);
    expect((await h.request("DELETE", `/api/geofences/${general.id}`, as(northOperator))).status).toBe(403);
    expect((await h.request("PUT", `/api/geofences/${northOnly.id}`, { ...as(northOperator), body: { name: "Bodega norte 2", geometry: circle(0, 250) } })).status).toBe(200);

    // When the group is deleted, its geofence is left with no vehicles: it does not become applicable to everyone.
    expect((await h.request("DELETE", `/api/groups/${northGroup}`, as(ana))).status).toBe(204);
    const after = (await h.request("GET", "/api/geofences", as(ana))).json.geofences.find((g: { id: string }) => g.id === northOnly.id);
    expect(after.groupIds).toEqual([]);
    await report(ungrouped, 10, [at(900), at(0)]);
    expect((await typesFor(ungrouped.id)).slice(1)).toEqual(["geofence_exit"]);
  });
});

describe("geofences for single vehicles", () => {
  it("applies only to the vehicles it names, and whoever sees one of them sees it", async () => {
    const northGroup = await addGroup(`Norte ${Date.now()}`);
    const truckVehicle = await addVehicle(ana, "Camión", northGroup);
    const motorbike = await addVehicle(ana, "Moto", northGroup);
    const pickup = await addVehicle(ana, "Pickup");

    const created = await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Casa del chofer", geometry: circle(0, 200), vehicleIds: [truckVehicle.id, pickup.id] } });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json.geofence).toMatchObject({ groupIds: null, vehicleIds: [truckVehicle.id, pickup.id] });
    const fence = created.json.geofence as { id: string };
    // Groups and vehicles at once are refused, and so are an empty list and a vehicle of another account.
    expect((await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Mala", geometry: circle(0), groupIds: [northGroup], vehicleIds: [truckVehicle.id] } })).status).toBe(400);
    expect((await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Mala", geometry: circle(0), vehicleIds: [] } })).status).toBe(400);
    const foreign = await h.request("POST", "/api/vehicles", { ...as(otherAccount), body: { name: "Ajeno", uniqueId: h.uniqueId(), modelId: "h02" } });
    expect((await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Mala", geometry: circle(0), vehicleIds: [foreign.json.vehicle.id] } })).status).toBe(400);

    for (const v of [truckVehicle, motorbike, pickup]) await report(v, 0, [at(900), at(0), at(900)]);
    expect(await typesFor(truckVehicle.id)).toEqual(["geofence_enter", "geofence_exit"]);
    expect(await typesFor(pickup.id)).toEqual(["geofence_enter", "geofence_exit"]);
    expect(await typesFor(motorbike.id)).toEqual([]);

    // Whoever sees only the pickup sees the geofence, with the count of what they see; whoever sees only the moto does not.
    const fromPickup = await join("Operador de la pickup", "operator", [], [pickup.id]);
    const fromMotorbike = await join("Lector de la moto", "viewer", [], [motorbike.id]);
    expect((await h.request("GET", "/api/geofences", as(fromPickup))).json.geofences.map((g: { name: string }) => g.name)).toEqual(["Casa del chofer"]);
    expect((await h.request("GET", "/api/geofences", as(fromMotorbike))).json.geofences).toEqual([]);
    expect((await h.request("GET", `/api/geofences/${fence.id}`, as(fromMotorbike))).status).toBe(404);
    // It also names a vehicle they do not see: they can look at it, not change it.
    expect((await h.request("PUT", `/api/geofences/${fence.id}`, { ...as(fromPickup), body: { name: "Tomada", geometry: circle(0, 300), vehicleIds: [pickup.id] } })).status).toBe(403);
    expect((await h.request("DELETE", `/api/geofences/${fence.id}`, as(fromPickup))).status).toBe(403);
    // What they create without choosing is for their vehicle; they cannot name one they do not see.
    const own = await h.request("POST", "/api/geofences", { ...as(fromPickup), body: { name: "Taller", geometry: circle(5000) } });
    expect(own.status, JSON.stringify(own.json)).toBe(201);
    expect(own.json.geofence).toMatchObject({ groupIds: null, vehicleIds: [pickup.id] });
    expect((await h.request("POST", "/api/geofences", { ...as(fromPickup), body: { name: "Ajena", geometry: circle(5000), vehicleIds: [truckVehicle.id] } })).status).toBe(400);
    expect((await h.request("PUT", `/api/geofences/${own.json.geofence.id}`, { ...as(fromPickup), body: { name: "Taller 2", geometry: circle(5000, 300), vehicleIds: [pickup.id] } })).status).toBe(200);

    // Changing whom it applies to forgets who was inside, and the new vehicle starts being watched.
    const changed = await h.request("PUT", `/api/geofences/${fence.id}`, { ...as(ana), body: { name: "Casa del chofer", geometry: circle(0, 200), vehicleIds: [motorbike.id] } });
    expect(changed.json.geofence).toMatchObject({ vehicleIds: [motorbike.id], inside: 0 });
    await report(motorbike, 10, [at(900), at(0)]);
    await report(truckVehicle, 10, [at(900), at(0)]);
    expect(await typesFor(motorbike.id)).toEqual(["geofence_enter"]);
    expect(await typesFor(truckVehicle.id)).toEqual(["geofence_enter", "geofence_exit"]);

    // When the vehicle is deleted the geofence is left with none: it does not become applicable to everyone.
    expect((await h.request("DELETE", `/api/vehicles/${motorbike.id}`, as(ana))).status).toBe(204);
    const after = (await h.request("GET", "/api/geofences", as(ana))).json.geofences.find((g: { id: string }) => g.id === fence.id);
    expect(after.vehicleIds).toEqual([]);
    await report(truckVehicle, 20, [at(900), at(0)]);
    expect(await typesFor(truckVehicle.id)).toEqual(["geofence_enter", "geofence_exit"]);
  });
});
