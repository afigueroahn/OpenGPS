// Module E · Maintenance: plans by mileage, hours or date, notifications,
// work orders with costs and attachments, workshops, spare parts and expiries.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type FleetExpenses, type MaintOrder, type MaintOverview, type MaintPart, type MaintPlan, type MaintWorkshop, type ReportDocument, type VehicleEvent, maintDue, maintReason as reasonOf, sharedText } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, ORIGIN, type TestUser, createHarness, traccarRow } from "./harness";

/** The most urgent thing about a service, as Spanish says it. */
const maintReason = (...args: Parameters<typeof maintDue> extends unknown[] ? [Parameters<typeof reasonOf>[0], Parameters<typeof reasonOf>[1]] : never) => {
  const text = reasonOf(args[0], args[1], "es");
  return sharedText("es")(text.key, text.params);
};
let h: Harness;
let ana: TestUser; // owner, with maintenance
let otherAccount: TestUser; // another account, without the module
let bea: TestUser; // with maintenance, fleet and reports

const KNOTS = 1 / 1.852;
const DAY = 86_400_000;
const LAT = 14.0818;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const as = (user: TestUser) => ({ cookie: user.cookie });
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const today = ymd(Date.now());

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
/** A stretch at constant speed heading east, one position every 30 seconds. */
async function drive(car: Car, start: number, seconds: number, kmh: number, from = -87.2068) {
  const rows = [];
  let lon = from;
  for (let t = start; t <= start + seconds * 1000; t += 30_000) {
    rows.push(traccarRow(car.deviceId, { fix: new Date(t), lon, lat: LAT, knots: kmh * KNOTS, attributes: { ignition: true } }));
    lon += ((kmh / 3.6) * 30) / M_PER_DEG_LON;
  }
  await h.ingestFrom(rows).tick();
  await h.settle();
  return lon;
}
const overviewOf = async (user: TestUser) => {
  const res = await h.request("GET", "/api/maintenance", as(user));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.overview as MaintOverview;
};
const setOdometer = async (user: TestUser, car: Car, odometerKm: number) => expect((await h.request("PUT", `/api/vehicles/${car.id}/meters`, { ...as(user), body: { odometerKm } })).status).toBe(200);
const eventsOf = async (user: TestUser, car: Car) => ((await h.request("GET", `/api/events?limit=200&vehicleId=${car.id}`, as(user))).json.events as VehicleEvent[]).reverse();
const sweep = async () => {
  await h.maintenance.sweep();
  await h.settle();
};
const order = (car: Car, extra: Record<string, unknown> = {}) => ({ vehicleId: car.id, kind: "corrective", title: "Cambio de pastillas de freno", openedOn: today, currency: "HNL", ...extra });
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(900, 32)]);

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Taller");
  otherAccount = await h.signUp("Otra Cuenta");
  bea = await h.signUp("Bea Completa");
  await h.enableModules(ana.orgId, ["E"]);
  await h.enableModules(bea.orgId, ["E", "D", "G"]);
  // The account wants the service and expiry notices by email.
  await h.emailNotification(ana, ["service_soon", "service_due", "expiry_soon", "expiry_due"], "America/Tegucigalpa");
});
afterAll(async () => {
  await h?.close();
});

