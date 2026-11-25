// Module A · Anti-theft and commands: safe engine lock, recovery
// mode, incidents with their timeline, evidence and escalation.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_TTL_MIN, type IncidentDetail, type LockCheck, type VehicleEvent, type VehicleSecurity } from "@opengps/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pruneEvidence } from "../src/modules/antitheft/incidents";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser; // owner, with the module
let otherAccount: TestUser; // another account, without the module

const KNOTS = 1 / 1.852;
const MIN = 60_000;
const as = (user: TestUser) => ({ cookie: user.cookie });

interface Car {
  id: string;
  deviceId: number;
}
async function addVehicle(user: TestUser, name: string, modelId = "teltonika", groupId?: string): Promise<Car> {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const id = res.json.vehicle.id as string;
  if (groupId) expect((await h.request("PATCH", `/api/vehicles/${id}`, { ...as(user), body: { groupId } })).status).toBe(200);
  return { id, deviceId: h.traccar.devices.get(uniqueId) as number };
}

/** The positions in these tests are from right now: the lock depends on how recent the last one is. */
let clock = 0;
interface Step {
  kmh?: number;
  ignition?: boolean;
  alarm?: string;
  /** Device digital output: on a Teltonika, true means engine cut. */
  out1?: boolean;
  at?: [number, number];
}
async function report(car: Car, steps: Step[]) {
  const rows = steps.map((s) => {
    clock = Math.max(Date.now(), clock + 1000);
    const attributes = {
      ...(s.ignition === undefined ? {} : { ignition: s.ignition }),
      ...(s.alarm ? { alarm: s.alarm } : {}),
      ...(s.out1 === undefined ? {} : { out1: s.out1 }),
    };
    return traccarRow(car.deviceId, { fix: new Date(clock), lon: s.at?.[0] ?? -87.2068, lat: s.at?.[1] ?? 14.0818, knots: (s.kmh ?? 0) * KNOTS, attributes });
  });
  await h.ingestFrom(rows).tick();
  await h.settle();
}

const security = async (user: TestUser, car: Car) => (await h.request("GET", `/api/vehicles/${car.id}/security`, as(user))).json.security as VehicleSecurity;
const prepare = async (user: TestUser, car: Car, action: "lock" | "unlock") => h.request("POST", `/api/vehicles/${car.id}/lock/prepare`, { ...as(user), body: { action } });
/** Both steps in a row, as a person who reads and confirms would do. */
async function order(user: TestUser, car: Car, action: "lock" | "unlock") {
  const check = (await prepare(user, car, action)).json.check as LockCheck;
  const res = await h.request("POST", `/api/vehicles/${car.id}/lock`, { ...as(user), body: { action, confirmToken: check.confirmToken, word: action === "lock" ? "bloquear" : "DESBLOQUEAR" } });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.security as VehicleSecurity;
}
const sentTo = (car: Car) => h.traccar.sent.filter((c) => c.id === car.deviceId).map((c) => c.type);
const incidents = async (user: TestUser, open = true) => (await h.request("GET", `/api/incidents?open=${open ? 1 : 0}`, as(user))).json.incidents as IncidentDetail[];
const incident = async (user: TestUser, id: string) => (await h.request("GET", `/api/incidents/${id}`, as(user))).json.incident as IncidentDetail;
const incidentOf = async (car: Car) => (await incidents(ana, false)).find((i) => i.vehicleId === car.id && i.status !== "closed");
const eventsOf = async (car: Car) => ((await h.request("GET", `/api/events?limit=100&vehicleId=${car.id}`, as(ana))).json.events as VehicleEvent[]).map((e) => e.type).reverse();

async function addMember(name: string, role: string, groups: string[] | null) {
  const person = await h.signUp(name);
  const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role, groups } });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);
  expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
  return person;
}

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Antirrobo");
  otherAccount = await h.signUp("Otra Cuenta");
  await h.enableModules(ana.orgId, ["A"]);
});
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h.traccar.state.online = true;
  h.traccar.state.types = ["engineStop", "engineResume", "positionPeriodic", "custom"];
  h.mails.length = 0;
});

