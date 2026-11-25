// Module G · Reports and dashboards. Each report is compared with a control
// calculation: what the vehicle really travelled in the test, and what
// the history says, which analyses the whole period without going through the stored days.
import { mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Dashboard, DashboardData, ReportDocument, ReportSchedule, ReportTable, ReportValue, VehicleHistory } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TraccarRow } from "../src/ingest/poller";
import { nextRun, periodFor } from "../src/modules/reports/schedules";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser; // owner, with modules G, B and F
let otherAccount: TestUser; // another account, without the module

const KNOTS = 1 / 1.852;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LAT = 14.0818;
const LON = -87.2068;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const ZONE = "America/Tegucigalpa"; // six hours behind UTC, no time change
const as = (user: TestUser) => ({ cookie: user.cookie });
/** UTC midnight three days ago: everything from that day and the next is already complete. */
const BASE = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;
/** Local day A: from 06:00 UTC of that day to 06:00 of the next. Then comes day B. */
const DAY_A = BASE + 6 * HOUR;
const DAY_B = DAY_A + DAY;
const dateOf = (ms: number) => new Date(ms - 6 * HOUR).toISOString().slice(0, 10);

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
async function join(name: string, role: string, groups: string[] | null = null): Promise<TestUser> {
  const person = await h.signUp(name);
  const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role, groups } });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);
  expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
  return person;
}

/** Track heading east from a point, with one position every 30 seconds. */
function trackOf(car: Car, start: number, lon = LON) {
  let t = start;
  const rows: TraccarRow[] = [];
  const api = {
    go(seconds: number, kmh: number, extra: { ignition?: boolean; attrs?: (i: number, n: number) => Record<string, unknown> } = {}) {
      const n = seconds / 30;
      for (let i = 1; i <= n; i++) {
        t += 30_000;
        lon += ((kmh / 3.6) * 30) / M_PER_DEG_LON;
        rows.push(traccarRow(car.deviceId, { fix: new Date(t), lon, lat: LAT, knots: kmh * KNOTS, attributes: { ignition: extra.ignition ?? kmh > 0, ...extra.attrs?.(i, n) } }));
      }
      return api;
    },
    async send() {
      await h.ingestFrom(rows.splice(0)).tick();
      await h.settle();
    },
  };
  return api;
}

const query = (from: number, to: number, extra: Record<string, string | number> = {}) =>
  new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), zone: ZONE, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) }).toString();
async function reportOf(user: TestUser, type: string, from: number, to: number, extra: Record<string, string | number> = {}): Promise<ReportDocument> {
  const res = await h.request("GET", `/api/reports/${type}?${query(from, to, extra)}`, as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.report as ReportDocument;
}
async function historyOf(user: TestUser, car: Car, from: number, to: number): Promise<VehicleHistory> {
  const res = await h.request("GET", `/api/vehicles/${car.id}/history?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`, as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.history as VehicleHistory;
}
const tableOf = (doc: ReportDocument, title: string): ReportTable => {
  const found = doc.tables.find((t) => t.title === title);
  if (!found) throw new Error(`el reporte no trae la tabla "${title}": ${doc.tables.map((t) => t.title).join(", ")}`);
  return found;
};
/** Rows of a table as objects, with the name of each column. */
const rowsOf = (t: ReportTable) => t.rows.map((row) => Object.fromEntries(t.columns.map((c, i) => [c.label, row[i] as ReportValue])));
const statOf = (doc: ReportDocument, label: string) => doc.stats.find((s) => s.label === label)?.value;
const near = (value: unknown, expected: number, tolerance: number) => {
  expect(typeof value).toBe("number");
  expect(Math.abs((value as number) - expected), `${value} debería estar a ${tolerance} de ${expected}`).toBeLessThanOrEqual(tolerance);
};

/** With EXPORT_SAMPLES_DIR, the generated files are saved there so they can be opened and viewed. */
function save(name: string, body: Buffer) {
  const dir = process.env.EXPORT_SAMPLES_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(pathJoin(dir, name), body);
}

function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + buffer.readUInt16LE(offset + 28);
    files.set(buffer.toString("utf8", offset + 30, offset + 30 + nameLength), inflateRawSync(buffer.subarray(start, start + size)).toString("utf8"));
    offset = start + size;
  }
  return files;
}

let carOne: Car; // two trips and a stop on day A
let carTwo: Car; // a trip that crosses UTC midnight, and another on day B
let carThree: Car; // a stretch at 100 km/h
let north: string; // group of "dos"

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Reportes");
  otherAccount = await h.signUp("Otra Cuenta");
  await h.enableModules(ana.orgId, ["G"]);
  north = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: "Norte" } })).json.group.id as string;
  carOne = await addVehicle(ana, "Uno");
  carTwo = await addVehicle(ana, "Dos", north);
  carThree = await addVehicle(ana, "Tres");
  // One, 08:00 on day A: 30 minutes at 60 km/h, 20 stopped with the engine off and 15 at 40 km/h.
  await trackOf(carOne, DAY_A + 8 * HOUR)
    .go(1800, 60)
    .go(1200, 0, { ignition: false })
    .go(900, 40)
    .go(600, 0, { ignition: false })
    .send();
  // Two, 17:40 on day A (23:40 UTC): 40 minutes at 60 km/h, crossing UTC midnight. And at 01:00 on day B, 10 minutes at 30 km/h.
  await trackOf(carTwo, DAY_A + 17 * HOUR + 40 * 60_000)
    .go(2400, 60)
    .go(600, 0, { ignition: false })
    .send();
  await trackOf(carTwo, DAY_B + HOUR, LON + 0.5)
    .go(600, 30)
    .go(300, 0, { ignition: false })
    .send();
  // Three, 09:00 on day A: 10 minutes at 70, 5 at 100 and 10 at 70 km/h.
  await trackOf(carThree, DAY_A + 9 * HOUR)
    .go(600, 70)
    .go(300, 100)
    .go(600, 70)
    .go(300, 0, { ignition: false })
    .send();
}, 300_000);
afterAll(async () => {
  await h?.close();
});

