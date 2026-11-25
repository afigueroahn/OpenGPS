// Platform tests against the local database: registration, isolation between
// accounts, GPS activation, ingestion without duplicates and live channel.
import { LEGAL_VERSION } from "@opengps/shared";
import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { CoreEvents } from "../src/bus";
import { createGeocoder, shortAddress } from "../src/core/geocode";
import { expireClaims } from "../src/core/tasks";
import { type Harness, ORIGIN, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser;
let beto: TestUser;

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana");
  beto = await h.signUp("Beto");
});
afterAll(async () => {
  await h?.close();
});

const addVehicle = async (user: TestUser, name: string, uniqueId = h.uniqueId()) => {
  const res = await h.request("POST", "/api/vehicles", { cookie: user.cookie, body: { name, uniqueId, modelId: "h02" } });
  expect(res.status).toBe(201);
  return { id: res.json.vehicle.id as string, uniqueId };
};
const traccarIdOf = (uniqueId: string) => h.traccar.devices.get(uniqueId) as number;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("registration and session", () => {
  it("each registration creates its own account", () => {
    expect(ana.orgId).toBeTruthy();
    expect(beto.orgId).toBeTruthy();
    expect(ana.orgId).not.toBe(beto.orgId);
  });

  it("does not let in without confirming the email", async () => {
    const email = `t-sinverificar-${Date.now()}@prueba.test`;
    const password = "clave-de-prueba-9";
    const created = await h.request("POST", "/api/auth/sign-up/email", { body: { name: "Sin verificar", email, password, legalVersion: LEGAL_VERSION } });
    expect(created.status).toBe(200);
    const login = await h.request("POST", "/api/auth/sign-in/email", { body: { email, password } });
    expect(login.status).toBe(403);
    await h.db.core.query(`DELETE FROM auth.organization WHERE id IN (SELECT "organizationId" FROM auth.member m JOIN auth."user" u ON u.id = m."userId" WHERE u.email = $1)`, [email]);
    await h.db.core.query(`DELETE FROM auth."user" WHERE email = $1`, [email]);
  });

  it("signing up again with an email that has an account answers the same, and the email says how to come in", async () => {
    const mailsTo = (email: string) => h.mails.filter((m) => m.to === email).map((m) => m.subject);
    const before = mailsTo(ana.email).length;
    const again = await h.request("POST", "/api/auth/sign-up/email", { body: { name: "Ana otra vez", email: ana.email, password: "otra-clave-123", legalVersion: LEGAL_VERSION } });
    expect(again.status).toBe(200);
    // Asking for the confirmation link of a confirmed email sends the same notice, and answers the same as any other.
    const resent = await h.request("POST", "/api/auth/send-verification-email", { body: { email: ana.email, callbackURL: "/" } });
    expect(resent.status).toBe(200);
    const nobody = await h.request("POST", "/api/auth/send-verification-email", { body: { email: `t-nadie-${Date.now()}@prueba.test`, callbackURL: "/" } });
    expect(nobody.status).toBe(200);
    await vi.waitFor(() => expect(mailsTo(ana.email).length).toBe(before + 2));
    expect(mailsTo(ana.email).slice(before)).toEqual([`Ya tienes una cuenta en ${h.config.appName}`, `Ya tienes una cuenta en ${h.config.appName}`]);
    expect(h.mails.findLast((m) => m.to === ana.email)?.url).toBe(`${h.config.publicUrl}/login`);
    // The account is the one there was, with its password.
    expect((await h.request("POST", "/api/auth/sign-in/email", { body: { email: ana.email, password: ana.password } })).status).toBe(200);
  });

  it("signs in with email and password after confirming", async () => {
    const login = await h.request("POST", "/api/auth/sign-in/email", { body: { email: ana.email, password: ana.password } });
    expect(login.status).toBe(200);
    expect(String(login.headers["set-cookie"])).toContain("gps.session_token");
  });

  it("rejects the wrong password", async () => {
    const login = await h.request("POST", "/api/auth/sign-in/email", { body: { email: ana.email, password: "otra-clave-000" } });
    expect(login.status).toBe(401);
  });

  it("sends the link to reset the password", async () => {
    const res = await h.request("POST", "/api/auth/request-password-reset", { body: { email: beto.email, redirectTo: "/reset-password" } });
    expect(res.status).toBe(200);
    expect(h.mails.findLast((m) => m.to === beto.email)?.subject).toContain("Restablece");
  });

  it("without a session nothing is accessible", async () => {
    for (const [method, url] of [
      ["GET", "/api/me"],
      ["GET", "/api/vehicles"],
      ["GET", "/api/device-models"],
      ["POST", "/api/vehicles"],
      ["GET", "/api/vehicles/00000000-0000-0000-0000-000000000000"],
      ["DELETE", "/api/vehicles/00000000-0000-0000-0000-000000000000"],
    ] as const) {
      const res = await h.request(method, url, method === "POST" ? { body: {} } : {});
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it("rejects changes sent from another website", async () => {
    const res = await h.request("POST", "/api/vehicles", {
      cookie: ana.cookie,
      origin: "https://otro-sitio.example",
      body: { name: "X", uniqueId: h.uniqueId(), modelId: "h02" },
    });
    expect(res.status).toBe(403);
  });

  it("the session tables match what the library expects", async () => {
    const plan = await getMigrations(h.auth.auth.options, { throwOnUnsafe: false });
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([]);
    expect(plan.toBeAdded.map((t) => t.table)).toEqual([]);
  });
});

describe("isolation between accounts", () => {
  it("an account cannot see or touch another's vehicles", async () => {
    const mine = await addVehicle(ana, "Camioneta de Ana");

    const listB = await h.request("GET", "/api/vehicles", { cookie: beto.cookie });
    expect(listB.json.vehicles.map((v: { id: string }) => v.id)).not.toContain(mine.id);

    const attempts = [
      await h.request("GET", `/api/vehicles/${mine.id}`, { cookie: beto.cookie }),
      await h.request("PATCH", `/api/vehicles/${mine.id}`, { cookie: beto.cookie, body: { name: "Robado" } }),
      await h.request("GET", `/api/vehicles/${mine.id}/track`, { cookie: beto.cookie }),
      await h.request("DELETE", `/api/vehicles/${mine.id}/device`, { cookie: beto.cookie }),
      await h.request("POST", `/api/vehicles/${mine.id}/device`, { cookie: beto.cookie, body: { uniqueId: h.uniqueId(), modelId: "h02" } }),
      await h.request("DELETE", `/api/vehicles/${mine.id}`, { cookie: beto.cookie }),
    ];
    expect(attempts.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);

    const still = await h.request("GET", `/api/vehicles/${mine.id}`, { cookie: ana.cookie });
    expect(still.status).toBe(200);
    expect(still.json.vehicle.name).toBe("Camioneta de Ana");
    expect(still.json.vehicle.device.uniqueId).toBe(mine.uniqueId);
  });

  it("a GPS belongs to a single account", async () => {
    const mine = await addVehicle(ana, "Moto de Ana");
    const other = await h.request("POST", "/api/vehicles", { cookie: beto.cookie, body: { name: "Intento", uniqueId: mine.uniqueId, modelId: "h02" } });
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("device_taken");
    const again = await h.request("POST", "/api/vehicles", { cookie: ana.cookie, body: { name: "Repetido", uniqueId: mine.uniqueId, modelId: "h02" } });
    expect(again.json.error.code).toBe("device_exists");
    // The failed attempt does not leave a half-created vehicle.
    const listB = await h.request("GET", "/api/vehicles", { cookie: beto.cookie });
    expect(listB.json.vehicles.filter((v: { name: string }) => v.name === "Intento")).toEqual([]);
  });

  it("the live channel only delivers what belongs to the account itself", async () => {
    const mine = await addVehicle(ana, "Auto de Ana");
    const open = (user: TestUser) =>
      new Promise<{ socket: WebSocket; received: any[] }>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${h.port}/api/live`, { headers: { cookie: user.cookie, origin: ORIGIN } });
        const received: any[] = [];
        socket.on("message", (data) => {
          const message = JSON.parse(String(data));
          if (message.type === "hello") resolve({ socket, received });
          else received.push(message);
        });
        socket.on("error", reject);
      });
    const a = await open(ana);
    const b = await open(beto);

    const state: CoreEvents["position"]["state"] = {
      lastSeenAt: new Date().toISOString(), fixTime: new Date().toISOString(), lat: -12.05, lon: -77.03,
      altitude: null, speedKmh: 40, course: 90, accuracy: null, ignition: true, motion: true,
      ignitionInferred: false, powerVoltage: null, batteryVoltage: null, batteryLevel: null, satellites: null, signalBars: null,
    };
    h.bus.emit("position", { orgId: ana.orgId, vehicleId: mine.id, groupId: null, deviceId: 1, state });
    await new Promise((r) => setTimeout(r, 300));

    expect(a.received).toEqual([{ type: "position", vehicleId: mine.id, state }]);
    expect(b.received).toEqual([]);
    a.socket.close();
    b.socket.close();
  });

  it("the live channel requires a session", async () => {
    const result = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${h.port}/api/live`, { headers: { origin: ORIGIN } });
      socket.on("open", () => resolve("abierto"));
      socket.on("unexpected-response", (_req, res) => resolve(`rechazado ${res.statusCode}`));
      socket.on("error", () => resolve("error"));
    });
    expect(result).toBe("rechazado 401");
  });
});