describe("module A: per-account activation", () => {
  it("without the module enabled, its routes do not exist for that account", async () => {
    const car = await addVehicle(otherAccount, "Sin módulo");
    expect((await h.request("GET", "/api/incidents", as(otherAccount))).status).toBe(404);
    expect((await h.request("GET", `/api/vehicles/${car.id}/security`, as(otherAccount))).status).toBe(404);
    expect((await h.request("POST", `/api/vehicles/${car.id}/lock/prepare`, { ...as(otherAccount), body: { action: "lock" } })).status).toBe(404);
    // And its alarms do not open incidents.
    await report(car, [{ alarm: "sos" }]);
    await h.enableModules(otherAccount.orgId, ["A"]);
    expect((await h.request("GET", "/api/incidents", as(otherAccount))).json.incidents).toEqual([]);
    await h.enableModules(otherAccount.orgId, []);
    expect((await h.request("GET", "/api/incidents", {})).status).toBe(401);
  });
});

describe("module A: engine lock", () => {
  it("locks in two steps, the device confirms it, and unlocks the same way", async () => {
    const car = await addVehicle(ana, "Camioneta con relé");
    await report(car, [{ kmh: 0, ignition: false, out1: false }]);
    expect(await security(ana, car)).toMatchObject({ lockSupported: true, lock: null, pending: null, recovery: null, commands: [] });

    const check = (await prepare(ana, car, "lock")).json.check as LockCheck;
    expect(check).toMatchObject({ speedKmh: 0, safeNow: true });
    expect(check.fixAgeS).toBeLessThan(30);
    const post = (body: Record<string, unknown>) => h.request("POST", `/api/vehicles/${car.id}/lock`, { ...as(ana), body });
    // Without the word, with the confirmation of another order, or with a made-up one: nothing is sent.
    expect((await post({ action: "lock", confirmToken: check.confirmToken, word: "si" })).status).toBe(400);
    expect((await post({ action: "unlock", confirmToken: check.confirmToken, word: "DESBLOQUEAR" })).status).toBe(403);
    expect((await post({ action: "lock", confirmToken: "inventada.inventada", word: "BLOQUEAR" })).status).toBe(403);
    expect(sentTo(car)).toEqual([]);

    const sent = await order(ana, car, "lock");
    expect(sentTo(car)).toEqual(["engineStop"]);
    expect(sent.pending).toMatchObject({ kind: "lock", status: "sent", requestedBy: "Ana Antirrobo" });
    expect(sent.lock).toMatchObject({ state: "locked", confirmed: false });

    // The device reports its output on: the cut is confirmed.
    await report(car, [{ out1: true }]);
    const locked = await security(ana, car);
    expect(locked.pending).toBeNull();
    expect(locked.lock).toMatchObject({ state: "locked", confirmed: true });
    expect(locked.commands[0]).toMatchObject({ status: "confirmed" });
    expect(await eventsOf(car)).toEqual(["engine_locked"]);

    await order(ana, car, "unlock");
    expect(sentTo(car)).toEqual(["engineStop", "engineResume"]);
    await report(car, [{ out1: false }]);
    expect((await security(ana, car)).lock).toMatchObject({ state: "unlocked", confirmed: true });
    expect(await eventsOf(car)).toEqual(["engine_locked", "engine_unlocked"]);
    const audit = (await h.request("GET", "/api/audit?limit=20", as(ana))).json.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["command.lock", "command.unlock"]));
  });

  it("does not cut the engine of a moving vehicle: waits until it goes slowly", async () => {
    const car = await addVehicle(ana, "En carretera");
    await report(car, [{ kmh: 80, ignition: true }]);
    expect((await prepare(ana, car, "lock")).json.check).toMatchObject({ speedKmh: 80, safeNow: false });
    const waiting = await order(ana, car, "lock");
    expect(waiting.pending).toMatchObject({ status: "waiting", note: "Esperando a que baje de 10 km/h" });
    expect(waiting.lock).toBeNull();
    expect(sentTo(car)).toEqual([]);

    await report(car, [{ kmh: 60, ignition: true }, { kmh: 35, ignition: true }]);
    expect(sentTo(car)).toEqual([]);
    await report(car, [{ kmh: 6, ignition: true }]);
    expect(sentTo(car)).toEqual(["engineStop"]);
    expect((await security(ana, car)).pending).toMatchObject({ status: "sent" });
    // Unlocking does not wait: there is no risk in giving the engine back.
    await report(car, [{ kmh: 70, ignition: true, out1: true }]);
    await order(ana, car, "unlock");
    expect(sentTo(car)).toEqual(["engineStop", "engineResume"]);
  });

  it("the order expires if the safe moment never arrives, and can be cancelled while it waits", async () => {
    const car = await addVehicle(ana, "Sin frenar");
    await report(car, [{ kmh: 90, ignition: true }]);
    await order(ana, car, "lock");
    await h.antitheft.sweep(Date.now() + (COMMAND_TTL_MIN + 1) * MIN, ana.orgId);
    const expired = await security(ana, car);
    expect(expired.pending).toBeNull();
    expect(expired.commands[0]).toMatchObject({ status: "expired", note: "Esperando a que baje de 10 km/h" });
    // Even if it brakes afterwards, an expired order is no longer sent.
    await report(car, [{ kmh: 0, ignition: false }]);
    expect(sentTo(car)).toEqual([]);

    await report(car, [{ kmh: 90, ignition: true }]);
    await order(ana, car, "lock");
    const cancelled = await h.request("DELETE", `/api/vehicles/${car.id}/lock`, as(ana));
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.security.commands[0]).toMatchObject({ status: "cancelled" });
    await report(car, [{ kmh: 0, ignition: false }]);
    expect(sentTo(car)).toEqual([]);
    // An order already sent cannot be cancelled.
    await order(ana, car, "lock");
    expect(sentTo(car)).toEqual(["engineStop"]);
    expect((await h.request("DELETE", `/api/vehicles/${car.id}/lock`, as(ana))).status).toBe(409);
  });

  it("if the device is not connected, the order waits and is retried", async () => {
    const car = await addVehicle(ana, "Sin conexión");
    await report(car, [{ kmh: 0, ignition: false }]);
    h.traccar.state.online = false;
    const waiting = await order(ana, car, "lock");
    expect(waiting.pending).toMatchObject({ status: "waiting" });
    expect(waiting.pending?.note).toContain("no está conectado");
    expect(sentTo(car)).toEqual([]);
    h.traccar.state.online = true;
    await h.antitheft.sweep(Date.now(), ana.orgId);
    expect(sentTo(car)).toEqual(["engineStop"]);
  });

  it("a device that does not report its engine state leaves the order as sent, unconfirmed", async () => {
    const car = await addVehicle(ana, "Con H02", "h02");
    await report(car, [{ kmh: 0, ignition: false }]);
    const done = await order(ana, car, "lock");
    expect(done.pending).toBeNull();
    expect(done.commands[0]).toMatchObject({ status: "sent", note: "Este equipo no informa si aplicó la orden" });
    expect(done.commands[0]?.finishedAt).toBeTruthy();
    expect(done.lock).toMatchObject({ state: "locked", confirmed: false });
  });

  it("a device without remote lock says so before trying anything", async () => {
    h.traccar.state.types = ["custom"];
    const car = await addVehicle(ana, "Sin relé", "gps103");
    await report(car, [{ kmh: 0 }]);
    expect((await security(ana, car)).lockSupported).toBe(false);
    const res = await prepare(ana, car, "lock");
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("lock_unsupported");
  });

  it("only whoever has the permission gives orders; the rest only look", async () => {
    const car = await addVehicle(ana, "Con permisos");
    await report(car, [{ kmh: 0, ignition: false }]);
    const operator = await addMember("Operador sin órdenes", "operator", null);
    expect((await security(operator, car)).lockSupported).toBe(true);
    expect((await prepare(operator, car, "lock")).status).toBe(403);
    expect((await h.request("POST", `/api/vehicles/${car.id}/recovery`, { ...as(operator), body: { on: true } })).status).toBe(403);
    expect((await prepare(otherAccount, car, "lock")).status).toBe(404);
    // One person's confirmation is no use to another.
    const admin = await addMember("Administradora", "admin", null);
    const mine = (await prepare(ana, car, "lock")).json.check as LockCheck;
    expect((await h.request("POST", `/api/vehicles/${car.id}/lock`, { ...as(admin), body: { action: "lock", confirmToken: mine.confirmToken, word: "BLOQUEAR" } })).status).toBe(403);
    await order(admin, car, "lock");
    expect(sentTo(car)).toEqual(["engineStop"]);
  });
});