describe("module E: how long until a service", () => {
  const plan = { everyKm: 5000, everyHours: 250, everyDays: 180, warnKm: 500, warnHours: 25, warnDays: 15 };
  const last = { on: "2026-01-10", km: 40_000, hours: 1000 };

  it("is due by whichever comes first: kilometres, engine hours or days", () => {
    const fresh = maintDue(plan, last, { km: 41_000, hours: 1050, today: "2026-02-01" });
    expect(fresh).toMatchObject({ status: "ok", remainingKm: 4000, remainingHours: 200, remainingDays: 158, dueKm: 45_000, dueHours: 1250, dueOn: "2026-07-09" });
    expect(maintReason(fresh, plan)).toBe("faltan 4.000 km");
    // Close by kilometres.
    const soon = maintDue(plan, last, { km: 44_600, hours: 1050, today: "2026-02-01" });
    expect(soon.status).toBe("soon");
    expect(maintReason(soon, plan)).toBe("faltan 400 km");
    // Overdue by hours, even if kilometres and days remain.
    const due = maintDue(plan, last, { km: 41_000, hours: 1262, today: "2026-02-01" });
    expect(due.status).toBe("due");
    expect(maintReason(due, plan)).toBe("se pasó por 12 horas de motor");
    // Overdue by date.
    expect(maintReason(maintDue(plan, last, { km: 41_000, hours: 1050, today: "2026-07-12" }), plan)).toBe("se pasó por 3 días");
    expect(maintReason(maintDue(plan, last, { km: 41_000, hours: 1050, today: "2026-07-08" }), plan)).toBe("falta 1 día");
  });

  it("a date-only plan does not look at the odometer, and without an advance notice it only says when it is already due", () => {
    const yearly = { everyKm: null, everyHours: null, everyDays: 365, warnKm: null, warnHours: null, warnDays: null };
    expect(maintDue(yearly, last, { km: 999_999, hours: 99_999, today: "2027-01-09" })).toMatchObject({ status: "ok", remainingKm: null, remainingHours: null, remainingDays: 1 });
    expect(maintDue(yearly, last, { km: 0, hours: 0, today: "2027-01-10" }).status).toBe("due");
  });
});