describe("GPS activation", () => {
  it("validates the identifier and the brand", async () => {
    const badId = await h.request("POST", "/api/vehicles", { cookie: ana.cookie, body: { name: "X", uniqueId: "12 34", modelId: "h02" } });
    expect(badId.status).toBe(400);
    const badModel = await h.request("POST", "/api/vehicles", { cookie: ana.cookie, body: { name: "X", uniqueId: h.uniqueId(), modelId: "no-existe" } });
    expect(badModel.status).toBe(400);
  });

  it("each family lists its known models, and the device remembers the one chosen", async () => {
    const families = (await h.request("GET", "/api/device-models", { cookie: ana.cookie })).json.models as { id: string; models: string[] }[];
    expect(families).toHaveLength(9);
    for (const family of families) {
      expect(family.models.length, family.id).toBeGreaterThan(10);
      expect(new Set(family.models.map((m) => m.toLowerCase())).size, family.id).toBe(family.models.length);
    }
    expect(families.find((f) => f.id === "teltonika")?.models).toContain("Teltonika FMC920");
    expect(families.find((f) => f.id === "h02")?.models).toContain("Sinotrack ST-901");

    const made = await h.request("POST", "/api/vehicles", { cookie: ana.cookie, body: { name: "Con modelo", uniqueId: h.uniqueId(), modelId: "teltonika", modelName: "Teltonika FMC920" } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json.vehicle.device).toMatchObject({ modelId: "teltonika", modelName: "Teltonika FMC920" });
    expect((await h.request("GET", `/api/vehicles/${made.json.vehicle.id}`, { cookie: ana.cookie })).json.vehicle.device.modelName).toBe("Teltonika FMC920");
    // Without a model, only the family is known, as before.
    const plain = await h.request("POST", "/api/vehicles", { cookie: ana.cookie, body: { name: "Sin modelo", uniqueId: h.uniqueId(), modelId: "teltonika" } });
    expect(plain.json.vehicle.device.modelName).toBeNull();
    // The model has to be one of that family's.
    const foreign = await h.request("POST", "/api/vehicles", { cookie: ana.cookie, body: { name: "X", uniqueId: h.uniqueId(), modelId: "h02", modelName: "Teltonika FMC920" } });
    expect(foreign.status).toBe(400);
    const invented = await h.request("POST", "/api/vehicles", { cookie: ana.cookie, body: { name: "Suelto", uniqueId: h.uniqueId(), modelId: "gt06", modelName: "Modelo inventado" } });
    expect(invented.status).toBe(400);
  });

  it("stays pending and is confirmed by the first report", async () => {
    const v = await addVehicle(beto, "Camión de Beto");
    const before = await h.request("GET", `/api/vehicles/${v.id}`, { cookie: beto.cookie });
    expect(before.json.vehicle.device.status).toBe("pending");
    expect(before.json.vehicle.state).toBeNull();

    const events: CoreEvents["device"][] = [];
    const off = h.bus.on("device", (e) => events.push(e));
    const ingest = h.ingestFrom([traccarRow(traccarIdOf(v.uniqueId), { fix: minutesAgo(1), knots: 20 })]);
    expect(await ingest.tick()).toBe(1);
    off();

    const after = await h.request("GET", `/api/vehicles/${v.id}`, { cookie: beto.cookie });
    expect(after.json.vehicle.device.status).toBe("active");
    expect(after.json.vehicle.device.confirmedAt).toBeTruthy();
    expect(after.json.vehicle.state.speedKmh).toBe(37);
    expect(events.map((e) => [e.orgId, e.vehicleId, e.device?.status])).toEqual([[beto.orgId, v.id, "active"]]);
  });

  it("if the GPS does not report in time, it is released and the vehicle is left without a device", async () => {
    const v = await addVehicle(ana, "Sin señal");
    await h.db.core.query(`UPDATE gps.devices SET claim_expires_at = now() - interval '1 minute' WHERE unique_id = $1`, [v.uniqueId]);
    await expireClaims({ db: h.db, bus: h.bus, traccar: h.traccar.api, config: h.config });

    const after = await h.request("GET", `/api/vehicles/${v.id}`, { cookie: ana.cookie });
    expect(after.status).toBe(200);
    expect(after.json.vehicle.device).toBeNull();
    expect(h.traccar.devices.has(v.uniqueId)).toBe(false);

    // Released, another account can register it; and the vehicle accepts another device.
    await addVehicle(beto, "Ahora de Beto", v.uniqueId);
    const attach = await h.request("POST", `/api/vehicles/${v.id}/device`, { cookie: ana.cookie, body: { uniqueId: h.uniqueId(), modelId: "teltonika" } });
    expect(attach.status).toBe(201);
    expect(attach.json.vehicle.device.status).toBe("pending");
  });

  it("deleting a vehicle deletes its device, its history and its record in Traccar", async () => {
    const v = await addVehicle(ana, "Para borrar");
    const ingest = h.ingestFrom([traccarRow(traccarIdOf(v.uniqueId), { fix: minutesAgo(2) })]);
    await ingest.tick();
    const deviceId = (await h.db.core.query<{ id: number }>(`SELECT id FROM gps.devices WHERE unique_id = $1`, [v.uniqueId])).rows[0]?.id;

    const deletion = await h.request("DELETE", `/api/vehicles/${v.id}`, { cookie: ana.cookie });
    expect(deletion.status).toBe(204);
    expect((await h.request("GET", `/api/vehicles/${v.id}`, { cookie: ana.cookie })).status).toBe(404);
    expect(h.traccar.devices.has(v.uniqueId)).toBe(false);
    const left = await h.db.core.query(`SELECT 1 FROM gps.positions WHERE device_id = $1`, [deviceId]);
    expect(left.rowCount).toBe(0);
  });
});

describe("ingestion", () => {
  const countPositions = async (uniqueId: string) =>
    (
      await h.db.core.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM gps.positions p JOIN gps.devices d ON d.id = p.device_id WHERE d.unique_id = $1`,
        [uniqueId],
      )
    ).rows[0]?.n;

  it("stores each position only once, even if it is read or arrives twice", async () => {
    const v = await addVehicle(ana, "Sin duplicados");
    const dev = traccarIdOf(v.uniqueId);
    const t4 = minutesAgo(4);
    const feed = [
      traccarRow(dev, { fix: minutesAgo(5), lat: -12.05 }),
      traccarRow(dev, { fix: t4, lat: -12.051 }),
      // Recent ones: the cursor does not move past them and they are read again.
      traccarRow(dev, { fix: minutesAgo(3), lat: -12.052, settled: false }),
      // The same minute-4 position, resent by the device: another row in Traccar, same content.
      traccarRow(dev, { fix: t4, lat: -12.051, settled: false }),
    ];
    const ingest = h.ingestFrom(feed);

    expect(await ingest.tick()).toBe(3);
    expect(ingest.status().cursor).toBe(feed[1]?.id);
    expect(await ingest.tick()).toBe(0);
    expect(await ingest.tick()).toBe(0);
    expect(await countPositions(v.uniqueId)).toBe(3);

    // Once settled, the cursor advances and nothing is left to re-read.
    for (const row of feed) row.settled = true;
    expect(await ingest.tick()).toBe(0);
    expect(ingest.status().cursor).toBe(feed[3]?.id);
  });

  it("late data is stored but does not overwrite the current position", async () => {
    const v = await addVehicle(ana, "Datos atrasados");
    const dev = traccarIdOf(v.uniqueId);
    const feed = [traccarRow(dev, { fix: minutesAgo(1), lat: -12.1, knots: 10 })];
    const ingest = h.ingestFrom(feed);
    await ingest.tick();

    // The device recovers its connection and uploads a position from an hour ago.
    feed.push(traccarRow(dev, { fix: minutesAgo(60), lat: -13.5, knots: 50 }));
    expect(await ingest.tick()).toBe(1);

    const now = await h.request("GET", `/api/vehicles/${v.id}`, { cookie: ana.cookie });
    expect(now.json.vehicle.state.lat).toBe(-12.1);
    expect(now.json.vehicle.state.speedKmh).toBe(18.5);
    expect(await countPositions(v.uniqueId)).toBe(2);

    const track = await h.request("GET", `/api/vehicles/${v.id}/track?minutes=120`, { cookie: ana.cookie });
    expect(track.json.points.map((p: { lat: number }) => p.lat)).toEqual([-13.5, -12.1]);
  });

  it("ignores positions from devices that do not belong to the platform", async () => {
    const ingest = h.ingestFrom([traccarRow(899_999_999, { fix: minutesAgo(1) })]);
    expect(await ingest.tick()).toBe(0);
  });

  it("notifies live of each device's latest position", async () => {
    const v = await addVehicle(beto, "En vivo");
    const dev = traccarIdOf(v.uniqueId);
    const events: CoreEvents["position"][] = [];
    const off = h.bus.on("position", (e) => events.push(e));
    const ingest = h.ingestFrom([
      traccarRow(dev, { fix: minutesAgo(3), lat: -12.01 }),
      traccarRow(dev, { fix: minutesAgo(2), lat: -12.02 }),
      traccarRow(dev, { fix: minutesAgo(1), lat: -12.03, knots: 30 }),
    ]);
    await ingest.tick();
    off();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orgId: beto.orgId, vehicleId: v.id, state: { lat: -12.03, speedKmh: 55.6 } });
  });
});

describe("power and signal", () => {
  it("stores voltage, battery and signal, and keeps the last known value", async () => {
    const v = await addVehicle(ana, "Con telemetría");
    const dev = traccarIdOf(v.uniqueId);
    const feed = [
      traccarRow(dev, { fix: minutesAgo(2), attributes: { power: 14.1, battery: 4.05, batteryLevel: 90, sat: 11, rssi: 5 }, knots: 0 }),
    ];
    const ingest = h.ingestFrom(feed);
    await ingest.tick();
    let state = (await h.request("GET", `/api/vehicles/${v.id}`, { cookie: ana.cookie })).json.vehicle.state;
    expect(state).toMatchObject({ powerVoltage: 14.1, batteryVoltage: 4.05, batteryLevel: 90, satellites: 11, signalBars: 4 });
    // Without ignition from the device, it is deduced from the voltage: engine on and not advancing.
    expect(state).toMatchObject({ ignition: true, ignitionInferred: true });

    // The next position carries no power or signal: they are not lost.
    feed.push(traccarRow(dev, { fix: minutesAgo(1), attributes: {}, knots: 0, lat: -12.06 }));
    await ingest.tick();
    state = (await h.request("GET", `/api/vehicles/${v.id}`, { cookie: ana.cookie })).json.vehicle.state;
    expect(state).toMatchObject({ lat: -12.06, powerVoltage: 14.1, batteryLevel: 90, satellites: 11, signalBars: 4, ignition: true });
  });
});

describe("groups", () => {
  it("creates, assigns, renames and deletes groups", async () => {
    const created = await h.request("POST", "/api/groups", { cookie: ana.cookie, body: { name: "Reparto" } });
    expect(created.status).toBe(201);
    const groupId = created.json.group.id as string;
    const duplicate = await h.request("POST", "/api/groups", { cookie: ana.cookie, body: { name: "reparto" } });
    expect(duplicate.status).toBe(409);

    const v = await addVehicle(ana, "Furgón 1");
    const assigned = await h.request("PATCH", `/api/vehicles/${v.id}`, { cookie: ana.cookie, body: { groupId } });
    expect(assigned.json.vehicle.groupId).toBe(groupId);
    // Changing only the name does not touch the group.
    const renamedVehicle = await h.request("PATCH", `/api/vehicles/${v.id}`, { cookie: ana.cookie, body: { name: "Furgón uno" } });
    expect(renamedVehicle.json.vehicle).toMatchObject({ name: "Furgón uno", groupId });

    const list = await h.request("GET", "/api/groups", { cookie: ana.cookie });
    expect(list.json.groups.find((g: { id: string }) => g.id === groupId)).toMatchObject({ name: "Reparto", vehicleCount: 1 });

    const renamed = await h.request("PATCH", `/api/groups/${groupId}`, { cookie: ana.cookie, body: { name: "Reparto norte" } });
    expect(renamed.json.groups.find((g: { id: string }) => g.id === groupId).name).toBe("Reparto norte");

    expect((await h.request("DELETE", `/api/groups/${groupId}`, { cookie: ana.cookie })).status).toBe(204);
    // The vehicle is still there, now without a group.
    const after = await h.request("GET", `/api/vehicles/${v.id}`, { cookie: ana.cookie });
    expect(after.json.vehicle.groupId).toBeNull();
  });

  it("an account cannot see or use another's groups", async () => {
    const created = await h.request("POST", "/api/groups", { cookie: ana.cookie, body: { name: "Solo de Ana" } });
    const groupId = created.json.group.id as string;

    const listB = await h.request("GET", "/api/groups", { cookie: beto.cookie });
    expect(listB.json.groups.map((g: { id: string }) => g.id)).not.toContain(groupId);
    expect((await h.request("PATCH", `/api/groups/${groupId}`, { cookie: beto.cookie, body: { name: "Mío" } })).status).toBe(404);
    expect((await h.request("DELETE", `/api/groups/${groupId}`, { cookie: beto.cookie })).status).toBe(404);

    // Beto cannot put a vehicle of his in Ana's group.
    const v = await addVehicle(beto, "Auto de Beto");
    const assign = await h.request("PATCH", `/api/vehicles/${v.id}`, { cookie: beto.cookie, body: { groupId } });
    expect(assign.status).toBe(400);
    // The same name in another account is allowed.
    expect((await h.request("POST", "/api/groups", { cookie: beto.cookie, body: { name: "Solo de Ana" } })).status).toBe(201);
    expect((await h.request("GET", "/api/groups", {})).status).toBe(401);
  });
});

describe("approximate address", () => {
  it("builds a short address with street, area and city", () => {
    expect(shortAddress({ address: { road: "Bulevar Suyapa", suburb: "Colonia Florencia", city: "Tegucigalpa", country: "Honduras" } })).toBe(
      "Bulevar Suyapa, Colonia Florencia, Tegucigalpa",
    );
    expect(shortAddress({ address: { road: "Calle 5", house_number: "120", town: "Comayagua" } })).toBe("Calle 5 120, Comayagua");
    expect(shortAddress({ address: { state: "Francisco Morazán", country: "Honduras" } })).toBe("Francisco Morazán");
    expect(shortAddress({ display_name: "Algún lugar, Zona, Ciudad, País" })).toBe("Algún lugar, Zona, Ciudad");
    expect(shortAddress({})).toBeNull();
  });

  it("queries the service once per place and then answers from the cache", async () => {
    // Unique coordinate so as not to clash with other tests.
    const lat = -30 - Math.random();
    const lon = -60 - Math.random();
    const calls: string[] = [];
    const geocoder = createGeocoder(
      { geocoder: { url: "https://direcciones.prueba/reverse", userAgent: "pruebas", minIntervalMs: 0 } },
      h.db.core,
      async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({ address: { road: "Calle de la Caché", city: "Ciudad Prueba" } }) };
      },
    );
    expect(geocoder.enabled).toBe(true);
    // Two simultaneous queries for the same place count as one.
    const [a, b] = await Promise.all([geocoder.reverse(lat, lon), geocoder.reverse(lat, lon)]);
    expect(a).toBe("Calle de la Caché, Ciudad Prueba");
    expect(b).toBe(a);
    expect(await geocoder.reverse(lat, lon)).toBe(a);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("accept-language=es");
    await h.db.core.query(`DELETE FROM gps.geocode_cache WHERE lat_key = $1 AND lon_key = $2`, [Math.round(lat * 10000), Math.round(lon * 10000)]);
  });

  it("if the service fails, it answers without an address and breaks nothing", async () => {
    const geocoder = createGeocoder(
      { geocoder: { url: "https://direcciones.prueba/reverse", userAgent: "pruebas", minIntervalMs: 0 } },
      h.db.core,
      async () => ({ ok: false, status: 503, json: async () => ({}) }),
    );
    expect(await geocoder.reverse(-31.5 - Math.random(), -61.5)).toBeNull();
    const off = createGeocoder({ geocoder: { url: "", userAgent: "", minIntervalMs: 0 } }, h.db.core);
    expect(off.enabled).toBe(false);
    expect(await off.reverse(1, 1)).toBeNull();
  });

  it("gives the address of one's own vehicle and not of another's", async () => {
    const v = await addVehicle(ana, "Con dirección");
    const none = await h.request("GET", `/api/vehicles/${v.id}/address`, { cookie: ana.cookie });
    expect(none.json).toEqual({ address: null }); // still no position
    await h.ingestFrom([traccarRow(traccarIdOf(v.uniqueId), { fix: minutesAgo(1), lat: -12.07, lon: -77.05 })]).tick();
    const mine = await h.request("GET", `/api/vehicles/${v.id}/address`, { cookie: ana.cookie });
    expect(mine.json).toEqual({ address: "Bulevar de Prueba 123, Centro" });
    expect(h.geocoded.at(-1)).toEqual([-12.07, -77.05]);
    expect((await h.request("GET", `/api/vehicles/${v.id}/address`, { cookie: beto.cookie })).status).toBe(404);
  });
});
