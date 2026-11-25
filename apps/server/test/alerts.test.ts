// Alerts: rules through the API, event engine detectors and the emails the account's notifications send about them.
import { type AlertRule, type LonLat, type VehicleEvent, type WeekSchedule, offset } from "@opengps/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser; // owner
let otherAccount: TestUser; // another account

const center: LonLat = [-87.2068, 14.0818];
const at = (east: number, north = 0): LonLat => offset(offset(center, east, 90), north, 0);
const KNOTS = 1 / 1.852;
/** Everything happens a few hours ago; each test uses its own stretch of time. */
const T0 = Date.now() - 8 * 3_600_000;
let clock = 0;
const ALWAYS: WeekSchedule = { zone: "UTC", days: Array.from({ length: 7 }, () => [0, 1440] as [number, number]) };
/** Schedule that is valid neither today nor yesterday. */
const NEVER_NOW: WeekSchedule = { zone: "UTC", days: Array.from({ length: 7 }, (_, d) => (d === (new Date(T0).getUTCDay() + 3) % 7 ? ([0, 1440] as [number, number]) : null)) };

const as = (user: TestUser) => ({ cookie: user.cookie });

async function addVehicle(user: TestUser, name: string, groupId?: string) {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId: "h02" } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const id = res.json.vehicle.id as string;
  if (groupId) expect((await h.request("PATCH", `/api/vehicles/${id}`, { ...as(user), body: { groupId } })).status).toBe(200);
  return { id, deviceId: h.traccar.devices.get(uniqueId) as number };
}
/**
 * Creates an alert. With `email`, also a notification of the account that sends
 * the events of that alert by email: to everyone, or to whom `email` says.
 */
async function addAlert(user: TestUser, body: Record<string, unknown>) {
  const { email, ...rule } = body as { email?: boolean | Record<string, unknown>; name: string; zone?: string };
  const res = await h.request("POST", "/api/alerts", { ...as(user), body: rule });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const alert = res.json.alert as AlertRule;
  if (email) {
    const to = email === true ? { everyone: true } : email;
    const notification = await h.request("POST", "/api/notifications", { ...as(user), body: { name: `Correo de ${rule.name}`, channel: "email", ruleIds: [alert.id], zone: rule.zone ?? "UTC", ...to } });
    expect(notification.status, JSON.stringify(notification.json)).toBe(201);
  }
  return alert;
}
const alertsOf = async (user: TestUser) => (await h.request("GET", "/api/alerts", as(user))).json.alerts as AlertRule[];

interface Step {
  /** Seconds since the previous position (10 by default). */
  dt?: number;
  kmh?: number;
  at?: LonLat;
  ignition?: boolean;
  alarm?: string;
  power?: number;
}
/** The vehicle reports that sequence. Time continues from the last report of any test. */
async function report(vehicle: { deviceId: number }, steps: Step[]) {
  const rows = steps.map((s) => {
    clock += (s.dt ?? 10) * 1000;
    const p = s.at ?? center;
    const attributes = { ...(s.ignition === undefined ? {} : { ignition: s.ignition }), ...(s.alarm ? { alarm: s.alarm } : {}), ...(s.power ? { power: s.power } : {}) };
    return traccarRow(vehicle.deviceId, { fix: new Date(T0 + clock), lon: p[0], lat: p[1], knots: (s.kmh ?? 0) * KNOTS, attributes });
  });
  await h.ingestFrom(rows).tick();
  await h.events.idle();
  await h.notifier.idle();
}
const eventsFor = async (vehicleId: string) => ((await h.request("GET", `/api/events?limit=200&vehicleId=${vehicleId}`, as(ana))).json.events as VehicleEvent[]).reverse();
const typesFor = async (vehicleId: string) => (await eventsFor(vehicleId)).map((e) => e.type);

async function join(name: string, role: string, groups: string[] | null, vehicles: string[] = []) {
  const person = await h.signUp(name);
  const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role, groups, vehicles } });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);
  expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
  return person;
}

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Alertas");
  otherAccount = await h.signUp("Otra Cuenta");
});
afterAll(async () => {
  await h?.close();
});
// Each test starts with the basic alerts and no geofences.
beforeEach(async () => {
  await h.db.core.query(`DELETE FROM gps.alert_rules WHERE org_id = $1`, [ana.orgId]);
  await h.db.core.query(`DELETE FROM gps.geofences WHERE org_id = $1`, [ana.orgId]);
  await h.db.core.query(`UPDATE gps.account_settings SET alerts_seeded = false WHERE org_id = $1`, [ana.orgId]);
  h.bus.emit("alerts_changed", { orgId: ana.orgId });
  h.bus.emit("geofences_changed", { orgId: ana.orgId });
  h.mails.length = 0;
});

