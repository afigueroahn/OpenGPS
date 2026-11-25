// Module C · Diagnostics: what the device reads from the vehicle, its charts, the
// fault codes, the engine notifications, and the odometer and engine hours
// kept by the core.
import type { DiagFault, DiagSeries, DiagSettings, DiagStatus, VehicleEvent, VehicleMeters } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TraccarRow } from "../src/ingest/poller";
import { readAll, readFaults, readParam, unknownAttrs } from "../src/core/readings";
import { keepPeaks, voltageLimit } from "../src/modules/diagnostics/diag";
import { DTC_CATALOG_SIZE, describeDtc } from "../src/modules/diagnostics/dtc";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let engineMail: Awaited<ReturnType<Harness["emailNotification"]>>;
let ana: TestUser; // owner, with the module
let otherAccount: TestUser; // another account, without the module
let workshop: TestUser; // another account, with maintenance only

const KNOTS = 1 / 1.852;
const HOUR = 3_600_000;
const LAT = 14.0818;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const as = (user: TestUser) => ({ cookie: user.cookie });
/** Each test uses its own vehicle and its own window of the last few hours. */
const START = Date.now() - 20 * HOUR;
const slot = (hour: number) => START + hour * HOUR;

interface Car {
  id: string;
  deviceId: number;
}
async function addVehicle(user: TestUser, name: string, modelId = "teltonika"): Promise<Car> {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { id: res.json.vehicle.id as string, deviceId: h.traccar.devices.get(uniqueId) as number };
}
const statusOf = async (user: TestUser, car: Car) => {
  const res = await h.request("GET", `/api/vehicles/${car.id}/diagnostics`, as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.diagnostics as DiagStatus;
};
const metersOf = async (user: TestUser, car: Car) => (await h.request("GET", `/api/vehicles/${car.id}/meters`, as(user))).json.meters as VehicleMeters;
const seriesOf = async (user: TestUser, car: Car, param: string, from: number, to: number) => {
  const res = await h.request("GET", `/api/vehicles/${car.id}/diagnostics/series?param=${param}&from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`, as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.series as DiagSeries;
};
const eventsOf = async (user: TestUser, car: Car) => ((await h.request("GET", `/api/events?limit=200&vehicleId=${car.id}`, as(user))).json.events as VehicleEvent[]).reverse();
const valueOf = (status: DiagStatus, param: string) => status.readings.find((r) => r.param === param)?.value;
const between = (value: number | undefined | null, min: number, max: number) => {
  expect(value).toBeGreaterThanOrEqual(min);
  expect(value).toBeLessThanOrEqual(max);
};

/** Track heading east, one position every `step` seconds, with the data that `attrs` gives. */
function trackOf(car: Car, start: number, protocol = "teltonika") {
  let t = start;
  let lon = -87.2068;
  const rows: TraccarRow[] = [];
  const api = {
    go(seconds: number, kmh: number, extra: { ignition?: boolean; step?: number; attrs?: (i: number, n: number) => Record<string, unknown> } = {}) {
      const step = extra.step ?? 30;
      const n = seconds / step;
      for (let i = 1; i <= n; i++) {
        t += step * 1000;
        lon += ((kmh / 3.6) * step) / M_PER_DEG_LON;
        const ignition = extra.ignition ?? kmh > 0;
        const attributes = { ignition, power: ignition ? 13.9 : 12.6, ...extra.attrs?.(i, n) };
        rows.push(traccarRow(car.deviceId, { fix: new Date(t), lon, lat: LAT, knots: kmh * KNOTS, attributes, protocol }));
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

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Diagnóstico");
  otherAccount = await h.signUp("Otra Cuenta");
  workshop = await h.signUp("Cuenta Taller");
  await h.enableModules(ana.orgId, ["C"]);
  await h.enableModules(workshop.orgId, ["E"]);
  // The account wants the engine notices by email.
  engineMail = await h.emailNotification(ana, ["engine_fault", "engine_overrev", "engine_overheat", "battery_low"]);
});
afterAll(async () => {
  await h?.close();
});

describe("module C: reading the vehicle data", () => {
  it("finds each datum where the device leaves it, in its unit", () => {
    // A Teltonika with a CAN adapter: the data arrive by their parameter number.
    const can = { io85: 2350, io115: 880, io114: 40, io82: 25, io81: 62, io83: 1234, io84: 450, io89: 70, io110: 85, io87: 123_456_000, io102: 90_000, power: 13.9, battery: 4.05 };
    expect(readAll(can, "teltonika")).toEqual({
      rpm: 2350,
      coolantTemp: 88,
      engineLoad: 40,
      throttle: 25,
      obdSpeed: 62,
      fuelUsed: 123.4,
      fuelLevelL: 45,
      fuelLevel: 70,
      fuelRate: 8.5,
      ecuOdometer: 123_456,
      ecuHours: 1500,
      power: 13.9,
      deviceBattery: 4.05,
    });
    // With an OBD reader the numbers are different, and some come on another scale.
    const obd = { io36: 2400, io32: 92, io31: 45, io41: 30, io37: 60, io48: 55, io60: 850, io39: 35, io58: 95, io51: 13_800, io42: 600 };
    expect(readAll(obd, "teltonika")).toEqual({ rpm: 2400, coolantTemp: 92, engineLoad: 45, throttle: 30, obdSpeed: 60, fuelLevel: 55, fuelRate: 8.5, intakeTemp: 35, oilTemp: 95, moduleVoltage: 13.8, engineRuntime: 10 });
    // If both come, the vehicle network one counts.
    expect(readParam("rpm", { io36: 2400, io85: 2350 }, "teltonika")).toBe(2350);
    // In another protocol those numbers mean something else: only the named data count.
    expect(readAll({ io36: 2400, io85: 2350, rpm: 1800, coolantTemp: 90 }, "ruptela")).toEqual({ rpm: 1800, coolantTemp: 90 });
    expect(readParam("rpm", { rpm: "1800" }, null)).toBe(1800);
    expect(readParam("rpm", { rpm: "no" }, null)).toBeNull();
    // What cannot be named is shown as is, without what already has its place.
    expect(unknownAttrs({ io85: 2350, io999: 5, io7: 1, ignition: true, sat: 12, distance: 4, dtcs: "P0300", texto: "x" }, "teltonika")).toEqual([
      { name: "io7", value: 1 },
      { name: "io999", value: 5 },
    ]);
  });

  it("reads the fault codes, and tells 'no faults' from 'says nothing'", () => {
    expect(readFaults({ dtcs: "P0300 P0171" }, "teltonika")).toEqual(["P0300", "P0171"]);
    expect(readFaults({ dtcs: "p0300,P0300;u0100" }, null)).toEqual(["P0300", "U0100"]);
    expect(readFaults({ dtcs: "" }, "teltonika")).toEqual([]);
    expect(readFaults({ io30: 0 }, "teltonika")).toEqual([]);
    expect(readFaults({ io30: 2 }, "teltonika")).toBeNull();
    expect(readFaults({ io30: 0 }, "h02")).toBeNull();
    expect(readFaults({ rpm: 900 }, "teltonika")).toBeNull();
  });

  it("explains each code in Spanish, or at least which system it belongs to", () => {
    expect(DTC_CATALOG_SIZE).toBeGreaterThan(200);
    expect(describeDtc("P0300", "es")).toEqual({ description: "Fallos de encendido en varios cilindros", specific: true, system: "Motor y transmisión" });
    expect(describeDtc("p0171", "es")).toMatchObject({ description: "Mezcla demasiado pobre, banco 1", specific: true });
    expect(describeDtc("U0100", "es")).toMatchObject({ specific: true, system: "Red de comunicación" });
    // A standard one that is not in the catalogue: its family says what it refers to.
    expect(describeDtc("P0399", "es")).toMatchObject({ specific: false, description: expect.stringMatching(/encendido/) });
    expect(describeDtc("P0799", "es")).toMatchObject({ specific: false, description: expect.stringMatching(/transmisión/) });
    // The manufacturer-specific ones are recognised as such.
    expect(describeDtc("P1234", "es")).toMatchObject({ specific: false, description: expect.stringMatching(/fabricante/) });
    expect(describeDtc("C1201", "es")).toMatchObject({ specific: false, system: "Chasis", description: expect.stringMatching(/fabricante/) });
    expect(describeDtc("B0099", "es")).toMatchObject({ specific: false, system: "Carrocería" });
  });

  it("thinning a chart does not lose the peaks", () => {
    const points = Array.from({ length: 6000 }, (_, i) => ({ t: i, v: i === 3333 ? 5200 : i === 4444 ? 300 : 2000 }));
    const light = keepPeaks(points, 300);
    expect(light.length).toBeLessThanOrEqual(600);
    expect(Math.max(...light.map((p) => p.v))).toBe(5200);
    expect(Math.min(...light.map((p) => p.v))).toBe(300);
    expect(light.map((p) => p.t)).toEqual(light.map((p) => p.t).sort((a, b) => a - b));
    expect(keepPeaks(points.slice(0, 100), 300)).toHaveLength(100);
    // The battery minimum is for a 12 V system: in a 24 V one it is double.
    expect(voltageLimit(11.8, 12.4)).toBe(11.8);
    expect(voltageLimit(11.8, 25.1)).toBe(23.6);
    expect(voltageLimit(23, 25.1)).toBe(23);
  });
});

describe("module C: dashboard and charts", () => {
  it("without the module enabled, its routes do not exist for that account", async () => {
    const car = await addVehicle(otherAccount, "Sin diagnóstico");
    for (const path of [`/api/vehicles/${car.id}/diagnostics`, `/api/vehicles/${car.id}/diagnostics/faults`, `/api/vehicles/${car.id}/meters`, "/api/diagnostics/settings"]) {
      expect((await h.request("GET", path, as(otherAccount))).status, path).toBe(404);
    }
    const mine = await addVehicle(ana, "Ajeno para la otra");
    expect((await h.request("GET", `/api/vehicles/${mine.id}/diagnostics`, as(otherAccount))).status).toBe(404);
  });

  it("shows the last thing the device read of each datum, and only what that device sends", async () => {
    const car = await addVehicle(ana, "Camión con CAN");
    const t0 = slot(0);
    const track = trackOf(car, t0);
    track.go(600, 60, { attrs: () => ({ io85: 1800, io115: 870, io83: 1200, io87: 123_400_000, io102: 89_990, io999: 5 }) });
    // The latest positions no longer carry the temperature: the last one read is still shown.
    track.go(60, 60, { attrs: () => ({ io85: 2350, io83: 1234, io87: 123_456_000, io102: 90_000, io999: 7 }) });
    await track.send();
    const status = await statusOf(ana, car);
    expect(valueOf(status, "rpm")).toBe(2350);
    expect(valueOf(status, "coolantTemp")).toBe(87);
    expect(valueOf(status, "fuelUsed")).toBeCloseTo(123.4, 5);
    expect(valueOf(status, "ecuOdometer")).toBe(123_456);
    expect(valueOf(status, "ecuHours")).toBe(1500);
    expect(valueOf(status, "power")).toBe(13.9);
    // This device does not send throttle or engine load: they do not appear.
    expect(status.readings.map((r) => r.param)).not.toContain("throttle");
    expect(status.readings.map((r) => r.param)).not.toContain("engineLoad");
    expect(status.others).toEqual([{ name: "io999", value: 7 }]);
    expect(status.faults).toEqual([]);
    expect(status.limits).toEqual({ rpmMax: 4500, tempMaxC: 105, voltageMinV: 11.8 });
    expect(status.own).toEqual({});
    // The odometer and hours are those of the vehicle itself.
    expect(status.meters).toMatchObject({ odometerKm: 123_456, odometerSource: "ecu", engineHours: 1500, hoursSource: "ecu" });

    // A device that reads nothing from the vehicle: only the voltage, and the platform's counters.
    const plain = await addVehicle(ana, "Camioneta sencilla", "h02");
    await trackOf(plain, t0, "h02").go(600, 60).send();
    const simple = await statusOf(ana, plain);
    expect(simple.readings.map((r) => r.param)).toEqual(["power"]);
    expect(simple.meters).toMatchObject({ odometerSource: "gps", hoursSource: "ignition" });
  });

  it("charts a datum over a period without losing the peaks, with its limit, and says how much a counter advanced", async () => {
    const car = await addVehicle(ana, "Camión de la gráfica");
    const t0 = slot(2);
    const track = trackOf(car, t0);
    // One hour at 2,000 rpm with a brief peak, and the fuel counter advancing 6 litres.
    track.go(3600, 60, { step: 5, attrs: (i, n) => ({ io36: i === 400 ? 5200 : 2000, io32: 88, io83: 1000 + Math.round((60 * i) / n) }) });
    await track.send();
    const rpm = await seriesOf(ana, car, "rpm", t0, t0 + 2 * HOUR);
    expect(rpm).toMatchObject({ param: "rpm", min: 2000, max: 5200, limit: 4500, delta: null });
    expect(rpm.points.length).toBeGreaterThan(100);
    expect(rpm.points.length).toBeLessThanOrEqual(600);
    expect(Math.max(...rpm.points.map((p) => p.v))).toBe(5200);
    between(rpm.avg, 2000, 2010);
    const used = await seriesOf(ana, car, "fuelUsed", t0, t0 + 2 * HOUR);
    expect(used).toMatchObject({ min: 100, max: 106, limit: null });
    expect(used.delta).toBeCloseTo(6, 5);
    expect(await seriesOf(ana, car, "coolantTemp", t0, t0 + 2 * HOUR)).toMatchObject({ min: 88, max: 88, limit: 105 });
    expect(await seriesOf(ana, car, "power", t0, t0 + 2 * HOUR)).toMatchObject({ min: 13.9, limit: 11.8 });
    // A datum the device does not send comes out empty, and one that does not exist is rejected.
    expect(await seriesOf(ana, car, "throttle", t0, t0 + 2 * HOUR)).toMatchObject({ points: [], min: null, max: null, avg: null });
    expect((await h.request("GET", `/api/vehicles/${car.id}/diagnostics/series?param=inventado&from=${new Date(t0).toISOString()}&to=${new Date(t0 + HOUR).toISOString()}`, as(ana))).status).toBe(400);
  });
});

describe("module C: engine notifications", () => {
  it("warns if the engine over-revs or overheats for a while, not for an isolated peak", async () => {
    const car = await addVehicle(ana, "Camión exigido");
    h.mails.length = 0;
    const t0 = slot(4);
    const track = trackOf(car, t0);
    track.go(300, 60, { step: 5, attrs: (i) => ({ io36: i === 20 ? 5000 : 2200, io32: i === 30 ? 112 : 90 }) }); // peaks of a single reading
    await track.send();
    expect((await eventsOf(ana, car)).filter((e) => e.type.startsWith("engine_"))).toEqual([]);
    track.go(60, 60, { step: 5, attrs: () => ({ io36: 4800, io32: 90 }) }); // twelve readings over the rev limit
    track.go(120, 60, { step: 5, attrs: () => ({ io36: 2200, io32: 109 }) }); // two minutes overheated
    await track.send();
    const events = (await eventsOf(ana, car)).filter((e) => e.type.startsWith("engine_"));
    expect(events).toMatchObject([
      { type: "engine_overrev", detail: { rpm: 4800, limit: 4500 } },
      { type: "engine_overheat", detail: { tempC: 109, limit: 105 } },
    ]);
    // Among those that need attention, and by email to whoever sees the vehicle.
    const alerts = (await h.request("GET", `/api/events?alerts=1&vehicleId=${car.id}`, as(ana))).json.events as VehicleEvent[];
    expect(alerts.map((e) => e.type).sort()).toEqual(["engine_overheat", "engine_overrev"]);
    expect(h.mails.map((m) => m.subject).sort()).toEqual(["Camión exigido: motor pasado de revoluciones", "Camión exigido: motor recalentado"]);
    expect(h.mails.find((m) => m.subject.includes("recalentado"))?.body).toContain("llegó a 109 °C; el límite es 105 °C");

    // While it stays the same it does not repeat; if it normalises and happens again soon after, neither.
    track.go(120, 60, { step: 5, attrs: () => ({ io36: 2200, io32: 110 }) });
    track.go(120, 60, { step: 5, attrs: () => ({ io36: 2200, io32: 90 }) });
    track.go(120, 60, { step: 5, attrs: () => ({ io36: 2200, io32: 110 }) });
    await track.send();
    expect((await eventsOf(ana, car)).filter((e) => e.type === "engine_overheat")).toHaveLength(1);
  });

  it("the limits belong to the account, each vehicle can have its own, and a notification can be turned off", async () => {
    const settings = (await h.request("GET", "/api/diagnostics/settings", as(ana))).json.settings as DiagSettings;
    expect(settings).toEqual({ rpmMax: 4500, tempMaxC: 105, voltageMinV: 11.8, zone: "UTC" });
    const saved = await h.request("PUT", "/api/diagnostics/settings", { ...as(ana), body: { ...settings, rpmMax: 4000, zone: "America/Tegucigalpa" } });
    expect(saved.json.settings).toEqual({ rpmMax: 4000, tempMaxC: 105, voltageMinV: 11.8, zone: "America/Tegucigalpa" });
    expect((await engineMail.set(false)).status).toBe(200);
    expect((await h.request("PUT", "/api/diagnostics/settings", { ...as(ana), body: { ...settings, rpmMax: 50 } })).status).toBe(400);
    expect((await h.request("PUT", "/api/diagnostics/settings", { ...as(otherAccount), body: settings })).status).toBe(404);

    // A diesel truck warns much sooner; the motorbike's revs are not watched.
    const truck = await addVehicle(ana, "Camión diésel");
    const bike = await addVehicle(ana, "Moto");
    const own = await h.request("PUT", `/api/vehicles/${truck.id}/diagnostics/limits`, { ...as(ana), body: { rpmMax: 2800 } });
    expect(own.json.diagnostics).toMatchObject({ limits: { rpmMax: 2800, tempMaxC: 105, voltageMinV: 11.8 }, own: { rpmMax: 2800 } });
    expect((await h.request("PUT", `/api/vehicles/${bike.id}/diagnostics/limits`, { ...as(ana), body: { rpmMax: null } })).json.diagnostics).toMatchObject({ limits: { rpmMax: null }, own: { rpmMax: null } });
    expect((await h.request("PUT", `/api/vehicles/${truck.id}/diagnostics/limits`, { ...as(otherAccount), body: { rpmMax: 2800 } })).status).toBe(404);
    h.mails.length = 0;
    const t0 = slot(6);
    for (const car of [truck, bike]) await trackOf(car, t0).go(120, 60, { step: 5, attrs: () => ({ io36: 3200 }) }).send();
    expect((await eventsOf(ana, truck)).filter((e) => e.type === "engine_overrev")).toMatchObject([{ detail: { rpm: 3200, limit: 2800 } }]);
    expect((await eventsOf(ana, bike)).filter((e) => e.type === "engine_overrev")).toEqual([]);
    // With the account's notification turned off, the notice stays on the platform and is not sent.
    expect(h.mails).toEqual([]);
    // Without its own limits, the account's applies again.
    expect((await h.request("PUT", `/api/vehicles/${truck.id}/diagnostics/limits`, { ...as(ana), body: {} })).json.diagnostics).toMatchObject({ limits: { rpmMax: 4000 }, own: {} });
    expect((await engineMail.set(true)).status).toBe(200);
  });

  it("warns about low battery if it stays that way for several minutes, and in a 24 V system with its own minimum", async () => {
    const car = await addVehicle(ana, "Batería gastada");
    const big = await addVehicle(ana, "Camión de 24 V");
    const t0 = slot(8);
    const track = trackOf(car, t0);
    // On starting it drops for a moment: it does not count.
    track.go(60, 0, { ignition: true, step: 10, attrs: (i) => ({ power: i === 2 ? 9.8 : 12.5 }) });
    track.go(240, 0, { ignition: false, attrs: () => ({ power: 11.4 }) });
    await track.send();
    expect((await eventsOf(ana, car)).filter((e) => e.type === "battery_low")).toEqual([]);
    track.go(240, 0, { ignition: false, attrs: () => ({ power: 11.3 }) });
    await track.send();
    expect((await eventsOf(ana, car)).filter((e) => e.type === "battery_low")).toMatchObject([{ detail: { volts: 11.3, limit: 11.8 } }]);
    // In the 24 V one, 23 volts is low even though it is above 11.8.
    await trackOf(big, t0).go(600, 0, { ignition: false, attrs: () => ({ power: 23 }) }).send();
    expect((await eventsOf(ana, big)).filter((e) => e.type === "battery_low")).toMatchObject([{ detail: { volts: 23, limit: 23.6 } }]);
    // Fully disconnected is not a low battery.
    const cut = await addVehicle(ana, "Desconectado");
    await trackOf(cut, t0).go(600, 0, { ignition: false, attrs: () => ({ power: 0.4 }) }).send();
    expect((await eventsOf(ana, cut)).filter((e) => e.type === "battery_low")).toEqual([]);
  });
});

describe("module C: fault codes", () => {
  it("records each code that appears, with its explanation, and marks it resolved when the vehicle stops reporting it", async () => {
    const car = await addVehicle(ana, "Camión con falla");
    h.mails.length = 0;
    const t0 = slot(10);
    const track = trackOf(car, t0);
    track.go(120, 60, { attrs: () => ({ io30: 0, io36: 2000 }) }); // no faults
    track.go(120, 60, { attrs: () => ({ io30: 2, dtcs: "P0300 P1234", io36: 2000 }) });
    await track.send();
    const events = async () => (await eventsOf(ana, car)).filter((e) => e.type.startsWith("engine_fault"));
    expect(await events()).toMatchObject([
      { type: "engine_fault", detail: { code: "P0300", description: "Fallos de encendido en varios cilindros" } },
      { type: "engine_fault", detail: { code: "P1234" } },
    ]);
    expect(h.mails.map((m) => m.subject)).toEqual(["Camión con falla: código de falla del motor", "Camión con falla: código de falla del motor"]);
    expect(h.mails[0]?.body).toContain("P0300: Fallos de encendido en varios cilindros");
    let status = await statusOf(ana, car);
    expect(status.faults).toMatchObject([
      { code: "P0300", specific: true, system: "Motor y transmisión", clearedAt: null },
      { code: "P1234", specific: false, clearedAt: null },
    ]);
    expect(status.faults[1]?.description).toMatch(/fabricante/);

    // While it keeps reporting it, it does not repeat. With the engine off, the empty reading resolves nothing.
    track.go(600, 60, { attrs: () => ({ io30: 2, dtcs: "P0300 P1234" }) });
    track.go(300, 0, { ignition: false, attrs: () => ({ io30: 0, dtcs: "" }) });
    await track.send();
    expect(await events()).toHaveLength(2);
    expect((await statusOf(ana, car)).faults.filter((f) => f.clearedAt === null)).toHaveLength(2);
    expect(Date.parse((await statusOf(ana, car)).faults[0]?.lastSeenAt as string)).toBeGreaterThan(t0 + 10 * 60_000);

    // They repair it: with the engine on only one is left. The resolved one stays in the history.
    track.go(120, 60, { attrs: () => ({ io30: 1, dtcs: "P1234" }) });
    await track.send();
    expect((await events()).map((e) => e.type)).toEqual(["engine_fault", "engine_fault", "engine_fault_cleared"]);
    status = await statusOf(ana, car);
    expect(status.faults.map((f) => [f.code, f.clearedAt === null])).toEqual([
      ["P1234", true],
      ["P0300", false],
    ]);
    // A resolved code does not ask for attention.
    const alerts = (await h.request("GET", `/api/events?alerts=1&vehicleId=${car.id}`, as(ana))).json.events as VehicleEvent[];
    expect(alerts.map((e) => e.type)).toEqual(["engine_fault", "engine_fault"]);
    // If it appears again, it is a new fault.
    track.go(120, 60, { attrs: () => ({ io30: 2, dtcs: "P1234 P0300" }) });
    await track.send();
    expect((await events()).filter((e) => e.type === "engine_fault")).toHaveLength(3);
    const history = (await h.request("GET", `/api/vehicles/${car.id}/diagnostics/faults`, as(ana))).json.faults as DiagFault[];
    expect(history.map((f) => [f.code, f.clearedAt === null])).toEqual([
      ["P0300", true],
      ["P1234", true],
      ["P0300", false],
    ]);
  });
});

describe("core: odometer and engine hours", () => {
  it("the platform keeps them by adding up distance travelled and engine-on time, and they are adjusted to what the dashboard shows", async () => {
    const car = await addVehicle(ana, "Camioneta sin lector", "h02");
    const t0 = slot(12);
    const track = trackOf(car, t0, "h02");
    track.go(3600, 60); // 60 km in an hour
    track.go(1800, 0, { ignition: true }); // half an hour idling
    track.go(1800, 0, { ignition: false }); // half an hour off
    await track.send();
    let meters = await metersOf(ana, car);
    expect(meters).toMatchObject({ odometerSource: "gps", hoursSource: "ignition" });
    // The first position has no previous one: that half kilometre is not counted.
    between(meters.odometerKm, 59, 60.5);
    between(meters.engineHours, 1.45, 1.55);

    // The dashboard shows 150,000 km and 3,200 hours: it keeps adding from there.
    const set = await h.request("PUT", `/api/vehicles/${car.id}/meters`, { ...as(ana), body: { odometerKm: 150_000, engineHours: 3200 } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.meters).toMatchObject({ odometerKm: 150_000, engineHours: 3200, odometerSource: "gps" });
    track.go(1800, 60);
    await track.send();
    meters = await metersOf(ana, car);
    between(meters.odometerKm, 150_029.5, 150_030.5);
    between(meters.engineHours, 3200.45, 3200.55);
    // One alone can be adjusted; with none, or from another account, not.
    expect((await h.request("PUT", `/api/vehicles/${car.id}/meters`, { ...as(ana), body: { engineHours: 3000 } })).json.meters).toMatchObject({ engineHours: 3000 });
    between((await metersOf(ana, car)).odometerKm, 150_029.5, 150_030.5);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/meters`, { ...as(ana), body: {} })).status).toBe(400);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/meters`, { ...as(otherAccount), body: { odometerKm: 1 } })).status).toBe(404);
    // What arrives repeated or late is not added twice.
    await h.ingestFrom([traccarRow(car.deviceId, { fix: new Date(t0 + 60_000), lon: -87.2, lat: LAT, knots: 60 * KNOTS, attributes: { ignition: true }, protocol: "h02" })]).tick();
    await h.settle();
    between((await metersOf(ana, car)).odometerKm, 150_029.5, 150_030.5);
  });

  it("if the device reads the vehicle's values, those count, without jumping when switching from one to the other", async () => {
    const car = await addVehicle(ana, "Camión que estrena lector");
    const t0 = slot(15);
    const track = trackOf(car, t0);
    track.go(1800, 60); // 30 km without a reader
    await track.send();
    between((await metersOf(ana, car)).odometerKm, 29.5, 30.5);
    // They install the reader: since nobody had adjusted it, it takes the value the vehicle reports.
    track.go(600, 60, { attrs: (i) => ({ io87: 80_000_000 + i * 500, io102: 120_000 + i }) });
    await track.send();
    let meters = await metersOf(ana, car);
    expect(meters).toMatchObject({ odometerKm: 80_010, odometerSource: "ecu", hoursSource: "ecu" });
    between(meters.engineHours, 2000.3, 2000.4);
    // Adjusted by hand against the dashboard, it follows the vehicle's from that value.
    expect((await h.request("PUT", `/api/vehicles/${car.id}/meters`, { ...as(ana), body: { odometerKm: 80_500 } })).json.meters).toMatchObject({ odometerKm: 80_500, odometerSource: "ecu" });
    track.go(300, 60, { attrs: (i) => ({ io87: 80_010_000 + i * 500 }) });
    await track.send();
    expect((await metersOf(ana, car)).odometerKm).toBe(80_505);

    // Another vehicle adjusted by hand before having a reader: when the vehicle's data arrive it does not lose its adjustment.
    const tuned = await addVehicle(ana, "Camión ya ajustado");
    const other = trackOf(tuned, t0);
    other.go(600, 60);
    await other.send();
    expect((await h.request("PUT", `/api/vehicles/${tuned.id}/meters`, { ...as(ana), body: { odometerKm: 200_000 } })).status).toBe(200);
    other.go(600, 60, { attrs: (i) => ({ io87: 5_000_000 + i * 500 }) });
    await other.send();
    meters = await metersOf(ana, tuned);
    expect(meters.odometerSource).toBe("ecu");
    between(meters.odometerKm, 200_009, 200_011);
  });

  it("an account with maintenance and without diagnostics also sees them", async () => {
    const car = await addVehicle(workshop, "Del taller", "h02");
    await trackOf(car, slot(18), "h02").go(600, 60).send();
    const res = await h.request("GET", `/api/vehicles/${car.id}/meters`, as(workshop));
    expect(res.status).toBe(200);
    between((res.json.meters as VehicleMeters).odometerKm, 9.5, 10.5);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/meters`, { ...as(workshop), body: { odometerKm: 500 } })).json.meters).toMatchObject({ odometerKm: 500 });
    expect((await h.request("GET", `/api/vehicles/${car.id}/diagnostics`, as(workshop))).status).toBe(404);
  });
});