describe("module A: incidents", () => {
  it("the panic button opens a priority incident and notifies by email; everything else is added to its timeline", async () => {
    const car = await addVehicle(ana, "Taxi 12");
    await report(car, [{ kmh: 30 }, { kmh: 30, alarm: "sos" }, { kmh: 30, alarm: "sos" }, { kmh: 0, alarm: "tampering" }]);
    const open = await incidentOf(car);
    expect(open).toMatchObject({ kind: "sos", priority: 1, status: "open", vehicleName: "Taxi 12", escalation: 0 });
    const detail = await incident(ana, (open as IncidentDetail).id);
    // A repeated alarm does not fill the timeline.
    expect(detail.entries.map((e) => [e.kind, e.text])).toEqual([
      ["alarm", "Botón de pánico"],
      ["alarm", "Manipulación del equipo GPS"],
    ]);
    // One notification per person, to the owner and to whoever administers the account.
    expect(new Set(h.mails.map((m) => m.subject))).toEqual(new Set(["Botón de pánico: Taxi 12"]));
    expect(h.mails.filter((m) => m.to === ana.email)).toHaveLength(1);
    expect(new Set(h.mails.map((m) => m.to)).size).toBe(h.mails.length);
    // Tampering also appears in the event list, as a notification.
    expect(await eventsOf(car)).toEqual(expect.arrayContaining(["sos", "tampering"]));
    expect((await h.request("GET", `/api/events?alerts=1&vehicleId=${car.id}`, as(ana))).json.events.map((e: VehicleEvent) => e.type)).toContain("tampering");
  });

  it("classifies each alarm and raises the priority if something more serious arrives", async () => {
    const jammed = await addVehicle(ana, "Con inhibidor");
    await report(jammed, [{ alarm: "jamming" }]);
    expect(await incidentOf(jammed)).toMatchObject({ kind: "jamming", priority: 1 });
    expect(await eventsOf(jammed)).toEqual(["jamming"]);

    const unplugged = await addVehicle(ana, "Sin batería");
    await report(unplugged, [{ alarm: "powerCut" }]);
    expect(await incidentOf(unplugged)).toMatchObject({ kind: "power_cut", priority: 2 });
    await report(unplugged, [{ alarm: "removing" }]);
    expect(await incidentOf(unplugged)).toMatchObject({ kind: "tampering", priority: 1 });
    await report(unplugged, [{ alarm: "sos" }]);
    const worst = await incidentOf(unplugged);
    expect(worst).toMatchObject({ kind: "sos", priority: 1 });
    expect((await incidents(ana)).filter((i) => i.vehicleId === unplugged.id)).toHaveLength(1);
    // Priority ones go first in the admin console.
    const order = (await incidents(ana)).map((i) => i.priority);
    expect(order).toEqual([...order].sort());

    const towed = await addVehicle(ana, "En grúa");
    await report(towed, [{ alarm: "tow" }]);
    expect(await incidentOf(towed)).toMatchObject({ kind: "tow", priority: 2 });

    // A Teltonika reports the jammer with a parameter, not with a named alarm.
    const fmb = await addVehicle(ana, "Teltonika con inhibidor");
    const row = traccarRow(fmb.deviceId, { fix: new Date(), lon: -87.2068, lat: 14.0818, protocol: "teltonika", attributes: { io249: 1, out1: false } });
    await h.ingestFrom([row]).tick();
    await h.settle();
    expect(await incidentOf(fmb)).toMatchObject({ kind: "jamming", priority: 1 });
  });

  it("a parked vehicle that moves also opens an incident", async () => {
    const car = await addVehicle(ana, "Estacionado");
    await report(car, [{ kmh: 0 }]);
    expect((await h.request("POST", `/api/vehicles/${car.id}/park`, { ...as(ana), body: { parked: true } })).status).toBe(200);
    // Two seconds after parking, never earlier than the reports the previous tests sent.
    clock = Math.max(Date.now(), clock) + 2000;
    await report(car, [{ kmh: 30, at: [-87.2068, 14.0868] }]);
    expect(await incidentOf(car)).toMatchObject({ kind: "movement", priority: 2 });
  });

  it("is handled, gets notes and evidence added, and is closed", async () => {
    const car = await addVehicle(ana, "Camión robado");
    const reported = await h.request("POST", "/api/incidents", { ...as(ana), body: { vehicleId: car.id, note: "El chofer avisó por teléfono que se lo robaron" } });
    expect(reported.status, JSON.stringify(reported.json)).toBe(201);
    const id = reported.json.incident.id as string;
    expect(reported.json.incident).toMatchObject({ kind: "manual", status: "open", priority: 2 });
    expect(reported.json.incident.entries[0]).toMatchObject({ kind: "note", userName: "Ana Antirrobo", text: "El chofer avisó por teléfono que se lo robaron" });

    const attended = await h.request("POST", `/api/incidents/${id}/attend`, as(ana));
    expect(attended.json.incident).toMatchObject({ status: "attended", attendedBy: "Ana Antirrobo" });
    await h.request("POST", `/api/incidents/${id}/notes`, { ...as(ana), body: { text: "Denuncia puesta en la posta policial" } });

    // A photo as evidence.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 7)]);
    const upload = (headers: Record<string, string>, payload: Buffer, name = "Denuncia%20firmada.png") =>
      h.fastify.inject({ method: "POST", url: `/api/incidents/${id}/files?name=${name}`, headers: { cookie: ana.cookie, origin: "http://localhost:5173", ...headers }, payload });
    const uploaded = await upload({ "content-type": "image/png" }, png);
    expect(uploaded.statusCode, uploaded.body.slice(0, 200)).toBe(201);
    const file = (uploaded.json().incident as IncidentDetail).entries.at(-1);
    expect(file).toMatchObject({ kind: "evidence", text: "Adjuntó Denuncia firmada.png", file: { name: "Denuncia firmada.png", size: png.length, mime: "image/png" } });
    const fileId = file?.file?.id as string;
    const download = await h.fastify.inject({ method: "GET", url: `/api/incidents/${id}/files/${fileId}`, headers: { cookie: ana.cookie } });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.rawPayload.equals(png)).toBe(true);
    // Other file types and ones that are too large are rejected; another account cannot reach the file.
    expect((await upload({ "content-type": "text/html" }, Buffer.from("<script>"))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload({ "content-type": "application/pdf" }, Buffer.alloc(9 * 1024 * 1024))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await h.fastify.inject({ method: "GET", url: `/api/incidents/${id}/files/${fileId}`, headers: { cookie: otherAccount.cookie } })).statusCode).toBe(404);
    expect((await h.fastify.inject({ method: "GET", url: `/api/incidents/${id}/files/${fileId}` })).statusCode).toBe(401);

    const closed = await h.request("POST", `/api/incidents/${id}/close`, { ...as(ana), body: { resolution: "recovered", note: "Apareció en un taller" } });
    expect(closed.json.incident).toMatchObject({ status: "closed", resolution: "recovered", closedBy: "Ana Antirrobo" });
    expect(closed.json.incident.entries.at(-1).text).toBe("Cerró el incidente: vehículo recuperado. Apareció en un taller");
    expect(closed.json.incident.entries.map((e: { kind: string }) => e.kind)).toEqual(["note", "status", "note", "evidence", "status"]);
    // Once closed, it no longer changes; and a new alarm opens another incident.
    expect((await h.request("POST", `/api/incidents/${id}/notes`, { ...as(ana), body: { text: "Tarde" } })).status).toBe(400);
    expect((await incidents(ana)).some((i) => i.id === id)).toBe(false);
    expect((await incidents(ana, false)).some((i) => i.id === id)).toBe(true);
    await report(car, [{ alarm: "sos" }]);
    expect((await incidentOf(car))?.id).not.toBe(id);

    // Deleting the vehicle removes its incidents, and the cleanup takes their files off the disk.
    const folder = join(h.config.filesDir, "incidents", ana.orgId, id);
    expect(existsSync(join(folder, fileId))).toBe(true);
    expect((await h.request("DELETE", `/api/vehicles/${car.id}`, as(ana))).status).toBe(204);
    await pruneEvidence(h);
    expect(existsSync(folder)).toBe(false);
  });

  it("an unhandled panic button is escalated, and stops once someone handles it", async () => {
    const car = await addVehicle(ana, "Sin respuesta");
    await report(car, [{ alarm: "sos" }]);
    const id = (await incidentOf(car))?.id as string;
    const opened = Date.parse((await incident(ana, id)).openedAt);
    h.mails.length = 0;
    // The notifications for this incident that the owner receives; the account has other open ones.
    const mine = () => h.mails.filter((m) => m.to === ana.email && m.subject.endsWith("Sin respuesta")).map((m) => m.subject);
    await h.antitheft.sweep(opened + 3 * MIN, ana.orgId);
    expect(mine()).toEqual([]);
    await h.antitheft.sweep(opened + 6 * MIN, ana.orgId);
    expect(mine()).toEqual(["SIN ATENDER · Botón de pánico: Sin respuesta"]);
    await h.antitheft.sweep(opened + 8 * MIN, ana.orgId);
    expect(mine()).toHaveLength(1);
    await h.antitheft.sweep(opened + 16 * MIN, ana.orgId);
    await h.antitheft.sweep(opened + 60 * MIN, ana.orgId);
    expect(mine()).toHaveLength(2);
    const escalated = await incident(ana, id);
    expect(escalated.escalation).toBe(2);
    expect(escalated.entries.filter((e) => e.kind === "escalation")).toHaveLength(2);

    const other = await addVehicle(ana, "Con respuesta");
    await report(other, [{ alarm: "sos" }]);
    const attendedId = (await incidentOf(other))?.id as string;
    expect((await h.request("POST", `/api/incidents/${attendedId}/attend`, as(ana))).status).toBe(200);
    h.mails.length = 0;
    await h.antitheft.sweep(Date.now() + 30 * MIN, ana.orgId);
    expect(h.mails.filter((m) => m.subject.includes("Con respuesta"))).toEqual([]);
  });

  it("whoever cannot see the vehicle cannot see its incident, and a reader cannot handle it", async () => {
    const north = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: `Norte ${Date.now()}` } })).json.group.id as string;
    const south = (await h.request("POST", "/api/groups", { ...as(ana), body: { name: `Sur ${Date.now()}` } })).json.group.id as string;
    const car = await addVehicle(ana, "Del norte", "teltonika", north);
    await report(car, [{ alarm: "sos" }]);
    const id = (await incidentOf(car))?.id as string;
    const fromSouth = await addMember("Operador del sur", "operator", [south]);
    expect((await incidents(fromSouth)).some((i) => i.id === id)).toBe(false);
    expect((await h.request("GET", `/api/incidents/${id}`, as(fromSouth))).status).toBe(404);
    expect((await h.request("POST", `/api/incidents/${id}/attend`, as(fromSouth))).status).toBe(404);
    const reader = await addMember("Lector de incidentes", "viewer", [north]);
    expect((await incident(reader, id)).kind).toBe("sos");
    expect((await h.request("POST", `/api/incidents/${id}/attend`, as(reader))).status).toBe(403);
    expect((await h.request("GET", `/api/incidents/${id}`, as(otherAccount))).status).toBe(404);
  });
});