describe("alerts: rules", () => {
  it("a new account comes with the basic alerts, and deleting them does not bring them back", async () => {
    const first = await alertsOf(ana);
    expect(first.map((a) => a.type).sort()).toEqual(["parked_movement", "power_cut", "sos", "tow"]);
    expect(first.every((a) => a.active && a.vehicleIds === null && a.groupIds === null)).toBe(true);
    expect(first.find((a) => a.type === "parked_movement")?.params).toEqual({ meters: 150 });

    const sos = first.find((a) => a.type === "sos") as AlertRule;
    expect((await h.request("DELETE", `/api/alerts/${sos.id}`, as(ana))).status).toBe(204);
    expect((await alertsOf(ana)).map((a) => a.type).sort()).toEqual(["parked_movement", "power_cut", "tow"]);
  });

  it("creates, edits and deletes, and rejects what does not fit", async () => {
    const speed = await addAlert(ana, { name: "Límite en ciudad", type: "speeding", params: { limitKmh: 60 } });
    expect(speed).toMatchObject({ type: "speeding", params: { limitKmh: 60, seconds: 20, geofenceId: null }, active: true, zone: "UTC" });

    const edited = await h.request("PUT", `/api/alerts/${speed.id}`, {
      ...as(ana),
      body: { name: "Límite en carretera", type: "speeding", params: { limitKmh: 90, seconds: 30 }, zone: "America/Tegucigalpa", schedule: ALWAYS },
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect(edited.json.alert).toMatchObject({ name: "Límite en carretera", params: { limitKmh: 90, seconds: 30 }, zone: "America/Tegucigalpa" });

    const post = (body: Record<string, unknown>) => h.request("POST", "/api/alerts", { ...as(ana), body });
    expect((await post({ name: "Sin límite", type: "speeding", params: {} })).status).toBe(400);
    expect((await post({ name: "Muy lento", type: "speeding", params: { limitKmh: 3 } })).json.error.message).toContain("10 km/h");
    expect((await post({ name: "Tipo raro", type: "teletransporte", params: {} })).status).toBe(400);
    expect((await post({ name: "Sin condiciones", type: "custom", params: { conditions: [] } })).json.error.message).toContain("al menos una condición");
    expect((await post({ name: "Geocerca ajena", type: "speeding", params: { limitKmh: 50, geofenceId: "0195b8a0-0000-7000-8000-000000000000" } })).status).toBe(400);
    expect((await post({ name: "Vehículo ajeno", type: "sos", vehicleIds: ["0195b8a0-0000-7000-8000-000000000000"] })).status).toBe(400);
    // An alert's type cannot be changed.
    expect((await h.request("PUT", `/api/alerts/${speed.id}`, { ...as(ana), body: { name: "Otra cosa", type: "sos" } })).status).toBe(400);

    expect((await h.request("DELETE", `/api/alerts/${speed.id}`, as(ana))).status).toBe(204);
    const audit = await h.request("GET", "/api/audit?limit=20", as(ana));
    expect(audit.json.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["alert.create", "alert.update", "alert.delete"]));
  });

  it("another account cannot see or touch them, and a reader cannot create them", async () => {
    const mine = await addAlert(ana, { name: "Mía", type: "signal_lost", params: { minutes: 30 } });
    expect((await alertsOf(otherAccount)).some((a) => a.id === mine.id)).toBe(false);
    expect((await h.request("PUT", `/api/alerts/${mine.id}`, { ...as(otherAccount), body: { name: "Robada", type: "signal_lost", params: { minutes: 30 } } })).status).toBe(404);
    expect((await h.request("DELETE", `/api/alerts/${mine.id}`, as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", "/api/alerts", {})).status).toBe(401);

    const reader = await join("Lector de Alertas", "viewer", null);
    expect((await alertsOf(reader)).some((a) => a.id === mine.id)).toBe(true);
    expect((await h.request("POST", "/api/alerts", { ...as(reader), body: { name: "No", type: "sos" } })).status).toBe(403);
    expect((await h.request("DELETE", `/api/alerts/${mine.id}`, as(reader))).status).toBe(403);
  });
});

describe("alerts: detectors", () => {
  it("speeding: notifies once when the excess lasts, and rearms when speed drops", async () => {
    await addAlert(ana, { name: "Límite 60", type: "speeding", params: { limitKmh: 60, seconds: 20 } });
    const truck = await addVehicle(ana, "Veloz");
    // A short spike does not notify: 10 seconds above, then back down.
    await report(truck, [{ kmh: 50 }, { kmh: 70 }, { kmh: 55 }]);
    expect(await typesFor(truck.id)).toEqual([]);
    // 20 seconds in a row above: notifies, and does not repeat while it continues.
    await report(truck, [{ kmh: 72 }, { kmh: 80 }, { kmh: 95 }, { kmh: 90 }, { kmh: 88 }]);
    const events = await eventsFor(truck.id);
    expect(events.map((e) => e.type)).toEqual(["speeding"]);
    expect(events[0]).toMatchObject({ ruleName: "Límite 60", geofenceName: null, detail: { speedKmh: 95, limitKmh: 60 } });
    // Drops and exceeds again: another notification.
    await report(truck, [{ kmh: 40 }, { kmh: 75 }, { kmh: 76 }, { kmh: 77 }]);
    expect(await typesFor(truck.id)).toEqual(["speeding", "speeding"]);
    expect((await h.request("GET", `/api/events?alerts=1&vehicleId=${truck.id}`, as(ana))).json.events).toHaveLength(2);
  });

  it("speeding inside a geofence: outside it does not count", async () => {
    const zone = (await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Zona escolar", geometry: { shape: "circle", center, radiusM: 300 } } })).json.geofence;
    await addAlert(ana, { name: "30 en zona escolar", type: "speeding", params: { limitKmh: 30, seconds: 0, geofenceId: zone.id } });
    const truck = await addVehicle(ana, "Escolar");
    await report(truck, [{ kmh: 50, at: at(900) }, { kmh: 50, at: at(800) }]);
    expect((await typesFor(truck.id)).filter((t) => t === "speeding")).toEqual([]);
    await report(truck, [{ kmh: 45, at: at(100) }]);
    const speeding = (await eventsFor(truck.id)).filter((e) => e.type === "speeding");
    expect(speeding).toHaveLength(1);
    expect(speeding[0]).toMatchObject({ geofenceName: "Zona escolar", detail: { speedKmh: 45, limitKmh: 30 } });
  });

  it("ignition outside schedule", async () => {
    // Allowed only on a day that is not today: any ignition now is outside the schedule.
    await addAlert(ana, { name: "Solo en horario", type: "ignition_off_hours", params: { allowed: NEVER_NOW } });
    const truck = await addVehicle(ana, "Nocturno");
    await report(truck, [{ ignition: false }, { ignition: true }, { ignition: true }, { ignition: false }, { ignition: true }]);
    expect(await typesFor(truck.id)).toEqual(["ignition_off_hours", "ignition_off_hours"]);
    // With the schedule open all day, turning on does not notify.
    await h.db.core.query(`DELETE FROM gps.alert_rules WHERE org_id = $1 AND type = 'ignition_off_hours'`, [ana.orgId]);
    await addAlert(ana, { name: "Siempre permitido", type: "ignition_off_hours", params: { allowed: ALWAYS } });
    const other = await addVehicle(ana, "Diurno");
    await report(other, [{ ignition: false }, { ignition: true }]);
    expect(await typesFor(other.id)).toEqual([]);
  });

  it("device alarms: panic and battery notify without any configuration, without repeating", async () => {
    await alertsOf(ana); // creates the basic alerts
    h.bus.emit("alerts_changed", { orgId: ana.orgId });
    const truck = await addVehicle(ana, "Con botón");
    await report(truck, [{ kmh: 20 }, { kmh: 20, alarm: "sos" }, { kmh: 20, alarm: "sos" }, { kmh: 20, alarm: "powerCut" }]);
    const events = await eventsFor(truck.id);
    expect(events.map((e) => e.type)).toEqual(["sos", "power_cut"]);
    expect(events[0]).toMatchObject({ ruleName: "Botón de pánico" });
    // After a few minutes, a new alarm notifies again.
    await report(truck, [{ dt: 400, kmh: 20, alarm: "sos" }]);
    expect(await typesFor(truck.id)).toEqual(["sos", "power_cut", "sos"]);
    // Harsh driving is not there by default: without its alert, it is not recorded.
    await report(truck, [{ kmh: 60, alarm: "hardBraking" }]);
    expect(await typesFor(truck.id)).toHaveLength(3);
    await addAlert(ana, { name: "Manejo brusco", type: "harsh_driving" });
    await report(truck, [{ kmh: 60, alarm: "hardBraking,hardCornering" }]);
    const last = (await eventsFor(truck.id)).at(-1);
    expect(last).toMatchObject({ type: "harsh_driving", detail: { kind: "hardBraking" } });
  });

  it("tow: by the device alarm or by moving with the engine off", async () => {
    await alertsOf(ana);
    h.bus.emit("alerts_changed", { orgId: ana.orgId });
    const truck = await addVehicle(ana, "Remolcado");
    // Off and still is nothing; off and at 25 km/h for 20 seconds, it is.
    await report(truck, [{ ignition: false }, { ignition: false, kmh: 25 }, { ignition: false, kmh: 25 }]);
    expect(await typesFor(truck.id)).toEqual([]);
    await report(truck, [{ ignition: false, kmh: 28 }, { ignition: false, kmh: 30 }]);
    const events = await eventsFor(truck.id);
    expect(events.map((e) => e.type)).toEqual(["tow"]);
    expect(events[0]?.detail).toEqual({ speedKmh: 28 });
    // With the engine on, moving is normal.
    const other = await addVehicle(ana, "Normal");
    await report(other, [{ ignition: true, kmh: 40 }, { ignition: true, kmh: 40 }, { ignition: true, kmh: 40 }, { ignition: true, kmh: 40 }]);
    expect(await typesFor(other.id)).toEqual([]);
    await report(other, [{ ignition: true, kmh: 0, alarm: "tow" }]);
    expect((await eventsFor(other.id)).map((e) => [e.type, e.detail])).toEqual([["tow", { byDevice: true }]]);
  });

  it("parked mode: notifies if the vehicle moves away from where it was left", async () => {
    await alertsOf(ana);
    h.bus.emit("alerts_changed", { orgId: ana.orgId });
    const car = await addVehicle(ana, "Estacionado");
    // Without a position yet it cannot be set as parked.
    expect((await h.request("POST", `/api/vehicles/${car.id}/park`, { ...as(ana), body: { parked: true } })).status).toBe(400);
    await report(car, [{ at: at(0) }]);
    const parked = await h.request("POST", `/api/vehicles/${car.id}/park`, { ...as(ana), body: { parked: true } });
    expect(parked.status, JSON.stringify(parked.json)).toBe(200);
    expect(parked.json.vehicle.parkedSince).toBeTruthy();
    // Parking starts now and the tests' reports carry past timestamps:
    // for this test the clock is moved forward to an instant after parking.
    const before = clock;
    clock = Date.now() - T0 + 3_000;

    await report(car, [{ dt: 2, at: at(60) }, { dt: 2, at: at(120) }]); // the GPS wanders a little: no notification
    expect(await typesFor(car.id)).toEqual([]);
    await report(car, [{ dt: 2, at: at(400), kmh: 30 }, { dt: 2, at: at(900), kmh: 30 }]);
    const events = await eventsFor(car.id);
    expect(events.map((e) => e.type)).toEqual(["unauthorized_movement"]);
    expect(events[0]?.detail.meters as number).toBeGreaterThan(350);

    // Removing the mode stops the watch; turning it on again, it watches from the new spot.
    const off = await h.request("POST", `/api/vehicles/${car.id}/park`, { ...as(ana), body: { parked: false } });
    expect(off.json.vehicle.parkedSince).toBeNull();
    await report(car, [{ dt: 2, at: at(2000), kmh: 30 }]);
    expect(await typesFor(car.id)).toHaveLength(1);
    expect((await h.request("POST", `/api/vehicles/${car.id}/park`, { ...as(ana), body: { parked: true } })).status).toBe(200);
    clock = Math.max(clock, Date.now() - T0 + 1_000);
    await report(car, [{ dt: 2, at: at(2010) }, { dt: 2, at: at(2600), kmh: 20 }]);
    clock = before;
    expect(await typesFor(car.id)).toEqual(["unauthorized_movement", "unauthorized_movement"]);
    // A reader cannot change the parked mode.
    const reader = await join("Lector Estacionado", "viewer", null);
    expect((await h.request("POST", `/api/vehicles/${car.id}/park`, { ...as(reader), body: { parked: false } })).status).toBe(403);
  });

  it("signal loss: notifies once per silence and records the return", async () => {
    // Only for this vehicle: those of other tests have also gone a while without reporting.
    const truck = await addVehicle(ana, "Callado");
    await addAlert(ana, { name: "Sin señal 10 min", type: "signal_lost", params: { minutes: 10 }, vehicleIds: [truck.id] });
    await report(truck, [{ kmh: 30 }]);
    const lastSeen = Date.now();
    expect(await h.events.sweep(lastSeen + 5 * 60_000, ana.orgId)).toBe(0);
    expect(await h.events.sweep(lastSeen + 15 * 60_000, ana.orgId)).toBe(1);
    expect(await h.events.sweep(lastSeen + 20 * 60_000, ana.orgId)).toBe(0);
    let events = await eventsFor(truck.id);
    expect(events.map((e) => e.type)).toEqual(["signal_lost"]);
    expect(events[0]).toMatchObject({ ruleName: "Sin señal 10 min" });
    expect(events[0]?.detail.silentMin as number).toBeGreaterThanOrEqual(14);
    // It reports again: that is recorded, and a new silence notifies again.
    await report(truck, [{ kmh: 30 }]);
    events = await eventsFor(truck.id);
    expect(events.map((e) => e.type)).toEqual(["signal_lost", "signal_back"]);
    expect(await h.events.sweep(Date.now() + 30 * 60_000, ana.orgId)).toBe(1);
  });

  it("custom alert: all conditions at once, for the requested time", async () => {
    const zone = (await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Mina", geometry: { shape: "circle", center, radiusM: 300 } } })).json.geofence;
    await addAlert(ana, {
      name: "Rápido dentro de la mina",
      type: "custom",
      params: {
        conditions: [
          { field: "speed", op: "gt", value: 20 },
          { field: "ignition", value: true },
          { field: "geofence", inside: true, geofenceId: zone.id },
          { field: "power", op: "lt", value: 13 },
        ],
        seconds: 10,
      },
    });
    const truck = await addVehicle(ana, "Minero");
    // One condition fails at a time: outside the zone, slow, off, high battery.
    await report(truck, [
      { kmh: 40, ignition: true, power: 12.5, at: at(900) },
      { kmh: 10, ignition: true, power: 12.5 },
      { kmh: 40, ignition: false, power: 12.5 },
      { kmh: 40, ignition: true, power: 14.1 },
    ]);
    expect((await typesFor(truck.id)).filter((t) => t === "custom")).toEqual([]);
    // All at once, but only for an instant: not yet. Ten seconds later, yes.
    await report(truck, [{ kmh: 40, ignition: true, power: 12.5 }]);
    expect((await typesFor(truck.id)).filter((t) => t === "custom")).toEqual([]);
    await report(truck, [{ kmh: 42, ignition: true, power: 12.4 }]);
    const custom = (await eventsFor(truck.id)).filter((e) => e.type === "custom");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ ruleName: "Rápido dentro de la mina" });
  });

  it("applies only to its vehicles or groups, and respects its schedule", async () => {
    const northGroup = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: `Norte ${Date.now()}` } })).json.group.id as string;
    const a = await addVehicle(ana, "Elegido");
    const b = await addVehicle(ana, "Del norte", northGroup);
    const c = await addVehicle(ana, "Ninguno");
    await addAlert(ana, { name: "Solo el elegido", type: "speeding", params: { limitKmh: 50, seconds: 0 }, vehicleIds: [a.id] });
    await addAlert(ana, { name: "Solo el norte", type: "speeding", params: { limitKmh: 50, seconds: 0 }, groupIds: [northGroup] });
    await addAlert(ana, { name: "Fuera de horario", type: "speeding", params: { limitKmh: 50, seconds: 0 }, schedule: NEVER_NOW });
    for (const v of [a, b, c]) await report(v, [{ kmh: 80 }]);
    expect((await eventsFor(a.id)).map((e) => e.ruleName)).toEqual(["Solo el elegido"]);
    expect((await eventsFor(b.id)).map((e) => e.ruleName)).toEqual(["Solo el norte"]);
    expect(await typesFor(c.id)).toEqual([]);

    // A northern operator sees and changes their group's alert; the rest only those for the whole account, without touching them.
    const operator = await join("Operador de Alertas", "operator", [northGroup]);
    const seen = await alertsOf(operator);
    // Sees their group's and those for the whole account (including the basic ones); not that of a vehicle outside their scope.
    expect(seen.map((r) => r.name)).toEqual(expect.arrayContaining(["Fuera de horario", "Solo el norte", "Botón de pánico"]));
    expect(seen.some((r) => r.name === "Solo el elegido")).toBe(false);
    const own = seen.find((r) => r.name === "Solo el norte") as AlertRule;
    const wide = seen.find((r) => r.name === "Fuera de horario") as AlertRule;
    expect((await h.request("DELETE", `/api/alerts/${wide.id}`, as(operator))).status).toBe(403);
    expect((await h.request("PUT", `/api/alerts/${own.id}`, { ...as(operator), body: { name: "Norte a 70", type: "speeding", params: { limitKmh: 70 } } })).status).toBe(200);
    const created = await h.request("POST", "/api/alerts", { ...as(operator), body: { name: "Pánico del norte", type: "sos" } });
    expect(created.json.alert.groupIds).toEqual([northGroup]);
    expect((await h.request("POST", "/api/alerts", { ...as(operator), body: { name: "De otro", type: "sos", vehicleIds: [c.id] } })).status).toBe(400);

    // Whoever sees a single vehicle sees the alerts that watch it and creates them only for it.
    const fromOne = await join("Operador de un vehículo", "operator", [], [a.id]);
    const theirs = await alertsOf(fromOne);
    expect(theirs.map((r) => r.name)).toEqual(expect.arrayContaining(["Solo el elegido", "Fuera de horario"]));
    expect(theirs.some((r) => r.name === "Norte a 70" || r.name === "Pánico del norte")).toBe(false);
    const single = await h.request("POST", "/api/alerts", { ...as(fromOne), body: { name: "Pánico del elegido", type: "sos" } });
    expect(single.json.alert).toMatchObject({ vehicleIds: [a.id], groupIds: null });
    expect((await h.request("PUT", `/api/alerts/${single.json.alert.id}`, { ...as(fromOne), body: { name: "Pánico del elegido", type: "sos", vehicleIds: [a.id] } })).status).toBe(200);
    expect((await h.request("POST", "/api/alerts", { ...as(fromOne), body: { name: "De otro", type: "sos", vehicleIds: [c.id] } })).status).toBe(400);
    expect((await h.request("POST", "/api/alerts", { ...as(fromOne), body: { name: "De un grupo", type: "sos", groupIds: [northGroup] } })).status).toBe(403);
  });
});