describe("module E: plans and notifications", () => {
  it("without the module enabled, its routes do not exist for that account", async () => {
    for (const path of ["/api/maintenance", "/api/maintenance/plans", "/api/maintenance/orders", "/api/maintenance/workshops", "/api/maintenance/parts", "/api/maintenance/settings"]) {
      expect((await h.request("GET", path, as(otherAccount))).status, path).toBe(404);
      expect((await h.request("GET", path)).status, path).toBe(401);
    }
  });

  it("notifies by real mileage when the service is near and when it was already due, and the work order closes it", async () => {
    const car = await addVehicle(ana, "Camión de reparto");
    const withoutPlan = await addVehicle(ana, "Camión sin plan");
    expect((await h.request("PUT", "/api/maintenance/settings", { ...as(ana), body: { currency: "HNL", zone: "America/Tegucigalpa" } })).json.settings).toEqual({ currency: "HNL" });
    // A plan has to say how often it is due.
    expect((await h.request("POST", "/api/maintenance/plans", { ...as(ana), body: { name: "Vacío" } })).status).toBe(400);
    const created = await h.request("POST", "/api/maintenance/plans", { ...as(ana), body: { name: "Cambio de aceite y filtro", everyKm: 10, warnKm: 2, vehicleIds: [car.id] } });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const plan = (created.json.plans as MaintPlan[])[0] as MaintPlan;
    expect(plan).toMatchObject({ name: "Cambio de aceite y filtro", everyKm: 10, everyHours: null, everyDays: null, warnKm: 2, vehicleIds: [car.id] });
    // Just applied, it counts from today and from the odometer it has.
    let view = await overviewOf(ana);
    expect(view.schedules).toHaveLength(1);
    expect(view.schedules[0]).toMatchObject({ planName: "Cambio de aceite y filtro", vehicleId: car.id, vehicleName: "Camión de reparto", lastKm: 0, status: "ok", remainingKm: 10, openOrderId: null });
    await sweep();
    expect(await eventsOf(ana, car)).toEqual([]);

    // It travels about 9 km: it enters the notice margin.
    h.mails.length = 0;
    const start = Date.now() - 2 * 3_600_000;
    const lon = await drive(car, start, 540, 60);
    view = await overviewOf(ana);
    expect(view.schedules[0]?.status).toBe("soon");
    expect(view.schedules[0]?.remainingKm).toBeGreaterThanOrEqual(0);
    expect(view.schedules[0]?.remainingKm).toBeLessThanOrEqual(2);
    await sweep();
    let events = await eventsOf(ana, car);
    expect(events.map((e) => e.type)).toEqual(["service_soon"]);
    expect(events[0]?.detail).toMatchObject({ subject: "Cambio de aceite y filtro" });
    expect(String(events[0]?.detail.reason)).toMatch(/^faltan? \d+ km$/);
    expect(h.mails.map((m) => m.subject)).toEqual(["Camión de reparto: servicio de mantenimiento próximo"]);
    expect(h.mails[0]?.body).toContain("Cambio de aceite y filtro: falta");
    // The same notification is not repeated.
    await sweep();
    expect((await eventsOf(ana, car)).map((e) => e.type)).toEqual(["service_soon"]);

    // It keeps rolling and goes past: now the service is overdue.
    await drive(car, start + 600_000, 240, 60, lon);
    view = await overviewOf(ana);
    expect(view.schedules[0]?.status).toBe("due");
    expect(view.schedules[0]?.reason).toMatch(/^se pasó por \d+ km$/);
    await sweep();
    await sweep();
    events = await eventsOf(ana, car);
    expect(events.map((e) => e.type)).toEqual(["service_soon", "service_due"]);
    expect(h.mails.map((m) => m.subject)).toEqual(["Camión de reparto: servicio de mantenimiento próximo", "Camión de reparto: servicio de mantenimiento vencido"]);
    expect(await eventsOf(ana, withoutPlan)).toEqual([]);

    // The service work order is opened and finished: the count starts over.
    const schedule = view.schedules[0] as MaintOverview["schedules"][number];
    const opened = await h.request("POST", "/api/maintenance/orders", { ...as(ana), body: order(car, { kind: "preventive", title: "Cambio de aceite", scheduleId: schedule.id, laborCost: 350 }) });
    expect(opened.status, JSON.stringify(opened.json)).toBe(201);
    const work = opened.json.order as MaintOrder;
    expect(work).toMatchObject({ number: 1, status: "open", kind: "preventive", planName: "Cambio de aceite y filtro", vehicleName: "Camión de reparto", doneOn: null, total: 350 });
    view = await overviewOf(ana);
    expect(view).toMatchObject({ openOrders: 1 });
    expect(view.schedules[0]).toMatchObject({ status: "due", openOrderId: work.id });
    // One vehicle's service is not valid for another's order.
    expect((await h.request("POST", "/api/maintenance/orders", { ...as(ana), body: order(withoutPlan, { scheduleId: schedule.id }) })).status).toBe(400);

    const closed = await h.request("PUT", `/api/maintenance/orders/${work.id}`, { ...as(ana), body: order(car, { kind: "preventive", title: "Cambio de aceite", scheduleId: schedule.id, laborCost: 350, status: "done" }) });
    expect(closed.status, JSON.stringify(closed.json)).toBe(200);
    const done = closed.json.order as MaintOrder;
    // Finished with no further data: with today's date in the account and the vehicle's odometer.
    expect(done.status).toBe("done");
    expect(done.doneOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(done.odometerKm).toBeGreaterThanOrEqual(11);
    view = await overviewOf(ana);
    expect(view.openOrders).toBe(0);
    expect(view.schedules[0]).toMatchObject({ status: "ok", lastKm: done.odometerKm, lastOn: done.doneOn, openOrderId: null });
    await sweep();
    expect((await eventsOf(ana, car)).map((e) => e.type)).toEqual(["service_soon", "service_due"]);

    // When it gets near again, it notifies again: it is another service.
    await setOdometer(ana, car, (done.odometerKm as number) + 9);
    await sweep();
    expect((await eventsOf(ana, car)).map((e) => e.type)).toEqual(["service_soon", "service_due", "service_soon"]);

    // When the vehicle is removed from the plan, it stops being counted; when the plan is deleted, everything goes.
    const edited = await h.request("PUT", `/api/maintenance/plans/${plan.id}`, { ...as(ana), body: { name: "Cambio de aceite", everyKm: 5000, warnKm: 500, vehicleIds: [withoutPlan.id] } });
    expect((edited.json.plans as MaintPlan[])[0]).toMatchObject({ name: "Cambio de aceite", everyKm: 5000, vehicleIds: [withoutPlan.id] });
    expect((await overviewOf(ana)).schedules.map((s) => s.vehicleId)).toEqual([withoutPlan.id]);
    expect((await h.request("PUT", `/api/maintenance/plans/${plan.id}`, { ...as(otherAccount), body: { name: "x", everyKm: 1 } })).status).toBe(404);
    expect((await h.request("DELETE", `/api/maintenance/plans/${plan.id}`, as(ana))).status).toBe(204);
    expect((await overviewOf(ana)).schedules).toEqual([]);
    expect((await h.request("GET", "/api/maintenance/plans", as(ana))).json.plans).toEqual([]);
  });

  it("a date plan is corrected with when the service was last done", async () => {
    const car = await addVehicle(ana, "Pickup de ventas");
    const created = await h.request("POST", "/api/maintenance/plans", { ...as(ana), body: { name: "Revisión de frenos", everyDays: 30, warnDays: 5, everyHours: 100, vehicleIds: [car.id] } });
    const plan = (created.json.plans as MaintPlan[]).find((p) => p.name === "Revisión de frenos") as MaintPlan;
    const schedule = (await overviewOf(ana)).schedules.find((s) => s.planId === plan.id) as MaintOverview["schedules"][number];
    expect(schedule).toMatchObject({ status: "ok", remainingDays: 30, remainingHours: 100 });
    const moved = await h.request("PUT", `/api/maintenance/schedules/${schedule.id}`, { ...as(ana), body: { lastOn: ymd(Date.now() - 27 * DAY), lastKm: 0, lastHours: 0 } });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    const soon = (moved.json.overview as MaintOverview).schedules.find((s) => s.id === schedule.id);
    expect(soon?.status).toBe("soon");
    expect([2, 3, 4]).toContain(soon?.remainingDays);
    const late = await h.request("PUT", `/api/maintenance/schedules/${schedule.id}`, { ...as(ana), body: { lastOn: ymd(Date.now() - 40 * DAY), lastKm: 0, lastHours: 0 } });
    const due = (late.json.overview as MaintOverview).schedules.find((s) => s.id === schedule.id);
    expect(due?.status).toBe("due");
    expect(due?.reason).toMatch(/^se pasó por (9|10|11) días$/);
    // What is overdue goes first.
    expect((late.json.overview as MaintOverview).schedules[0]?.id).toBe(schedule.id);
    expect((await h.request("PUT", `/api/maintenance/schedules/${schedule.id}`, { ...as(otherAccount), body: { lastOn: today, lastKm: 0, lastHours: 0 } })).status).toBe(404);
    await h.request("DELETE", `/api/maintenance/plans/${plan.id}`, as(ana));
  });
});

describe("module E: work orders, workshops and spare parts", () => {
  it("keeps the catalogue of workshops and of spare parts", async () => {
    const shop = await h.request("POST", "/api/maintenance/workshops", { ...as(ana), body: { name: "Taller El Rápido", phone: "2232-1010", address: "Bulevar Morazán" } });
    expect(shop.status, JSON.stringify(shop.json)).toBe(201);
    expect(shop.json.workshops).toMatchObject([{ name: "Taller El Rápido", kind: "workshop", phone: "2232-1010", email: null, orders: 0 }]);
    expect((await h.request("POST", "/api/maintenance/workshops", { ...as(ana), body: { name: "taller el rápido" } })).status).toBe(409);
    const supplier = await h.request("POST", "/api/maintenance/workshops", { ...as(ana), body: { name: "Repuestos Centro", kind: "supplier" } });
    const list = supplier.json.workshops as MaintWorkshop[];
    expect(list.map((w) => [w.name, w.kind])).toEqual([
      ["Repuestos Centro", "supplier"],
      ["Taller El Rápido", "workshop"],
    ]);
    const renamed = await h.request("PUT", `/api/maintenance/workshops/${list[0]?.id}`, { ...as(ana), body: { name: "Repuestos del Centro", kind: "supplier", contact: "Mario" } });
    expect((renamed.json.workshops as MaintWorkshop[])[0]).toMatchObject({ name: "Repuestos del Centro", contact: "Mario" });
    expect((await h.request("DELETE", `/api/maintenance/workshops/${list[0]?.id}`, as(otherAccount))).status).toBe(404);
    expect((await h.request("DELETE", `/api/maintenance/workshops/${list[0]?.id}`, as(ana))).status).toBe(204);

    const part = await h.request("POST", "/api/maintenance/parts", { ...as(ana), body: { name: "Filtro de aceite", code: "FA-204", unitCost: 180, stock: 10 } });
    expect(part.status, JSON.stringify(part.json)).toBe(201);
    expect(part.json.parts).toEqual([expect.objectContaining({ name: "Filtro de aceite", code: "FA-204", unit: "unidad", unitCost: 180, stock: 10, used: 0 })]);
    expect((await h.request("POST", "/api/maintenance/parts", { ...as(ana), body: { name: "FILTRO DE ACEITE" } })).status).toBe(409);
    expect((await h.request("GET", "/api/maintenance/parts", as(bea))).json.parts).toEqual([]);
  });

  it("an order adds labour and parts, and what was used is deducted from stock when it is finished", async () => {
    const car = await addVehicle(ana, "Camión de frenos");
    const shop = ((await h.request("GET", "/api/maintenance/workshops", as(ana))).json.workshops as MaintWorkshop[])[0] as MaintWorkshop;
    const filter = ((await h.request("GET", "/api/maintenance/parts", as(ana))).json.parts as MaintPart[])[0] as MaintPart;
    const parts = [
      { partId: filter.id, name: "Filtro de aceite", quantity: 2, unitCost: 180 },
      { partId: null, name: "Pastillas delanteras", quantity: 1, unitCost: 950.5 },
    ];
    const made = await h.request("POST", "/api/maintenance/orders", { ...as(ana), body: order(car, { workshopId: shop.id, laborCost: 600, description: "Chillaban al frenar", parts }) });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const work = made.json.order as MaintOrder;
    expect(work).toMatchObject({ kind: "corrective", status: "open", workshopName: "Taller El Rápido", laborCost: 600, partsCost: 1310.5, total: 1910.5, currency: "HNL", description: "Chillaban al frenar" });
    expect(work.parts).toEqual(parts);
    expect(work.number).toBeGreaterThan(0);
    const stockOf = async () => ((await h.request("GET", "/api/maintenance/parts", as(ana))).json.parts as MaintPart[]).find((p) => p.id === filter.id);
    expect(await stockOf()).toMatchObject({ stock: 10, used: 0 });

    // When it is finished, what was used leaves the stock.
    const body = order(car, { workshopId: shop.id, laborCost: 600, parts, status: "done", doneOn: today, odometerKm: 52_300 });
    const done = (await h.request("PUT", `/api/maintenance/orders/${work.id}`, { ...as(ana), body })).json.order as MaintOrder;
    expect(done).toMatchObject({ status: "done", doneOn: today, odometerKm: 52_300, total: 1910.5 });
    expect(await stockOf()).toMatchObject({ stock: 8, used: 2 });
    // Correcting a finished order does not deduct twice.
    await h.request("PUT", `/api/maintenance/orders/${work.id}`, { ...as(ana), body: { ...body, parts: [{ partId: filter.id, name: "Filtro de aceite", quantity: 3, unitCost: 180 }] } });
    expect(await stockOf()).toMatchObject({ stock: 7, used: 3 });
    // If it goes back to in progress, what was used returns.
    await h.request("PUT", `/api/maintenance/orders/${work.id}`, { ...as(ana), body: { ...body, status: "in_progress" } });
    expect(await stockOf()).toMatchObject({ stock: 10, used: 0 });
    expect(((await h.request("GET", `/api/maintenance/orders/${work.id}`, as(ana))).json.order as MaintOrder).doneOn).toBeNull();

    // Orders are numbered consecutively and filtered by status and by vehicle.
    const second = (await h.request("POST", "/api/maintenance/orders", { ...as(ana), body: order(car, { title: "Alineación", status: "done", laborCost: 400 }) })).json.order as MaintOrder;
    expect(second.number).toBe(work.number + 1);
    const all = (await h.request("GET", `/api/maintenance/orders?vehicleId=${car.id}`, as(ana))).json.orders as MaintOrder[];
    expect(all.map((o) => o.title)).toEqual(["Alineación", "Cambio de pastillas de freno"]);
    expect(((await h.request("GET", `/api/maintenance/orders?vehicleId=${car.id}&status=pending`, as(ana))).json.orders as MaintOrder[]).map((o) => o.title)).toEqual(["Cambio de pastillas de freno"]);
    expect(((await h.request("GET", `/api/maintenance/orders?status=done&from=${ymd(Date.now() - 2 * DAY)}&to=${ymd(Date.now() + DAY)}`, as(ana))).json.orders as MaintOrder[]).some((o) => o.id === second.id)).toBe(true);
    expect(((await h.request("GET", "/api/maintenance/workshops", as(ana))).json.workshops as MaintWorkshop[])[0]?.orders).toBe(1);

    // What does not fit is rejected, and another account sees nothing.
    expect((await h.request("POST", "/api/maintenance/orders", { ...as(ana), body: order(car, { title: "" }) })).status).toBe(400);
    expect((await h.request("POST", "/api/maintenance/orders", { ...as(ana), body: order(car, { status: "done", doneOn: ymd(Date.now() - 5 * DAY) }) })).status).toBe(400);
    expect((await h.request("POST", "/api/maintenance/orders", { ...as(ana), body: order(car, { parts: [{ name: "Tornillo", quantity: 0 }] }) })).status).toBe(400);
    expect((await h.request("GET", `/api/maintenance/orders/${work.id}`, as(bea))).status).toBe(404);
    expect((await h.request("DELETE", `/api/maintenance/orders/${work.id}`, as(bea))).status).toBe(404);

    // Deleting a finished order returns what it used.
    await h.request("PUT", `/api/maintenance/orders/${work.id}`, { ...as(ana), body });
    expect(await stockOf()).toMatchObject({ stock: 8 });
    expect((await h.request("DELETE", `/api/maintenance/orders/${work.id}`, as(ana))).status).toBe(204);
    expect(await stockOf()).toMatchObject({ stock: 10, used: 0 });
  });

  it("stores an order's attachments on the server and deletes them with it", async () => {
    const car = await addVehicle(ana, "Camión con factura");
    const work = (await h.request("POST", "/api/maintenance/orders", { ...as(ana), body: order(car) })).json.order as MaintOrder;
    const upload = (user: TestUser, type: string, payload: Buffer) =>
      h.fastify.inject({ method: "POST", url: `/api/maintenance/orders/${work.id}/files?name=${encodeURIComponent("Factura 0042.pdf")}`, headers: { cookie: user.cookie, origin: ORIGIN, "content-type": type }, payload });
    const sent = await upload(ana, "application/pdf", PDF);
    expect(sent.statusCode, sent.body).toBe(201);
    const file = (sent.json().order as MaintOrder).files[0];
    expect(file).toMatchObject({ name: "Factura 0042.pdf", mime: "application/pdf", size: PDF.length });
    const folder = join(h.config.filesDir, "maintenance", ana.orgId, work.id);
    expect(existsSync(join(folder, file?.id ?? ""))).toBe(true);
    const got = await h.fastify.inject({ method: "GET", url: `/api/maintenance/files/${file?.id}`, headers: { cookie: ana.cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("application/pdf");
    expect(got.rawPayload.equals(PDF)).toBe(true);
    expect((await upload(ana, "application/zip", PDF)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload(ana, "application/pdf", Buffer.alloc(0))).statusCode).toBe(400);
    expect((await upload(bea, "application/pdf", PDF)).statusCode).toBe(404);
    expect((await h.fastify.inject({ method: "GET", url: `/api/maintenance/files/${file?.id}`, headers: { cookie: bea.cookie } })).statusCode).toBe(404);
    expect((await h.request("DELETE", `/api/maintenance/orders/${work.id}`, as(ana))).status).toBe(204);
    expect(existsSync(folder)).toBe(false);
  });
});

describe("module E: expiries", () => {
  it("notifies about what is about to expire and what has expired, and stops notifying when renewed", async () => {
    const car = await addVehicle(ana, "Camión asegurado");
    h.mails.length = 0;
    const made = await h.request("POST", "/api/maintenance/expiries", { ...as(ana), body: { vehicleId: car.id, kind: "insurance", name: "Póliza 4471", expiresOn: ymd(Date.now() + 10 * DAY), warnDays: 30 } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const expiry = (made.json.overview as MaintOverview).expiries.find((e) => e.vehicleId === car.id);
    expect(expiry).toMatchObject({ source: "own", kind: "insurance", name: "Póliza 4471", status: "soon", warnDays: 30, vehicleName: "Camión asegurado" });
    expect([9, 10, 11]).toContain(expiry?.daysLeft);
    await sweep();
    await sweep();
    let events = await eventsOf(ana, car);
    expect(events.map((e) => e.type)).toEqual(["expiry_soon"]);
    expect(events[0]?.detail.subject).toBe("Seguro · Póliza 4471");
    expect(String(events[0]?.detail.reason)).toMatch(/^vence el \d+ \w+ \d{4}$/);
    expect(h.mails.map((m) => m.subject)).toEqual(["Camión asegurado: documento por vencer"]);

    // With the date already past, it is expired.
    const body = { vehicleId: car.id, kind: "insurance", name: "Póliza 4471", warnDays: 30 };
    const late = await h.request("PUT", `/api/maintenance/expiries/${expiry?.id}`, { ...as(ana), body: { ...body, expiresOn: ymd(Date.now() - 3 * DAY) } });
    expect((late.json.overview as MaintOverview).expiries.find((e) => e.id === expiry?.id)).toMatchObject({ status: "due" });
    await sweep();
    events = await eventsOf(ana, car);
    expect(events.map((e) => e.type)).toEqual(["expiry_soon", "expiry_due"]);
    expect(String(events[1]?.detail.reason)).toMatch(/^venció el /);

    // Renewed for a year: up to date, and no more notifications.
    const renewed = await h.request("PUT", `/api/maintenance/expiries/${expiry?.id}`, { ...as(ana), body: { ...body, expiresOn: ymd(Date.now() + 365 * DAY) } });
    expect((renewed.json.overview as MaintOverview).expiries.find((e) => e.id === expiry?.id)).toMatchObject({ status: "ok" });
    await sweep();
    expect((await eventsOf(ana, car)).map((e) => e.type)).toEqual(["expiry_soon", "expiry_due"]);

    expect((await h.request("PUT", `/api/maintenance/expiries/${expiry?.id}`, { ...as(otherAccount), body: { ...body, expiresOn: today } })).status).toBe(404);
    const gone = await h.request("DELETE", `/api/maintenance/expiries/${expiry?.id}`, as(ana));
    expect((gone.json.overview as MaintOverview).expiries.some((e) => e.id === expiry?.id)).toBe(false);
  });
});

describe("module E: with fleet and reports", () => {
  it("watches the fleet documents, its orders count as an expense and appear in the maintenance report", async () => {
    const car = await addVehicle(bea, "Furgón completo");
    // A fleet-module document with an expiry date.
    const doc = await h.fastify.inject({
      method: "POST",
      url: `/api/vehicles/${car.id}/fleet/documents?name=Revision.pdf&kind=inspection&expiresOn=${ymd(Date.now() + 5 * DAY)}`,
      headers: { cookie: bea.cookie, origin: ORIGIN, "content-type": "application/pdf" },
      payload: PDF,
    });
    expect(doc.statusCode, doc.body).toBe(201);
    const view = await overviewOf(bea);
    expect(view.expiries).toMatchObject([{ source: "fleet", kind: "inspection", name: "Revision.pdf", status: "soon", vehicleId: car.id }]);
    await sweep();
    expect((await eventsOf(bea, car)).map((e) => [e.type, e.detail.subject])).toEqual([["expiry_soon", "Revisión técnica · Revision.pdf"]]);

    // A finished order with its cost.
    const plan = ((await h.request("POST", "/api/maintenance/plans", { ...as(bea), body: { name: "Servicio mayor", everyDays: 10, warnDays: 3, vehicleIds: [car.id] } })).json.plans as MaintPlan[])[0] as MaintPlan;
    const schedule = (await overviewOf(bea)).schedules[0] as MaintOverview["schedules"][number];
    await h.request("PUT", `/api/maintenance/schedules/${schedule.id}`, { ...as(bea), body: { lastOn: ymd(Date.now() - 20 * DAY), lastKm: 0, lastHours: 0 } });
    const made = await h.request("POST", "/api/maintenance/orders", {
      ...as(bea),
      body: order(car, { title: "Cambio de embrague", status: "done", laborCost: 2500, parts: [{ name: "Kit de embrague", quantity: 1, unitCost: 6200 }] }),
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    await h.request("POST", "/api/maintenance/orders", { ...as(bea), body: order(car, { title: "Revisar fuga de aceite" }) });

    // It enters the fleet expenses by itself, as maintenance.
    const from = ymd(Date.now() - 2 * DAY);
    const to = ymd(Date.now() + 2 * DAY);
    const expenses = (await h.request("GET", `/api/fleet/expenses?from=${from}&to=${to}`, as(bea))).json.expenses as FleetExpenses;
    expect(expenses.items).toMatchObject([{ id: null, category: "maintenance", amount: 8700, currency: "HNL", note: `Orden de trabajo n.º ${(made.json.order as MaintOrder).number}: Cambio de embrague` }]);
    expect(expenses.totals).toEqual([{ currency: "HNL", total: 8700, byCategory: [{ category: "maintenance", total: 8700 }] }]);

    // And in the report: what was done, what it cost and what is pending.
    const query = new URLSearchParams({ from: new Date(Date.now() - 3 * DAY).toISOString(), to: new Date(Date.now() + DAY).toISOString(), zone: "UTC" }).toString();
    const res = await h.request("GET", `/api/reports/maintenance?${query}`, as(bea));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const report = res.json.report as ReportDocument;
    expect(report.title).toBe("Reporte de mantenimiento");
    expect(Object.fromEntries(report.stats.map((s) => [s.label, s.value]))).toMatchObject({ "Servicios hechos": 1, Preventivos: 0, Correctivos: 1, Costo: "8.700,00 HNL", "Servicios vencidos": 1, "Órdenes abiertas": 1 });
    const [services, costs, pending] = report.tables;
    expect(services?.rows).toMatchObject([[expect.any(String), "Furgón completo", expect.any(Number), "Correctivo", "Cambio de embrague", null, null, 2500, 6200, 8700, "HNL"]]);
    expect(costs?.rows).toEqual([["Furgón completo", "HNL", 1, 2500, 6200, 8700]]);
    expect(pending?.rows.map((r) => [r[1], r[2], r[3]])).toEqual([
      ["Servicio programado", plan.name, "Vencido"],
      ["Vencimiento", "Revisión técnica · Revision.pdf", "Próximo"],
      ["Orden de trabajo", expect.stringContaining("Revisar fuga de aceite"), "Abierta"],
    ]);
    // It is downloaded as Excel and as PDF, like the others.
    for (const format of ["xlsx", "pdf"]) {
      const file = await h.fastify.inject({ method: "GET", url: `/api/reports/maintenance/export?${query}&format=${format}`, headers: { cookie: bea.cookie } });
      expect(file.statusCode, format).toBe(200);
      expect(file.rawPayload.length, format).toBeGreaterThan(1000);
    }
    // Without the maintenance module, that report does not exist.
    expect((await h.request("GET", `/api/reports/maintenance?${query}`, as(otherAccount))).status).toBe(404);
  });
});
