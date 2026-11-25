// Module D · Fleet: vehicle profile, availability, activation and deactivation,
// documents, assignments, expenses, utilisation, useful life and group tree.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FleetAssignments, FleetDetail, FleetExpenses, FleetUtilization, FleetVehicle, VehicleGroup } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lifeOf } from "../src/modules/fleet/fleet";
import { type Harness, ORIGIN, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser; // owner, with fleet
let otherAccount: TestUser; // another account, without the module
let bea: TestUser; // another account, with fleet, drivers and fuel

const KNOTS = 1 / 1.852;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LAT = 14.0818;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const as = (user: TestUser) => ({ cookie: user.cookie });
const DAY0 = Math.floor(Date.now() / DAY) * DAY;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Car {
  id: string;
  deviceId: number;
}
async function addVehicle(user: TestUser, name: string, plate?: string): Promise<Car> {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId: "h02", ...(plate ? { plate } : {}) } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { id: res.json.vehicle.id as string, deviceId: h.traccar.devices.get(uniqueId) as number };
}
const addGroup = async (user: TestUser, name: string) => (await h.request("POST", "/api/groups", { ...as(user), body: { name } })).json.group.id as string;
const fleetOf = async (user: TestUser) => (await h.request("GET", "/api/fleet", as(user))).json.fleet as FleetVehicle[];
const detailOf = async (user: TestUser, car: Car) => {
  const res = await h.request("GET", `/api/vehicles/${car.id}/fleet`, as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.vehicle as FleetDetail;
};
/** A stretch at constant speed heading east, one position every 30 seconds. */
async function drive(car: Car, start: number, seconds: number, kmh: number, ignition = kmh > 0) {
  const rows = [];
  let lon = -87.2068;
  for (let t = start + 30_000; t <= start + seconds * 1000; t += 30_000) {
    lon += ((kmh / 3.6) * 30) / M_PER_DEG_LON;
    rows.push(traccarRow(car.deviceId, { fix: new Date(t), lon, lat: LAT, knots: kmh * KNOTS, attributes: { ignition } }));
  }
  await h.ingestFrom(rows).tick();
  await h.settle();
}
const upload = (user: TestUser, car: Car, query: string, type: string, payload: Buffer) =>
  h.fastify.inject({ method: "POST", url: `/api/vehicles/${car.id}/fleet/documents?${query}`, headers: { cookie: user.cookie, origin: ORIGIN, "content-type": type }, payload });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1500, 7)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(900, 32)]);

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Flota");
  otherAccount = await h.signUp("Otra Cuenta");
  bea = await h.signUp("Bea Completa");
  await h.enableModules(ana.orgId, ["D"]);
  await h.enableModules(bea.orgId, ["D", "B", "F"]);
});
afterAll(async () => {
  await h?.close();
});

