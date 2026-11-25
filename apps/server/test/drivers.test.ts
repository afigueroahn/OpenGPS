// Module B · Driver: profiles, assignment, driving events, time at
// the wheel, score and ranking.
import { type Driver, type DriverRank, type DriverReport, type VehicleDriver, type VehicleEvent, drivingScore } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";
import type { TraccarRow } from "../src/ingest/poller";

let h: Harness;
let ana: TestUser; // owner, with the module
let otherAccount: TestUser; // another account, without the module

const KNOTS = 1 / 1.852;
const MIN = 60_000;
const HOUR = 3_600_000;
const LAT = 14.0818;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const as = (user: TestUser) => ({ cookie: user.cookie });
/** Each test uses its own time window, far from the others. */
const DAY0 = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const slot = (daysAgo: number, hour = 12) => DAY0 - daysAgo * 86_400_000 + hour * HOUR;

interface Car {
  id: string;
  deviceId: number;
}
async function addVehicle(user: TestUser, name: string, groupId?: string): Promise<Car> {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId: "teltonika" } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const id = res.json.vehicle.id as string;
  if (groupId) expect((await h.request("PATCH", `/api/vehicles/${id}`, { ...as(user), body: { groupId } })).status).toBe(200);
  return { id, deviceId: h.traccar.devices.get(uniqueId) as number };
}
async function addDriver(user: TestUser, name: string, extra: Record<string, unknown> = {}): Promise<Driver> {
  const res = await h.request("POST", "/api/drivers", { ...as(user), body: { name, ...extra } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.driver as Driver;
}
/** Assigns the driver. The tests' positions are in the past, so the assignment is dated by hand. */
async function assign(user: TestUser, car: Car, driverId: string | null, since?: number): Promise<VehicleDriver> {
  const res = await h.request("PUT", `/api/vehicles/${car.id}/driver`, { ...as(user), body: { driverId } });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  if (since !== undefined) {
    await h.db.core.query(`UPDATE gps.driver_assignments SET ends_at = $2 WHERE vehicle_id = $1 AND ends_at > $2`, [car.id, new Date(since)]);
    await h.db.core.query(`UPDATE gps.driver_assignments SET starts_at = $2 WHERE vehicle_id = $1 AND ends_at IS NULL`, [car.id, new Date(since)]);
  }
  return res.json as VehicleDriver;
}

/** Track of a vehicle heading east, stretch by stretch. */
function trackOf(car: Car, start: number) {
  let t = start;
  let lon = -87.2068;
  const rows: TraccarRow[] = [];
  const api = {
    /** Moves forward `seconds` at that speed, with one position every `every` seconds. */
    go(seconds: number, kmh: number, extra: { alarm?: string; key?: string; every?: number } = {}) {
      const every = extra.every ?? 30;
      for (let s = 0; s < seconds; s += every) {
        t += every * 1000;
        lon += ((kmh / 3.6) * every) / M_PER_DEG_LON;
        const attributes = { ignition: kmh > 0, ...(s === 0 && extra.alarm ? { alarm: extra.alarm } : {}), ...(extra.key ? { driverUniqueId: extra.key } : {}) };
        rows.push(traccarRow(car.deviceId, { fix: new Date(t), lon, lat: LAT, knots: kmh * KNOTS, attributes }));
      }
      return api;
    },
    now: () => t,
    async send() {
      await h.ingestFrom(rows.splice(0)).tick();
      await h.settle();
    },
  };
  return api;
}

/** The kilometres come from positions every 30 seconds: they are compared with a margin. */
const near = (meters: number | undefined, km: number) => expect(Math.abs((meters as number) / 1000 - km)).toBeLessThan(0.03 * km + 0.75);
const range = (from: number, to: number) => `from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`;
const rankingOf = async (user: TestUser, from: number, to: number, extra = "") => {
  const res = await h.request("GET", `/api/drivers/ranking?${range(from, to)}${extra}`, as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.ranking as DriverRank[];
};
const reportOf = async (user: TestUser, driverId: string, from: number, to: number) => {
  const res = await h.request("GET", `/api/drivers/${driverId}/report?${range(from, to)}&zone=America/Tegucigalpa`, as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.report as DriverReport;
};
const driverOf = async (user: TestUser, car: Car) => (await h.request("GET", `/api/vehicles/${car.id}/driver`, as(user))).json as VehicleDriver;

async function addMember(owner: TestUser, name: string, role: string, groups: string[] | null) {
  const person = await h.signUp(name);
  const invited = await h.request("POST", "/api/members/invitations", { ...as(owner), body: { email: person.email, role, groups } });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);
  expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
  return person;
}
/** A new account with the module, for tests that count everything in the account. */
async function freshAccount(name: string) {
  const owner = await h.signUp(name);
  await h.enableModules(owner.orgId, ["B"]);
  return owner;
}

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Conductores");
  otherAccount = await h.signUp("Otra Cuenta");
  await h.enableModules(ana.orgId, ["B"]);
});
afterAll(async () => {
  await h?.close();
});

describe("module B: driver profiles", () => {
  it("without the module enabled, its routes do not exist for that account", async () => {
    const car = await addVehicle(otherAccount, "Sin módulo");
    expect((await h.request("GET", "/api/drivers", as(otherAccount))).status).toBe(404);
    expect((await h.request("POST", "/api/drivers", { ...as(otherAccount), body: { name: "Nadie" } })).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${car.id}/driver`, as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", "/api/drivers/settings", as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", "/api/drivers", {})).status).toBe(401);
  });

  it("they are created, edited and deleted; each key belongs to a single driver", async () => {
    const luis = await addDriver(ana, "  Luis Mejía ", { license: "0801-1990-12345", phone: "9999-0000", keyId: "0000a1b2c3d4" });
    expect(luis).toMatchObject({ name: "Luis Mejía", license: "0801-1990-12345", phone: "9999-0000", keyId: "A1B2C3D4", active: true, vehicleId: null, since: null });
    const dup = await h.request("POST", "/api/drivers", { ...as(ana), body: { name: "Otro", keyId: "A1B2C3D4" } });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("driver_key_taken");
    expect((await h.request("POST", "/api/drivers", { ...as(ana), body: { name: "" } })).status).toBe(400);
    expect((await h.request("POST", "/api/drivers", { ...as(ana), body: { name: "Mala llave", keyId: "no-es-hex" } })).status).toBe(400);

    const edited = await h.request("PUT", `/api/drivers/${luis.id}`, { ...as(ana), body: { name: "Luis A. Mejía", notes: "Turno de noche" } });
    expect(edited.json.driver).toMatchObject({ name: "Luis A. Mejía", notes: "Turno de noche", license: null, keyId: null });
    expect((await h.request("GET", "/api/drivers", as(ana))).json.drivers.map((d: Driver) => d.name)).toContain("Luis A. Mejía");

    // Another account cannot reach them even if it has the module.
    await h.enableModules(otherAccount.orgId, ["B"]);
    expect((await h.request("PUT", `/api/drivers/${luis.id}`, { ...as(otherAccount), body: { name: "Robado" } })).status).toBe(404);
    expect((await h.request("DELETE", `/api/drivers/${luis.id}`, as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", "/api/drivers", as(otherAccount))).json.drivers).toEqual([]);
    await h.enableModules(otherAccount.orgId, []);

    expect((await h.request("DELETE", `/api/drivers/${luis.id}`, as(ana))).status).toBe(204);
    expect((await h.request("GET", "/api/drivers", as(ana))).json.drivers.some((d: Driver) => d.id === luis.id)).toBe(false);
    const audit = (await h.request("GET", "/api/audit?limit=20", as(ana))).json.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["driver.create", "driver.update", "driver.delete"]));
  });

  it("a reader sees them but cannot change them", async () => {
    const driver = await addDriver(ana, "Para leer");
    const car = await addVehicle(ana, "De lectura");
    const reader = await addMember(ana, "Lector de conductores", "viewer", null);
    expect((await h.request("GET", "/api/drivers", as(reader))).status).toBe(200);
    expect((await h.request("POST", "/api/drivers", { ...as(reader), body: { name: "No puede" } })).status).toBe(403);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/driver`, { ...as(reader), body: { driverId: driver.id } })).status).toBe(403);
    expect((await h.request("PUT", "/api/drivers/settings", { ...as(reader), body: { speedLimitKmh: 80, speedingSeconds: 5, maxContinuousMin: 120, minRestMin: 15, maxDailyMin: 480 } })).status).toBe(403);
    const operator = await addMember(ana, "Operador de conductores", "operator", null);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/driver`, { ...as(operator), body: { driverId: driver.id } })).status).toBe(200);
  });
});

describe("module B: who drives each vehicle", () => {
  it("a vehicle has one driver at a time, and a driver one vehicle", async () => {
    const [truck, pickup] = [await addVehicle(ana, "Camión 1"), await addVehicle(ana, "Pickup 2")];
    const [rosa, juan] = [await addDriver(ana, "Rosa"), await addDriver(ana, "Juan")];
    expect(await driverOf(ana, truck)).toEqual({ driver: null, unknownKey: null });

    expect((await assign(ana, truck, rosa.id)).driver).toMatchObject({ id: rosa.id, name: "Rosa", source: "manual" });
    // Juan takes the truck: Rosa leaves it.
    expect((await assign(ana, truck, juan.id)).driver).toMatchObject({ id: juan.id });
    // Juan moves to the pickup: the truck is left without a driver.
    await assign(ana, pickup, juan.id);
    expect((await driverOf(ana, truck)).driver).toBeNull();
    const list = (await h.request("GET", "/api/drivers", as(ana))).json.drivers as Driver[];
    expect(list.find((d) => d.id === juan.id)).toMatchObject({ vehicleId: pickup.id });
    expect(list.find((d) => d.id === rosa.id)).toMatchObject({ vehicleId: null, since: null });

    expect((await assign(ana, pickup, null)).driver).toBeNull();
    expect((await h.request("PUT", `/api/vehicles/${pickup.id}/driver`, { ...as(ana), body: { driverId: "018f2f6e-0000-7000-8000-000000000000" } })).status).toBe(404);
    // Deactivated, they leave the vehicle and cannot be assigned another.
    await assign(ana, truck, rosa.id);
    await h.request("PUT", `/api/drivers/${rosa.id}`, { ...as(ana), body: { name: "Rosa", active: false } });
    expect((await driverOf(ana, truck)).driver).toBeNull();
    const refused = await h.request("PUT", `/api/vehicles/${truck.id}/driver`, { ...as(ana), body: { driverId: rosa.id } });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe("driver_inactive");
  });

  it("the driver identifies with their key on the device", async () => {
    const car = await addVehicle(ana, "Con lector de llave");
    const marta = await addDriver(ana, "Marta", { keyId: "1F00BC55" });
    const t0 = slot(2, 3);
    const track = trackOf(car, t0);
    // A key that nobody has registered stays visible, so it can be registered.
    await track.go(60, 40, { key: "00000000000ABCDE" }).send();
    expect(await driverOf(ana, car)).toMatchObject({ driver: null, unknownKey: { key: "ABCDE" } });
    // Marta's key, as the device sends it: padded with zeros.
    await track.go(60, 40, { key: "000000001F00BC55" }).send();
    const now = await driverOf(ana, car);
    expect(now.driver).toMatchObject({ id: marta.id, name: "Marta", source: "key" });
    expect(Date.parse(now.driver?.since as string)).toBe(t0 + 90_000);
    expect(now.unknownKey).toBeNull();
    // When the unknown key is registered, its owner takes the vehicle as soon as it is read again.
    const pedro = await addDriver(ana, "Pedro", { keyId: "abcde" });
    await track.go(60, 40, { key: "00000000000ABCDE" }).send();
    expect((await driverOf(ana, car)).driver).toMatchObject({ id: pedro.id, source: "key" });
    expect((await h.request("GET", "/api/drivers", as(ana))).json.drivers.find((d: Driver) => d.id === marta.id)).toMatchObject({ vehicleId: null });
  });
});

describe("module B: events and score", () => {
  it("counts hard accelerations, hard braking and turns from the device and computes the score per 100 km", async () => {
    const car = await addVehicle(ana, "Con acelerómetro");
    const driver = await addDriver(ana, "Brusco");
    const t0 = slot(3, 2);
    await assign(ana, car, driver.id, t0);
    const track = trackOf(car, t0);
    // 20 km at 60 km/h, with one notification of each kind.
    track.go(300, 60).go(300, 60, { alarm: "hardAcceleration" }).go(300, 60, { alarm: "hardBraking" }).go(300, 60, { alarm: "hardCornering" });
    await track.send();
    const [rank] = (await rankingOf(ana, t0, t0 + 2 * HOUR)).filter((r) => r.driverId === driver.id);
    expect(rank).toMatchObject({ name: "Brusco", counts: { accel: 1, brake: 1, corner: 1, speeding: 0 }, points: 10, daysOverDaily: 0 });
    near(rank?.distanceM, 20);
    expect(rank?.score).toBe(drivingScore(10, (rank as DriverRank).distanceM));
    expect(rank?.score).toBeGreaterThan(45);
    expect(rank?.score).toBeLessThan(55);
    expect(rank?.drivingS).toBeGreaterThan(19 * 60);

    // The same notification received again does not count twice.
    const again = traccarRow(car.deviceId, { fix: new Date(t0 + 330_000), lon: -87.15, lat: LAT, knots: 60 * KNOTS, attributes: { alarm: "hardAcceleration" } });
    await h.ingestFrom([again]).tick();
    await h.settle();
    const report = await reportOf(ana, driver.id, t0, t0 + 2 * HOUR);
    expect(report.rank.counts).toEqual({ accel: 1, brake: 1, corner: 1, speeding: 0 });
    expect(report.events.map((e) => e.type).sort()).toEqual(["accel", "brake", "corner"]);
    expect(report.events[0]).toMatchObject({ vehicleId: car.id, vehicleName: "Con acelerómetro", speedKmh: 60 });
    // With less than 10 km there is no score: the sample is too small.
    expect(drivingScore(3, 9_900)).toBeNull();
    expect(drivingScore(4, 100_000)).toBe(96);
    expect(drivingScore(500, 100_000)).toBe(0);
  });

  it("records speeding under the name of whoever was driving, once per episode", async () => {
    const owner = await freshAccount("Dueña de veloces");
    const car = await addVehicle(owner, "Veloz");
    const driver = await addDriver(owner, "Con prisa");
    const t0 = slot(3, 6);
    const step = { every: 10 };
    const track = trackOf(car, t0);
    // No driver: a sustained excess of 30 seconds.
    await track.go(30, 80, step).go(10, 120, step).go(10, 126, step).go(10, 121, step).go(30, 80, step).send();
    const assignedAt = track.now();
    await assign(owner, car, driver.id, assignedAt);
    // With a driver: a momentary spike, which does not count, and another sustained excess.
    await track.go(20, 80, step).go(10, 135, step).go(30, 80, step).go(40, 112, step).go(30, 80, step).send();

    const ranking = await rankingOf(owner, t0, t0 + HOUR);
    expect(ranking.map((r) => [r.driverId, r.counts.speeding, r.points])).toEqual([
      [driver.id, 1, 5],
      [null, 1, 5],
    ]);
    expect(ranking[1]?.name).toBe("Sin conductor asignado");
    const report = await reportOf(owner, driver.id, t0, t0 + HOUR);
    expect(report.events).toHaveLength(1);
    expect(report.events[0]).toMatchObject({ type: "speeding", speedKmh: 112 });
    const stored = await h.db.core.query<{ speed_kmh: number; detail: { seconds: number; limitKmh: number }; driver_id: string | null }>(
      `SELECT speed_kmh, detail, driver_id FROM gps.driver_events WHERE vehicle_id = $1 ORDER BY at`,
      [car.id],
    );
    expect(stored.rows.map((r) => [Math.round(r.speed_kmh), r.detail.seconds, r.detail.limitKmh, r.driver_id])).toEqual([
      [126, 30, 100, null],
      [112, 40, 100, driver.id],
    ]);

    // With another limit in the account settings, it counts from there.
    const saved = await h.request("PUT", "/api/drivers/settings", { ...as(owner), body: { speedLimitKmh: 70, speedingSeconds: 0, maxContinuousMin: 240, minRestMin: 30, maxDailyMin: 600 } });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect((await h.request("GET", "/api/drivers/settings", as(owner))).json.settings).toMatchObject({ speedLimitKmh: 70, speedingSeconds: 0 });
    await track.go(20, 60, step).go(10, 75, step).go(20, 60, step).send();
    expect((await reportOf(owner, driver.id, t0, t0 + HOUR)).rank.counts.speeding).toBe(2);
    const bad = await h.request("PUT", "/api/drivers/settings", { ...as(owner), body: { speedLimitKmh: 70, speedingSeconds: 0, maxContinuousMin: 60, minRestMin: 60, maxDailyMin: 600 } });
    expect(bad.status).toBe(400);
  });

  it("when a driver is deleted, what they did stays as driven without a driver", async () => {
    const owner = await freshAccount("Dueña de bajas");
    const car = await addVehicle(owner, "Heredado");
    const driver = await addDriver(owner, "Se va");
    const t0 = slot(3, 9);
    await assign(owner, car, driver.id, t0);
    await trackOf(car, t0).go(900, 60, { alarm: "hardBraking" }).send();
    expect((await rankingOf(owner, t0, t0 + HOUR)).map((r) => r.driverId)).toEqual([driver.id]);
    expect((await h.request("DELETE", `/api/drivers/${driver.id}`, as(owner))).status).toBe(204);
    const after = await rankingOf(owner, t0, t0 + HOUR);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ driverId: null, counts: { brake: 1 } });
    near(after[0]?.distanceM, 15);
  });
});

describe("module B: driving time", () => {
  it("warns about the stretch without a break and about the shift, and the report counts them the same", async () => {
    const owner = await freshAccount("Dueña de jornadas");
    const saved = await h.request("PUT", "/api/drivers/settings", { ...as(owner), body: { speedLimitKmh: 100, speedingSeconds: 10, maxContinuousMin: 30, minRestMin: 5, maxDailyMin: 60 } });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const car = await addVehicle(owner, "De ruta larga");
    const driver = await addDriver(owner, "Incansable");
    const t0 = slot(4, 1);
    await assign(owner, car, driver.id, t0);
    const track = trackOf(car, t0);
    // 33 minutes at the wheel, 6 of rest and another 29.
    await track.go(33 * 60, 60).send();
    await track.go(6 * 60, 0).go(29 * 60, 60).go(4 * 60, 0).send();

    const events = ((await h.request("GET", `/api/events?limit=50&vehicleId=${car.id}`, as(owner))).json.events as VehicleEvent[]).filter((e) => e.type === "driving_time").reverse();
    expect(events.map((e) => e.detail)).toEqual([
      { kind: "continuous", minutes: 30, limitMinutes: 30, driverId: driver.id, driverName: "Incansable" },
      { kind: "daily", minutes: 60, limitMinutes: 60, driverId: driver.id, driverName: "Incansable" },
    ]);
    // The first arrives half an hour after departure; the second, at the hour of driving.
    expect(Date.parse((events[0] as VehicleEvent).at) - t0).toBe(30.5 * MIN);
    expect(Date.parse((events[1] as VehicleEvent).at) - t0).toBe((33 + 6 + 28) * MIN);

    const report = await reportOf(owner, driver.id, t0, t0 + 3 * HOUR);
    expect(report.days).toHaveLength(1);
    const day = report.days[0];
    expect(day).toMatchObject({ date: new Date(t0 - 6 * HOUR).toISOString().slice(0, 10), rests: 1 });
    expect(day?.drivingS).toBeGreaterThan(60 * 60);
    expect(day?.drivingS).toBeLessThanOrEqual(62 * 60);
    expect(day?.longestStretchS).toBeGreaterThan(31 * 60);
    expect(day?.longestStretchS).toBeLessThanOrEqual(33 * 60);
    near(day?.distanceM, 62);
    expect(report.rank).toMatchObject({ daysOverDaily: 1, longestStretchS: day?.longestStretchS, drivingS: day?.drivingS });

    // After a long rest another shift begins.
    const next = trackOf(car, t0 + 12 * HOUR);
    await next.go(20 * 60, 60).send();
    const two = await reportOf(owner, driver.id, t0, t0 + 14 * HOUR);
    expect(two.days.map((d) => d.rests)).toEqual([1, 0]);
    expect(two.rank.daysOverDaily).toBe(1);
  });

  it("with another person at the wheel, the time starts from zero", async () => {
    const owner = await freshAccount("Dueña de relevos");
    await h.request("PUT", "/api/drivers/settings", { ...as(owner), body: { speedLimitKmh: 100, speedingSeconds: 10, maxContinuousMin: 30, minRestMin: 5, maxDailyMin: 600 } });
    const car = await addVehicle(owner, "De dos turnos");
    const [driverOne, driverTwo] = [await addDriver(owner, "Uno"), await addDriver(owner, "Dos")];
    const t0 = slot(4, 8);
    await assign(owner, car, driverOne.id, t0);
    const track = trackOf(car, t0);
    await track.go(20 * 60, 60).send();
    // Handover without stopping: Two keeps driving 20 more minutes.
    await assign(owner, car, driverTwo.id, track.now());
    await track.go(20 * 60, 60).send();
    const events = ((await h.request("GET", `/api/events?limit=50&vehicleId=${car.id}`, as(owner))).json.events as VehicleEvent[]).filter((e) => e.type === "driving_time");
    expect(events).toEqual([]);
    // The trip was a single one, but each person gets their half.
    const ranking = await rankingOf(owner, t0, t0 + 2 * HOUR);
    expect(ranking.map((r) => r.name).sort()).toEqual(["Dos", "Uno"]);
    for (const rank of ranking) near(rank.distanceM, 20);
  });
});

describe("module B: ranking", () => {
  it("orders from best to worst score, by period and by group, and respects the scope of whoever is looking", async () => {
    const owner = await freshAccount("Dueña de flota");
    const north = (await h.request("POST", "/api/groups", { ...as(owner), body: { name: "Norte" } })).json.group.id as string;
    const south = (await h.request("POST", "/api/groups", { ...as(owner), body: { name: "Sur" } })).json.group.id as string;
    const [carN, carS] = [await addVehicle(owner, "Del norte", north), await addVehicle(owner, "Del sur", south)];
    const [carefulDriver, recklessDriver] = [await addDriver(owner, "Prudente"), await addDriver(owner, "Temerario")];
    const t0 = slot(5, 4);
    await assign(owner, carN, carefulDriver.id, t0);
    await assign(owner, carS, recklessDriver.id, t0);
    await trackOf(carN, t0).go(1800, 60).send();
    await trackOf(carS, t0).go(600, 60, { alarm: "hardBraking" }).go(600, 60, { alarm: "hardBraking" }).go(600, 60, { alarm: "hardCornering" }).send();

    const all = await rankingOf(owner, t0, t0 + 2 * HOUR);
    expect(all.map((r) => [r.name, r.score])).toEqual([
      ["Prudente", 100],
      ["Temerario", drivingScore(11, (all[1] as DriverRank).distanceM)],
    ]);
    expect(all[1]?.score).toBeLessThan(70);
    // Another period: nobody drove.
    expect(await rankingOf(owner, t0 - 5 * HOUR, t0 - 3 * HOUR)).toEqual([]);
    expect((await rankingOf(owner, t0, t0 + 2 * HOUR, `&groupId=${south}`)).map((r) => r.name)).toEqual(["Temerario"]);
    // A period that is too long or reversed is not accepted.
    expect((await h.request("GET", `/api/drivers/ranking?${range(t0 - 40 * 86_400_000, t0)}`, as(owner))).status).toBe(400);
    expect((await h.request("GET", `/api/drivers/ranking?${range(t0, t0 - HOUR)}`, as(owner))).status).toBe(400);

    const fromSouth = await addMember(owner, "Supervisor del sur", "operator", [south]);
    expect((await rankingOf(fromSouth, t0, t0 + 2 * HOUR)).map((r) => r.name)).toEqual(["Temerario"]);
    // They see nothing driven by the northern driver, nor which vehicle they are in.
    expect((await reportOf(fromSouth, carefulDriver.id, t0, t0 + 2 * HOUR)).rank).toMatchObject({ distanceM: 0, score: null });
    const seen = (await h.request("GET", "/api/drivers", as(fromSouth))).json.drivers as Driver[];
    expect(seen.find((d) => d.id === carefulDriver.id)?.vehicleId).toBeNull();
    expect(seen.find((d) => d.id === recklessDriver.id)?.vehicleId).toBe(carS.id);
    expect((await h.request("PUT", `/api/vehicles/${carN.id}/driver`, { ...as(fromSouth), body: { driverId: recklessDriver.id } })).status).toBe(404);
  });

  it("saves the trips of finished days and redoes them if a late position arrives", async () => {
    const owner = await freshAccount("Dueña de atrasos");
    const car = await addVehicle(owner, "Con memoria");
    const driver = await addDriver(owner, "Puntual");
    const t0 = slot(6, 10);
    await assign(owner, car, driver.id, t0);
    await trackOf(car, t0).go(1200, 60).send();
    // The stored days belong to the core; here the track's own is what matters.
    const saved = () => h.db.core.query<{ day: string }>(`SELECT day::text FROM gps.vehicle_days WHERE vehicle_id = $1 AND day = $2::date`, [car.id, new Date(t0).toISOString().slice(0, 10)]);
    expect((await saved()).rows).toEqual([]);
    const first = await rankingOf(owner, t0 - HOUR, t0 + 6 * HOUR);
    near(first[0]?.distanceM, 20);
    expect((await saved()).rows).toEqual([{ day: new Date(t0).toISOString().slice(0, 10) }]);
    // The second query comes from what was stored and gives the same.
    expect(await rankingOf(owner, t0 - HOUR, t0 + 6 * HOUR)).toEqual(first);

    // The device uploads another trip of that same day late.
    await trackOf(car, t0 + 2 * HOUR).go(1200, 60).send();
    expect((await saved()).rows).toEqual([]);
    const second = await rankingOf(owner, t0 - HOUR, t0 + 6 * HOUR);
    near(second[0]?.distanceM, 40);
    expect((second[0] as DriverRank).drivingS).toBeGreaterThan(2 * (first[0] as DriverRank).drivingS - 120);
  });
});
