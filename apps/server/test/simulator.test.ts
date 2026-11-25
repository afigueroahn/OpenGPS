// The device simulator of the admin console: its API, and the simulator
// itself running devices against a local gateway with the test's clock.
import { connect } from "node:net";
import { type SimRouteSummary, type SimulationDetail, type SimulationSummary, type SimulatorMeta, type VehicleState, generateSimId, isImei } from "@opengps/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSimulator } from "../src/simulator/manager";
import { type Harness, type TestUser, createHarness } from "./harness";
import { type Gateway, closeGateways, gateway, until } from "./sim-gateway";

let h: Harness;
let boss: TestUser; // administers the platform
let customer: TestUser; // any account
let routes: SimRouteSummary[];

const as = (user: TestUser) => ({ cookie: user.cookie });
const admin = (method: string, url: string, body?: unknown) => h.request(method, url, body === undefined ? as(boss) : { ...as(boss), body });
const BASE = "/api/admin/simulator";
const imei = () => generateSimId({ kind: "imei" });
const h02Id = () => generateSimId({ kind: "digits", length: 10 });
const actor = () => ({ userId: boss.userId, ip: "127.0.0.1" });
const EXAMPLES = ["Lima", "Bogotá", "Ciudad de México", "Tegucigalpa", "San Salvador"];

/** A simulation as the console sends it. */
const draft = (over: Record<string, unknown> = {}) => ({ name: "Camión de prueba", modelId: "teltonika", identifiers: [imei()], routeId: routes[0]?.id, host: h.config.gatewayHost, port: 5027, ...over });
async function create(over: Record<string, unknown> = {}): Promise<SimulationDetail> {
  const res = await admin("POST", `${BASE}/simulations`, draft(over));
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.simulation as SimulationDetail;
}
const detail = async (id: string) => (await admin("GET", `${BASE}/simulations/${id}`)).json.simulation as SimulationDetail;
const list = async () => (await admin("GET", `${BASE}/simulations`)).json.simulations as SimulationSummary[];