describe("module D: profile, availability and activation or deactivation", () => {
  it("without the module enabled, its routes do not exist for that account", async () => {
    const car = await addVehicle(otherAccount, "Sin flota");
    for (const path of ["/api/fleet", `/api/vehicles/${car.id}/fleet`, `/api/fleet/expenses?from=2026-01-01&to=2026-01-31`, "/api/fleet/groups"]) {
      expect((await h.request("GET", path, as(otherAccount))).status, path).toBe(404);
    }
    const mine = await addVehicle(ana, "Ajeno para la otra");
    expect((await h.request("GET", `/api/vehicles/${mine.id}/fleet`, as(otherAccount))).status).toBe(404);
  });

  it("saves the vehicle profile and shows it in the fleet list", async () => {
    const car = await addVehicle(ana, "Camión 12", "HAA-0012");
    let card = (await fleetOf(ana)).find((v) => v.vehicleId === car.id) as FleetVehicle;
    // No profile yet: active, available and without data.
    expect(card).toMatchObject({ name: "Camión 12", plate: "HAA-0012", vin: null, status: "available", availability: "available", state: "active", documents: 0, life: null });
    const body = { vin: " 1HGCM82633A004352 ", brand: "Hino", model: "Serie 300", year: 2022, color: "Blanco", kind: "Camión", notes: "Caja seca de 4 toneladas" };
    const saved = await h.request("PUT", `/api/vehicles/${car.id}/fleet`, { ...as(ana), body });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.vehicle).toMatchObject({ vin: "1HGCM82633A004352", brand: "Hino", model: "Serie 300", year: 2022, color: "Blanco", kind: "Camión", notes: "Caja seca de 4 toneladas" });
    card = (await fleetOf(ana)).find((v) => v.vehicleId === car.id) as FleetVehicle;
    expect(card).toMatchObject({ brand: "Hino", year: 2022 });
    expect((await h.request("PUT", `/api/vehicles/${car.id}/fleet`, { ...as(ana), body: { ...body, year: 1800 } })).status).toBe(400);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/fleet`, { ...as(ana), body: { ...body, purchasePrice: 100 } })).status).toBe(400);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/fleet`, { ...as(otherAccount), body })).status).toBe(404);
  });

  it("availability is set by hand, and an available vehicle that moves is on a route", async () => {
    const car = await addVehicle(ana, "Reparto 3");
    await drive(car, Date.now() - 10 * 60_000, 540, 50);
    expect(await detailOf(ana, car)).toMatchObject({ status: "available", availability: "on_route" });
    // To the workshop: it stops counting as on a route even if it moves.
    const shop = await h.request("PUT", `/api/vehicles/${car.id}/fleet/status`, { ...as(ana), body: { status: "workshop", note: "Cambio de frenos" } });
    expect(shop.json.vehicle).toMatchObject({ status: "workshop", availability: "workshop", statusNote: "Cambio de frenos" });
    expect((await h.request("PUT", `/api/vehicles/${car.id}/fleet/status`, { ...as(ana), body: { status: "on_route" } })).status).toBe(400);
    // Temporarily deactivated and then reactivated: each change is recorded with who made it.
    expect((await h.request("PUT", `/api/vehicles/${car.id}/fleet/state`, { ...as(ana), body: { state: "suspended", note: "Sin seguro vigente" } })).json.vehicle).toMatchObject({ state: "suspended", stateNote: "Sin seguro vigente" });
    // Repeating the same thing records nothing new.
    await h.request("PUT", `/api/vehicles/${car.id}/fleet/state`, { ...as(ana), body: { state: "suspended", note: "Sin seguro vigente" } });
    await h.request("PUT", `/api/vehicles/${car.id}/fleet/state`, { ...as(ana), body: { state: "retired", note: "Vendido" } });
    const detail = await detailOf(ana, car);
    expect(detail.log.map((l) => [l.field, l.value, l.note, l.userName])).toEqual([
      ["state", "retired", "Vendido", "Ana Flota"],
      ["state", "suspended", "Sin seguro vigente", "Ana Flota"],
      ["status", "workshop", "Cambio de frenos", "Ana Flota"],
    ]);
    expect((await fleetOf(ana)).find((v) => v.vehicleId === car.id)).toMatchObject({ state: "retired", status: "workshop" });
  });
});