describe("module G: per-account activation", () => {
  it("without the module enabled, its routes do not exist for that account", async () => {
    expect((await h.request("GET", `/api/reports/trips?${query(DAY_A, DAY_B)}`, as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", `/api/reports/trips/export?${query(DAY_A, DAY_B, { format: "pdf" })}`, as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", "/api/reports/schedules", as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", "/api/dashboards", as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", `/api/dashboards/data?${query(DAY_A, DAY_B)}`, as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", `/api/reports/trips?${query(DAY_A, DAY_B)}`)).status).toBe(401);
  });

  it("a report that does not exist, or from a module the account does not have, answers that it does not exist", async () => {
    expect((await h.request("GET", `/api/reports/inventado?${query(DAY_A, DAY_B)}`, as(ana))).status).toBe(404);
    expect((await h.request("GET", `/api/reports/drivers?${query(DAY_A, DAY_B)}`, as(ana))).status).toBe(404);
    expect((await h.request("GET", `/api/reports/fuel?${query(DAY_A, DAY_B)}`, as(ana))).status).toBe(404);
  });

  it("rejects impossible periods and time zones that do not exist", async () => {
    expect((await h.request("GET", `/api/reports/trips?${query(DAY_B, DAY_A)}`, as(ana))).status).toBe(400);
    expect((await h.request("GET", `/api/reports/trips?${query(DAY_A - 40 * DAY, DAY_A)}`, as(ana))).status).toBe(400);
    expect((await h.request("GET", `/api/reports/trips?${query(DAY_A, DAY_B).replace("America%2FTegucigalpa", "Marte%2FOlimpo")}`, as(ana))).status).toBe(400);
    expect((await h.request("GET", `/api/reports/trips?${query(Date.now() + DAY, Date.now() + 2 * DAY)}`, as(ana))).status).toBe(400);
  });
});

describe("module G: core reports", () => {
  it("trips: each trip with its distance and times, the same as in the history", async () => {
    const doc = await reportOf(ana, "trips", DAY_A, DAY_B, { vehicleIds: carOne.id });
    expect(doc.title).toBe("Reporte de recorridos");
    expect(doc.scope).toBe("Uno");
    const rows = rowsOf(tableOf(doc, "Viajes"));
    expect(rows).toHaveLength(2);
    // Control: 30 minutes at 60 km/h is 30 km; 15 minutes at 40 km/h, 10 km.
    near(rows[0]?.Distancia, 30_000, 600);
    near(rows[1]?.Distancia, 10_000, 400);
    expect(rows[0]?.["Vel. máxima"]).toBe(60);
    expect(rows[1]?.["Vel. máxima"]).toBe(40);
    near(rows[0]?.["Duración"], 1800, 31);
    expect(new Date(rows[0]?.Inicio as string).getTime()).toBe(DAY_A + 8 * HOUR + 30_000);

    const history = await historyOf(ana, carOne, DAY_A, DAY_B);
    expect(rows.map((r) => r.Distancia)).toEqual(history.trips.map((t) => t.distanceM));
    expect(rows.map((r) => [r.Inicio, r.Fin])).toEqual(history.trips.map((t) => [t.start, t.end]));
    expect(statOf(doc, "Distancia")).toBe(history.summary.distanceM);
    expect(statOf(doc, "Viajes")).toBe(2);
    expect(tableOf(doc, "Viajes").totals?.[4]).toBe(history.summary.distanceM);
  });

  it("a trip that crosses UTC midnight comes out whole, on the local day it began", async () => {
    const doc = await reportOf(ana, "trips", DAY_A, DAY_B, { vehicleIds: carTwo.id });
    const rows = rowsOf(tableOf(doc, "Viajes"));
    expect(rows).toHaveLength(1);
    near(rows[0]?.Distancia, 40_000, 600);
    near(rows[0]?.["Duración"], 2400, 31);
    // The trip of the following early morning belongs to day B, not this one.
    expect(rowsOf(tableOf(await reportOf(ana, "trips", DAY_B, DAY_B + DAY, { vehicleIds: carTwo.id }), "Viajes"))).toHaveLength(1);
  });

  it("stops: duration and place, and a minimum that leaves out the short ones", async () => {
    const doc = await reportOf(ana, "stops", DAY_A + 8 * HOUR, DAY_A + 9 * HOUR, { vehicleIds: carOne.id });
    const rows = rowsOf(tableOf(doc, "Paradas"));
    // Within that hour: the 20 minutes between the two trips and what remained stopped at the end.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    near(rows[0]?.["Duración"], 1200, 31);
    // The engine was still on at the trip's last position: at most, that half minute.
    near(rows[0]?.["Con el motor encendido"], 0, 30);
    expect(rows[0]?.Lugar).toMatchObject({ lat: LAT });
    const history = await historyOf(ana, carOne, DAY_A + 8 * HOUR, DAY_A + 9 * HOUR);
    expect(rows.map((r) => r["Duración"])).toEqual(history.stops.map((s) => s.durationS));

    const long = await reportOf(ana, "stops", DAY_A + 8 * HOUR, DAY_A + 9 * HOUR, { vehicleIds: carOne.id, minStopMin: 30 });
    expect(tableOf(long, "Paradas").rows).toHaveLength(0);
    expect(long.options).toEqual(["Paradas de al menos 30 min"]);
  });

  it("mileage: by vehicle, by day and by group, and everything adds up to the same", async () => {
    const doc = await reportOf(ana, "mileage", DAY_A, DAY_B + DAY);
    const byCar = rowsOf(tableOf(doc, "Por vehículo"));
    const km = (name: string) => byCar.find((r) => r["Vehículo"] === name)?.Distancia as number;
    near(km("Uno"), 40_000, 800);
    near(km("Dos"), 45_000, 800);
    near(km("Tres"), 31_670, 900);
    const total = km("Uno") + km("Dos") + km("Tres");
    expect(statOf(doc, "Distancia")).toBe(total);

    const byDay = rowsOf(tableOf(doc, "Por día"));
    expect(byDay.map((r) => r["Día"])).toEqual([dateOf(DAY_A), dateOf(DAY_B)]);
    // Day B: only the 10 minutes at 30 km/h of "Dos".
    near(byDay[1]?.Distancia, 5000, 300);
    expect(byDay[1]?.["Vehículos con viajes"]).toBe(1);
    expect((byDay[0]?.Distancia as number) + (byDay[1]?.Distancia as number)).toBe(total);
    expect(doc.chart?.labels).toEqual([dateOf(DAY_A), dateOf(DAY_B)]);
    expect(doc.chart?.series[0]?.values).toEqual(byDay.map((r) => r.Distancia));

    const byGroup = rowsOf(tableOf(doc, "Por grupo"));
    expect(byGroup.find((r) => r.Grupo === "Norte")).toMatchObject({ "Vehículos": 1, Distancia: km("Dos") });
    expect(byGroup.find((r) => r.Grupo === "Sin grupo")).toMatchObject({ "Vehículos": 2, Distancia: km("Uno") + km("Tres") });
    const detail = rowsOf(tableOf(doc, "Por día y vehículo"));
    expect(detail.reduce((n, r) => n + (r.Distancia as number), 0)).toBe(total);

    // The day's mileage is the sum of that day's trips in the trips report.
    const trips = await reportOf(ana, "trips", DAY_A, DAY_B);
    expect(statOf(trips, "Distancia")).toBe(byDay[0]?.Distancia);

    const group = await reportOf(ana, "mileage", DAY_A, DAY_B + DAY, { groupId: north });
    expect(group.scope).toBe("Grupo Norte");
    expect(rowsOf(tableOf(group, "Por vehículo")).map((r) => r["Vehículo"])).toEqual(["Dos"]);
  });

  it("speeds: maximum, average and the excesses over the chosen limit", async () => {
    const doc = await reportOf(ana, "speed", DAY_A, DAY_B, { vehicleIds: carThree.id, speedLimitKmh: 80 });
    expect(doc.options).toEqual(["Límite: 80 km/h"]);
    const car = rowsOf(tableOf(doc, "Por vehículo"))[0];
    expect(car).toMatchObject({ "Vehículo": "Tres", "Vel. máxima": 100, Excesos: 1 });
    // Control: 10 min at 70, 5 at 100 and 10 at 70 are 31.7 km in 25 minutes: 76 km/h.
    near(car?.["Vel. promedio en marcha"], 76, 2);
    const over = rowsOf(tableOf(doc, "Excesos"));
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ "Vel. máxima": 100, "Sobre el límite": 20 });
    near(over[0]?.["Duración"], 300, 31);
    expect(new Date(over[0]?.Inicio as string).getTime()).toBe(DAY_A + 9 * HOUR + 600_000 + 30_000);

    const calm = await reportOf(ana, "speed", DAY_A, DAY_B, { vehicleIds: carThree.id, speedLimitKmh: 120 });
    expect(tableOf(calm, "Excesos").rows).toHaveLength(0);
    expect(statOf(calm, "Excesos")).toBe(0);
    // With all the vehicles, at 65 km/h only "Tres" exceeds the limit: one continuous stretch of 25 minutes.
    const all = await reportOf(ana, "speed", DAY_A, DAY_B, { speedLimitKmh: 65 });
    expect(statOf(all, "Vehículos con excesos")).toBe("1 de 3");
    near(rowsOf(tableOf(all, "Excesos"))[0]?.["Duración"], 1500, 31);
  });

  it("utilisation: time on trips over the total of the period", async () => {
    const doc = await reportOf(ana, "utilization", DAY_A, DAY_B);
    const rows = rowsOf(tableOf(doc, "Por vehículo"));
    const one = rows.find((r) => r["Vehículo"] === "Uno");
    // Control: 45 minutes on trips out of 24 hours is 3.1 %.
    near(one?.["En viaje"], 2700, 62);
    near(one?.Uso, 3.1, 0.2);
    expect((one?.["En viaje"] as number) + (one?.["Sin viajar"] as number)).toBe(86_400);
    expect(one?.[`Días con uso (de 1)`]).toBe(1);
    expect(statOf(doc, "Vehículos sin uso")).toBe("0 de 3");
    expect(doc.chart?.series.map((s) => s.name)).toEqual(["En movimiento", "Ralentí"]);
  });

  it("alarms: by type, by vehicle and by day", async () => {
    const insert = (car: Car, type: string, at: number, detail: object = {}) =>
      h.db.core.query(`INSERT INTO gps.events (org_id, vehicle_id, device_id, type, at, lat, lon, detail) SELECT $1, $2, d.id, $3, $4, $5, $6, $7::jsonb FROM gps.devices d WHERE d.vehicle_id = $2`, [
        ana.orgId,
        car.id,
        type,
        new Date(at),
        LAT,
        LON,
        JSON.stringify(detail),
      ]);
    await insert(carOne, "speeding", DAY_A + 8 * HOUR, { speedKmh: 95, limitKmh: 80, ruleName: "Carretera" });
    await insert(carOne, "speeding", DAY_A + 9 * HOUR, { speedKmh: 99, limitKmh: 80, ruleName: "Carretera" });
    await insert(carTwo, "sos", DAY_B + 2 * HOUR);
    // A geofence entry is a record, not an alarm.
    await insert(carTwo, "geofence_enter", DAY_B + 3 * HOUR, { geofenceName: "Patio" });

    const doc = await reportOf(ana, "alarms", DAY_A, DAY_B + DAY);
    expect(statOf(doc, "Alarmas")).toBe(3);
    expect(statOf(doc, "La más frecuente")).toBe("Exceso de velocidad");
    expect(rowsOf(tableOf(doc, "Por tipo"))).toEqual([
      { Tipo: "Exceso de velocidad", Cantidad: 2, "Vehículos": 1 },
      { Tipo: "Botón de pánico", Cantidad: 1, "Vehículos": 1 },
    ]);
    expect(rowsOf(tableOf(doc, "Por vehículo"))).toEqual([
      { "Vehículo": "Uno", Total: 2, "Exceso de velocidad": 2, "Botón de pánico": 0 },
      { "Vehículo": "Dos", Total: 1, "Exceso de velocidad": 0, "Botón de pánico": 1 },
    ]);
    expect(doc.chart?.series[0]?.values).toEqual([2, 1]);
    const detail = rowsOf(tableOf(doc, "Detalle"));
    expect(detail[0]?.Detalle).toBe('iba a 95 km/h con un límite de 80 km/h · alerta "Carretera"');
    expect(detail[2]).toMatchObject({ "Vehículo": "Dos", Tipo: "Botón de pánico" });
  });

  it("geofences: entries, exits and dwell time of each visit", async () => {
    const car = await addVehicle(ana, "Cuatro");
    // A geofence of 500 m radius 5 km from the start, on the vehicle's road.
    const fence = await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Bodega", geometry: { shape: "circle", center: [LON + 5000 / M_PER_DEG_LON, LAT], radiusM: 500 } } });
    expect(fence.status, JSON.stringify(fence.json)).toBe(201);
    const start = DAY_A + 12 * HOUR;
    // 36 km/h is 300 m per position: it reaches the centre, stays 10 minutes and continues.
    await trackOf(car, start).go(510, 36).go(600, 0, { ignition: false }).go(300, 36).go(300, 0, { ignition: false }).send();

    const events = (await h.request("GET", `/api/events?limit=50&vehicleId=${car.id}`, as(ana))).json.events as { type: string; at: string; detail: { stayedMin?: number } }[];
    const enter = events.find((e) => e.type === "geofence_enter");
    const exit = events.find((e) => e.type === "geofence_exit");
    expect(enter && exit).toBeTruthy();

    const doc = await reportOf(ana, "geofences", DAY_A, DAY_B, { vehicleIds: car.id });
    expect(rowsOf(tableOf(doc, "Visitas"))).toEqual([
      { Geocerca: "Bodega", "Vehículo": "Cuatro", Entrada: enter?.at, Salida: exit?.at, Permanencia: Math.round((Date.parse(exit?.at as string) - Date.parse(enter?.at as string)) / 1000) },
    ]);
    // Control: it enters about 30 seconds before stopping, spends 10 minutes still and takes another minute to leave.
    near(rowsOf(tableOf(doc, "Visitas"))[0]?.Permanencia, 690, 61);
    expect(rowsOf(tableOf(doc, "Por geocerca"))[0]).toMatchObject({ Geocerca: "Bodega", Entradas: 1, Salidas: 1, "Vehículos": 1 });

    // If the period starts with the vehicle already inside, the entry comes from what the exit says it was there.
    const late = await reportOf(ana, "geofences", Date.parse(enter?.at as string) + 60_000, DAY_B, { vehicleIds: car.id });
    const visit = rowsOf(tableOf(late, "Visitas"))[0];
    expect(visit?.Salida).toBe(exit?.at);
    expect(visit?.Permanencia).toBe((exit?.detail.stayedMin ?? 0) * 60);
    // And if it ends with the vehicle inside, the visit stays open until the close.
    const early = await reportOf(ana, "geofences", DAY_A, Date.parse(enter?.at as string) + 120_000, { vehicleIds: car.id });
    expect(rowsOf(tableOf(early, "Visitas"))[0]).toMatchObject({ Entrada: enter?.at, Salida: null, Permanencia: 120 });
  });
});

describe("module G: scope and stored days", () => {
  it("whoever sees only one group receives only the vehicles of that group", async () => {
    const leo = await join("Leo del Norte", "viewer", [north]);
    const doc = await reportOf(leo, "mileage", DAY_A, DAY_B + DAY);
    expect(rowsOf(tableOf(doc, "Por vehículo")).map((r) => r["Vehículo"])).toEqual(["Dos"]);
    // Manually requesting a vehicle of another group does not bring it.
    expect((await h.request("GET", `/api/reports/trips?${query(DAY_A, DAY_B, { vehicleIds: carOne.id })}`, as(leo))).status).toBe(400);
    const mixed = await reportOf(leo, "trips", DAY_A, DAY_B, { vehicleIds: `${carOne.id},${carTwo.id}` });
    expect(new Set(rowsOf(tableOf(mixed, "Viajes")).map((r) => r["Vehículo"]))).toEqual(new Set(["Dos"]));
    // And another account with the module sees nothing of this one.
    await h.enableModules(otherAccount.orgId, ["G"]);
    expect((await h.request("GET", `/api/reports/trips?${query(DAY_A, DAY_B, { vehicleIds: carOne.id })}`, as(otherAccount))).status).toBe(400);
    expect(tableOf(await reportOf(otherAccount, "trips", DAY_A, DAY_B), "Viajes").rows).toHaveLength(0);
    await h.enableModules(otherAccount.orgId, []);
  });

  it("days that are already complete are stored, and a late position recalculates them", async () => {
    const car = await addVehicle(ana, "Cinco");
    await trackOf(car, DAY_A + 10 * HOUR).go(600, 60).go(300, 0, { ignition: false }).send();
    const before = await reportOf(ana, "trips", DAY_A, DAY_B, { vehicleIds: car.id });
    expect(tableOf(before, "Viajes").rows).toHaveLength(1);
    // Local day A touches two UTC days: both are stored.
    const days = [new Date(BASE).toISOString().slice(0, 10), new Date(BASE + DAY).toISOString().slice(0, 10)];
    const saved = async () => (await h.db.core.query(`SELECT day FROM gps.vehicle_days WHERE vehicle_id = $1 AND day = ANY($2::date[])`, [car.id, days])).rowCount;
    expect(await saved()).toBe(2);

    // The device now uploads a trip from that same day that it had not sent.
    await trackOf(car, DAY_A + 15 * HOUR, LON + 0.3).go(600, 30).go(300, 0, { ignition: false }).send();
    expect(await saved()).toBe(0);
    const after = await reportOf(ana, "trips", DAY_A, DAY_B, { vehicleIds: car.id });
    expect(tableOf(after, "Viajes").rows).toHaveLength(2);
    expect(statOf(after, "Distancia")).toBe((await historyOf(ana, car, DAY_A, DAY_B)).summary.distanceM);
  });

  it("today's data also counts, even though the day has not ended", async () => {
    const car = await addVehicle(ana, "Seis");
    const start = Date.now() - 50 * 60_000;
    await trackOf(car, start).go(900, 60).go(300, 0, { ignition: false }).send();
    const doc = await reportOf(ana, "trips", Date.now() - 2 * HOUR, Date.now() + HOUR, { vehicleIds: car.id });
    const rows = rowsOf(tableOf(doc, "Viajes"));
    expect(rows).toHaveLength(1);
    near(rows[0]?.Distancia, 15_000, 600);
  });
});

describe("module G: reports from other modules", () => {
  it("drivers and fuel appear when the account has those modules", async () => {
    await h.enableModules(ana.orgId, ["G", "B", "F"]);
    const car = await addVehicle(ana, "Siete");
    const driver = await h.request("POST", "/api/drivers", { ...as(ana), body: { name: "Marta Conductora" } });
    expect(driver.status, JSON.stringify(driver.json)).toBe(201);
    const start = DAY_A + 11 * HOUR;
    await h.db.core.query(`INSERT INTO gps.driver_assignments (org_id, vehicle_id, driver_id, starts_at, source) VALUES ($1, $2, $3, $4, 'manual')`, [ana.orgId, car.id, driver.json.driver.id, new Date(start - HOUR)]);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/fuel`, { ...as(ana), body: { capacityL: 100, attr: "fuel", kind: "percent", normL100km: 10, normIdleLh: null } })).status).toBe(200);
    // 60 km in an hour, with the tank dropping from 80 % to 74 %: 6 litres.
    // Then, parked with the engine off, 14 litres are taken out; later it refills 30.
    await trackOf(car, start)
      .go(3600, 60, { attrs: (i, n) => ({ fuel: 80 - (6 * i) / n }) })
      .go(300, 0, { ignition: false, attrs: () => ({ fuel: 74 }) })
      .go(600, 0, { ignition: false, attrs: () => ({ fuel: 60 }) })
      .go(600, 0, { ignition: false, attrs: () => ({ fuel: 90 }) })
      .send();
    // The fill is recorded with what it cost.
    const paid = await h.request("POST", `/api/vehicles/${car.id}/fuel/fills`, { ...as(ana), body: { at: new Date(start + 75 * 60_000).toISOString(), liters: 30, total: 3300, currency: "HNL" } });
    expect(paid.status, JSON.stringify(paid.json)).toBe(201);

    const drivers = await reportOf(ana, "drivers", DAY_A, DAY_B, { vehicleIds: car.id });
    const person = rowsOf(tableOf(drivers, "Conductores")).find((r) => r.Conductor === "Marta Conductora");
    near(person?.Distancia, 60_000, 800);
    expect(person?.Puntaje).toBe(100);
    near(person?.["Al volante"], 3600, 61);

    const fuel = await reportOf(ana, "fuel", DAY_A, DAY_B);
    expect(statOf(fuel, "Vehículos con tanque")).toMatch(/^1 de \d+$/);
    const row = rowsOf(tableOf(fuel, "Por vehículo"))[0];
    expect(row).toMatchObject({ "Vehículo": "Siete", "Cómo se midió": "Nivel del tanque", Cargas: 1, Descargas: 1, Pagado: "3.300,00 HNL" });
    // What was taken out does not count as consumption.
    near(row?.["Consumo medido"], 6, 0.3);
    near(row?.["Consumo por norma"], 6, 0.2);
    near(row?.["km/L"], 10, 0.5);
    near(row?.Cargado, 30, 0.5);
    near(row?.Descargado, 14, 0.5);
    // About 6 litres at 110 per litre over 60 km: 11 per kilometre.
    expect(row?.["Costo por km"]).toMatch(/^1[01],\d\d HNL$/);
    near(statOf(fuel, "Descargado") as number, 14, 0.5);
    expect(rowsOf(tableOf(fuel, "Descargas"))).toMatchObject([{ "Vehículo": "Siete", Motor: "Apagado: posible robo" }]);
    near(rowsOf(tableOf(fuel, "Descargas"))[0]?.Litros, 14, 0.5);
    expect(rowsOf(tableOf(fuel, "Pagado en abastecimientos"))).toMatchObject([{ Moneda: "HNL", Abastecimientos: 1, Total: "3.300,00 HNL", "Precio por litro": "110,00 HNL" }]);
  });
});

describe("module G: export", () => {
  it("Excel: a summary sheet and one per table, with the same totals", async () => {
    const res = await h.fastify.inject({ method: "GET", url: `/api/reports/mileage/export?${query(DAY_A, DAY_B + DAY, { format: "xlsx" })}`, headers: { cookie: ana.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="reporte-de-kilometraje-${dateOf(DAY_A)}_${dateOf(DAY_B)}.xlsx"`);
    save("mileage.xlsx", res.rawPayload);
    const files = unzip(res.rawPayload);
    const book = files.get("xl/workbook.xml") as string;
    expect([...book.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(["Resumen", "Por vehículo", "Por día", "Por grupo", "Por día y vehículo"]);
    expect(files.get("xl/worksheets/sheet1.xml")).toContain("Reporte de kilometraje");
    const doc = await reportOf(ana, "mileage", DAY_A, DAY_B + DAY);
    // The distance is in kilometres, as a number.
    expect(files.get("xl/worksheets/sheet2.xml")).toContain(`<v>${(statOf(doc, "Distancia") as number) / 1000}</v>`);
    expect(files.get("xl/worksheets/sheet2.xml")).toContain("Distancia (km)");

    const log = await h.db.core.query<{ detail: { type: string; format: string } }>(`SELECT detail FROM gps.audit_log WHERE org_id = $1 AND action = 'report.export' ORDER BY id DESC LIMIT 1`, [ana.orgId]);
    expect(log.rows[0]?.detail).toMatchObject({ type: "mileage", format: "xlsx" });
  });

  it("PDF: all the reports come out as a file", async () => {
    for (const type of ["trips", "stops", "mileage", "speed", "geofences", "alarms", "utilization", "drivers", "fuel"]) {
      const res = await h.fastify.inject({ method: "GET", url: `/api/reports/${type}/export?${query(DAY_A, DAY_B + DAY, { format: "pdf" })}`, headers: { cookie: ana.cookie } });
      expect(res.statusCode, `${type}: ${res.payload.slice(0, 200)}`).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(res.rawPayload.length).toBeGreaterThan(1500);
      save(`${type}.pdf`, res.rawPayload);
    }
    expect((await h.request("GET", `/api/reports/trips/export?${query(DAY_A, DAY_B, { format: "docx" })}`, as(ana))).status).toBe(400);
  });
});

describe("module G: scheduled reports", () => {
  const when = (frequency: "daily" | "weekly" | "monthly", extra: object = {}) => ({ frequency, atMinute: 7 * 60, weekday: 1, monthDay: 1, zone: ZONE, ...extra });
  const local = (iso: string) => Date.parse(`${iso}-06:00`);

  it("computes the next send and the period in the report's time zone", () => {
    // Daily at 07:00: if it has already passed, tomorrow.
    expect(nextRun(when("daily"), local("2026-11-22T06:59:00"))).toBe(local("2026-11-22T07:00:00"));
    expect(nextRun(when("daily"), local("2026-11-22T07:00:00"))).toBe(local("2026-11-23T07:00:00"));
    // Weekly, on Mondays: 22 November 2026 is a Sunday.
    expect(nextRun(when("weekly"), local("2026-11-22T12:00:00"))).toBe(local("2026-11-23T07:00:00"));
    expect(nextRun(when("weekly"), local("2026-11-23T07:00:00"))).toBe(local("2026-11-30T07:00:00"));
    // Monthly, on the 1st; in December it moves to the next year.
    expect(nextRun(when("monthly"), local("2026-11-22T12:00:00"))).toBe(local("2026-12-01T07:00:00"));
    expect(nextRun(when("monthly", { monthDay: 15 }), local("2026-12-20T00:00:00"))).toBe(local("2027-01-15T07:00:00"));
    // With a time change: in Madrid on 25 October 2026 the day lasts 25 hours.
    expect(nextRun(when("daily", { zone: "Europe/Madrid" }), Date.parse("2026-10-24T07:00:00+02:00"))).toBe(Date.parse("2026-10-25T07:00:00+01:00"));

    const at = local("2026-11-23T07:00:00");
    expect(periodFor(when("daily"), at)).toEqual({ from: new Date(local("2026-11-22T00:00:00")), to: new Date(local("2026-11-23T00:00:00")) });
    expect(periodFor(when("weekly"), at)).toEqual({ from: new Date(local("2026-11-16T00:00:00")), to: new Date(local("2026-11-23T00:00:00")) });
    expect(periodFor(when("monthly"), local("2027-01-01T07:00:00"))).toEqual({ from: new Date(local("2026-12-01T00:00:00")), to: new Date(local("2027-01-01T00:00:00")) });
  });

  const body = (extra: object = {}) => ({
    name: "Kilometraje diario",
    type: "mileage",
    params: { groupId: null, vehicleIds: null },
    frequency: "daily",
    atMinute: 7 * 60,
    zone: ZONE,
    format: "pdf",
    recipients: [ana.userId],
    ...extra,
  });

  it("schedules a report, sends it at its time with the file attached and records the send", async () => {
    const created = await h.request("POST", "/api/reports/schedules", { ...as(ana), body: body() });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const schedule = created.json.schedule as ReportSchedule;
    expect(schedule).toMatchObject({ name: "Kilometraje diario", active: true, lastRun: null, params: { speedLimitKmh: 100, minStopMin: 5 } });
    expect(schedule.recipients.map((p) => p.email)).toEqual([ana.email]);
    expect(Date.parse(schedule.nextRunAt as string)).toBeGreaterThan(Date.now());

    // It is not yet the time: nothing goes out.
    h.mails.length = 0;
    expect(await h.reports.tick()).toBe(0);
    expect(h.mails).toHaveLength(0);

    // The time of the day after day A arrives: the report covers all of day A.
    await h.db.core.query(`UPDATE gps.report_schedules SET next_run_at = $2 WHERE id = $1`, [schedule.id, new Date(DAY_B + 7 * HOUR)]);
    expect(await h.reports.tick(DAY_B + 7 * HOUR + 30_000)).toBe(1);
    const mail = h.mails.find((m) => m.to === ana.email);
    expect(mail?.subject).toContain("Kilometraje diario");
    expect(mail?.body).toContain("Va adjunto el reporte de kilometraje");
    expect(mail?.attachments).toHaveLength(1);
    expect(mail?.attachments[0]?.filename).toBe(`reporte-de-kilometraje-${dateOf(DAY_A)}.pdf`);
    expect(mail?.attachments[0]?.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // The email says the same as that day's report.
    const doc = await reportOf(ana, "mileage", DAY_A, DAY_B);
    expect(mail?.body).toContain(`Distancia: ${((statOf(doc, "Distancia") as number) / 1000).toFixed(1).replace(".", ",")} km`);

    const listed = (await h.request("GET", "/api/reports/schedules", as(ana))).json;
    const now = (listed.schedules as ReportSchedule[]).find((s) => s.id === schedule.id);
    expect(now?.lastRun).toMatchObject({ ok: true, error: null });
    // The next send was left for the following day at 07:00, and does not repeat.
    expect(Date.parse(now?.nextRunAt as string)).toBe(DAY_B + DAY + 7 * HOUR + 6 * HOUR - 6 * HOUR);
    h.mails.length = 0;
    expect(await h.reports.tick(DAY_B + 7 * HOUR + 90_000)).toBe(0);
    expect(h.mails).toHaveLength(0);
    expect((listed.people as { email: string }[]).map((p) => p.email)).toContain(ana.email);
  });

  it("only people in the account receive it, and each person manages what they can see", async () => {
    // Someone from outside cannot receive it.
    expect((await h.request("POST", "/api/reports/schedules", { ...as(ana), body: body({ recipients: [otherAccount.userId] }) })).status).toBe(400);
    expect((await h.request("POST", "/api/reports/schedules", { ...as(ana), body: body({ recipients: [] }) })).status).toBe(400);
    expect((await h.request("POST", "/api/reports/schedules", { ...as(ana), body: body({ zone: "Marte/Olimpo" }) })).status).toBe(400);

    // A reader does not schedule reports; a group operator does, and sees only their own.
    const reader = await join("Lía Lectora", "viewer");
    expect((await h.request("GET", "/api/reports/schedules", as(reader))).status).toBe(403);
    const northOperator = await join("Omar del Norte", "operator", [north]);
    expect((await h.request("GET", "/api/reports/schedules", as(northOperator))).json.schedules).toEqual([]);
    const own = await h.request("POST", "/api/reports/schedules", { ...as(northOperator), body: body({ name: "Del norte", format: "xlsx", frequency: "weekly", weekday: 1, recipients: [northOperator.userId, ana.userId] }) });
    expect(own.status, JSON.stringify(own.json)).toBe(201);
    expect((await h.request("GET", "/api/reports/schedules", as(northOperator))).json.schedules).toHaveLength(1);
    const all = (await h.request("GET", "/api/reports/schedules", as(ana))).json.schedules as ReportSchedule[];
    expect(all.map((s) => s.name).sort()).toEqual(["Del norte", "Kilometraje diario"]);
    const first = all.find((s) => s.name === "Kilometraje diario") as ReportSchedule;
    expect((await h.request("PUT", `/api/reports/schedules/${first.id}`, { ...as(northOperator), body: body({ recipients: [northOperator.userId] }) })).status).toBe(404);
    expect((await h.request("DELETE", `/api/reports/schedules/${first.id}`, as(northOperator))).status).toBe(404);
    // They cannot schedule a report for a group they do not see.
    const south = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: "Sur" } })).json.group.id as string;
    expect((await h.request("POST", "/api/reports/schedules", { ...as(northOperator), body: body({ params: { groupId: south, vehicleIds: null } }) })).status).toBe(404);

    // "Send now": the operator's report carries only their group, and reaches both people.
    h.mails.length = 0;
    const sent = await h.request("POST", `/api/reports/schedules/${own.json.schedule.id}/send`, { ...as(northOperator), body: {} });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json.sentTo).toBe(2);
    expect(h.mails.map((m) => m.to).sort()).toEqual([ana.email, northOperator.email].sort());
    const sheets = unzip(h.mails[0]?.attachments[0]?.content as Buffer);
    expect(sheets.get("xl/worksheets/sheet1.xml")).toContain("Todos los vehículos");
    expect(sheets.get("xl/worksheets/sheet2.xml")).toContain("Dos");
    expect(sheets.get("xl/worksheets/sheet2.xml")).not.toContain("Tres");
    // And it does not repeat right away.
    expect((await h.request("POST", `/api/reports/schedules/${own.json.schedule.id}/send`, { ...as(northOperator), body: {} })).status).toBe(429);

    // Paused, it has no next send; when deleted it disappears.
    const paused = await h.request("PUT", `/api/reports/schedules/${first.id}`, { ...as(ana), body: body({ active: false }) });
    expect(paused.json.schedule).toMatchObject({ active: false, nextRunAt: null });
    expect((await h.request("DELETE", `/api/reports/schedules/${first.id}`, as(ana))).status).toBe(204);
    expect(((await h.request("GET", "/api/reports/schedules", as(ana))).json.schedules as ReportSchedule[]).map((s) => s.name)).toEqual(["Del norte"]);
  });

  it("if whoever scheduled it leaves the account, the report is paused and says so", async () => {
    const temporal = await join("Tere Temporal", "operator");
    const created = await h.request("POST", "/api/reports/schedules", { ...as(temporal), body: body({ name: "De Tere", recipients: [ana.userId] }) });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect((await h.request("DELETE", `/api/members/${temporal.userId}`, as(ana))).status).toBe(204);
    await h.db.core.query(`UPDATE gps.report_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [created.json.schedule.id]);
    h.mails.length = 0;
    expect(await h.reports.tick()).toBe(1);
    expect(h.mails).toHaveLength(0);
    const after = ((await h.request("GET", "/api/reports/schedules", as(ana))).json.schedules as ReportSchedule[]).find((s) => s.name === "De Tere");
    expect(after).toMatchObject({ active: false, nextRunAt: null });
    expect(after?.lastRun).toMatchObject({ ok: false });
    expect(after?.lastRun?.error).toContain("ya no está en la cuenta");
  });
});

describe("module G: dashboards", () => {
  it("each person saves their dashboards, with their indicators in order", async () => {
    expect((await h.request("GET", "/api/dashboards", as(ana))).json.dashboards).toEqual([]);
    const created = await h.request("POST", "/api/dashboards", { ...as(ana), body: { name: "General", period: "7d", widgets: ["totals", "distance_by_day", "top_distance"] } });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const board = created.json.dashboard as Dashboard;
    expect(board).toMatchObject({ name: "General", period: "7d", groupId: null, widgets: ["totals", "distance_by_day", "top_distance"] });

    const changed = await h.request("PUT", `/api/dashboards/${board.id}`, { ...as(ana), body: { name: "Norte", period: "30d", groupId: north, widgets: ["alerts_by_type", "totals"] } });
    expect(changed.json.dashboard).toMatchObject({ name: "Norte", period: "30d", groupId: north, widgets: ["alerts_by_type", "totals"] });
    expect((await h.request("POST", "/api/dashboards", { ...as(ana), body: { name: "Malo", period: "7d", widgets: ["totals", "totals"] } })).status).toBe(400);
    expect((await h.request("POST", "/api/dashboards", { ...as(ana), body: { name: "Malo", period: "7d", widgets: ["inventado"] } })).status).toBe(400);
    expect((await h.request("POST", "/api/dashboards", { ...as(ana), body: { name: "", period: "7d", widgets: ["totals"] } })).status).toBe(400);

    // They belong to each person: another person in the same account neither sees nor touches them.
    const pepe = await join("Pepe Operador", "operator");
    expect((await h.request("GET", "/api/dashboards", as(pepe))).json.dashboards).toEqual([]);
    expect((await h.request("PUT", `/api/dashboards/${board.id}`, { ...as(pepe), body: { name: "Mío", period: "7d", widgets: ["totals"] } })).status).toBe(404);
    expect((await h.request("DELETE", `/api/dashboards/${board.id}`, as(pepe))).status).toBe(404);
    expect((await h.request("DELETE", `/api/dashboards/${board.id}`, as(ana))).status).toBe(204);
    expect((await h.request("GET", "/api/dashboards", as(ana))).json.dashboards).toEqual([]);
  });

  it("the indicators agree with the reports for the same period", async () => {
    const res = await h.request("GET", `/api/dashboards/data?${query(DAY_A, DAY_B + DAY)}`, as(ana));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const data = res.json.data as DashboardData;
    const mileage = await reportOf(ana, "mileage", DAY_A, DAY_B + DAY);
    expect(data.totals.distanceM).toBe(statOf(mileage, "Distancia"));
    expect(data.days.map((d) => [d.date, d.distanceM])).toEqual(rowsOf(tableOf(mileage, "Por día")).map((r) => [r["Día"], r.Distancia]));
    expect(data.byVehicle.reduce((n, v) => n + v.distanceM, 0)).toBe(data.totals.distanceM);
    expect(data.totals.trips).toBe(data.byVehicle.reduce((n, v) => n + v.trips, 0));
    const alarms = await reportOf(ana, "alarms", DAY_A, DAY_B + DAY);
    expect(data.totals.alerts).toBe(statOf(alarms, "Alarmas"));
    expect(data.alertTypes[0]).toEqual({ type: "speeding", count: 2 });
    expect(data.days.map((d) => d.alerts)).toEqual(alarms.chart?.series[0]?.values);
    // The previous period, of the same length, had no movement.
    expect(data.previous).toMatchObject({ distanceM: 0, trips: 0, alerts: 0 });
    // With the drivers module, it brings its ranking.
    expect(data.drivers?.some((d) => d.name === "Marta Conductora")).toBe(true);

    const group = (await h.request("GET", `/api/dashboards/data?${query(DAY_A, DAY_B + DAY, { groupId: north })}`, as(ana))).json.data as DashboardData;
    expect(group.vehicles).toBe(1);
    expect(group.byVehicle.map((v) => v.name)).toEqual(["Dos"]);

    // Or of vehicles chosen one by one.
    const picked = (await h.request("GET", `/api/dashboards/data?${query(DAY_A, DAY_B + DAY, { vehicleIds: `${carOne.id},${carThree.id}` })}`, as(ana))).json.data as DashboardData;
    expect(picked.vehicles).toBe(2);
    expect(picked.byVehicle.map((v) => v.name).sort()).toEqual(["Tres", "Uno"]);
    expect(picked.totals.distanceM).toBe(data.byVehicle.filter((v) => v.id === carOne.id || v.id === carThree.id).reduce((n, v) => n + v.distanceM, 0));
    expect(picked.totals.distanceM).toBeGreaterThan(0);
  });

  it("a dashboard keeps the vehicles chosen one by one, but not a group and a list at once", async () => {
    const created = await h.request("POST", "/api/dashboards", { ...as(ana), body: { name: "Dos camiones", period: "7d", vehicleIds: [carOne.id, carThree.id], widgets: ["totals"] } });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json.dashboard).toMatchObject({ groupId: null, vehicleIds: [carOne.id, carThree.id] });
    const id = created.json.dashboard.id as string;
    const toGroup = await h.request("PUT", `/api/dashboards/${id}`, { ...as(ana), body: { name: "Norte", period: "7d", groupId: north, widgets: ["totals"] } });
    expect(toGroup.json.dashboard).toMatchObject({ groupId: north, vehicleIds: null });
    expect((await h.request("PUT", `/api/dashboards/${id}`, { ...as(ana), body: { name: "Malo", period: "7d", groupId: north, vehicleIds: [carOne.id], widgets: ["totals"] } })).status).toBe(400);
    expect((await h.request("PUT", `/api/dashboards/${id}`, { ...as(ana), body: { name: "Malo", period: "7d", vehicleIds: [], widgets: ["totals"] } })).status).toBe(400);
    // Vehicles of another account are not within reach.
    const foreign = await addVehicle(otherAccount, "Ajeno");
    expect((await h.request("PUT", `/api/dashboards/${id}`, { ...as(ana), body: { name: "Malo", period: "7d", vehicleIds: [foreign.id], widgets: ["totals"] } })).status).toBe(400);
    expect((await h.request("DELETE", `/api/dashboards/${id}`, as(ana))).status).toBe(204);
  });
});