/** Adds a GPS to the customer's account, as a person does before simulating it. Returns the platform's device. */
async function addGps(uniqueId: string, modelId: string): Promise<{ deviceId: number; vehicleId: string }> {
  const res = await h.request("POST", "/api/vehicles", { ...as(customer), body: { name: `GPS ${uniqueId}`, uniqueId, modelId } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const device = await h.db.core.query<{ id: number }>(`SELECT id FROM gps.devices WHERE unique_id = $1`, [uniqueId]);
  return { deviceId: device.rows[0]?.id as number, vehicleId: res.json.vehicle.id as string };
}

/** The platform stored a position of that device, with that GPS time. */
function stored(device: { deviceId: number; vehicleId: string }, fixTime: number): void {
  h.bus.emit("position", { orgId: customer.orgId, vehicleId: device.vehicleId, groupId: null, deviceId: device.deviceId, state: { fixTime: new Date(fixTime).toISOString() } as VehicleState });
}

/** A simulator of the test's own: its clock moves by hand and every device connects to that gateway, wherever it was told to go. */
function ownSimulator(gw: Gateway) {
  const clock = { now: 1_800_000_000_000 };
  const simulator = createSimulator({ db: h.db, bus: h.bus, config: h.config, tickMs: null, now: () => clock.now, connect: () => connect({ host: "127.0.0.1", port: gw.port }) });
  const pass = (seconds: number) => {
    clock.now += seconds * 1000;
    simulator.tick(clock.now);
  };
  return { simulator, clock, pass };
}

beforeAll(async () => {
  h = await createHarness();
  boss = await h.signUp("Jefa de Plataforma");
  customer = await h.signUp("Cliente Común");
  await h.makeOwner(boss);
  // The example circuits it starts with; routes saved by other tests are not these.
  routes = ((await admin("GET", `${BASE}/routes`)).json.routes as SimRouteSummary[]).filter((r) => EXAMPLES.includes(r.name));
});

afterEach(async () => {
  h.simulator.stop();
  await h.simulator.idle();
  await closeGateways();
  await h.db.core.query(`DELETE FROM gps.simulations`);
});

afterAll(async () => {
  await h.close();
});

describe("device simulator", () => {
  it("exists only for whoever administers the platform", async () => {
    const id = "019ab000-0000-7000-8000-000000000000";
    for (const [method, url] of [
      ["GET", `${BASE}/meta`],
      ["GET", `${BASE}/routes`],
      ["GET", `${BASE}/simulations`],
      ["POST", `${BASE}/simulations`],
      ["GET", `${BASE}/simulations/${id}`],
      ["PUT", `${BASE}/simulations/${id}`],
      ["DELETE", `${BASE}/simulations/${id}`],
      ["POST", `${BASE}/simulations/${id}/run`],
      ["POST", `${BASE}/run`],
    ] as const) {
      const body = method === "GET" || method === "DELETE" ? {} : { body: {} };
      expect((await h.request(method, url, { ...as(customer), ...body })).status, `${method} ${url}`).toBe(404);
      expect((await h.request(method, url, body)).status, `${method} ${url} without a session`).toBe(401);
    }
  });

  it("says which brands it speaks, where devices connect and which routes there are", async () => {
    const meta = (await admin("GET", `${BASE}/meta`)).json.meta as SimulatorMeta;
    expect(meta.brands.map((b) => b.modelId).sort()).toEqual(["h02", "teltonika"]);
    const teltonika = meta.brands.find((b) => b.modelId === "teltonika");
    expect(teltonika).toMatchObject({ protocol: "teltonika", port: 5027, idLabel: "IMEI", idFormat: { kind: "imei" } });
    expect(teltonika?.capabilities).toEqual(expect.arrayContaining(["ignition", "engineCut", "lockState", "fuel"]));
    expect(meta.brands.find((b) => b.modelId === "h02")).toMatchObject({ port: 5013, idFormat: { kind: "digits", length: 10 } });
    // A new simulated device starts with the address real devices are given.
    expect(meta.host).toBe(h.config.gatewayHost);
    expect(meta).toMatchObject({ running: 0 });

    // The example circuits it starts with, each one closed on itself.
    expect(routes.map((r) => r.name).sort()).toEqual([...EXAMPLES].sort());
    for (const route of routes) expect(route).toMatchObject({ closed: true, inUse: 0, timed: false });
    expect(routes.find((r) => r.name === "Lima")?.lengthM).toBe(18_585);
  });

  it("makes identifiers a device of each brand could have", () => {
    for (let i = 0; i < 50; i++) {
      expect(isImei(imei())).toBe(true);
      expect(h02Id()).toMatch(/^[1-9]\d{9}$/);
    }
    expect(isImei("356307042441013")).toBe(true); // a real one
    expect(isImei("356307042441014")).toBe(false);
  });

  it("checks what it is asked to simulate", async () => {
    const bad = async (over: Record<string, unknown>) => {
      const res = await admin("POST", `${BASE}/simulations`, draft(over));
      return [res.status, (res.json.error as { message?: string } | undefined)?.message] as const;
    };
    expect(await bad({ modelId: "gt06" })).toEqual([400, "El simulador todavía no habla esa marca"]);
    expect((await bad({ identifiers: ["356307042441014"] }))[0]).toBe(400); // wrong check digit
    expect(await bad({ modelId: "h02", identifiers: ["12345"] })).toEqual([400, "El identificador de esta marca son 10 dígitos"]);
    expect((await bad({ identifiers: [] }))[0]).toBe(400);
    const twice = imei();
    expect(await bad({ identifiers: [twice, twice] })).toEqual([400, "Hay un identificador repetido"]);
    // Its server and its port are written by hand, as on a real GPS: neither can be missing.
    expect(await bad({ host: undefined })).toEqual([400, "Escribe el servidor y el puerto"]);
    expect(await bad({ host: "  " })).toEqual([400, "Escribe el servidor y el puerto"]);
    expect(await bad({ port: undefined })).toEqual([400, "Escribe el servidor y el puerto"]);
    expect(await bad({ port: 0 })).toEqual([400, "Escribe el servidor y el puerto"]);
    expect(await bad({ port: 70_000 })).toEqual([400, "Escribe el servidor y el puerto"]);
    expect(await bad({ host: "http://otro.ejemplo.com" })).toEqual([400, "El servidor es un nombre o una IP, sin http:// ni espacios"]);
    expect(await bad({ routeId: "019ab000-0000-7000-8000-000000000000" })).toEqual([400, "Esa ruta ya no existe: elige otra"]);
    expect((await bad({ intervalS: 0 }))[0]).toBe(400);
    expect((await bad({ scenario: { cruiseKmh: 900 } }))[0]).toBe(400);
    expect(await list()).toEqual([]);

    // An identifier belongs to one simulation.
    const first = await create();
    const again = await admin("POST", `${BASE}/simulations`, draft({ identifiers: first.identifiers }));
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: "identifier_in_use" });
    // Saving the same simulation again is not a clash with itself.
    expect((await admin("PUT", `${BASE}/simulations/${first.id}`, draft({ name: "Otro nombre", identifiers: first.identifiers }))).status).toBe(200);
    expect((await admin("GET", `${BASE}/simulations/not-an-id`)).status).toBe(404);
  });

  it("keeps a simulation as it was written, stopped until it is started", async () => {
    const identifier = imei();
    const made = await create({ identifiers: [identifier], scenario: { cruiseKmh: 60, end: "loop" } });
    expect(made).toMatchObject({
      name: "Camión de prueba",
      modelId: "teltonika",
      identifiers: [identifier],
      host: h.config.gatewayHost,
      port: 5027,
      toPlatform: true,
      intervalS: 5,
      routeName: routes[0]?.name,
      scenario: { cruiseKmh: 60, end: "loop", idleS: 20, restS: 240 },
      running: false,
      status: "stopped",
      online: 0,
      problems: 0,
      unregistered: 1,
      lastSentAt: null,
      latency: null,
      log: [],
    });
    expect(made.route).toMatchObject({ closed: true, lengthM: routes[0]?.lengthM });
    expect(made.route.line.length).toBeGreaterThan(3);
    expect(made.devices).toEqual([expect.objectContaining({ identifier, status: "stopped", registered: false, sent: 0, lat: null, engineCut: false })]);
    expect((await admin("GET", `${BASE}/routes`)).json.routes).toContainEqual(expect.objectContaining({ id: routes[0]?.id, inUse: 1 }));

    // Once that GPS is added to the platform, the simulator says so.
    await addGps(identifier, "teltonika");
    expect((await detail(made.id)).unregistered).toBe(0);
    expect((await list())[0]).toMatchObject({ id: made.id, unregistered: 0, running: false });

    // Its server can be the platform by any of its names: the IP real devices are given, or its name inside the server.
    for (const own of [h.config.gatewayIp as string, new URL(h.config.traccar.apiUrl).hostname, h.config.gatewayHost.toUpperCase()]) {
      const moved = (await admin("PUT", `${BASE}/simulations/${made.id}`, draft({ identifiers: [identifier], host: own }))).json.simulation as SimulationDetail;
      expect(moved, own).toMatchObject({ host: own, port: 5027, toPlatform: true });
    }
    // Or any other server and port: then nothing it sends is expected here.
    const elsewhere = (await admin("PUT", `${BASE}/simulations/${made.id}`, draft({ identifiers: [identifier], host: "gps.otro.ejemplo.com", port: 6000 }))).json.simulation as SimulationDetail;
    expect(elsewhere).toMatchObject({ host: "gps.otro.ejemplo.com", port: 6000, toPlatform: false });
    // One saved before its server was written by hand goes where real devices are sent, to its brand's port.
    await h.db.core.query(`UPDATE gps.simulations SET host = NULL, port = NULL WHERE id = $1`, [made.id]);
    expect(await detail(made.id)).toMatchObject({ host: h.config.gatewayHost, port: 5027, toPlatform: true });

    expect((await admin("DELETE", `${BASE}/simulations/${made.id}`)).status).toBe(204);
    expect((await admin("GET", `${BASE}/simulations/${made.id}`)).status).toBe(404);
    expect((await admin("DELETE", `${BASE}/simulations/${made.id}`)).status).toBe(404);

    const log = await h.db.core.query<{ action: string; detail: { name: string } }>(`SELECT action, detail FROM gps.audit_log WHERE user_id = $1 AND entity = 'simulation' AND entity_id = $2 ORDER BY id`, [boss.userId, made.id]);
    expect(log.rows.map((r) => r.action)).toEqual(["admin.simulator.create", ...Array.from({ length: 4 }, () => "admin.simulator.update"), "admin.simulator.delete"]);
  });

  it("started from the console, its device connects and reports; stopped, it hangs up", async () => {
    const gw = await gateway((data) => (data.length === 17 ? Buffer.from([0x01]) : null));
    const made = await create({ host: "127.0.0.1", port: gw.port, intervalS: 1 });
    const started = await admin("POST", `${BASE}/simulations/${made.id}/run`, { run: true });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect(started.json.simulation).toMatchObject({ running: true, status: "connecting" });

    h.simulator.tick();
    await until(() => gw.frames.length >= 1, "the handshake");
    await until(async () => {
      h.simulator.tick();
      return (await detail(made.id)).devices[0]?.sent === 1;
    }, "the first report");
    const live = await detail(made.id);
    expect(live).toMatchObject({ running: true, status: "online", online: 1, problems: 0 });
    expect(live.devices[0]).toMatchObject({ status: "online", ignition: true, engineCut: false });
    expect(live.devices[0]?.lat).toBeCloseTo(routes[0]?.name === "Bogotá" ? 4.5981 : (live.route.line[0]?.[1] as number), 3);
    expect(live.lastSentAt).not.toBeNull();
    // The latest comes first in the log.
    expect(live.log.map((e) => e.code)).toEqual(["connected", "started"]);
    expect(live.log[1]).toMatchObject({ identifier: null, params: { host: "127.0.0.1", port: gw.port } });
    expect((await admin("GET", `${BASE}/meta`)).json.meta).toMatchObject({ running: 1 });

    // Starting what is running changes nothing.
    expect((await admin("POST", `${BASE}/simulations/${made.id}/run`, { run: true })).json.simulation.log).toHaveLength(2);

    const stopped = (await admin("POST", `${BASE}/simulations/${made.id}/run`, { run: false })).json.simulation as SimulationDetail;
    expect(stopped).toMatchObject({ running: false, status: "stopped" });
    expect(stopped.log[0]?.code).toBe("stopped");
    await until(() => gw.sockets[0]?.destroyed === true || gw.sockets[0]?.readyState !== "open", "the hang-up");

    const log = await h.db.core.query<{ action: string }>(`SELECT action FROM gps.audit_log WHERE user_id = $1 AND entity_id = $2 AND action LIKE 'admin.simulator.st%' ORDER BY id`, [boss.userId, made.id]);
    expect(log.rows.map((r) => r.action)).toEqual(["admin.simulator.start", "admin.simulator.stop"]);
  });

  it("all of them start and stop at once, however many they are", async () => {
    const gw = await gateway();
    const one = await create({ modelId: "h02", identifiers: [h02Id()], host: "127.0.0.1", port: gw.port });
    // One simulation with many devices: nothing caps how many run at once.
    await create({ modelId: "h02", identifiers: Array.from({ length: 60 }, () => h02Id()), host: "127.0.0.1", port: gw.port });
    expect(((await admin("POST", `${BASE}/run`, { run: true })).json.simulations as SimulationSummary[]).map((s) => s.running)).toEqual([true, true]);
    expect((await admin("GET", `${BASE}/meta`)).json.meta).toMatchObject({ running: 61 });
    // Deleting one that runs stops it first.
    expect((await admin("DELETE", `${BASE}/simulations/${one.id}`)).status).toBe(204);
    expect((await admin("GET", `${BASE}/meta`)).json.meta).toMatchObject({ running: 60 });
    expect(((await admin("POST", `${BASE}/run`, { run: false })).json.simulations as SimulationSummary[]).map((s) => s.running)).toEqual([false]);
  });

  it("tells whether the platform is receiving what the device sends, and how long it takes", async () => {
    const gw = await gateway();
    const identifier = h02Id();
    const made = await create({ modelId: "h02", identifiers: [identifier] });
    const { simulator, clock, pass } = ownSimulator(gw);
    await simulator.run(made.id, true, actor());
    pass(0);
    await until(() => gw.sockets.length === 1, "the connection");
    await until(async () => (await simulator.get(made.id)).status === "online", "being online");
    for (let i = 0; i < 4; i++) pass(5);
    // Reports written one right after another may arrive together: they are counted by their closing mark.
    await until(() => Buffer.concat(gw.frames).toString("ascii").split("#").length - 1 >= 4, "some reports");
    // It is not added to the platform: the gateway takes its reports and nothing arrives.
    pass(5);
    expect(await simulator.get(made.id)).toMatchObject({ status: "silent", problems: 1, unregistered: 1, lastReceivedAt: null, latency: null });

    // Added while it runs, the simulator recognizes it without being restarted.
    const gps = await addGps(identifier, "h02");
    await simulator.idle();
    pass(5);
    const sentAt = clock.now;
    clock.now += 800;
    stored(gps, sentAt);
    const receiving = await simulator.get(made.id);
    expect(receiving).toMatchObject({ status: "online", problems: 0, unregistered: 0, latency: { p50: 800, p95: 800, max: 800, samples: 1 } });
    expect(receiving.devices[0]).toMatchObject({ registered: true, latencyMs: 800, lastReceivedAt: new Date(clock.now).toISOString() });
    // A position that is not from one of its reports still shows it arrives, without a time.
    stored(gps, sentAt - 3_600_000);
    expect((await simulator.get(made.id)).devices[0]).toMatchObject({ latencyMs: null });
    expect((await simulator.get(made.id)).latency).toMatchObject({ samples: 1 });
    // If the platform stops receiving while the device keeps sending, it says so again.
    for (let i = 0; i < 5; i++) pass(5);
    expect(await simulator.get(made.id)).toMatchObject({ status: "silent", problems: 1 });
    stored(gps, clock.now);
    expect(await simulator.get(made.id)).toMatchObject({ status: "online", problems: 0 });
    simulator.stop();
    await simulator.idle();
  });

  it("obeys the engine cut, and after a restart goes on where it was, still cut", async () => {
    const gw = await gateway();
    const made = await create({ modelId: "h02", identifiers: [h02Id()], scenario: { cruiseKmh: 36, end: "loop" } });
    // One that sends to another server, also left running.
    const away = await create({ modelId: "h02", identifiers: [h02Id()], host: "127.0.0.1", port: gw.port });
    const first = ownSimulator(gw);
    await first.simulator.run(made.id, true, actor());
    await first.simulator.run(away.id, true, actor());
    first.pass(0);
    await until(() => gw.sockets.length === 2, "the connections");
    first.pass(0);
    first.pass(100);
    const before = (await first.simulator.get(made.id)).devices[0];
    expect(before).toMatchObject({ engineCut: false, speedKmh: 36 });

    for (const socket of gw.sockets) socket.write("*HQ,0000000000,S20,081516,1,1#");
    await until(async () => (await first.simulator.get(made.id)).devices[0]?.engineCut === true, "the cut");
    first.pass(0);
    const cut = await first.simulator.get(made.id);
    expect(cut.devices[0]).toMatchObject({ engineCut: true, speedKmh: 0, ignition: false });
    expect(cut.log.slice(0, 2).map((e) => e.code)).toEqual(["engineCut", "command"]);
    expect(cut.log[1]).toMatchObject({ params: { text: "*HQ,0000000000,S20,081516,1,1#" } });
    first.pass(50);

    // The server stops…
    first.simulator.stop();
    await first.simulator.idle();
    const saved = await h.db.core.query<{ desired: string; trip_s: number; state: Record<string, { cut: boolean; heldS: number }> }>(`SELECT desired, trip_s, state FROM gps.simulations WHERE id = $1`, [made.id]);
    expect(saved.rows[0]).toMatchObject({ desired: "running", trip_s: 150 });
    expect(Object.values(saved.rows[0]?.state ?? {})[0]).toMatchObject({ cut: true, heldS: 50 });

    // …and starts again: what was running resumes, except what was sending to another server.
    const second = ownSimulator(gw);
    await second.simulator.start();
    expect((await second.simulator.list()).map((s) => [s.id, s.running])).toEqual([
      [made.id, true],
      [away.id, false],
    ]);
    expect((await h.db.core.query(`SELECT desired FROM gps.simulations WHERE id = $1`, [away.id])).rows[0]).toEqual({ desired: "stopped" });
    second.pass(0);
    await until(() => gw.sockets.length === 3, "the reconnection");
    await until(async () => {
      second.pass(0);
      return ((await second.simulator.get(made.id)).devices[0]?.sent ?? 0) >= 1;
    }, "the report after the restart");
    const resumed = await second.simulator.get(made.id);
    expect(resumed.log.at(-1)?.code).toBe("resumed");
    expect(resumed.devices[0]).toMatchObject({ engineCut: true, speedKmh: 0 });
    // Still where it was cut: the 50 seconds it lost standing still are not driven.
    expect(resumed.devices[0]?.lat).toBeCloseTo(cut.devices[0]?.lat as number, 6);
    expect(resumed.devices[0]?.lon).toBeCloseTo(cut.devices[0]?.lon as number, 6);
    second.simulator.stop();
    await second.simulator.idle();
  });

  it("changing a simulation that runs starts it over with what changed", async () => {
    const gw = await gateway();
    const identifier = h02Id();
    const made = await create({ modelId: "h02", identifiers: [identifier], host: "127.0.0.1", port: gw.port });
    await admin("POST", `${BASE}/simulations/${made.id}/run`, { run: true });
    h.simulator.tick();
    await until(() => gw.sockets.length === 1, "the connection");
    const changed = await admin("PUT", `${BASE}/simulations/${made.id}`, draft({ modelId: "h02", identifiers: [identifier], host: "127.0.0.1", port: gw.port, routeId: routes[1]?.id, intervalS: 2 }));
    expect(changed.json.simulation).toMatchObject({ running: true, routeName: routes[1]?.name, intervalS: 2 });
    h.simulator.tick();
    await until(() => gw.sockets.length === 2, "the new connection");
    // A route in use cannot disappear from under it: that is the database's rule.
    await expect(h.db.core.query(`DELETE FROM gps.sim_routes WHERE id = $1`, [routes[1]?.id])).rejects.toThrow(/foreign key/);
  });

  it("takes what happens along the route, and rejects what the brand cannot carry", async () => {
    const actions = [
      { kind: "stop", atM: 2000, seconds: 300 },
      { kind: "alarm", atM: 4000, alarm: "powerCut" },
      { kind: "speeding", atM: 6000, lengthM: 1500, kmh: 130 },
      { kind: "signalLoss", atM: 9000, seconds: 600 },
    ];
    const scenario = { cruiseKmh: 50, end: "loop", actions, fuel: { startPct: 60, burnPer100Km: 12 }, driverKey: "1f00bc55", extraIo: [{ id: 66, value: 11_500 }], reportIgnition: false };
    const made = await create({ scenario });
    // Saved as written, with what was not said at its starting value.
    expect(made.scenario).toMatchObject({ cruiseKmh: 50, roadSpeeds: true, reportIgnition: false, driverKey: "1F00BC55", fuel: { startPct: 60, burnPer100Km: 12 }, extraIo: [{ id: 66, value: 11_500 }] });
    expect(made.scenario.actions).toEqual([
      { kind: "stop", atM: 2000, seconds: 300, engineOn: false },
      { kind: "alarm", atM: 4000, alarm: "powerCut" },
      { kind: "speeding", atM: 6000, lengthM: 1500, kmh: 130 },
      { kind: "signalLoss", atM: 9000, seconds: 600 },
    ]);
    // Where each one happens, to draw it on the map: on the route, in the order written.
    expect(made.route.marks.map((m) => m.kind)).toEqual(["stop", "alarm", "speeding", "signalLoss"]);
    for (const mark of made.route.marks) expect(Math.abs(mark.lat)).toBeLessThanOrEqual(90);
    expect((await detail(made.id)).scenario.actions).toHaveLength(4);

    // An H02 carries the panic button and the power cut, and nothing about fuel, drivers, faults or numbered parameters.
    const h02 = (over: Record<string, unknown>) => admin("POST", `${BASE}/simulations`, draft({ modelId: "h02", identifiers: [h02Id()], ...over }));
    expect((await h02({ scenario: { actions: [{ kind: "alarm", atM: 100, alarm: "sos" }, { kind: "stop", atM: 200, seconds: 60 }, { kind: "towing", atM: 300, lengthM: 500 }] } })).status).toBe(201);
    for (const scenario of [
      { actions: [{ kind: "refuel", atM: 100, seconds: 120, pct: 20 }] },
      { actions: [{ kind: "alarm", atM: 100, alarm: "jamming" }] },
      { actions: [{ kind: "engineLock", atM: 100, seconds: 60 }] },
      { actions: [{ kind: "driverKey", atM: 100, key: "1F00BC55" }] },
      { actions: [{ kind: "dtc", atM: 100, codes: ["P0300"] }] },
      { fuel: { startPct: 50 } },
      { driverKey: "1F00BC55" },
      { extraIo: [{ id: 200, value: 1 }] },
      { reportIgnition: false },
    ]) {
      const refused = await h02({ scenario });
      expect(refused.status, JSON.stringify(scenario)).toBe(400);
      expect(refused.json, JSON.stringify(scenario)).toMatchObject({ error: { code: "not_carried" } });
    }
    // A Teltonika carries every alarm, its panic button among them.
    expect((await admin("POST", `${BASE}/simulations`, draft({ scenario: { actions: [{ kind: "alarm", atM: 100, alarm: "sos" }, { kind: "alarm", atM: 200, alarm: "jamming" }] } }))).status).toBe(201);

    // And what is not an option at all is not taken.
    for (const bad of [
      { kind: "stop", atM: 100, seconds: 0 },
      { kind: "stop", atM: -5, seconds: 60 },
      { kind: "speeding", atM: 100, lengthM: 10, kmh: 130 },
      { kind: "refuel", atM: 100, seconds: 60, pct: 0 },
      { kind: "driverKey", atM: 100, key: "XYZ" },
      { kind: "dtc", atM: 100, codes: ["0300"] },
      { kind: "fly", atM: 100 },
    ]) {
      expect((await admin("POST", `${BASE}/simulations`, draft({ scenario: { actions: [bad] } }))).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("does things to a running device by hand, and only what its brand carries", async () => {
    const gw = await gateway();
    const made = await create({ modelId: "h02", identifiers: [h02Id()], host: "127.0.0.1", port: gw.port, intervalS: 60 });
    const inject = (body: unknown, id = made.id) => admin("POST", `${BASE}/simulations/${id}/inject`, body);
    // Stopped, there is nobody to do it to.
    const idle = await inject({ kind: "alarm", alarm: "sos" });
    expect(idle.status).toBe(409);
    expect(idle.json).toMatchObject({ error: { code: "not_running" } });

    expect((await admin("POST", `${BASE}/simulations/${made.id}/run`, { run: true })).status).toBe(200);
    h.simulator.tick();
    await until(async () => {
      h.simulator.tick();
      return (await detail(made.id)).devices[0]?.sent === 1;
    }, "the first report");
    const sent = () => Buffer.concat(gw.frames).toString("ascii").split("#").length - 1;

    // The panic button: a report goes out at once, without waiting the minute of its interval.
    const pressed = await inject({ kind: "alarm", alarm: "sos" });
    expect(pressed.status, JSON.stringify(pressed.json)).toBe(200);
    expect((pressed.json.simulation as SimulationDetail).log[0]).toMatchObject({ code: "alarm", params: { alarm: "sos" } });
    await until(() => sent() === 2, "the alarm on the wire");
    // Bit 1 of an H02's status is its panic button, pressed when it is 0.
    const status = Number.parseInt(Buffer.concat(gw.frames).toString("ascii").split("#")[1]?.split(",").at(-1) as string, 16);
    expect(status & 2).toBe(0);

    // A theft and a disconnection are written in its log.
    expect(((await inject({ kind: "theft" })).json.simulation as SimulationDetail).log.map((e) => e.code)).toEqual(expect.arrayContaining(["theft", "alarm"]));
    const gone = (await inject({ kind: "disconnect", seconds: 120 })).json.simulation as SimulationDetail;
    expect(gone.log[0]).toMatchObject({ code: "signalLost" });
    expect(gone).toMatchObject({ status: "noSignal" });
    expect(gone.devices[0]).toMatchObject({ status: "noSignal", stored: 1 });

    // What an H02 does not carry is not done to it; and without a tank there is no fuel to move.
    for (const body of [{ kind: "alarm", alarm: "jamming" }, { kind: "engineLock", on: true }, { kind: "fuel", pct: -20 }]) {
      const refused = await inject(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.json, JSON.stringify(body)).toMatchObject({ error: { code: "not_carried" } });
    }
    for (const body of [{ kind: "fuel", pct: 0.5 }, { kind: "disconnect" }, { kind: "alarm", alarm: "fire" }, { kind: "dance" }]) expect((await inject(body)).status, JSON.stringify(body)).toBe(400);
    const teltonika = await create({ host: "127.0.0.1", port: gw.port });
    expect((await admin("POST", `${BASE}/simulations/${teltonika.id}/run`, { run: true })).status).toBe(200);
    expect((await inject({ kind: "fuel", pct: 20 }, teltonika.id)).json).toMatchObject({ error: { code: "no_tank" } });
    expect((await inject({ kind: "engineLock", on: true }, teltonika.id)).json.simulation.log[0]).toMatchObject({ code: "engineCut" });

    // Only for whoever administers the platform.
    expect((await h.request("POST", `${BASE}/simulations/${made.id}/inject`, { ...as(customer), body: { kind: "alarm", alarm: "sos" } })).status).toBe(404);
    expect((await h.request("POST", `${BASE}/simulations/${made.id}/backfill`, { ...as(customer), body: {} })).status).toBe(404);
  });

  it("sends its whole route as a trip of the past, with the time each report would have had", async () => {
    const gw = await gateway();
    // A lap of the shortest example circuit, a report every 30 seconds.
    const route = [...routes].sort((a, b) => a.lengthM - b.lengthM)[0] as SimRouteSummary;
    const made = await create({ modelId: "h02", identifiers: [h02Id()], routeId: route.id, host: "127.0.0.1", port: gw.port, intervalS: 30, scenario: { cruiseKmh: 60, end: "loop", idleS: 0, restS: 0 } });
    const backfill = (body: unknown = {}) => admin("POST", `${BASE}/simulations/${made.id}/backfill`, body);
    expect((await backfill()).json).toMatchObject({ error: { code: "not_running" } });

    expect((await admin("POST", `${BASE}/simulations/${made.id}/run`, { run: true })).status).toBe(200);
    // Not connected yet: there is nobody to upload it.
    expect((await backfill()).json).toMatchObject({ error: { code: "not_connected" } });
    h.simulator.tick();
    await until(async () => {
      h.simulator.tick();
      return (await detail(made.id)).devices[0]?.sent === 1;
    }, "the first report");

    const lapS = route.lengthM / (60 / 3.6);
    const expected = Math.floor(lapS / 30) + 1;
    const before = Date.now();
    const res = await backfill({ hoursAgo: 24 });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.reports).toBe(expected);
    expect((res.json.simulation as SimulationDetail).log[0]).toMatchObject({ code: "backfill", params: { count: expected, hours: 24 } });
    expect((res.json.simulation as SimulationDetail).devices[0]?.sent).toBe(expected + 1);

    // On the wire: every report of the trip, in order, from a lap before yesterday at this hour until then.
    const frames = () => Buffer.concat(gw.frames).toString("ascii").split("#").filter(Boolean);
    await until(() => frames().length === expected + 1, "the trip on the wire");
    const times = frames()
      .slice(1)
      .map((frame) => {
        const f = frame.split(",");
        const [time, date] = [f[3] as string, f[11] as string];
        return Date.UTC(2000 + Number(date.slice(4, 6)), Number(date.slice(2, 4)) - 1, Number(date.slice(0, 2)), Number(time.slice(0, 2)), Number(time.slice(2, 4)), Number(time.slice(4, 6)));
      });
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const end = before - 24 * 3_600_000;
    expect(Math.abs((times.at(-1) as number) - (end - (lapS % 30) * 1000))).toBeLessThan(5000);
    expect(Math.abs((times[0] as number) - (end - lapS * 1000))).toBeLessThan(5000);
    expect((times[1] as number) - (times[0] as number)).toBe(30_000);

    // A trip that would be too many reports is not sent; nor one that ended longer ago than a month.
    const slow = await create({ modelId: "h02", identifiers: [h02Id()], host: "127.0.0.1", port: gw.port, intervalS: 1, scenario: { cruiseKmh: 5, end: "loop" } });
    expect((await admin("POST", `${BASE}/simulations/${slow.id}/run`, { run: true })).status).toBe(200);
    expect((await admin("POST", `${BASE}/simulations/${slow.id}/backfill`, {})).json).toMatchObject({ error: { code: "backfill_too_long" } });
    expect((await backfill({ hoursAgo: 721 })).status).toBe(400);
    expect((await backfill({ hoursAgo: -1 })).status).toBe(400);
  });
});