describe("alerts: email notifications", () => {
  it("sends the email to those the notification names and who see the vehicle", async () => {
    const northGroup = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: `Correo norte ${Date.now()}` } })).json.group.id as string;
    const south = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: `Correo sur ${Date.now()}` } })).json.group.id as string;
    const fromNorth = await join("Lector Norte", "viewer", [northGroup]);
    const fromSouth = await join("Lector Sur", "viewer", [south]);
    // An operator: the notification only names the owner and the readers.
    const quiet = await join("Operador sin correos", "operator", null);
    expect((await h.request("GET", "/api/me", as(quiet))).json.settings).toEqual({ theme: "system", language: null, phone: null });
    // Each preference is saved on its own, without touching the rest.
    expect((await h.request("PUT", "/api/me/settings", { ...as(quiet), body: { phone: "+50499887766" } })).status).toBe(204);
    expect((await h.request("PUT", "/api/me/settings", { ...as(quiet), body: { theme: "dark", language: "en" } })).status).toBe(204);
    expect((await h.request("GET", "/api/me", as(quiet))).json.settings).toEqual({ theme: "dark", language: "en", phone: "+50499887766" });
    expect((await h.request("PUT", "/api/me/settings", { ...as(quiet), body: { theme: "system", language: null, phone: null } })).status).toBe(204);
    expect((await h.request("GET", "/api/me", as(quiet))).json.settings).toEqual({ theme: "system", language: null, phone: null });
    expect((await h.request("PUT", "/api/me/settings", { ...as(quiet), body: { language: "fr" } })).status).toBe(400);
    expect((await h.request("PUT", "/api/me/settings", { ...as(quiet), body: { phone: "99887766" } })).status).toBe(400);

    await addAlert(ana, { name: "Límite con correo", type: "speeding", params: { limitKmh: 60, seconds: 0 }, email: { roles: ["owner", "viewer"] }, zone: "America/Tegucigalpa" });
    const truck = await addVehicle(ana, "Camión del norte", northGroup);
    await addAlert(ana, { name: "Señal sin correo", type: "signal_lost", params: { minutes: 10 }, vehicleIds: [truck.id] });
    // Two more readers, each limited to one vehicle: the truck, and another one.
    const fromTruck = await join("Lector del camión", "viewer", [], [truck.id]);
    const fromOther = await join("Lector de otro vehículo", "viewer", [], [(await addVehicle(ana, "Otro vehículo")).id]);
    h.mails.length = 0;
    await report(truck, [{ kmh: 95 }]);

    // Readers with no group limit created by other tests also receive it.
    const to = h.mails.map((m) => m.to);
    expect(to).toContain(ana.email);
    expect(to).toContain(fromNorth.email);
    expect(to).toContain(fromTruck.email);
    expect(to).not.toContain(fromOther.email);
    expect(to).not.toContain(fromSouth.email);
    expect(to).not.toContain(quiet.email);
    expect(to).not.toContain(otherAccount.email);
    expect(new Set(to).size).toBe(to.length);
    const mail = h.mails[0];
    expect(mail?.subject).toBe("Camión del norte: exceso de velocidad");
    expect(mail?.body).toContain("iba a 95 km/h con un límite de 60 km/h");
    expect(mail?.body).toContain("Te lo envía el aviso «Correo de Límite con correo»");
    expect(mail?.body).toContain("hora de America/Tegucigalpa");
    expect(mail?.url).toBe(h.config.publicUrl);

    // An alert no notification tells about sends nothing.
    h.mails.length = 0;
    expect(await h.events.sweep(Date.now() + 20 * 60_000, ana.orgId)).toBe(1);
    await h.notifier.idle();
    expect(h.mails).toEqual([]);
  });

  it("a notification of a geofence alert tells about the geofence events that alert covers", async () => {
    const zone = (await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Zona roja", geometry: { shape: "circle", center, radiusM: 200 }, kind: "forbidden" } })).json.geofence;
    const otherZone = (await h.request("POST", "/api/geofences", { ...as(ana), body: { name: "Otra zona", geometry: { shape: "circle", center: at(3000), radiusM: 200 }, kind: "forbidden" } })).json.geofence;
    const truck = await addVehicle(ana, "Intruso");
    // Without a notification: the event exists, but there is no email.
    await report(truck, [{ at: at(900) }, { at: at(0) }, { at: at(900) }]);
    expect((await typesFor(truck.id)).slice(0, 2)).toEqual(["zone_forbidden", "geofence_exit"]);
    expect(h.mails).toEqual([]);

    await addAlert(ana, { name: "Zona roja por correo", type: "geofence", params: { geofenceIds: [zone.id] }, email: true });
    await report(truck, [{ at: at(0) }, { at: at(900) }, { at: at(3000) }]);
    // The one for the chosen zone arrives; the other zone and the exit (which is not a notification) generate no email.
    expect([...new Set(h.mails.map((m) => m.subject))]).toEqual(["Intruso: entró a una zona prohibida"]);
    expect(h.mails.filter((m) => m.to === ana.email)).toHaveLength(1);
    expect(h.mails[0]?.body).toContain("Entró a una zona prohibida: Zona roja");
    expect(otherZone.id).toBeTruthy();
  });

  it("a badly tuned alert does not flood the mailbox: there is an hourly cap", async () => {
    await addAlert(ana, { name: "Demasiado sensible", type: "speeding", params: { limitKmh: 10, seconds: 0 }, email: true });
    const truck = await addVehicle(ana, "Insistente");
    // Goes up and down without stopping: one notification each time.
    const steps: Step[] = [];
    const cap = h.config.alertEmailsPerHour;
    for (let i = 0; i < cap + 15; i++) steps.push({ kmh: 40 }, { kmh: 0 });
    h.mails.length = 0;
    await report(truck, steps);
    expect((await typesFor(truck.id)).filter((t) => t === "speeding")).toHaveLength(cap + 15);
    expect(h.mails.length).toBeLessThanOrEqual(cap);
    expect(h.mails.length).toBeGreaterThan(0);
  });
});
