// Module I · Integrations: public API with keys and limits, signed webhooks
// with retries and log, automations, sensors, and import and
// export. The "other system" is a test server on the machine itself.
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiKey, Automation, AutomationRun, ImportResult, MaintOrder, RouteTrip, Sensor, SensorSeries, VehicleEvent, Webhook, WebhookDelivery } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openApi } from "../src/modules/integrations/api";
import { createLimiter } from "../src/modules/integrations/keys";
import { OutboundError, isInternalAddress, postJson } from "../src/core/outbound";
import { type Harness, ORIGIN, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser; // owner, with integrations and the other modules
let otherAccount: TestUser; // another account, without the module
let bea: TestUser; // with integrations and nothing else

const KNOTS = 1 / 1.852;
const MIN = 60_000;
const HOUR = 3_600_000;
const LAT = 14.0818;
const LON0 = -87.2068;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const as = (user: TestUser) => ({ cookie: user.cookie });

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
/** A stretch at 60 km/h heading east, one position every 30 seconds. */
async function drive(car: Car, start: number, seconds: number) {
  const rows = [];
  let lon = LON0;
  for (let t = start; t <= start + seconds * 1000; t += 30_000) {
    rows.push(traccarRow(car.deviceId, { fix: new Date(t), lon, lat: LAT, knots: 60 * KNOTS, attributes: { ignition: true } }));
    lon += 500 / M_PER_DEG_LON;
  }
  await h.ingestFrom(rows).tick();
  await h.settle();
}
/** A call to the public API, with its key in the header. */
const api = (method: "GET" | "POST", url: string, key?: string, body?: unknown) =>
  h.fastify.inject({ method, url, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
const eventsOf = async (user: TestUser, car: Car) => ((await h.request("GET", `/api/events?limit=200&vehicleId=${car.id}`, as(user))).json.events as VehicleEvent[]).reverse();
const newKey = async (user: TestUser, name: string, canWrite = false) => {
  const res = await h.request("POST", "/api/integrations/keys", { ...as(user), body: { name, canWrite } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { keys: ApiKey[]; secret: string };
};

// ─── The other system ─────────────────────────────────────────────────────────

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
  json: { id: number; type: string; label: string; event: { vehicleName: string; summary: string | null; detail: Record<string, unknown> } | null; automation?: string };
}
const received: Received[] = [];
/** Which code the other system answers with: to test retries. */
let answer = 200;
let external: http.Server;
let hookUrl = "";

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Integra");
  otherAccount = await h.signUp("Otra Cuenta");
  bea = await h.signUp("Bea Sola");
  await h.enableModules(ana.orgId, ["I", "B", "E", "F", "H"]);
  await h.enableModules(bea.orgId, ["I"]);
  external = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ headers: request.headers, body, json: JSON.parse(body) });
      response.statusCode = answer;
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(external.address() as AddressInfo).port}/avisos`;
});
afterAll(async () => {
  await new Promise((resolve) => external?.close(resolve));
  await h?.close();
});

/** A sensor on a vehicle, with its key, and the way to make it send readings. */
async function addSensor(user: TestUser, car: Car | null, extra: Record<string, unknown> = {}) {
  const res = await h.request("POST", "/api/integrations/sensors", { ...as(user), body: { name: "Sonda de la caja fría", kind: "temperature", unit: "°C", vehicleId: car?.id ?? null, maxValue: 8, ...extra } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const { sensors, secret } = res.json as { sensors: Sensor[]; secret: string };
  const sensor = sensors.find((s) => s.keyPrefix === `${secret.slice(0, 9)}…`) as Sensor;
  const push = async (body: unknown, key = secret) => {
    const sent = await api("POST", "/api/v1/sensors/readings", key, body);
    await h.settle();
    return sent;
  };
  return { sensor, secret, push };
}

describe("module I: keys and public API", () => {
  it("without the module, neither its administration nor its API exist for that account", async () => {
    for (const path of ["/api/integrations/keys", "/api/integrations/webhooks", "/api/integrations/automations", "/api/integrations/sensors", "/api/integrations/export/vehicles"]) {
      expect((await h.request("GET", path, as(otherAccount))).status, path).toBe(404);
      expect((await h.request("GET", path)).status, path).toBe(401);
    }
    expect((await api("GET", "/api/v1/vehicles")).statusCode).toBe(401);
    expect((await api("GET", "/api/v1/vehicles", "gps_inventada")).statusCode).toBe(401);
    // The API description is public: tools read it before having a key.
    const doc = await api("GET", "/api/v1/openapi.json");
    expect(doc.statusCode).toBe(200);
    expect(doc.json()).toMatchObject({ openapi: "3.0.3", security: [{ clave: [] }] });
    expect(Object.keys(openApi("GPS", "https://ejemplo.test", "es").paths as object)).toEqual(expect.arrayContaining(["/vehicles", "/vehicles/{id}/positions", "/events", "/sensors/readings"]));
    expect((await api("GET", "/api/v1")).json()).toMatchObject({ version: "1" });
  });

  it("with an account key, vehicles, positions, trips and events can be queried", async () => {
    const car = await addVehicle(ana, "Camión de reparto");
    await addVehicle(bea, "Vehículo ajeno");
    const start = Date.now() - 3 * HOUR;
    await drive(car, start, 600);
    const { keys, secret } = await newKey(ana, "ERP de la empresa");
    // The whole key is shown only once; in the list, only its beginning.
    expect(secret).toMatch(/^gps_[\w-]{20,}$/);
    expect(keys).toMatchObject([{ name: "ERP de la empresa", canWrite: false, lastUsedAt: null }]);
    expect(keys[0]?.prefix).toBe(`${secret.slice(0, 9)}…`);
    expect(JSON.stringify(keys)).not.toContain(secret);

    const list = await api("GET", "/api/v1/vehicles", secret);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.headers["x-ratelimit-limit"]).toBe("120");
    expect(Number(list.headers["x-ratelimit-remaining"])).toBeLessThan(120);
    const vehicles = list.json().vehicles as { id: string; name: string; status: string; position: { lat: number; speedKmh: number } | null; device: { model: string }; odometerKm: number }[];
    // Only those of its account.
    expect(vehicles.map((v) => v.name)).toEqual(["Camión de reparto"]);
    expect(vehicles[0]).toMatchObject({ id: car.id, device: { model: "h02" } });
    expect(vehicles[0]?.position?.lat).toBeCloseTo(LAT, 4);
    expect(vehicles[0]?.odometerKm).toBeGreaterThan(9);
    expect((await api("GET", `/api/v1/vehicles/${car.id}`, secret)).json().vehicle).toMatchObject({ name: "Camión de reparto" });

    const range = `from=${new Date(start - MIN).toISOString()}&to=${new Date(start + HOUR).toISOString()}`;
    const positions = (await api("GET", `/api/v1/vehicles/${car.id}/positions?${range}`, secret)).json().positions as { at: string; lat: number; speedKmh: number }[];
    expect(positions).toHaveLength(21);
    expect(positions[0]).toMatchObject({ at: new Date(start).toISOString(), speedKmh: 60 });
    const trips = (await api("GET", `/api/v1/vehicles/${car.id}/trips?${range}`, secret)).json();
    expect(trips.trips).toHaveLength(1);
    expect(trips.trips[0].distanceM).toBeGreaterThan(9500);
    expect((await api("GET", `/api/v1/vehicles/${car.id}/positions`, secret)).statusCode).toBe(400);

    expect((await api("GET", "/api/v1/groups", secret)).json()).toEqual({ groups: [] });
    expect((await api("GET", "/api/v1/geofences", secret)).json()).toEqual({ geofences: [] });
    expect((await api("GET", "/api/v1/drivers", secret)).json()).toEqual({ drivers: [] });
    expect((await api("GET", "/api/v1/maintenance/orders", secret)).json()).toEqual({ orders: [] });
    // Another account, with its own key, does not see this one's data; and what belongs to a module it does not have does not exist for it.
    const other = await newKey(bea, "Clave de Bea");
    expect((await api("GET", `/api/v1/vehicles/${car.id}`, other.secret)).statusCode).toBe(404);
    expect((await api("GET", "/api/v1/drivers", other.secret)).statusCode).toBe(404);
    expect((await api("GET", "/api/v1/routes/trips", other.secret)).statusCode).toBe(404);
    // It was used: when is recorded.
    expect(((await h.request("GET", "/api/integrations/keys", as(ana))).json.keys as ApiKey[])[0]?.lastUsedAt).not.toBeNull();
  });

  it("a read-only key does not record; one that can, creates a dispatch and a fill", async () => {
    const car = await addVehicle(ana, "Furgón de entregas");
    const reader = (await newKey(ana, "Solo lectura")).secret;
    const writer = (await newKey(ana, "CRM de pedidos", true)).secret;
    const trip = { name: "Pedido 4471", vehicleId: car.id, startsAt: new Date(Date.now() + HOUR).toISOString(), stops: [{ name: "Cliente Aurora", lat: LAT, lon: LON0 }] };
    expect((await api("POST", "/api/v1/routes/trips", reader, trip)).statusCode).toBe(403);
    const made = await api("POST", "/api/v1/routes/trips", writer, trip);
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().trip).toMatchObject({ name: "Pedido 4471", status: "assigned", vehicleName: "Furgón de entregas" });
    expect(((await api("GET", "/api/v1/routes/trips", reader)).json().trips as RouteTrip[]).map((t) => t.name)).toContain("Pedido 4471");
    expect((await api("POST", "/api/v1/routes/trips", writer, { name: "Sin vehículo" })).statusCode).toBe(400);

    await h.request("PUT", `/api/vehicles/${car.id}/fuel`, { ...as(ana), body: { capacityL: 60, attr: null, normL100km: 10 } });
    const fill = await api("POST", `/api/v1/vehicles/${car.id}/fuel/fills`, writer, { at: new Date(Date.now() - HOUR).toISOString(), liters: 38.5, total: 4200, currency: "HNL", station: "Puma" });
    expect(fill.statusCode, fill.body).toBe(201);
    expect(fill.json().fill).toMatchObject({ liters: 38.5, total: 4200, currency: "HNL" });
    expect((await api("POST", `/api/v1/vehicles/${car.id}/fuel/fills`, reader, { at: new Date().toISOString(), liters: 10 })).statusCode).toBe(403);

    // A removed key stops working immediately.
    const keys = (await h.request("GET", "/api/integrations/keys", as(ana))).json.keys as ApiKey[];
    const gone = keys.find((k) => k.name === "Solo lectura") as ApiKey;
    expect((await h.request("DELETE", `/api/integrations/keys/${gone.id}`, as(bea))).status).toBe(404);
    expect((await h.request("DELETE", `/api/integrations/keys/${gone.id}`, as(ana))).status).toBe(204);
    expect((await api("GET", "/api/v1/vehicles", reader)).statusCode).toBe(401);
    expect((await api("GET", "/api/v1/vehicles", writer)).statusCode).toBe(200);
  });

  it("each key has its own limit of queries per minute", () => {
    const limiter = createLimiter(3);
    const t = 1_000_000;
    expect(limiter.hit("a", t).remaining).toBe(2);
    expect(limiter.hit("a", t + 1000).remaining).toBe(1);
    expect(limiter.hit("a", t + 2000).remaining).toBe(0);
    // The fourth within the minute is rejected, and says how long until another fits.
    expect(limiter.hit("a", t + 3000)).toEqual({ remaining: -1, resetS: 57 });
    // Another key keeps its own count.
    expect(limiter.hit("b", t + 3000).remaining).toBe(2);
    // Once the first one's minute has passed, one fits again.
    expect(limiter.hit("a", t + 60_500).remaining).toBe(0);
  });
});

describe("module I: webhooks", () => {
  it("does not send to internal addresses when not allowed", async () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.1.220", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(isInternalAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) expect(isInternalAddress(ip), ip).toBe(false);
    await expect(postJson(hookUrl, "{}", {}, { allowInternal: false })).rejects.toThrow(OutboundError);
    await expect(postJson("http://localhost:1/x", "{}", {}, { allowInternal: false })).rejects.toThrow(/interna/);
    await expect(postJson("ftp://ejemplo.test/x", "{}", {}, { allowInternal: true })).rejects.toThrow(/https/);
    // Allowed, it arrives.
    received.length = 0;
    expect(await postJson(hookUrl, '{"id":0,"type":"x","label":"x","event":null}', {}, { allowInternal: true })).toBe(200);
    expect(received).toHaveLength(1);
  });

  it("notifies the other system of each event, signed, and records it in the log", async () => {
    const car = await addVehicle(ana, "Camión refrigerado");
    const { sensor, push } = await addSensor(ana, car);
    expect((await h.request("POST", "/api/integrations/webhooks", { ...as(ana), body: { name: "Mal", url: "ftp://ejemplo.test" } })).status).toBe(400);
    const made = await h.request("POST", "/api/integrations/webhooks", { ...as(ana), body: { name: "ERP: alertas", url: hookUrl, headers: [{ name: "X-Api-Key", value: "clave-del-erp" }] } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const { webhooks, secret } = made.json as { webhooks: Webhook[]; secret: string };
    const hook = webhooks[0] as Webhook;
    expect(secret).toMatch(/^whsec_/);
    // Of the custom headers, the name is shown, never the value.
    expect(hook).toMatchObject({ name: "ERP: alertas", url: hookUrl, events: null, active: true, headerNames: ["X-Api-Key"], last: null });
    expect(JSON.stringify(webhooks)).not.toContain("clave-del-erp");
    // Another one that is only interested in speeding.
    await h.request("POST", "/api/integrations/webhooks", { ...as(ana), body: { name: "Solo velocidad", url: `${hookUrl}/velocidad`, events: ["speeding"] } });

    // The probe exceeds its maximum: the alert is raised and, with it, the notification.
    received.length = 0;
    answer = 200;
    expect((await push({ value: 4.5 })).statusCode).toBe(201);
    expect(received).toEqual([]);
    expect((await push({ value: 12.3 })).json()).toEqual({ stored: 1 });
    expect((await eventsOf(ana, car)).map((e) => [e.type, e.detail.subject, e.detail.reason])).toEqual([["sensor_alert", "Sonda de la caja fría", "12,3 °C; el máximo es 8 °C"]]);
    expect(received).toHaveLength(1);
    const got = received[0] as Received;
    expect(got.headers["x-opengps-event"]).toBe("sensor_alert");
    expect(got.headers["x-api-key"]).toBe("clave-del-erp");
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.json).toMatchObject({ type: "sensor_alert", label: "Sensor fuera de rango", event: { vehicleName: "Camión refrigerado", summary: "Sonda de la caja fría: 12,3 °C; el máximo es 8 °C" } });
    // The signature is checked with the secret: it is the digest of "timestamp.body".
    const [, t, v1] = String(got.headers["x-opengps-signature"]).match(/^t=(\d+),v1=([0-9a-f]{64})$/) as RegExpMatchArray;
    expect(t).toBe(got.headers["x-opengps-timestamp"]);
    expect(v1).toBe(createHmac("sha256", secret).update(`${t}.${got.body}`).digest("hex"));
    expect(v1).not.toBe(createHmac("sha256", "otro-secreto").update(`${t}.${got.body}`).digest("hex"));

    let log = (await h.request("GET", `/api/integrations/webhooks/${hook.id}/deliveries`, as(ana))).json.deliveries as WebhookDelivery[];
    expect(log).toMatchObject([{ topic: "sensor_alert", status: "ok", attempts: 1, code: 200, error: null, nextAt: null }]);
    expect(String(got.headers["x-opengps-delivery"])).toBe(String(log[0]?.id));
    expect(((await h.request("GET", "/api/integrations/webhooks", as(ana))).json.webhooks as Webhook[])[0]?.last).toMatchObject({ status: "ok", code: 200 });

    // A test notification, to check the connection without waiting for something to happen.
    const test = await h.request("POST", `/api/integrations/webhooks/${hook.id}/test`, as(ana));
    expect((test.json.deliveries as WebhookDelivery[])[0]).toMatchObject({ topic: "test", status: "ok" });
    expect(received.at(-1)?.json).toMatchObject({ type: "test", event: null });
    // With a new secret, the signature changes.
    const rotated = (await h.request("POST", `/api/integrations/webhooks/${hook.id}/secret`, as(ana))).json.secret as string;
    expect(rotated).not.toBe(secret);
    await h.request("POST", `/api/integrations/webhooks/${hook.id}/test`, as(ana));
    const last = received.at(-1) as Received;
    const [, t2, v2] = String(last.headers["x-opengps-signature"]).match(/^t=(\d+),v1=([0-9a-f]{64})$/) as RegExpMatchArray;
    expect(v2).toBe(createHmac("sha256", rotated).update(`${t2}.${last.body}`).digest("hex"));
    // Another account does not touch it.
    expect((await h.request("GET", `/api/integrations/webhooks/${hook.id}/deliveries`, as(bea))).status).toBe(404);
    expect((await h.request("DELETE", `/api/integrations/webhooks/${hook.id}`, as(bea))).status).toBe(404);
    expect(sensor.vehicleName).toBe("Camión refrigerado");
  });

  it("what is not delivered is retried at increasing intervals, until it is given up as lost", async () => {
    const car = await addVehicle(ana, "Camión con mala señal");
    const { push } = await addSensor(ana, car, { name: "Sonda de reintentos" });
    const hook = ((await h.request("GET", "/api/integrations/webhooks", as(ana))).json.webhooks as Webhook[])[0] as Webhook;
    const logOf = async () => ((await h.request("GET", `/api/integrations/webhooks/${hook.id}/deliveries`, as(ana))).json.deliveries as WebhookDelivery[])[0] as WebhookDelivery;
    received.length = 0;
    answer = 500;
    const t0 = Date.now();
    await push({ value: 30 });
    expect(received).toHaveLength(1);
    let d = await logOf();
    expect(d).toMatchObject({ status: "pending", attempts: 1, code: 500, error: "Respondió 500" });
    expect(Date.parse(d.nextAt as string) - t0).toBeGreaterThan(50_000);
    // Before time, it does not insist.
    await h.integrations.deliver(t0 + 20_000);
    expect(received).toHaveLength(1);
    // After a minute, the second attempt; the third, five minutes later.
    await h.integrations.deliver(t0 + 70_000);
    expect(received).toHaveLength(2);
    d = await logOf();
    expect(d).toMatchObject({ status: "pending", attempts: 2 });
    expect(Date.parse(d.nextAt as string) - (t0 + 70_000)).toBe(5 * MIN);
    // The other system recovers: the third attempt delivers it.
    answer = 200;
    await h.integrations.deliver(t0 + 7 * MIN);
    expect(await logOf()).toMatchObject({ status: "ok", attempts: 3, code: 200, error: null, nextAt: null });
    expect(received.map((r) => r.json.id)).toEqual([d.id, d.id, d.id]);

    // If it never answers properly, after six attempts it is given up as lost.
    answer = 503;
    await h.request("POST", `/api/integrations/webhooks/${hook.id}/test`, as(ana));
    let at = Date.now();
    for (const wait of [1, 5, 30, 120, 360]) await h.integrations.deliver((at += (wait + 1) * MIN));
    expect(await logOf()).toMatchObject({ topic: "test", status: "failed", attempts: 6, code: 503, nextAt: null });
    expect(((await h.request("GET", "/api/integrations/webhooks", as(ana))).json.webhooks as Webhook[])[0]?.last).toMatchObject({ status: "failed", code: 503 });
    answer = 200;
    // A disabled webhook receives nothing.
    const off = await h.request("PUT", `/api/integrations/webhooks/${hook.id}`, { ...as(ana), body: { name: hook.name, url: hook.url, active: false } });
    expect((off.json.webhooks as Webhook[])[0]).toMatchObject({ active: false, headerNames: ["X-Api-Key"] });
    received.length = 0;
    await push({ value: 2 });
    await push({ value: 40 });
    expect(received).toEqual([]);
    await h.request("PUT", `/api/integrations/webhooks/${hook.id}`, { ...as(ana), body: { name: hook.name, url: hook.url, active: true } });
  });
});

describe("module I: automations", () => {
  it("when something happens to its vehicles, notifies some addresses through a channel, notifies a webhook or opens a work order", async () => {
    const car = await addVehicle(ana, "Camión de vacunas");
    const other = await addVehicle(ana, "Camión de ladrillos");
    const cold = await addSensor(ana, car, { name: "Sonda de vacunas" });
    const bricks = await addSensor(ana, other, { name: "Sonda de ladrillos" });
    const hook = ((await h.request("GET", "/api/integrations/webhooks", as(ana))).json.webhooks as Webhook[]).find((w) => w.name === "Solo velocidad") as Webhook;
    const base = { triggers: ["sensor_alert"], vehicleIds: [car.id] };
    const make = (body: Record<string, unknown>) => h.request("POST", "/api/integrations/automations", { ...as(ana), body: { ...base, ...body } });
    expect((await make({ name: "Sin disparador", triggers: [], action: { type: "notify", channel: "email", to: ["jefe@empresa.test"] } })).status).toBe(400);
    expect((await make({ name: "Correo malo", action: { type: "notify", channel: "email", to: ["no-es-correo"] } })).status).toBe(400);
    expect((await make({ name: "Sin destino", action: { type: "notify", channel: "email", to: [] } })).status).toBe(400);
    // The custom channel is off until the owner sets it up.
    expect((await make({ name: "Personalizado apagado", action: { type: "notify", channel: "webhook", to: [] } })).status).toBe(400);
    // The address has to fit the channel, and the channel has to be one the platform has connected.
    expect((await make({ name: "Teléfono malo", action: { type: "notify", channel: "sms", to: ["99887766"] } })).status).toBe(400);
    expect((await make({ name: "Canal apagado", action: { type: "notify", channel: "sms", to: ["+50499887766"] } })).status).toBe(400);
    expect((await make({ name: "Webhook ajeno", action: { type: "webhook", webhookId: "01a20100-e157-7b84-b90a-7bc47908ba04" } })).status).toBe(400);
    const mail = await make({ name: "Cadena de frío", cooldownMin: 30, action: { type: "notify", channel: "email", to: ["calidad@empresa.test", "jefe@empresa.test"] } });
    expect(mail.status, JSON.stringify(mail.json)).toBe(201);
    await make({ name: "Avisar al ERP", action: { type: "webhook", webhookId: hook.id } });
    const all = (await make({ name: "Revisar el equipo de frío", action: { type: "order", title: "Revisar el equipo de frío" } })).json.automations as Automation[];
    expect(all.map((a) => [a.name, a.action.type, a.runs])).toEqual([
      ["Cadena de frío", "notify", 0],
      ["Avisar al ERP", "webhook", 0],
      ["Revisar el equipo de frío", "order", 0],
    ]);

    h.mails.length = 0;
    received.length = 0;
    await cold.push({ value: 14 });
    // The email, to both addresses.
    expect(h.mails.map((m) => [m.to, m.subject])).toEqual([
      ["calidad@empresa.test", "Camión de vacunas: sensor fuera de rango"],
      ["jefe@empresa.test", "Camión de vacunas: sensor fuera de rango"],
    ]);
    expect(h.mails[0]?.body).toContain("Sonda de vacunas: 14 °C; el máximo es 8 °C");
    expect(h.mails[0]?.body).toContain("«Cadena de frío»");
    // The notification to the other system, even though that webhook was subscribed only to speed.
    const toErp = received.filter((r) => r.json.automation === "Avisar al ERP");
    expect(toErp).toHaveLength(1);
    expect(toErp[0]?.json).toMatchObject({ type: "sensor_alert", event: { vehicleName: "Camión de vacunas" } });
    // The work order, corrective and open.
    const orders = (await h.request("GET", `/api/maintenance/orders?vehicleId=${car.id}`, as(ana))).json.orders as MaintOrder[];
    expect(orders).toMatchObject([{ kind: "corrective", status: "open", title: "Revisar el equipo de frío", vehicleName: "Camión de vacunas" }]);
    expect(orders[0]?.description).toContain("Sonda de vacunas: 14 °C");

    // What each one did is recorded.
    const after = (await h.request("GET", "/api/integrations/automations", as(ana))).json.automations as Automation[];
    expect(after.map((a) => a.runs)).toEqual([1, 1, 1]);
    const runsOf = async (name: string) => (await h.request("GET", `/api/integrations/automations/${after.find((a) => a.name === name)?.id}/runs`, as(ana))).json.runs as AutomationRun[];
    expect(await runsOf("Cadena de frío")).toMatchObject([{ vehicleName: "Camión de vacunas", eventType: "sensor_alert", ok: true, detail: "Aviso por Correo a 2 destinos" }]);
    expect(await runsOf("Avisar al ERP")).toMatchObject([{ ok: true, detail: "Aviso a «Solo velocidad»" }]);
    expect((await runsOf("Revisar el equipo de frío"))[0]?.detail).toMatch(/^Orden de trabajo n\.º \d+$/);

    // The other truck does not belong to these automations.
    h.mails.length = 0;
    await bricks.push({ value: 50 });
    expect(h.mails).toEqual([]);
    // It returns to its range and leaves again: the email one waits half an hour and does not repeat; the others do.
    await cold.push({ value: 5 });
    await cold.push({ value: 15 });
    expect(h.mails).toEqual([]);
    expect((await h.request("GET", `/api/maintenance/orders?vehicleId=${car.id}`, as(ana))).json.orders).toHaveLength(2);

    // Disabled, it does not act; deleted, it disappears.
    const coldCheck = after.find((a) => a.name === "Revisar el equipo de frío") as Automation;
    await h.request("PUT", `/api/integrations/automations/${coldCheck.id}`, { ...as(ana), body: { ...base, name: coldCheck.name, active: false, action: coldCheck.action } });
    await cold.push({ value: 5 });
    await cold.push({ value: 16 });
    expect((await h.request("GET", `/api/maintenance/orders?vehicleId=${car.id}`, as(ana))).json.orders).toHaveLength(2);
    expect((await h.request("DELETE", `/api/integrations/automations/${coldCheck.id}`, as(bea))).status).toBe(404);
    expect((await h.request("DELETE", `/api/integrations/automations/${coldCheck.id}`, as(ana))).status).toBe(204);
    // Without the maintenance module, it cannot be asked to open work orders.
    const beaCar = await addVehicle(bea, "Camión de Bea");
    expect((await h.request("POST", "/api/integrations/automations", { ...as(bea), body: { name: "Orden", triggers: ["sensor_alert"], vehicleIds: [beaCar.id], action: { type: "order", title: null } } })).status).toBe(400);
    // Nor to target vehicles of another account.
    expect((await h.request("POST", "/api/integrations/automations", { ...as(bea), body: { name: "Ajeno", triggers: ["sensor_alert"], vehicleIds: [car.id], action: { type: "notify", channel: "email", to: ["x@empresa.test"] } } })).status).toBe(400);
  });

  it("only acts on the days and hours it is given", async () => {
    const car = await addVehicle(ana, "Camión de noche");
    const probe = await addSensor(ana, car, { name: "Sonda de noche" });
    // A schedule that only applies at an hour we are not in: the opposite of the current one.
    const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const from = (minute + 600) % 1440;
    const closed = { zone: "UTC", days: Array.from({ length: 7 }, () => [from, Math.min(1440, from + 60)]) };
    const made = await h.request("POST", "/api/integrations/automations", { ...as(ana), body: { name: "Solo a otra hora", triggers: ["sensor_alert"], vehicleIds: [car.id], schedule: closed, action: { type: "notify", channel: "email", to: ["noche@empresa.test"] } } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    h.mails.length = 0;
    await probe.push({ value: 20 });
    expect(h.mails.filter((m) => m.to === "noche@empresa.test")).toEqual([]);
    // With the schedule open all day, it does.
    const auto = (made.json.automations as Automation[]).find((a) => a.name === "Solo a otra hora") as Automation;
    const open = { zone: "UTC", days: Array.from({ length: 7 }, () => [0, 1440]) };
    await h.request("PUT", `/api/integrations/automations/${auto.id}`, { ...as(ana), body: { name: auto.name, triggers: auto.triggers, vehicleIds: [car.id], schedule: open, action: auto.action } });
    await probe.push({ value: 5 });
    await probe.push({ value: 21 });
    expect(h.mails.filter((m) => m.to === "noche@empresa.test")).toHaveLength(1);
  });
});

describe("module I: sensors", () => {
  it("stores the readings each sensor sends with its key, and alerts when it leaves its range", async () => {
    const car = await addVehicle(ana, "Camión de helados");
    const { sensor, secret, push } = await addSensor(ana, car, { name: "Sonda del congelador", minValue: -25, maxValue: -15 });
    expect(secret).toMatch(/^sns_/);
    expect(sensor).toMatchObject({ name: "Sonda del congelador", kind: "temperature", unit: "°C", vehicleId: car.id, vehicleName: "Camión de helados", minValue: -25, maxValue: -15, lastValue: null, alerting: false });
    expect((await h.request("POST", "/api/integrations/sensors", { ...as(ana), body: { name: "Rango al revés", minValue: 5, maxValue: 1 } })).status).toBe(400);

    // One reading, and a batch of late readings with their time.
    const t0 = Date.now() - 30 * MIN;
    expect((await push({ value: -18.2 })).json()).toEqual({ stored: 1 });
    const batch = [0, 1, 2, 3].map((i) => ({ value: -20 + i, at: new Date(t0 + i * MIN).toISOString() }));
    expect((await push(batch)).json()).toEqual({ stored: 4 });
    // What is repeated is not stored twice.
    expect((await push(batch)).json()).toEqual({ stored: 0 });
    // The latest is still the most recent reading, not the last to arrive.
    const sensorsOf = async () => ((await h.request("GET", "/api/integrations/sensors", as(ana))).json.sensors as Sensor[]).find((s) => s.id === sensor.id) as Sensor;
    expect(await sensorsOf()).toMatchObject({ lastValue: -18.2, alerting: false });
    expect(await eventsOf(ana, car)).toEqual([]);

    // It rises above its maximum: one alert. While it stays out, it does not repeat.
    await push({ value: -9.5 });
    await push({ value: -8 });
    expect(await sensorsOf()).toMatchObject({ lastValue: -8, alerting: true });
    expect((await eventsOf(ana, car)).map((e) => e.detail.reason)).toEqual(["-9,5 °C; el máximo es -15 °C"]);
    // It returns to its range and then drops below its minimum: another alert.
    await push({ value: -20 });
    expect((await sensorsOf()).alerting).toBe(false);
    await push({ value: -31 });
    expect((await eventsOf(ana, car)).map((e) => e.detail.reason)).toEqual(["-9,5 °C; el máximo es -15 °C", "-31 °C; el mínimo es -25 °C"]);

    const range = `from=${new Date(t0 - MIN).toISOString()}&to=${new Date(Date.now() + MIN).toISOString()}`;
    const series = (await h.request("GET", `/api/integrations/sensors/${sensor.id}/readings?${range}`, as(ana))).json.series as SensorSeries;
    expect(series.points).toHaveLength(9);
    expect(series.points.slice(0, 4).map((p) => p[1])).toEqual([-20, -19, -18, -17]);
    expect(series.points.at(-1)?.[1]).toBe(-31);

    // What does not fit is rejected; with another key, or none, nothing gets in.
    expect((await push({ value: "caliente" })).statusCode).toBe(400);
    expect((await push({ value: 1 }, "sns_inventada")).statusCode).toBe(401);
    expect((await api("POST", "/api/v1/sensors/readings", undefined, { value: 1 })).statusCode).toBe(401);
    // With a new key, the previous one stops working.
    const fresh = (await h.request("POST", `/api/integrations/sensors/${sensor.id}/key`, as(ana))).json.secret as string;
    expect((await push({ value: -19 })).statusCode).toBe(401);
    expect((await push({ value: -19 }, fresh)).statusCode).toBe(201);
    // Another account does not see or touch it.
    expect((await h.request("GET", `/api/integrations/sensors/${sensor.id}/readings?${range}`, as(bea))).status).toBe(404);
    expect(((await h.request("GET", "/api/integrations/sensors", as(bea))).json.sensors as Sensor[]).some((s) => s.id === sensor.id)).toBe(false);
    expect((await h.request("DELETE", `/api/integrations/sensors/${sensor.id}`, as(bea))).status).toBe(404);
    expect((await h.request("DELETE", `/api/integrations/sensors/${sensor.id}`, as(ana))).status).toBe(204);
    expect((await push({ value: -19 }, fresh)).statusCode).toBe(401);
  });

  it("a sensor that is on no vehicle stores its readings without raising alerts", async () => {
    const { sensor, push } = await addSensor(bea, null, { name: "Sonda de la bodega", maxValue: 30 });
    expect(sensor).toMatchObject({ vehicleId: null, vehicleName: null });
    expect((await push({ value: 45 })).json()).toEqual({ stored: 1 });
    expect(((await h.request("GET", "/api/integrations/sensors", as(bea))).json.sensors as Sensor[]).find((s) => s.id === sensor.id)).toMatchObject({ lastValue: 45, alerting: true });
  });
});

describe("module I: import and export", () => {
  const file = (user: TestUser, kind: string, format: string) => h.fastify.inject({ method: "GET", url: `/api/integrations/export/${kind}?format=${format}`, headers: { cookie: user.cookie } });
  const load = async (user: TestUser, kind: string, csv: string) => {
    const res = await h.request("POST", `/api/integrations/import/${kind}`, { ...as(user), body: { csv } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.result as ImportResult;
  };

  it("loads vehicles, drivers and geofences from a spreadsheet, and says which row failed", async () => {
    const carol = await h.signUp("Carol Importa");
    await h.enableModules(carol.orgId, ["I", "B"]);
    const [a, b] = [h.uniqueId(), h.uniqueId()];
    const vehicles = await load(carol, "vehicles", `Nombre;Placa;IMEI;Modelo;Grupo\nCamión 1;haa-1001;${a};h02;Zona norte\nCamión 2;;${b};Teltonika;Zona norte\nCamión 3;;${h.uniqueId()};marca inventada;\n;;${h.uniqueId()};h02;\nCamión 1 otra vez;;${a};h02;\n`);
    expect(vehicles).toMatchObject({ created: 2, skipped: 1 });
    expect(vehicles.errors).toEqual([
      { row: 4, message: "No reconocemos el modelo «marca inventada»" },
      { row: 5, message: "Escribe un nombre" },
    ]);
    const list = (await h.request("GET", "/api/vehicles", as(carol))).json.vehicles as { name: string; plate: string | null; groupId: string | null; device: { modelId: string } }[];
    expect(list.map((v) => [v.name, v.plate, v.device.modelId])).toEqual([
      ["Camión 1", "HAA-1001", "h02"],
      ["Camión 2", null, "teltonika"],
    ]);
    // The group that did not exist was created, once, and both ended up in it.
    const groups = (await h.request("GET", "/api/groups", as(carol))).json.groups as { id: string; name: string; vehicleCount: number }[];
    expect(groups).toMatchObject([{ name: "Zona norte", vehicleCount: 2 }]);
    expect(list.every((v) => v.groupId === groups[0]?.id)).toBe(true);

    const drivers = await load(carol, "drivers", "nombre,licencia,teléfono,llave\nCarlos Mejía,0801-1988-04512,9988-1020,1F00BC55\nRosa Díaz,,,\nCarlos Mejía,,,\nSin llave válida,,,ZZZ\n");
    expect(drivers).toMatchObject({ created: 2, skipped: 1 });
    expect(drivers.errors).toHaveLength(1);
    expect(drivers.errors[0]?.row).toBe(5);

    const fences = await load(carol, "geofences", `nombre,tipo,latitud,longitud,radio,puntos\nBodega central,Zona prohibida,14.08,-87.2,150,\nPatio,,,,,"14.08 -87.20; 14.09 -87.20; 14.09 -87.19; 14.08 -87.19"\nSin lugar,,,,,\nBodega central,,14.08,-87.2,150,\n`);
    expect(fences).toMatchObject({ created: 2, skipped: 1 });
    expect(fences.errors).toEqual([{ row: 4, message: "Un círculo lleva latitud, longitud y radio; un polígono, sus puntos" }]);

    // And exports them, as CSV and as Excel.
    const csv = await file(carol, "vehicles", "csv");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="vehiculos.csv"');
    const lines = csv.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Nombre,Placa,IMEI,Modelo,Grupo,Agregado");
    // The model name contains a comma: it goes in quotes, as the format requires.
    expect(lines[1]).toMatch(new RegExp(`^Camión 1,HAA-1001,${a},".+ H02",Zona norte,\\d{4}-\\d{2}-\\d{2}$`));
    expect(lines).toHaveLength(3);
    const xlsx = await file(carol, "drivers", "xlsx");
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe("PK");
    const out = (await file(carol, "geofences", "csv")).body;
    expect(out).toContain("Bodega central,Círculo,Zona prohibida,14.08,-87.2,150,,");
    expect(out).toContain('Patio,Polígono,');
    // What was exported can be loaded again: everything already exists.
    expect(await load(carol, "geofences", out)).toMatchObject({ created: 0, skipped: 2, errors: [] });

    // What belongs to a module the account does not have does not exist; neither does anything else.
    expect((await file(bea, "drivers", "csv")).statusCode).toBe(404);
    expect((await file(carol, "motores", "csv")).statusCode).toBe(404);
    expect((await h.request("POST", "/api/integrations/import/vehicles", { ...as(carol), body: { csv: "Nombre;IMEI;Modelo\n" } })).status).toBe(400);
    expect(ORIGIN).toContain("http");
  });
});