describe("module D: documents", () => {
  it("stores photos and documents on the server, warns about those expiring and deletes them with the vehicle", async () => {
    const car = await addVehicle(ana, "Camión con papeles");
    const soon = ymd(Date.now() + 10 * DAY);
    const late = ymd(Date.now() + 200 * DAY);
    const photo = await upload(ana, car, "name=Frente.png&kind=photo", "image/png", PNG);
    expect(photo.statusCode, photo.body.slice(0, 200)).toBe(201);
    expect((await upload(ana, car, `name=P%C3%B3liza%202026.pdf&kind=insurance&expiresOn=${soon}&note=Seguros%20del%20Pa%C3%ADs`, "application/pdf", PDF)).statusCode).toBe(201);
    const last = await upload(ana, car, `name=Revisi%C3%B3n.pdf&kind=inspection&expiresOn=${late}`, "application/pdf", PDF);
    const detail = last.json().vehicle as FleetDetail;
    // The photo does not count as a document; of the two documents, one expires soon.
    expect(detail).toMatchObject({ documents: 2, expiring: 1 });
    expect(detail.photoId).toBe(detail.docs.find((d) => d.kind === "photo")?.id);
    expect(detail.docs.map((d) => [d.kind, d.name, d.expiresOn])).toEqual([
      ["insurance", "Póliza 2026.pdf", soon],
      ["inspection", "Revisión.pdf", late],
      ["photo", "Frente.png", null],
    ]);
    expect(detail.docs[0]).toMatchObject({ mime: "application/pdf", size: PDF.length, note: "Seguros del País" });

    const insurance = detail.docs[0]?.id as string;
    const file = await h.fastify.inject({ method: "GET", url: `/api/fleet/documents/${insurance}`, headers: { cookie: ana.cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.rawPayload.equals(PDF)).toBe(true);
    const onDisk = join(h.config.filesDir, "fleet", ana.orgId, car.id, insurance);
    expect(existsSync(onDisk)).toBe(true);

    // What is not valid: another file type, a PDF as a photo, an empty file, and another account.
    expect((await upload(ana, car, "name=notas.txt", "text/plain", Buffer.from("hola"))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload(ana, car, "name=foto.pdf&kind=photo", "application/pdf", PDF)).statusCode).toBe(400);
    expect((await upload(ana, car, "name=vacio.png", "image/png", Buffer.alloc(0))).statusCode).toBe(400);
    expect((await upload(otherAccount, car, "name=x.png", "image/png", PNG)).statusCode).toBe(404);
    expect((await h.fastify.inject({ method: "GET", url: `/api/fleet/documents/${insurance}`, headers: { cookie: otherAccount.cookie } })).statusCode).toBe(404);

    // A new photo becomes the vehicle's photo.
    const again = (await upload(ana, car, "name=Lateral.png&kind=photo", "image/png", PNG)).json().vehicle as FleetDetail;
    expect(again.docs.find((d) => d.id === again.photoId)?.name).toBe("Lateral.png");
    // The document is deleted, and its file with it.
    const removed = await h.request("DELETE", `/api/fleet/documents/${insurance}`, as(ana));
    expect(removed.json.vehicle).toMatchObject({ documents: 1, expiring: 0 });
    expect(existsSync(onDisk)).toBe(false);
    // When the vehicle is deleted, its whole folder goes.
    const folder = join(h.config.filesDir, "fleet", ana.orgId, car.id);
    expect(existsSync(folder)).toBe(true);
    expect((await h.request("DELETE", `/api/vehicles/${car.id}`, as(ana))).status).toBe(204);
    await h.settle();
    expect(existsSync(folder)).toBe(false);
  });
});

describe("module D: assignments", () => {
  it("without the drivers module, records who the vehicle is assigned to and between which dates", async () => {
    const car = await addVehicle(ana, "Pickup de ventas");
    const d = (days: number) => ymd(Date.now() + days * DAY);
    const add = (body: Record<string, unknown>) => h.request("POST", `/api/vehicles/${car.id}/fleet/assignments`, { ...as(ana), body });
    expect((await add({ person: "Luis Reyes", from: d(-60), to: d(-31), note: "Cobertura de vacaciones" })).status).toBe(201);
    expect((await add({ person: "Marta Solís", from: d(-30) })).status).toBe(201);
    // Another person from today: Marta's open assignment ends yesterday.
    const third = await add({ person: "Pedro Mejía", from: d(0) });
    expect((third.json.assignments as FleetAssignments).source).toBe("fleet");
    expect((third.json.assignments as FleetAssignments).items.map((a) => [a.person, a.from, a.to])).toEqual([
      ["Pedro Mejía", d(0), null],
      ["Marta Solís", d(-30), d(-1)],
      ["Luis Reyes", d(-60), d(-31)],
    ]);
    expect((await fleetOf(ana)).find((v) => v.vehicleId === car.id)?.assignedTo).toBe("Pedro Mejía");
    // They cannot overlap: someone is already there on those dates. Nor reversed dates, nor without a name.
    expect((await add({ person: "Otro", from: d(-45), to: d(-40) })).status).toBe(400);
    expect((await add({ person: "Otro", from: d(5), to: d(2) })).status).toBe(400);
    expect((await add({ person: " ", from: d(5) })).status).toBe(400);
    const list = (await h.request("GET", `/api/vehicles/${car.id}/fleet/assignments`, as(ana))).json.assignments as FleetAssignments;
    const removed = await h.request("DELETE", `/api/fleet/assignments/${list.items[0]?.id}`, as(ana));
    expect((removed.json.assignments as FleetAssignments).items).toHaveLength(2);
    expect((await fleetOf(ana)).find((v) => v.vehicleId === car.id)?.assignedTo).toBeNull();
  });

  it("with the drivers module, the history is its own and is changed from there", async () => {
    const car = await addVehicle(bea, "Camión con conductor");
    const driver = await h.request("POST", "/api/drivers", { ...as(bea), body: { name: "Rosa Díaz" } });
    expect(driver.status, JSON.stringify(driver.json)).toBe(201);
    expect((await h.request("PUT", `/api/vehicles/${car.id}/driver`, { ...as(bea), body: { driverId: driver.json.driver.id } })).status).toBe(200);
    const list = (await h.request("GET", `/api/vehicles/${car.id}/fleet/assignments`, as(bea))).json.assignments as FleetAssignments;
    expect(list.source).toBe("drivers");
    expect(list.items).toMatchObject([{ person: "Rosa Díaz", to: null }]);
    expect((await fleetOf(bea)).find((v) => v.vehicleId === car.id)?.assignedTo).toBe("Rosa Díaz");
    const add = await h.request("POST", `/api/vehicles/${car.id}/fleet/assignments`, { ...as(bea), body: { person: "Alguien", from: ymd(Date.now()) } });
    expect(add.status).toBe(400);
    expect(add.json.error.message).toMatch(/Conductor/);
  });
});

describe("module D: expenses, useful life and utilisation", () => {
  it("records expenses by category and currency, and automatically adds the fills from the fuel module", async () => {
    const car = await addVehicle(bea, "Camión de gastos");
    const today = ymd(Date.now());
    const add = (body: Record<string, unknown>) => h.request("POST", "/api/fleet/expenses", { ...as(bea), body: { vehicleId: car.id, date: today, currency: "HNL", ...body } });
    const toll = await add({ category: "toll", amount: 85, note: "Peaje a San Pedro" });
    expect(toll.status, JSON.stringify(toll.json)).toBe(201);
    expect(toll.json.expense).toMatchObject({ vehicleName: "Camión de gastos", category: "toll", amount: 85, currency: "HNL", note: "Peaje a San Pedro" });
    await add({ category: "fine", amount: 600 });
    await add({ category: "insurance", amount: 450, currency: "USD" });
    expect((await add({ category: "inventada", amount: 10 })).status).toBe(400);
    expect((await add({ category: "toll", amount: 0 })).status).toBe(400);
    expect((await h.request("POST", "/api/fleet/expenses", { ...as(ana), body: { vehicleId: car.id, date: today, currency: "HNL", category: "toll", amount: 1 } })).status).toBe(404);
    // A fill recorded in the fuel module, with its total.
    expect((await h.request("PUT", `/api/vehicles/${car.id}/fuel`, { ...as(bea), body: { capacityL: 100, attr: null, normL100km: 10 } })).status).toBe(200);
    expect((await h.request("POST", `/api/vehicles/${car.id}/fuel/fills`, { ...as(bea), body: { at: new Date(Date.now() - HOUR).toISOString(), liters: 40, total: 4400, currency: "HNL", station: "Puma" } })).status).toBe(201);

    const list = (await h.request("GET", `/api/fleet/expenses?from=${ymd(Date.now() - 2 * DAY)}&to=${today}`, as(bea))).json.expenses as FleetExpenses;
    expect(list.items.map((e) => [e.category, e.amount, e.currency, e.id === null])).toEqual(
      expect.arrayContaining([
        ["toll", 85, "HNL", false],
        ["fine", 600, "HNL", false],
        ["insurance", 450, "USD", false],
        ["fuel", 4400, "HNL", true],
      ]),
    );
    expect(list.items.find((e) => e.id === null)?.note).toBe("Abastecimiento de 40 L en Puma");
    expect(list.totals).toEqual([
      {
        currency: "HNL",
        total: 5085,
        byCategory: [
          { category: "fuel", total: 4400 },
          { category: "toll", total: 85 },
          { category: "fine", total: 600 },
        ],
      },
      { currency: "USD", total: 450, byCategory: [{ category: "insurance", total: 450 }] },
    ]);
    // The cost of owning the vehicle counts the expenses in its currency, with fuel.
    const owned = await h.request("PUT", `/api/vehicles/${car.id}/fleet`, { ...as(bea), body: { purchaseDate: ymd(Date.now() - 400 * DAY), purchasePrice: 900000, currency: "HNL", lifeYears: 10 } });
    expect(owned.status, JSON.stringify(owned.json)).toBe(200);
    expect(owned.json.vehicle.life).toMatchObject({ currency: "HNL", expenses: 5085 });
    // It is corrected, filtered by vehicle and deleted.
    const fixed = await h.request("PUT", `/api/fleet/expenses/${toll.json.expense.id}`, { ...as(bea), body: { vehicleId: car.id, date: today, currency: "HNL", category: "toll", amount: 95 } });
    expect(fixed.json.expense).toMatchObject({ amount: 95 });
    const other = await addVehicle(bea, "Sin gastos");
    expect(((await h.request("GET", `/api/fleet/expenses?from=${today}&to=${today}&vehicleId=${other.id}`, as(bea))).json.expenses as FleetExpenses).items).toEqual([]);
    expect((await h.request("DELETE", `/api/fleet/expenses/${toll.json.expense.id}`, as(ana))).status).toBe(404);
    expect((await h.request("DELETE", `/api/fleet/expenses/${toll.json.expense.id}`, as(bea))).status).toBe(204);
    expect((await h.request("GET", `/api/fleet/expenses?from=${today}&to=${ymd(Date.now() - DAY)}`, as(bea))).status).toBe(400);
  });

  it("computes straight-line depreciation and what it has cost to own the vehicle", async () => {
    // Bought two years ago for 300,000, with eight years of useful life and 60,000 salvage value: loses 30,000 a year.
    const now = Date.parse("2026-11-22T12:00:00Z");
    const life = lifeOf({ purchase_date: "2024-11-22", purchase_price: "300000", currency: "HNL", salvage_value: "60000", life_years: 8, purchase_odo_km: 10_000 }, 45_000, 70_000, now);
    expect(life).toMatchObject({ currency: "HNL", ageYears: 2, perYear: 30_000, usedPercent: 25, endsOn: "2032-11-22", expenses: 45_000, km: 60_000 });
    expect(life?.depreciated).toBeCloseTo(60_000, -2);
    expect(life?.bookValue).toBeCloseTo(240_000, -2);
    // What has been depreciated plus what has been spent, divided by the kilometres since purchase.
    expect(life?.totalCost).toBeCloseTo(105_000, -2);
    expect(life?.costPerKm).toBeCloseTo(1.75, 1);
    // Past its useful life it does not fall below the salvage value.
    expect(lifeOf({ purchase_date: "2010-01-01", purchase_price: "300000", currency: "HNL", salvage_value: "60000", life_years: 8, purchase_odo_km: null }, 0, null, now)).toMatchObject({ depreciated: 240_000, bookValue: 60_000, usedPercent: 100, km: null, costPerKm: null });
    expect(lifeOf({ purchase_date: null, purchase_price: "300000", currency: "HNL", salvage_value: null, life_years: 8, purchase_odo_km: null }, 0, null, now)).toBeNull();

    // In the profile: with the expenses recorded in the purchase currency and the odometer the platform keeps.
    const car = await addVehicle(ana, "Camión con historia");
    const bought = ymd(Date.now() - 365 * DAY);
    const saved = await h.request("PUT", `/api/vehicles/${car.id}/fleet`, { ...as(ana), body: { purchaseDate: bought, purchasePrice: 500_000, currency: "HNL", salvageValue: 100_000, lifeYears: 10, purchaseOdometerKm: 0 } });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    for (const [category, amount, currency] of [["maintenance", 12_000, "HNL"], ["insurance", 8_000, "HNL"], ["other", 500, "USD"]] as const) {
      await h.request("POST", "/api/fleet/expenses", { ...as(ana), body: { vehicleId: car.id, date: ymd(Date.now() - 30 * DAY), category, amount, currency } });
    }
    await drive(car, Date.now() - 3 * HOUR, 3600, 60);
    const detail = await detailOf(ana, car);
    expect(detail.life).toMatchObject({ currency: "HNL", perYear: 40_000, usedPercent: 10, expenses: 20_000 });
    expect(detail.life?.depreciated).toBeCloseTo(40_000, -3);
    expect(detail.life?.totalCost).toBeCloseTo(60_000, -3);
    expect(detail.life?.km).toBeGreaterThanOrEqual(59);
    expect(detail.life?.costPerKm).toBeGreaterThan(900);
  });

  it("says how much each vehicle was used in the period and how many days it did not go out", async () => {
    const used = await addVehicle(ana, "El que trabaja");
    const parked = await addVehicle(ana, "El que no sale");
    // Two working days in a week: one hour at 60 km/h each day, and half an hour idling on the second.
    await drive(used, DAY0 - 5 * DAY + 8 * HOUR, 3600, 60);
    await drive(used, DAY0 - 2 * DAY + 8 * HOUR, 3600, 60);
    await drive(used, DAY0 - 2 * DAY + 9 * HOUR + 60_000, 1800, 0, true);
    await drive(parked, DAY0 - 5 * DAY + 8 * HOUR, 600, 0, false);
    const from = new Date(DAY0 - 6 * DAY).toISOString();
    const to = new Date(DAY0 + DAY).toISOString();
    const res = await h.request("GET", `/api/fleet/utilization?from=${from}&to=${to}&zone=UTC`, as(ana));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const usage = res.json.utilization as FleetUtilization;
    const row = usage.vehicles.find((v) => v.vehicleId === used.id);
    expect(row).toMatchObject({ trips: 2, activeDays: 2 });
    expect(row?.distanceM).toBeGreaterThan(118_000);
    expect(row?.distanceM).toBeLessThan(121_000);
    expect(row?.tripS).toBeGreaterThan(7000);
    expect(row?.idleS).toBeGreaterThan(1700);
    // Used two days out of the six-plus of the period.
    expect(row?.unusedPercent).toBeGreaterThan(60);
    expect(row?.unusedPercent).toBeLessThan(75);
    expect(usage.vehicles.find((v) => v.vehicleId === parked.id)).toMatchObject({ trips: 0, activeDays: 0, unusedPercent: 100, distanceM: 0 });
    expect(usage.totals.withoutUse).toBeGreaterThanOrEqual(1);
    expect(usage.totals.distanceM).toBeGreaterThanOrEqual(row?.distanceM ?? 0);
    // The first in the list is the most used.
    expect(usage.vehicles[0]?.tripS).toBeGreaterThanOrEqual(usage.vehicles.at(-1)?.tripS ?? 0);
  });
});

describe("module D: group tree", () => {
  it("a group hangs from another, and whoever has permission on the upper one also sees those below", async () => {
    const north = await addGroup(ana, "Zona Norte");
    const sps = await addGroup(ana, "San Pedro");
    const depot = await addGroup(ana, "Bodega Choloma");
    const south = await addGroup(ana, "Zona Sur");
    const inSps = await addVehicle(ana, "Camión de San Pedro");
    const inDepot = await addVehicle(ana, "Montacargas de la bodega");
    const inSouth = await addVehicle(ana, "Camión del sur");
    for (const [car, groupId] of [[inSps, sps], [inDepot, depot], [inSouth, south]] as const) {
      expect((await h.request("PATCH", `/api/vehicles/${car.id}`, { ...as(ana), body: { groupId } })).status).toBe(200);
    }
    const move = (id: string, parentId: string | null, user = ana) => h.request("PUT", `/api/fleet/groups/${id}/parent`, { ...as(user), body: { parentId } });
    expect((await move(sps, north)).status).toBe(200);
    const tree = (await move(depot, sps)).json.groups as VehicleGroup[];
    expect(tree.find((g) => g.id === sps)?.parentId).toBe(north);
    expect(tree.find((g) => g.id === depot)?.parentId).toBe(sps);
    expect(tree.find((g) => g.id === north)?.parentId).toBeNull();
    // A group does not hang from itself or from one that hangs from it.
    expect((await move(north, north)).status).toBe(400);
    expect((await move(north, depot)).status).toBe(400);
    expect((await move(sps, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await move(sps, north, otherAccount)).status).toBe(404);

    // A person with permission only over Zona Norte sees what is in San Pedro and in its warehouse, not the south.
    const person = await h.signUp("Encargado del Norte");
    const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role: "operator", groups: [north] } });
    expect(invited.status, JSON.stringify(invited.json)).toBe(201);
    expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
    const seen = async () => ((await h.request("GET", "/api/vehicles", as(person))).json.vehicles as { name: string }[]).map((v) => v.name).sort();
    expect(await seen()).toEqual(["Camión de San Pedro", "Montacargas de la bodega"]);
    expect((await fleetOf(person)).map((v) => v.name).sort()).toEqual(["Camión de San Pedro", "Montacargas de la bodega"]);
    // They cannot move groups: it would change what they see.
    expect((await move(depot, null, person)).status).toBe(403);
    // If the warehouse stops hanging from San Pedro, they stop seeing it.
    expect((await move(depot, null)).status).toBe(200);
    expect(await seen()).toEqual(["Camión de San Pedro"]);
    // When the upper group is deleted, those below are left loose.
    expect((await h.request("DELETE", `/api/groups/${north}`, as(ana))).status).toBe(204);
    expect(((await h.request("GET", "/api/fleet/groups", as(ana))).json.groups as VehicleGroup[]).find((g) => g.id === sps)?.parentId).toBeNull();
  });
});