describe("module A: recovery mode", () => {
  it("creates a link for the authorities, asks for more frequent reports, and undoes it when turned off", async () => {
    const car = await addVehicle(ana, "Moto perdida", "h02");
    await report(car, [{ kmh: 20 }]);
    const on = await h.request("POST", `/api/vehicles/${car.id}/recovery`, { ...as(ana), body: { on: true } });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    expect(on.headers["cache-control"]).toBe("no-store");
    expect(on.json.shareToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(on.json.security.recovery.since).toBeTruthy();
    expect(h.traccar.sent.filter((c) => c.id === car.deviceId)).toEqual([{ id: car.deviceId, type: "positionPeriodic", attributes: { frequency: 10 } }]);
    // The link works without a session and is long-lived.
    const view = (token: string) => h.fastify.inject({ method: "POST", url: "/api/share/view", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" }, payload: JSON.stringify({ token }) });
    const seen = await view(on.json.shareToken);
    expect(seen.statusCode).toBe(200);
    expect((Date.parse(seen.json().view.expiresAt) - Date.now()) / 3_600_000).toBeGreaterThan(71);
    // It remains as an incident, with its note.
    const open = await incidentOf(car);
    const detail = await incident(ana, (open as IncidentDetail).id);
    expect(detail.entries.map((e) => e.kind)).toEqual(["note", "recovery"]);
    expect(detail.entries[1]?.text).toContain("enlace para autoridades válido 72 horas y reporte cada 10 segundos");
    expect((await h.request("POST", `/api/vehicles/${car.id}/recovery`, { ...as(ana), body: { on: true } })).status).toBe(409);

    const off = await h.request("POST", `/api/vehicles/${car.id}/recovery`, { ...as(ana), body: { on: false } });
    expect(off.json).toMatchObject({ shareToken: null, security: { recovery: null } });
    expect((await view(on.json.shareToken)).statusCode).toBe(404);
    expect(h.traccar.sent.filter((c) => c.id === car.deviceId).at(-1)).toEqual({ id: car.deviceId, type: "positionPeriodic", attributes: { frequency: 30 } });
  });

  it("with a device that does not change its report rate, the mode still counts because of the link", async () => {
    h.traccar.state.types = ["engineStop", "engineResume", "custom"];
    const car = await addVehicle(ana, "Camión Teltonika", "jt808");
    await report(car, [{ kmh: 0 }]);
    const on = await h.request("POST", `/api/vehicles/${car.id}/recovery`, { ...as(ana), body: { on: true } });
    expect(on.json.shareToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.traccar.sent.filter((c) => c.id === car.deviceId)).toEqual([]);
    const detail = await incident(ana, (await incidentOf(car))?.id as string);
    expect(detail.entries.at(-1)?.text).toContain("este equipo no permite cambiar su ritmo de reporte a distancia");
  });
});
