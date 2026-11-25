// Module F · Fuel: tank level, consumption by norm, consumption by
// sensor, refills, drains, possible theft, fills, costs and
// efficiency per vehicle and per driver.
import { type FuelFill, type FuelImportResult, type FuelReport, type FuelSettings, type FuelStatus, type VehicleEvent, fuelFillMismatch, parseAmount, parseCsv, parseDateTime } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TraccarRow } from "../src/ingest/poller";
import { type Pause, drains, litersOf, refuels, smooth } from "../src/modules/fuel/fuel";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let theftMail: Awaited<ReturnType<Harness["emailNotification"]>>;
let ana: TestUser; // owner, with the module
let otherAccount: TestUser; // another account, without the module

const KNOTS = 1 / 1.852;
const HOUR = 3_600_000;
const LAT = 14.0818;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const as = (user: TestUser) => ({ cookie: user.cookie });
const DAY0 = Math.floor(Date.now() / 86_400_000) * 86_400_000;
/** Each test uses its own vehicle and its own window of time from yesterday. */
const slot = (hour: number) => DAY0 - 86_400_000 + hour * HOUR;

interface Car {
  id: string;
  deviceId: number;
}
async function addVehicle(user: TestUser, name: string, plate?: string): Promise<Car> {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId: "teltonika", ...(plate ? { plate } : {}) } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { id: res.json.vehicle.id as string, deviceId: h.traccar.devices.get(uniqueId) as number };
}
async function setTank(user: TestUser, car: Car, body: Record<string, unknown>) {
  const res = await h.request("PUT", `/api/vehicles/${car.id}/fuel`, { ...as(user), body });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.fuel as FuelStatus;
}
const statusOf = async (user: TestUser, car: Car) => (await h.request("GET", `/api/vehicles/${car.id}/fuel`, as(user))).json.fuel as FuelStatus;
async function reportOf(user: TestUser, car: Car, from: number, to: number) {
  const res = await h.request("GET", `/api/vehicles/${car.id}/fuel/report?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`, as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.report as FuelReport;
}

const eventsOf = async (user: TestUser, car: Car) => ((await h.request("GET", `/api/events?limit=200&vehicleId=${car.id}`, as(user))).json.events as VehicleEvent[]).reverse();
async function fillsOf(user: TestUser, car: Car, from: number, to: number) {
  const res = await h.request("GET", `/api/vehicles/${car.id}/fuel/fills?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`, as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.fills as FuelFill[];
}
/** The module's watcher looks at what arrived, as it would on its own every couple of minutes. */
async function watch() {
  await h.fuel.sweep();
  await h.settle();
}

/** Track heading east; each position carries the data that `attrs` gives (stretch position, stretch total). */
function trackOf(car: Car, start: number) {
  let t = start;
  let lon = -87.2068;
  const rows: TraccarRow[] = [];
  const api = {
    go(seconds: number, kmh: number, extra: { ignition?: boolean; attrs?: (i: number, n: number) => Record<string, unknown> } = {}) {
      const n = seconds / 30;
      for (let i = 1; i <= n; i++) {
        t += 30_000;
        lon += ((kmh / 3.6) * 30) / M_PER_DEG_LON;
        const attributes = { ignition: extra.ignition ?? kmh > 0, ...extra.attrs?.(i, n) };
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
/** Level that drops in a straight line along the stretch. */
const falling = (attr: string, from: number, to: number) => (i: number, n: number) => ({ [attr]: from + ((to - from) * i) / n });
const between = (value: number | undefined | null, min: number, max: number) => {
  expect(value).toBeGreaterThanOrEqual(min);
  expect(value).toBeLessThanOrEqual(max);
};

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Combustible");
  otherAccount = await h.signUp("Otra Cuenta");
  await h.enableModules(ana.orgId, ["F"]);
  // The account wants a possible theft by email, with the time in its time zone.
  theftMail = await h.emailNotification(ana, ["fuel_theft"], "America/Tegucigalpa");
});
afterAll(async () => {
  await h?.close();
});

describe("module F: level calculation", () => {
  it("translates the device reading into litres according to how it arrives", () => {
    expect(litersOf({ capacityL: 60, kind: "percent", calibration: null }, 50)).toBe(30);
    expect(litersOf({ capacityL: 60, kind: "percent", calibration: null }, 140)).toBe(60);
    expect(litersOf({ capacityL: 60, kind: "liters", calibration: null }, 42.5)).toBe(42.5);
    expect(litersOf({ capacityL: 60, kind: "liters", calibration: null }, -3)).toBe(0);
    // Calibration table of an uneven tank: between two points, a straight line.
    const tank = { capacityL: 80, kind: "raw" as const, calibration: [[0, 0], [1000, 20], [4000, 80]] as [number, number][] };
    expect(litersOf(tank, 500)).toBe(10);
    expect(litersOf(tank, 1000)).toBe(20);
    expect(litersOf(tank, 2500)).toBe(50);
    expect(litersOf(tank, -20)).toBe(0);
    expect(litersOf(tank, 9000)).toBe(80);
  });

  it("removes the sloshing peaks and recognises a refill without mistaking it for noise", () => {
    const at = (values: number[]) => values.map((l, i) => ({ t: i * 30_000, l }));
    expect(smooth(at([50, 50, 58, 50, 49, 49, 41, 49, 48])).map((p) => p.l)).toEqual([50, 50, 50, 50, 49, 49, 49, 49, 48]);
    // Drops, rises 30 litres at once and keeps dropping: a refill of 30.
    expect(refuels(at([40, 39, 38, 68, 68, 67, 66, 65]), 100)).toEqual([{ t: 3 * 30_000, l: 30 }]);
    // Small rises, below the threshold, do not count.
    expect(refuels(at([40, 42, 41, 43, 40, 39, 41, 38]), 100)).toEqual([]);
    // A refill at the end of the period also counts.
    expect(refuels(at([30, 29, 28, 70, 70]), 100).map((r) => r.l)).toEqual([42]);
    // Two separate refills.
    expect(refuels(at([50, 40, 80, 78, 60, 59, 90, 88]), 100).map((r) => r.l)).toEqual([40, 31]);
  });
});

describe("module F: tank and level", () => {
  it("without the module enabled, its routes do not exist for that account", async () => {
    const car = await addVehicle(otherAccount, "Sin módulo");
    expect((await h.request("GET", `/api/vehicles/${car.id}/fuel`, as(otherAccount))).status).toBe(404);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/fuel`, { ...as(otherAccount), body: { capacityL: 60, attr: "fuel" } })).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${car.id}/fuel/report?from=2026-01-01&to=2026-01-02`, as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${car.id}/fuel`, {})).status).toBe(401);
  });

  it("shows the level with a percentage sensor and shows the data the device sends", async () => {
    const car = await addVehicle(ana, "Con CAN");
    expect(await statusOf(ana, car)).toEqual({ tank: null, level: null, attrs: [] });
    const track = trackOf(car, Date.now() - 20 * 60_000);
    await track.go(300, 40, { attrs: () => ({ fuel: 50, adc1: 2500, rssi: 4 }) }).send();
    // Before configuring, the numeric data are already visible, to choose the level one.
    expect((await statusOf(ana, car)).attrs).toEqual([
      { name: "adc1", value: 2500 },
      { name: "fuel", value: 50 },
      { name: "rssi", value: 4 },
    ]);
    const saved = await setTank(ana, car, { capacityL: 60, attr: "fuel", kind: "percent" });
    expect(saved.tank).toEqual({ capacityL: 60, attr: "fuel", kind: "percent", calibration: null, counterAttr: null, counterUnit: "l", normL100km: null, normIdleLh: null });
    expect(saved.level).toMatchObject({ liters: 30, percent: 50 });
    expect(Date.parse(saved.level?.at as string)).toBe(track.now());

    // The same vehicle with the analogue sensor and its calibration table.
    const raw = await setTank(ana, car, { capacityL: 80, attr: "adc1", kind: "raw", calibration: [[0, 0], [1000, 20], [4000, 80]] });
    expect(raw.level).toMatchObject({ liters: 50, percent: 63 });
    // A single spiked reading does not move the level shown.
    await track.go(30, 40, { attrs: () => ({ adc1: 3900 }) }).send();
    expect((await statusOf(ana, car)).level).toMatchObject({ liters: 50 });

    expect((await h.request("DELETE", `/api/vehicles/${car.id}/fuel`, as(ana))).status).toBe(204);
    expect((await statusOf(ana, car)).tank).toBeNull();
    expect((await h.request("DELETE", `/api/vehicles/${car.id}/fuel`, as(ana))).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${car.id}/fuel/report?from=2026-01-01&to=2026-01-02`, as(ana))).status).toBe(404);
    const audit = (await h.request("GET", "/api/audit?limit=20", as(ana))).json.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["fuel.configure", "fuel.remove"]));
  });

  it("rejects an unusable configuration, and only whoever administers vehicles can change it", async () => {
    const car = await addVehicle(ana, "Mal configurado");
    const put = (user: TestUser, body: Record<string, unknown>) => h.request("PUT", `/api/vehicles/${car.id}/fuel`, { ...as(user), body });
    expect((await put(ana, { capacityL: 60 })).status).toBe(400); // neither sensor nor norm
    expect((await put(ana, { capacityL: 60, attr: "adc1", kind: "raw" })).status).toBe(400); // no table
    expect((await put(ana, { capacityL: 60, attr: "adc1", kind: "raw", calibration: [[100, 5], [50, 20]] })).status).toBe(400); // out of order
    expect((await put(ana, { capacityL: 60, attr: "adc1", kind: "raw", calibration: [[0, 0], [4000, 90]] })).status).toBe(400); // more than the tank
    expect((await put(ana, { capacityL: 2, attr: "fuel" })).status).toBe(400);
    expect((await put(ana, { capacityL: 60, attr: "fuel; DROP", kind: "percent" })).status).toBe(400);
    expect((await put(ana, { capacityL: 60, normL100km: 9 })).status).toBe(200);

    const person = await h.signUp("Lector de combustible");
    const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role: "viewer", groups: null } });
    expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
    expect((await h.request("GET", `/api/vehicles/${car.id}/fuel`, as(person))).status).toBe(200);
    expect((await put(person, { capacityL: 60, normL100km: 9 })).status).toBe(403);
    await h.enableModules(otherAccount.orgId, ["F"]);
    expect((await put(otherAccount, { capacityL: 60, normL100km: 9 })).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${car.id}/fuel`, as(otherAccount))).status).toBe(404);
    await h.enableModules(otherAccount.orgId, []);
  });
});

describe("module F: consumption and efficiency", () => {
  it("estimates consumption by norm: per kilometre and per hour of idling", async () => {
    const car = await addVehicle(ana, "Sin sensor");
    await setTank(ana, car, { capacityL: 70, normL100km: 10, normIdleLh: 1.2 });
    const t0 = slot(1);
    // 30 km of road and half an hour stopped with the engine on.
    await trackOf(car, t0).go(1800, 60).go(1800, 0, { ignition: true }).go(300, 0, { ignition: false }).send();
    const report = await reportOf(ana, car, t0, t0 + 2 * HOUR);
    between(report.distanceM / 1000, 29, 30.5);
    between(report.idleS, 29 * 60, 31 * 60);
    between(report.estimated?.byDistanceL, 2.9, 3.05);
    between(report.estimated?.byIdleL, 0.55, 0.65);
    const parts = (report.estimated?.byDistanceL as number) + (report.estimated?.byIdleL as number);
    between(report.estimated?.liters, parts - 0.11, parts + 0.11);
    // Without a sensor there is no real consumption: efficiency comes from the norm, and it says so.
    expect(report.real).toBeNull();
    expect(report.series).toEqual([]);
    expect(report.efficiency?.basis).toBe("estimated");
    between(report.efficiency?.kmPerL, 8, 8.7);
    expect(report.drivers).toEqual([]);
    expect((await h.request("GET", `/api/vehicles/${car.id}/fuel/report?from=2026-01-01&to=2026-03-15`, as(ana))).status).toBe(400);
  });

  it("measures real consumption with the filtered level, adding what was refilled", async () => {
    const car = await addVehicle(ana, "Con sensor de nivel");
    await setTank(ana, car, { capacityL: 100, attr: "fuel", kind: "percent", normL100km: 8 });
    const t0 = slot(4);
    // An isolated peak every ten readings: the fuel moving in the tank.
    const noisy = (from: number, to: number) => (i: number, n: number) => ({ fuel: from + ((to - from) * i) / n + (i % 10 === 5 ? 6 : 0) });
    const track = trackOf(car, t0);
    track.go(3600, 60, { attrs: noisy(80, 74) }); // 60 km using 6 litres
    track.go(120, 0, { ignition: false, attrs: () => ({ fuel: 74 }) });
    track.go(180, 0, { ignition: false, attrs: () => ({ fuel: 94 }) }); // 20-litre refill
    track.go(1800, 60, { attrs: noisy(94, 91) }); // 30 km using 3 litres
    await track.send();

    const report = await reportOf(ana, car, t0, t0 + 3 * HOUR);
    between(report.distanceM / 1000, 89, 90.5);
    expect(report.real).toMatchObject({ method: "level" });
    between(report.real?.liters, 8.8, 9.2);
    between(report.real?.refueledL, 19.8, 20.2);
    expect(report.efficiency?.basis).toBe("real");
    between(report.efficiency?.lPer100km, 9.7, 10.3);
    between(report.efficiency?.kmPerL, 9.7, 10.3);
    // The norm says 8 L/100 km: it used more than expected.
    between(report.estimated?.liters, 7.1, 7.3);
    // The chart comes out without the peaks and within the point cap.
    expect(report.series.length).toBeGreaterThan(100);
    expect(report.series.length).toBeLessThanOrEqual(600);
    expect(Math.max(...report.series.map((p) => p.l))).toBeLessThanOrEqual(94);
    between(report.series[0]?.l, 79.5, 80);
    between(report.series.at(-1)?.l, 91, 91.2);
  });

  it("if the device provides the engine's litre counter, that datum is used", async () => {
    const car = await addVehicle(ana, "Con contador del motor");
    await setTank(ana, car, { capacityL: 300, attr: "fuel", kind: "percent" });
    const t0 = slot(8);
    await trackOf(car, t0)
      .go(2700, 60, { attrs: (i, n) => ({ fuelUsed: 15_000 + (4.5 * (i - 1)) / (n - 1), fuel: 60 }) })
      .send();
    const report = await reportOf(ana, car, t0, t0 + 2 * HOUR);
    expect(report.real).toEqual({ liters: 4.5, method: "ecu", refueledL: 0, drainedL: 0 });
    between(report.efficiency?.kmPerL, 9.7, 10.1);
    expect(report.estimated).toBeNull();

    // Another device sends it under another name and in tenths of a litre: which one it is and in what unit is chosen.
    const other = await addVehicle(ana, "Con contador en décimas");
    await setTank(ana, other, { capacityL: 300, counterAttr: "io83", counterUnit: "dl" });
    await trackOf(other, t0)
      .go(2700, 60, { attrs: (i, n) => ({ io83: 120_000 + Math.round((60 * (i - 1)) / (n - 1)) }) })
      .send();
    const tenths = await reportOf(ana, other, t0, t0 + 2 * HOUR);
    expect(tenths.real).toEqual({ liters: 6, method: "ecu", refueledL: 0, drainedL: 0 });
    expect(tenths.series).toEqual([]);
  });

  it("splits the efficiency among the drivers who had the vehicle", async () => {
    const owner = await h.signUp("Dueña con conductores");
    await h.enableModules(owner.orgId, ["B", "F"]);
    const car = await addVehicle(owner, "Compartido");
    await setTank(owner, car, { capacityL: 100, attr: "fuel", kind: "percent" });
    const driver = async (name: string) => (await h.request("POST", "/api/drivers", { ...as(owner), body: { name } })).json.driver.id as string;
    const [suave, pesado] = [await driver("Pie suave"), await driver("Pie pesado")];
    const t0 = slot(12);
    const assign = async (driverId: string, since: number) => {
      expect((await h.request("PUT", `/api/vehicles/${car.id}/driver`, { ...as(owner), body: { driverId } })).status).toBe(200);
      await h.db.core.query(`UPDATE gps.driver_assignments SET ends_at = $2 WHERE vehicle_id = $1 AND ends_at > $2`, [car.id, new Date(since)]);
      await h.db.core.query(`UPDATE gps.driver_assignments SET starts_at = $2 WHERE vehicle_id = $1 AND ends_at IS NULL`, [car.id, new Date(since)]);
    };
    await assign(suave, t0);
    const track = trackOf(car, t0);
    await track.go(1800, 60, { attrs: falling("fuel", 50, 47) }).send(); // 30 km with 3 litres
    await assign(pesado, track.now());
    await track.go(1800, 60, { attrs: falling("fuel", 47, 41) }).send(); // 30 km with 6 litres

    const report = await reportOf(owner, car, t0, t0 + 2 * HOUR);
    between(report.real?.liters, 8.7, 9.1);
    expect(report.drivers.map((d) => d.name).sort()).toEqual(["Pie pesado", "Pie suave"]);
    const of = (name: string) => report.drivers.find((d) => d.name === name);
    between(of("Pie suave")?.liters, 2.8, 3.2);
    between(of("Pie suave")?.kmPerL, 9.2, 10.6);
    between(of("Pie pesado")?.liters, 5.8, 6.2);
    between(of("Pie pesado")?.kmPerL, 4.8, 5.2);
    between(of("Pie pesado")?.lPer100km, 19, 21);
    between(((of("Pie suave")?.distanceM as number) + (of("Pie pesado")?.distanceM as number)) / 1000, 59, 60.5);

    // Without the drivers module, the vehicle's report is the same but without that split.
    await h.enableModules(owner.orgId, ["F"]);
    const alone = await reportOf(owner, car, t0, t0 + 2 * HOUR);
    expect(alone.drivers).toEqual([]);
    expect(alone.real).toEqual(report.real);
  });
});

describe("module F: reading files", () => {
  it("reads a CSV with whatever separator it has, quotes and empty cells", () => {
    expect(parseCsv('\uFEFFVehículo;Fecha;Litros\r\n"Camión; el rojo";2026-11-20 08:15;45,5\r\n\r\nPickup;"21/11/2026 09:00";30\n')).toEqual([
      ["Vehículo", "Fecha", "Litros"],
      ["Camión; el rojo", "2026-11-20 08:15", "45,5"],
      ["Pickup", "21/11/2026 09:00", "30"],
    ]);
    expect(parseCsv('a,b\n"dice ""hola""",2\n')).toEqual([
      ["a", "b"],
      ['dice "hola"', "2"],
    ]);
    expect(parseCsv("a\tb\n1\t\n")).toEqual([
      ["a", "b"],
      ["1", ""],
    ]);
  });

  it("understands numbers and dates as written in a spreadsheet", () => {
    expect(parseAmount("45,5")).toBe(45.5);
    expect(parseAmount("1.234,50")).toBe(1234.5);
    expect(parseAmount("L 1,234.50")).toBe(1234.5);
    expect(parseAmount("1,234")).toBe(1234);
    expect(parseAmount("12.345.678")).toBe(12345678);
    expect(parseAmount("38.75 L")).toBe(38.75);
    expect(parseAmount("sin dato")).toBeNull();
    // Tegucigalpa is six hours behind universal time, all year.
    expect(new Date(parseDateTime("2026-11-20 14:30", "America/Tegucigalpa") as number).toISOString()).toBe("2026-11-20T20:30:00.000Z");
    expect(new Date(parseDateTime("20/11/2026 14:30:15", "America/Tegucigalpa") as number).toISOString()).toBe("2026-11-20T20:30:15.000Z");
    // Without a time it defaults to noon, and a date with its own offset is respected.
    expect(new Date(parseDateTime("20/11/2026", "America/Tegucigalpa") as number).toISOString()).toBe("2026-11-20T18:00:00.000Z");
    expect(new Date(parseDateTime("2026-11-20T14:30:00-05:00", "America/Tegucigalpa") as number).toISOString()).toBe("2026-11-20T19:30:00.000Z");
    // Madrid changes its clock: in summer it is two hours ahead and in winter, one.
    expect(new Date(parseDateTime("2026-07-01 12:00", "Europe/Madrid") as number).toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(new Date(parseDateTime("2026-12-01 12:00", "Europe/Madrid") as number).toISOString()).toBe("2026-12-01T11:00:00.000Z");
    for (const bad of ["ayer", "30/02/2026", "2026-13-01", "20/11/2026 25:00", ""]) expect(parseDateTime(bad, "UTC"), bad).toBeNull();
  });
});

describe("module F: refills, drains and possible theft", () => {
  it("recognises a drain at a stop and does not mistake it for what the engine burns idling", () => {
    const MIN = 60_000;
    const flat = (from: number, to: number, l: number) => Array.from({ length: (to - from) / MIN }, (_, i) => ({ t: from + i * MIN, l }));
    const tank = { capacityL: 100, normIdleLh: 2 };
    // Arrives with 70, stopped with the engine off it drops to 50 and the trip continues.
    const series = [...flat(0, 10 * MIN, 70), ...flat(10 * MIN, 30 * MIN, 50)];
    const off: Pause = { from: 5 * MIN, to: 28 * MIN, idleS: 0, idle: [], lat: 14, lon: -87 };
    expect(drains(series, [off], tank)).toMatchObject([{ t: 10 * MIN, l: 20, engineOff: true }]);
    // With the engine on for the whole stop it is not "engine off", and what it burned idling is subtracted.
    const idling: Pause = { ...off, idleS: 23 * 60, idle: [[5 * MIN, 28 * MIN]] };
    const found = drains(series, [idling], tank);
    expect(found).toMatchObject([{ engineOff: false }]);
    between(found[0]?.l, 19.5, 20);
    // Arrive, leave the engine on for a couple of minutes and turn it off: if the level drops afterwards, it was with the engine off.
    const arrived: Pause = { ...off, idleS: 120, idle: [[5 * MIN, 7 * MIN]] };
    expect(drains([...flat(0, 20 * MIN, 70), ...flat(20 * MIN, 30 * MIN, 50)], [arrived], tank)).toMatchObject([{ t: 20 * MIN, engineOff: true }]);
    // Three hours idling burning 6 litres, with the norm at 2 L per hour: that is consumption.
    const slow = Array.from({ length: 181 }, (_, i) => ({ t: i * MIN, l: 70 - i / 30 }));
    expect(drains(slow, [{ from: 0, to: 180 * MIN, idleS: 180 * 60, idle: [[0, 180 * MIN]], lat: 14, lon: -87 }], tank)).toEqual([]);
    // Fill the tank and, without moving, take some out: the refill does not hide the drain.
    const filled = [...flat(0, 8 * MIN, 30), ...flat(8 * MIN, 16 * MIN, 90), ...flat(16 * MIN, 30 * MIN, 65)];
    expect(drains(filled, [off], tank)).toMatchObject([{ t: 16 * MIN, l: 25, engineOff: true }]);
    expect(refuels(filled, 100)).toMatchObject([{ l: 60 }]);
    // And the other way round: it is drained at night and refilled in the morning before leaving.
    const emptied = [...flat(0, 8 * MIN, 60), ...flat(8 * MIN, 16 * MIN, 35), ...flat(16 * MIN, 30 * MIN, 95)];
    expect(drains(emptied, [off], tank)).toMatchObject([{ t: 8 * MIN, l: 25 }]);
    expect(refuels(emptied, 100)).toMatchObject([{ l: 60 }]);
    // A slow siphon, half a litre per minute with the engine off, is also a drain.
    const siphon = Array.from({ length: 31 }, (_, i) => ({ t: i * MIN, l: 70 - i * 0.5 }));
    const slowTheft = drains(siphon, [{ from: 0, to: 30 * MIN, idleS: 0, idle: [], lat: 14, lon: -87 }], tank);
    expect(slowTheft).toMatchObject([{ engineOff: true }]);
    between(slowTheft[0]?.l, 13.5, 15);
    // Outside a stop it is not looked for: while driving, dropping is burning.
    expect(drains(series, [], tank)).toEqual([]);
    // A drop smaller than the threshold is sensor noise.
    expect(drains([...flat(0, 10 * MIN, 70), ...flat(10 * MIN, 30 * MIN, 67)], [off], tank)).toEqual([]);
  });

  it("a drain with the engine off does not count as consumption, is left as possible theft and is told by email only once", async () => {
    const car = await addVehicle(ana, "Camión del robo");
    await setTank(ana, car, { capacityL: 100, attr: "fuel", kind: "percent", normL100km: 10 });
    expect((await h.request("PUT", "/api/fuel/settings", { ...as(ana), body: { currency: "HNL", zone: "America/Tegucigalpa" } })).status).toBe(200);
    h.mails.length = 0;
    const t0 = slot(8);
    const track = trackOf(car, t0);
    track.go(1800, 60, { attrs: falling("fuel", 80, 77) }); // 30 km using 3 litres
    track.go(600, 0, { ignition: false, attrs: () => ({ fuel: 77 }) });
    const robbedAt = track.now();
    track.go(900, 0, { ignition: false, attrs: () => ({ fuel: 57 }) }); // 20 litres are taken out while parked
    await track.send();
    // Still parked: the watcher already sees it.
    await watch();
    let events = (await eventsOf(ana, car)).filter((e) => e.type.startsWith("fuel_"));
    expect(events).toMatchObject([{ type: "fuel_theft", detail: { engineOff: true } }]);
    between(events[0]?.detail.liters as number, 19.5, 20.5);
    between(Date.parse(events[0]?.at as string), robbedAt, robbedAt + 120_000);
    expect(events[0]?.lat).toBeCloseTo(LAT, 3);
    // The email reaches those who see the vehicle, with the time in the account's time zone.
    const sent = h.mails.length;
    expect(h.mails.map((m) => m.to)).toContain(ana.email);
    expect(h.mails.map((m) => m.to)).not.toContain(otherAccount.email);
    expect(h.mails[0]?.subject).toBe("Camión del robo: posible robo de combustible");
    expect(h.mails[0]?.body).toMatch(/salieron 20(,\d)? L del tanque con el motor apagado/);
    expect(h.mails[0]?.body).toContain("hora de America/Tegucigalpa");

    // The trip continues: on looking again neither the event nor the email repeats.
    track.go(1800, 60, { attrs: falling("fuel", 57, 54) });
    await track.send();
    await watch();
    events = (await eventsOf(ana, car)).filter((e) => e.type.startsWith("fuel_"));
    expect(events.map((e) => e.type)).toEqual(["fuel_theft"]);
    expect(h.mails).toHaveLength(sent);

    const report = await reportOf(ana, car, t0, t0 + 2 * HOUR);
    expect(report.drains).toMatchObject([{ engineOff: true }]);
    between(report.drains[0]?.liters, 19.5, 20.5);
    expect(report.drains[0]?.lat).toBeCloseTo(LAT, 3);
    // It burned the 6 litres of the two stretches, not the 26 by which the level dropped.
    between(report.real?.liters, 5.7, 6.3);
    between(report.real?.drainedL, 19.5, 20.5);
    expect(report.refuels).toEqual([]);
    between(report.efficiency?.lPer100km, 9.5, 10.5);
    // The alert appears among those that need attention.
    const alerts = (await h.request("GET", `/api/events?alerts=1&vehicleId=${car.id}`, as(ana))).json.events as VehicleEvent[];
    expect(alerts.map((e) => e.type)).toContain("fuel_theft");
  });

  it("with the engine on it is a drain and not a theft: it is recorded, without email; and with the notification turned off, the theft one does not arrive either", async () => {
    const car = await addVehicle(ana, "Camión en ralentí");
    await setTank(ana, car, { capacityL: 200, attr: "fuel", kind: "liters", normIdleLh: 2 });
    h.mails.length = 0;
    const t0 = slot(11);
    const track = trackOf(car, t0);
    track.go(600, 50, { attrs: () => ({ fuel: 150 }) });
    // An hour idling burning 2 litres: normal.
    track.go(3600, 0, { ignition: true, attrs: falling("fuel", 150, 148) });
    track.go(600, 50, { attrs: () => ({ fuel: 148 }) });
    // Another stop with the engine on in which 30 litres go missing.
    track.go(300, 0, { ignition: true, attrs: () => ({ fuel: 148 }) });
    track.go(600, 0, { ignition: true, attrs: () => ({ fuel: 118 }) });
    track.go(600, 50, { attrs: () => ({ fuel: 118 }) });
    await track.send();
    await watch();
    const events = (await eventsOf(ana, car)).filter((e) => e.type.startsWith("fuel_"));
    expect(events).toMatchObject([{ type: "fuel_drain", detail: { engineOff: false } }]);
    between(events[0]?.detail.liters as number, 28.5, 30.5);
    expect(h.mails).toEqual([]);
    const report = await reportOf(ana, car, t0, t0 + 2 * HOUR);
    expect(report.drains).toHaveLength(1);
    // Idling: the time, what the norm says and what the sensor measured in those stretches.
    between(report.idle.seconds, 4400, 4600);
    between(report.idle.estimatedL, 2.4, 2.6);
    between(report.idle.realL, 1.5, 3);

    // With the account's notification turned off, the theft is recorded but not sent.
    expect((await theftMail.set(false)).status).toBe(200);
    const quiet = await addVehicle(ana, "Camión sin correo");
    await setTank(ana, quiet, { capacityL: 100, attr: "fuel", kind: "percent" });
    const night = trackOf(quiet, slot(14));
    night.go(600, 50, { attrs: () => ({ fuel: 60 }) });
    night.go(300, 0, { ignition: false, attrs: () => ({ fuel: 60 }) });
    night.go(600, 0, { ignition: false, attrs: () => ({ fuel: 30 }) });
    await night.send();
    await watch();
    expect((await eventsOf(ana, quiet)).map((e) => e.type)).toContain("fuel_theft");
    expect(h.mails).toEqual([]);
    expect((await theftMail.set(true)).status).toBe(200);
  });

  it("does not take for an empty tank the zero that some devices send with the engine off", async () => {
    const car = await addVehicle(ana, "Con nivel por la computadora");
    await setTank(ana, car, { capacityL: 100, attr: "fuel", kind: "percent" });
    const t0 = slot(16);
    const track = trackOf(car, t0);
    track.go(900, 60, { attrs: falling("fuel", 70, 68) });
    // Off, the vehicle's computer goes to sleep and the device sends zero.
    track.go(1800, 0, { ignition: false, attrs: () => ({ fuel: 0 }) });
    track.go(900, 60, { attrs: falling("fuel", 68, 66) });
    await track.send();
    await watch();
    expect((await eventsOf(ana, car)).filter((e) => e.type.startsWith("fuel_"))).toEqual([]);
    const report = await reportOf(ana, car, t0, t0 + 2 * HOUR);
    expect(report.drains).toEqual([]);
    expect(report.refuels).toEqual([]);
    between(report.real?.liters, 3.5, 4.5);
    expect(Math.min(...report.series.map((p) => p.l))).toBeGreaterThan(60);
  });

  it("records the refill as an event when the level stops rising, and does not repeat it", async () => {
    const car = await addVehicle(ana, "Camión que carga");
    await setTank(ana, car, { capacityL: 100, attr: "fuel", kind: "percent" });
    h.mails.length = 0;
    const t0 = slot(18);
    const track = trackOf(car, t0);
    track.go(900, 60, { attrs: falling("fuel", 40, 38) });
    track.go(120, 0, { ignition: false, attrs: () => ({ fuel: 38 }) });
    track.go(60, 0, { ignition: false, attrs: () => ({ fuel: 55 }) }); // it is half full
    await track.send();
    // The watcher looks half a minute after the last thing that arrived.
    const look = async () => {
      await h.fuel.sweep(track.now() + 30_000);
      await h.settle();
    };
    await look();
    expect((await eventsOf(ana, car)).filter((e) => e.type.startsWith("fuel_"))).toEqual([]);
    track.go(60, 0, { ignition: false, attrs: () => ({ fuel: 78 }) });
    track.go(600, 60, { attrs: falling("fuel", 78, 77) });
    await track.send();
    await look();
    await look();
    const events = (await eventsOf(ana, car)).filter((e) => e.type.startsWith("fuel_"));
    expect(events).toMatchObject([{ type: "fuel_refuel" }]);
    between(events[0]?.detail.liters as number, 39, 41);
    // If the device goes quiet right after refilling, the refill is still recorded after a while.
    const silent = await addVehicle(ana, "Camión que calla");
    await setTank(ana, silent, { capacityL: 100, attr: "fuel", kind: "percent" });
    const last = trackOf(silent, Date.now() - 20 * 60_000);
    last.go(600, 60, { attrs: falling("fuel", 40, 39) });
    last.go(120, 0, { ignition: false, attrs: () => ({ fuel: 39 }) });
    last.go(90, 0, { ignition: false, attrs: () => ({ fuel: 69 }) }); // refill, and no more reports
    await last.send();
    const fuelEvents = async () => (await eventsOf(ana, silent)).filter((e) => e.type.startsWith("fuel_"));
    await watch();
    expect(await fuelEvents()).toEqual([]);
    await h.fuel.sweep(Date.now() + 15 * 60_000);
    await h.settle();
    expect(await fuelEvents()).toMatchObject([{ type: "fuel_refuel" }]);
    await h.fuel.sweep(Date.now() + 30 * 60_000);
    await h.settle();
    expect(await fuelEvents()).toHaveLength(1);
    // A refill is a record: it neither asks for attention nor is sent by email.
    expect((await h.request("GET", `/api/events?alerts=1&vehicleId=${car.id}`, as(ana))).json.events).toEqual([]);
    expect(h.mails).toEqual([]);
  });
});

describe("module F: fills and costs", () => {
  it("the module settings start from factory ones and only accept a currency and a time zone that exist", async () => {
    expect(((await h.request("GET", "/api/fuel/settings", as(otherAccount))).status)).toBe(404);
    const saved = await h.request("PUT", "/api/fuel/settings", { ...as(ana), body: { currency: "hnl", zone: "America/Tegucigalpa" } });
    expect(saved.json.settings as FuelSettings).toEqual({ currency: "HNL", zone: "America/Tegucigalpa" });
    expect((await h.request("GET", "/api/fuel/settings", as(ana))).json.settings).toEqual(saved.json.settings);
    expect((await h.request("PUT", "/api/fuel/settings", { ...as(ana), body: { currency: "lempiras", zone: "America/Tegucigalpa" } })).status).toBe(400);
    expect((await h.request("PUT", "/api/fuel/settings", { ...as(ana), body: { currency: "HNL", zone: "Marte/Olimpo" } })).status).toBe(400);
  });

  it("combines what was recorded with what the sensor saw, and shows when more was paid than entered the tank", async () => {
    const car = await addVehicle(ana, "Camión con vales");
    await setTank(ana, car, { capacityL: 100, attr: "fuel", kind: "percent", normL100km: 10 });
    const t0 = slot(20);
    const track = trackOf(car, t0);
    track.go(1800, 60, { attrs: falling("fuel", 50, 47) });
    track.go(120, 0, { ignition: false, attrs: () => ({ fuel: 47 }) });
    const firstAt = track.now();
    track.go(240, 0, { ignition: false, attrs: () => ({ fuel: 67 }) }); // 20 litres go in
    track.go(1800, 60, { attrs: falling("fuel", 67, 64) });
    track.go(120, 0, { ignition: false, attrs: () => ({ fuel: 64 }) });
    const secondAt = track.now();
    track.go(240, 0, { ignition: false, attrs: () => ({ fuel: 94 }) }); // 30 litres go in
    track.go(600, 60, { attrs: falling("fuel", 94, 93) });
    await track.send();
    const from = t0;
    const to = t0 + 2 * HOUR;

    // With nothing recorded, the two refills the sensor saw come out.
    let fills = await fillsOf(ana, car, from, to);
    expect(fills).toMatchObject([{ id: null, source: "detected" }, { id: null, source: "detected" }]);
    between(fills[1]?.liters, 19.5, 20.5);
    between(fills[0]?.detectedL, 29.5, 30.5);

    // The first one's voucher says 30 litres, but 20 entered the tank.
    const body = { at: new Date(firstAt + 10 * 60_000).toISOString(), liters: 30, total: 3300, currency: "HNL", odometerKm: 120_500, station: "Gasolinera del Centro", note: "Vale 1042" };
    const created = await h.request("POST", `/api/vehicles/${car.id}/fuel/fills`, { ...as(ana), body });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const fill = created.json.fill as FuelFill;
    expect(fill).toMatchObject({ liters: 30, total: 3300, currency: "HNL", pricePerL: 110, odometerKm: 120_500, station: "Gasolinera del Centro", note: "Vale 1042", source: "manual" });
    // Recording it twice is not valid; without a currency with a total, neither; nor in another account.
    expect((await h.request("POST", `/api/vehicles/${car.id}/fuel/fills`, { ...as(ana), body })).status).toBe(409);
    expect((await h.request("POST", `/api/vehicles/${car.id}/fuel/fills`, { ...as(ana), body: { ...body, liters: 31, currency: null } })).status).toBe(400);
    expect((await h.request("POST", `/api/vehicles/${car.id}/fuel/fills`, { ...as(ana), body: { ...body, liters: 0 } })).status).toBe(400);
    expect((await h.request("POST", `/api/vehicles/${car.id}/fuel/fills`, { ...as(otherAccount), body })).status).toBe(404);
    // The second is recorded just as the sensor saw it.
    const second = await h.request("POST", `/api/vehicles/${car.id}/fuel/fills`, { ...as(ana), body: { at: new Date(secondAt + 120_000).toISOString(), liters: 30, total: 3270, currency: "HNL", source: "detected" } });
    expect(second.status).toBe(201);

    fills = await fillsOf(ana, car, from, to);
    expect(fills).toHaveLength(2);
    expect(fills[1]).toMatchObject({ id: fill.id, liters: 30, source: "manual" });
    between(fills[1]?.detectedL, 19.5, 20.5);
    expect(fuelFillMismatch(fills[1] as FuelFill)).toBe(true);
    expect(fills[0]).toMatchObject({ source: "detected", liters: 30 });
    expect(fuelFillMismatch(fills[0] as FuelFill)).toBe(false);

    // Costs for the period: what was paid, by currency, and the cost per kilometre of what it actually consumed.
    const report = await reportOf(ana, car, from, to);
    expect(report.costs).toEqual([{ currency: "HNL", spent: 6570, liters: 60, fills: 2 }]);
    between(report.real?.liters, 6.5, 7.5);
    expect(report.costPerKm).toMatchObject({ currency: "HNL", pricePerL: 109.5, basis: "real" });
    // About 7 litres at 109.50 over 70 km.
    between(report.costPerKm?.value, 10.2, 11.7);

    // It is corrected and deleted.
    const fixed = await h.request("PUT", `/api/fuel/fills/${fill.id}`, { ...as(ana), body: { ...body, liters: 20, total: 2200 } });
    expect(fixed.json.fill).toMatchObject({ liters: 20, total: 2200, pricePerL: 110 });
    expect((await h.request("PUT", `/api/fuel/fills/${fill.id}`, { ...as(otherAccount), body })).status).toBe(404);
    expect(fuelFillMismatch((await fillsOf(ana, car, from, to))[1] as FuelFill)).toBe(false);
    expect((await h.request("DELETE", `/api/fuel/fills/${fill.id}`, as(otherAccount))).status).toBe(404);
    expect((await h.request("DELETE", `/api/fuel/fills/${fill.id}`, as(ana))).status).toBe(204);
    expect((await fillsOf(ana, car, from, to)).map((f) => f.source)).toEqual(["detected", "detected"]);
    expect((await fillsOf(ana, car, from, to))[1]?.id).toBeNull();
  });

  it("without fills in the period, the cost per kilometre uses the last known price; without a sensor, what the norm estimates", async () => {
    const car = await addVehicle(ana, "Camión sin sensor");
    await setTank(ana, car, { capacityL: 100, attr: null, normL100km: 10 });
    const t0 = slot(22);
    expect((await h.request("POST", `/api/vehicles/${car.id}/fuel/fills`, { ...as(ana), body: { at: new Date(t0 - 5 * 86_400_000).toISOString(), liters: 40, total: 160, currency: "USD" } })).status).toBe(201);
    const track = trackOf(car, t0);
    track.go(3600, 60);
    await track.send();
    const report = await reportOf(ana, car, t0, t0 + HOUR + 60_000);
    expect(report.costs).toEqual([]);
    between(report.estimated?.liters, 5.9, 6.1);
    // 6 litres at 4 dollars over 60 km: 0.40 per kilometre.
    expect(report.costPerKm).toMatchObject({ currency: "USD", pricePerL: 4, basis: "estimated" });
    between(report.costPerKm?.value, 0.39, 0.41);
    // Without a sensor there are no detected refills: only what was recorded.
    expect((await fillsOf(ana, car, t0 - 6 * 86_400_000, t0 + HOUR)).map((f) => f.source)).toEqual(["manual"]);
  });

  it("imports the fills from a file, says which rows it did not understand and does not repeat what was already recorded", async () => {
    const a = await addVehicle(ana, "Importado Uno", "HBA-0001");
    const b = await addVehicle(ana, "Importado Dos", "HBA-0002");
    await addVehicle(otherAccount, "Ajeno", "HBA-0003");
    const day = new Date(DAY0 - 3 * 86_400_000);
    const ymd = day.toISOString().slice(0, 10);
    const dmy = `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
    const csv = [
      "Vehículo;Fecha;Hora;Litros;Total;Moneda;Odómetro;Estación;Nota",
      `Importado Uno;${ymd};08:15;45,5;4.777,50;;120.500;Puma Centro;Vale 1`,
      `hba-0002;${dmy};14:30;"30";120;USD;;;`,
      `HBA-0003;${ymd};09:00;20;;;;;`,
      `Importado Uno;pronto;;20;;;;;`,
      `Importado Uno;${ymd};10:00;muchos;;;;;`,
      `;${ymd};10:00;20;;;;;`,
      `Importado Uno;${ymd};08:15;45,5;4.777,50;;;;`,
    ].join("\r\n");
    const res = await h.request("POST", "/api/fuel/fills/import", { ...as(ana), body: { csv, zone: "America/Tegucigalpa" } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const result = res.json.result as FuelImportResult;
    expect(result).toMatchObject({ imported: 2, repeated: 1 });
    expect(result.errors.map((e) => e.line)).toEqual([4, 5, 6, 7]);
    expect(result.errors[0]?.message).toMatch(/No hay ningún vehículo/);
    expect(result.errors[1]?.message).toMatch(/No se entiende la fecha/);
    expect(result.errors[2]?.message).toMatch(/litros/i);
    expect(result.errors[3]?.message).toMatch(/Falta el vehículo/);

    const from = day.getTime();
    const one = await fillsOf(ana, a, from, from + 2 * 86_400_000);
    // Without a currency on the row, the account's applies; the time is that of the indicated zone.
    expect(one).toMatchObject([{ liters: 45.5, total: 4777.5, currency: "HNL", pricePerL: 105, odometerKm: 120_500, station: "Puma Centro", note: "Vale 1", source: "imported" }]);
    expect(one[0]?.at).toBe(`${ymd}T14:15:00.000Z`);
    const two = await fillsOf(ana, b, from, from + 2 * 86_400_000);
    expect(two).toMatchObject([{ liters: 30, total: 120, currency: "USD", source: "imported" }]);
    expect(two[0]?.at).toBe(`${ymd}T20:30:00.000Z`);

    // Importing it again duplicates nothing.
    const again = (await h.request("POST", "/api/fuel/fills/import", { ...as(ana), body: { csv, zone: "America/Tegucigalpa" } })).json.result as FuelImportResult;
    expect(again).toMatchObject({ imported: 0, repeated: 3 });
    // A file without the necessary columns is rejected entirely, saying which one is missing.
    const bad = await h.request("POST", "/api/fuel/fills/import", { ...as(ana), body: { csv: "Vehículo,Litros\nImportado Uno,20\n", zone: "America/Tegucigalpa" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/falta la columna Fecha/);
    expect((await h.request("POST", "/api/fuel/fills/import", { ...as(otherAccount), body: { csv, zone: "UTC" } })).status).toBe(404);
  });
});
