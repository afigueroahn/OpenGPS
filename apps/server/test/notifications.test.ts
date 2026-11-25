// Notifications by channel: the channels the platform owner connects (the
// custom one with its address, headers and body, with variables), the
// notifications of an account over each of them, the log with its retries and
// caps, and the platform's own notifications.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AccountNotification, Delivery, NotificationOptions, SystemNotification } from "@opengps/shared";
import { customRequest } from "../src/core/channels";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Harness, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser; // owner of the account
let boss: TestUser; // administers the platform
let otherAccount: TestUser; // another account

const as = (user: TestUser) => ({ cookie: user.cookie });
const admin = (method: string, url: string, body?: unknown) => h.request(method, url, body === undefined ? as(boss) : { ...as(boss), body });
const KNOTS = 1 / 1.852;

/** What the simulated services received. */
interface Call {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: Record<string, any> | null;
  form: URLSearchParams;
}
const calls: Call[] = [];
/** What the account's own address answers with: to test retries. */
let hookAnswer = 200;
let services: http.Server;
let base = "";
const to = (path: string) => calls.filter((c) => c.path.startsWith(path));

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Avisos");
  boss = await h.signUp("Jefa de Plataforma");
  otherAccount = await h.signUp("Otra Cuenta");
  await h.makeOwner(boss);

  // One local server plays Twilio and the account's own system.
  services = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const path = request.url ?? "";
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(body);
      } catch {
        // A form, not JSON.
      }
      calls.push({ method: request.method ?? "", path, headers: request.headers, body, json, form: new URLSearchParams(body) });
      const reply = (code: number, answer: unknown) => {
        response.statusCode = code;
        response.setHeader("content-type", "application/json");
        response.end(answer === null ? "" : JSON.stringify(answer));
      };
      if (path.startsWith("/twilio/")) {
        return request.headers.authorization === `Basic ${Buffer.from("AC123:clave-de-twilio").toString("base64")}` ? reply(201, { sid: "SM1" }) : reply(401, { message: "Authenticate" });
      }
      return reply(hookAnswer, { received: true });
    });
  });
  await new Promise<void>((done) => services.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(services.address() as AddressInfo).port}`;
  h.config.providers.twilio = `${base}/twilio`;
});
afterAll(async () => {
  await new Promise((done) => services?.close(done));
  await h?.close();
});
beforeEach(() => {
  calls.length = 0;
  h.mails.length = 0;
  hookAnswer = 200;
});

let clock = 0;
const T0 = Date.now() - 6 * 3_600_000;
async function addVehicle(user: TestUser, name: string) {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId: "h02" } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { id: res.json.vehicle.id as string, deviceId: h.traccar.devices.get(uniqueId) as number };
}
/** The vehicle speeds once: with a speed alert, that is one event that calls for attention. */
async function speed(vehicle: { deviceId: number }) {
  const rows = [0, 95, 0].map((kmh) => traccarRow(vehicle.deviceId, { fix: new Date(T0 + (clock += 10_000)), knots: kmh * KNOTS }));
  await h.ingestFrom(rows).tick();
  await h.settle();
}
async function join(name: string, role: string, groups: string[] | null = null, vehicles: string[] = []): Promise<TestUser> {
  const person = await h.signUp(name);
  const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role, groups, vehicles } });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);
  expect((await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person))).status).toBe(204);
  return person;
}
const channelsOf = async () => (await admin("GET", "/api/admin/settings")).json.settings.channels as Record<string, any>;
const saveChannels = async (patch: Record<string, unknown>) => admin("PUT", "/api/admin/settings/channels", { ...(await channelsOf()), ...patch });
async function notify(user: TestUser, body: Record<string, unknown>) {
  const res = await h.request("POST", "/api/notifications", { ...as(user), body });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return (res.json.notifications as AccountNotification[]).find((n) => n.name === body.name) as AccountNotification;
}
/** The custom channel as the owner sets it up for these tests: one message per person, with their phone, email and name. */
const ERP = () => ({
  enabled: true,
  method: "POST",
  url: `${base}/erp/avisos?tipo={{type}}&mensaje={{ message }}&a={{phone}}`,
  headers: [
    { name: "Authorization", value: "Bearer clave-del-erp" },
    { name: "X-Destino", value: "{{email}}" },
  ],
  body: '{"texto": "{{message}}", "para": "{{name}}", "vehiculo": "{{vehicle}}"}',
});
const query = (call: Call | undefined) => new URL(call?.path ?? "/", base).searchParams;
const logOf = async (user: TestUser) => (await h.request("GET", "/api/notifications/deliveries", as(user))).json.deliveries as Delivery[];
const optionsOf = async (user: TestUser) => (await h.request("GET", "/api/notifications", as(user))).json.options as NotificationOptions;

describe("channels of the platform", () => {
  it("only the platform owner connects them; keys go in and never come back", async () => {
    expect((await h.request("GET", "/api/admin/settings", as(ana))).status).toBe(404);
    expect((await h.request("PUT", "/api/admin/settings/channels", { ...as(ana), body: {} })).status).toBe(404);
    const start = await channelsOf();
    expect(start).toEqual({
      email: { enabled: true },
      sms: { enabled: false, accountSid: "", hasToken: false, from: "", monthlyCap: 500 },
      webhook: { enabled: false, method: "POST", url: "", headerNames: [], body: "" },
      push: { enabled: true },
    });

    // Turning Twilio on needs its data.
    expect((await saveChannels({ sms: { ...start.sms, enabled: true, accountSid: "AC123" } })).status).toBe(400);
    const saved = await saveChannels({ sms: { enabled: true, accountSid: "AC123", token: "clave-de-twilio", from: "+15005550006", monthlyCap: null } });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.settings.channels.sms).toEqual({ enabled: true, accountSid: "AC123", hasToken: true, from: "+15005550006", monthlyCap: null });
    expect(JSON.stringify(saved.json)).not.toContain("clave-de-");
    // Saving again without the key keeps it.
    expect((await saveChannels({ push: { enabled: true } })).json.settings.channels.sms.hasToken).toBe(true);
    // In the database the key is not readable.
    const stored = await h.db.core.query<{ value: unknown }>(`SELECT value FROM gps.platform_settings WHERE section = 'channels'`);
    expect(JSON.stringify(stored.rows[0]?.value)).not.toContain("clave-de-");
    // Channels that are no longer the platform's are not accepted.
    expect((await saveChannels({ whatsapp: { enabled: true } })).json.settings.channels).not.toHaveProperty("whatsapp");
  });

  it("the custom channel is written once, with variables; its keys go in and never come back", async () => {
    // Turning it on needs the address it sends to; the variables must exist and cannot choose the server.
    expect((await saveChannels({ webhook: { ...ERP(), url: "" } })).status).toBe(400);
    expect((await saveChannels({ webhook: { ...ERP(), url: `${base}/erp?x={{color}}` } })).json.error.message).toBe("La variable {{color}} no existe");
    expect((await saveChannels({ webhook: { ...ERP(), url: "https://{{name}}.empresa.test/avisos" } })).status).toBe(400);
    expect((await saveChannels({ webhook: { ...ERP(), body: "{{ nada }}" } })).status).toBe(400);
    expect((await saveChannels({ webhook: { ...ERP(), headers: [{ name: "X-Mal", value: "{{otra}}" }] } })).status).toBe(400);
    const saved = await saveChannels({ webhook: ERP() });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.settings.channels.webhook).toEqual({ enabled: true, method: "POST", url: ERP().url, body: ERP().body, headerNames: ["Authorization", "X-Destino"] });
    expect(JSON.stringify(saved.json)).not.toContain("clave-del-erp");
    // Saving it again without the headers keeps them.
    const { headers: _headers, ...withoutHeaders } = ERP();
    expect((await saveChannels({ webhook: withoutHeaders })).json.settings.channels.webhook.headerNames).toEqual(["Authorization", "X-Destino"]);
    // In the database neither the address nor the keys are readable.
    const stored = await h.db.core.query<{ value: unknown }>(`SELECT value FROM gps.platform_settings WHERE section = 'channels'`);
    expect(JSON.stringify(stored.rows[0]?.value)).not.toMatch(/clave-del-erp|erp\/avisos/);
  });

  it("each channel can be tried with a test message, and says why when it does not go out", async () => {
    expect((await h.request("POST", "/api/admin/channels/sms/test", { ...as(ana), body: { to: "+50499887766" } })).status).toBe(404);
    expect((await admin("POST", "/api/admin/channels/humo/test", { to: "x" })).status).toBe(404);
    expect((await admin("POST", "/api/admin/channels/telegram/test", { to: "-100500" })).status).toBe(404);
    expect((await admin("POST", "/api/admin/channels/sms/test", { to: "99887766" })).status).toBe(400);

    const sms = await admin("POST", "/api/admin/channels/sms/test", { to: "+50499887766" });
    expect(sms.status, JSON.stringify(sms.json)).toBe(200);
    expect(sms.json.sentTo).toBe("+504…766");
    const text = to("/twilio/2010-04-01/Accounts/AC123/Messages.json")[0];
    expect(text?.form.get("To")).toBe("+50499887766");
    expect(text?.form.get("From")).toBe("+15005550006");
    expect(text?.form.get("Body")).toContain("Mensaje de prueba");

    expect((await admin("POST", "/api/admin/channels/email/test", { to: "pruebas@empresa.test" })).status).toBe(200);
    expect(h.mails.map((m) => m.to)).toEqual(["pruebas@empresa.test"]);
    // The custom channel's test fills its variables with what is written: here, a phone.
    expect((await admin("POST", "/api/admin/channels/webhook/test", { to: "no-es-destino" })).status).toBe(400);
    const custom = await admin("POST", "/api/admin/channels/webhook/test", { to: "+50499887766" });
    expect(custom.status, JSON.stringify(custom.json)).toBe(200);
    expect(custom.json.sentTo).toBe("+504…766");
    const call = to("/erp/avisos")[0];
    expect(call?.method).toBe("POST");
    expect(query(call).get("tipo")).toBe("test");
    expect(query(call).get("a")).toBe("+50499887766");
    expect(query(call).get("mensaje")).toContain("Mensaje de prueba");
    expect(call?.headers).toMatchObject({ authorization: "Bearer clave-del-erp", "x-destino": "", "content-type": "application/json" });
    expect(call?.json).toMatchObject({ para: "", vehiculo: "" });
    expect(call?.json?.texto).toContain("Mensaje de prueba");
    // Without anything written, its variables of the person stay empty.
    expect((await admin("POST", "/api/admin/channels/webhook/test", {})).json.sentTo).toBe(new URL(base).host);
    // Push has nowhere to go until the mobile app exists.
    const push = await admin("POST", "/api/admin/channels/push/test", { to: "x" });
    expect(push.status).toBe(400);
    expect(push.json.error.message).toContain("app móvil");

    // The service's reason reaches the console: a key Twilio no longer accepts.
    await saveChannels({ sms: { ...(await channelsOf()).sms, token: "clave-vencida" } });
    const failed = await admin("POST", "/api/admin/channels/sms/test", { to: "+50499887766" });
    expect(failed.status).toBe(400);
    expect(failed.json.error.message).toBe("Authenticate");
    await saveChannels({ sms: { ...(await channelsOf()).sms, token: "clave-de-twilio" } });
    // A channel that is off sends nothing.
    await saveChannels({ webhook: { ...ERP(), enabled: false } });
    expect((await admin("POST", "/api/admin/channels/webhook/test", { to: "+50499887766" })).status).toBe(400);
    await saveChannels({ webhook: ERP() });
  });
});

describe("notifications of an account", () => {
  it("offers the channels the platform has, and says who has a phone", async () => {
    await h.request("PUT", "/api/me/settings", { ...as(ana), body: { phone: "+50499001122" } });
    const options = await optionsOf(ana);
    expect([...options.channels].sort()).toEqual(["email", "push", "sms", "webhook"]);
    expect(options.people.find((p) => p.userId === ana.userId)).toEqual({ userId: ana.userId, name: "Ana Avisos", role: "owner", roleName: "Dueño", hasPhone: true });
    expect((await h.request("GET", "/api/me", as(ana))).json.settings).toEqual({ theme: "system", language: null, phone: "+50499001122" });
    // Twilio turned off is not offered.
    await saveChannels({ sms: { ...(await channelsOf()).sms, enabled: false } });
    expect((await optionsOf(ana)).channels).not.toContain("sms");
    await saveChannels({ sms: { ...(await channelsOf()).sms, enabled: true } });
  });

  it("one event reaches every channel that tells about it, once, and the log says where each message went", async () => {
    const car = await addVehicle(ana, "Camión de avisos");
    const rule = (await h.request("POST", "/api/alerts", { ...as(ana), body: { name: "Límite de la flota", type: "speeding", params: { limitKmh: 80, seconds: 0 } } })).json.alert as { id: string };
    // A reader of the account with a phone, but who only sees another vehicle: nothing about this one reaches them.
    const other = await addVehicle(ana, "Otro camión");
    const reader = await join("Lector de otro camión", "viewer", [], [other.id]);
    await h.request("PUT", "/api/me/settings", { ...as(reader), body: { phone: "+50488776655" } });

    await notify(ana, { name: "Correo a todos", channel: "email", everyone: true, events: ["speeding"], zone: "America/Tegucigalpa" });
    await notify(ana, { name: "SMS al dueño y a lectores", channel: "sms", roles: ["owner", "viewer"], ruleIds: [rule.id] });
    await notify(ana, { name: "SMS a la central", channel: "sms", addresses: ["+50422334455"], events: ["speeding", "sos"] });
    await notify(ana, { name: "Push a todos", channel: "push", everyone: true });
    // The custom channel names people, like the others: each one fills its variables.
    await notify(ana, { name: "Al ERP", channel: "webhook", roles: ["owner"] });
    // These do not cover the event: another type, another vehicle, turned off.
    await notify(ana, { name: "Solo pánico", channel: "sms", addresses: ["+50400000001"], events: ["sos"] });
    await notify(ana, { name: "Solo el otro", channel: "sms", addresses: ["+50400000002"], vehicleIds: [other.id] });
    await notify(ana, { name: "Apagado", channel: "sms", addresses: ["+50400000003"], active: false });

    calls.length = 0;
    h.mails.length = 0;
    await speed(car);
    // Email: to those who see the vehicle.
    expect(h.mails.map((m) => m.to)).toEqual([ana.email]);
    expect(h.mails[0]?.subject).toBe("Camión de avisos: exceso de velocidad");
    expect(h.mails[0]?.body).toContain("iba a 95 km/h con un límite de 80 km/h");
    expect(h.mails[0]?.body).toContain("hora de America/Tegucigalpa");
    expect(h.mails[0]?.body).toContain("Te lo envía el aviso «Correo a todos»");
    // SMS: the owner's phone and the central's, each once; not the reader who does not see the vehicle.
    expect(to("/twilio/").map((c) => c.form.get("To")).sort()).toEqual(["+50422334455", "+50499001122"]);
    expect(to("/twilio/")[0]?.form.get("Body")).toContain("Camión de avisos: exceso de velocidad");
    // The custom channel, with the details of the event and of the person, each written the way its place needs.
    const erp = to("/erp/avisos");
    expect(erp).toHaveLength(1);
    expect(query(erp[0]).get("tipo")).toBe("speeding");
    expect(query(erp[0]).get("a")).toBe("+50499001122");
    expect(query(erp[0]).get("mensaje")).toMatch(/^Camión de avisos: exceso de velocidad\. .*iba a 95 km\/h con un límite de 80 km\/h/);
    expect(erp[0]?.headers).toMatchObject({ authorization: "Bearer clave-del-erp", "x-destino": ana.email });
    expect(erp[0]?.json).toMatchObject({ para: "Ana Avisos", vehiculo: "Camión de avisos" });
    expect(erp[0]?.json?.texto).toContain("Te lo envía el aviso «Al ERP»");

    // The log: one line per message, without what is a secret. Push has nobody to reach yet.
    const log = (await logOf(ana)).filter((d) => d.title === "Camión de avisos: exceso de velocidad");
    expect(log.every((d) => d.status === "ok" && d.attempts === 1 && d.source === "notification")).toBe(true);
    expect(log.map((d) => [d.channel, d.to, d.name]).sort()).toEqual(
      [
        ["email", ana.email, "Correo a todos"],
        ["sms", "+504…122", "SMS al dueño y a lectores"],
        ["sms", "+504…455", "SMS a la central"],
        ["webhook", "Ana Avisos", "Al ERP"],
      ].sort(),
    );
    expect((await h.request("GET", "/api/notifications/deliveries", as(otherAccount))).json.deliveries).toEqual([]);
    // In the database no address or phone is readable.
    const rows = await h.db.core.query(`SELECT o.target, n.addresses FROM gps.outbox o LEFT JOIN gps.notifications n ON n.id = o.source_id WHERE o.org_id = $1`, [ana.orgId]);
    expect(JSON.stringify(rows.rows)).not.toMatch(/50422334455|50499001122/);
    // Each notification says how its latest message went.
    const listed = (await h.request("GET", "/api/notifications", as(ana))).json.notifications as AccountNotification[];
    expect(listed.find((n) => n.name === "Al ERP")).toMatchObject({ roles: ["owner"], addresses: [], last: { status: "ok" } });
    expect(listed.find((n) => n.name === "Solo pánico")?.last).toBeNull();
  });

  it("the custom channel calls once for everyone when it does not use their details, by GET if so set", async () => {
    await saveChannels({ webhook: { enabled: true, method: "GET", url: `${base}/erp/todos?tipo={{type}}&cuando={{time}}`, headers: [], body: "" } });
    expect((await optionsOf(ana)).customPerPerson).toBe(false);
    const all = await notify(ana, { name: "Al ERP, una vez", channel: "webhook", everyone: true });
    const tested = await h.request("POST", `/api/notifications/${all.id}/test`, as(ana));
    expect(tested.status, JSON.stringify(tested.json)).toBe(200);
    expect(to("/erp/todos")).toHaveLength(1);
    expect(to("/erp/todos")[0]).toMatchObject({ method: "GET", body: "" });
    expect(query(to("/erp/todos")[0]).get("tipo")).toBe("test");
    expect((tested.json.deliveries as Delivery[])[0]).toMatchObject({ to: new URL(base).host, status: "ok" });
    expect((await h.request("DELETE", `/api/notifications/${all.id}`, as(ana))).status).toBe(204);
    await saveChannels({ webhook: ERP() });
    expect((await optionsOf(ana)).customPerPerson).toBe(true);
  });

  it("writes each value of the custom channel the way the other system reads it", () => {
    const message = { title: 'Camión "1"', body: "Pasó algo & más", action: null, language: "es" as const, data: { type: "sos", label: "Pánico" } };
    const form = customRequest("OpenGPS", { enabled: true, method: "PUT", url: "https://sms.empresa.test/enviar/{{phone_digits}}", headers: [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }], body: "para={{phone}}&texto={{message}}" }, message, { phone: "+50499887766" });
    expect(form).toMatchObject({ method: "PUT", url: "https://sms.empresa.test/enviar/50499887766", body: `para=%2B50499887766&texto=${encodeURIComponent('Camión "1". Pasó algo & más')}` });
    expect(form.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    const json = customRequest("OpenGPS", { enabled: true, method: "POST", url: "https://erp.empresa.test/a", headers: [], body: '{"t": "{{title}}", "e": "{{event}}"}' }, message, {});
    expect(JSON.parse(json.body)).toEqual({ t: 'Camión "1"', e: "Pánico" });
    // Without a body of its own, every variable goes as JSON.
    const plain = customRequest("OpenGPS", { enabled: true, method: "POST", url: "https://erp.empresa.test/a", headers: [], body: "" }, message, { name: "Ana", email: "ana@empresa.test" });
    expect(JSON.parse(plain.body)).toMatchObject({ type: "sos", event: "Pánico", title: 'Camión "1"', name: "Ana", email: "ana@empresa.test", phone: "", latitude: null, app: "OpenGPS" });
  });

  it("the test button sends to everyone the notification names, now", async () => {
    const listed = (await h.request("GET", "/api/notifications", as(ana))).json.notifications as AccountNotification[];
    const sms = listed.find((n) => n.name === "SMS al dueño y a lectores") as AccountNotification;
    const tested = await h.request("POST", `/api/notifications/${sms.id}/test`, as(ana));
    expect(tested.status, JSON.stringify(tested.json)).toBe(200);
    // Without a vehicle, everyone it names: the owner and the reader.
    expect((tested.json.deliveries as Delivery[]).filter((d) => d.source === "test").map((d) => [d.to, d.status]).sort()).toEqual([
      ["+504…122", "ok"],
      ["+504…655", "ok"],
    ]);
    expect(to("/twilio/")[0]?.form.get("Body")).toContain("Aviso de prueba");
    // Another account's notification does not exist for this one.
    expect((await h.request("POST", `/api/notifications/${sms.id}/test`, as(otherAccount))).status).toBe(404);
    // Push says why nobody receives it yet.
    const push = listed.find((n) => n.name === "Push a todos") as AccountNotification;
    const nobody = await h.request("POST", `/api/notifications/${push.id}/test`, as(ana));
    expect(nobody.status).toBe(400);
    expect(nobody.json.error.message).toContain("app móvil");

    // A test that fails is not retried: its reason comes back right away. It carries the headers too.
    hookAnswer = 500;
    const erp = listed.find((n) => n.name === "Al ERP") as AccountNotification;
    const failed = (await h.request("POST", `/api/notifications/${erp.id}/test`, as(ana))).json.deliveries as Delivery[];
    expect(failed[0]).toMatchObject({ source: "test", status: "failed", attempts: 1, error: "Respondió 500", nextAt: null });
    expect(to("/erp/avisos")[0]?.headers.authorization).toBe("Bearer clave-del-erp");
  });

  it("what does not go out is retried with growing spacing, until attempts run out", async () => {
    const car = await addVehicle(ana, "Camión de reintentos");
    await h.db.core.query(`UPDATE gps.notifications SET active = (name = 'Al ERP') WHERE org_id = $1`, [ana.orgId]);
    hookAnswer = 503;
    await speed(car);
    const mine = async () => (await logOf(ana)).find((d) => d.title === "Camión de reintentos: exceso de velocidad") as Delivery;
    expect(await mine()).toMatchObject({ channel: "webhook", status: "pending", attempts: 1, error: "Respondió 503" });
    const queuedAt = Date.parse((await mine()).at);
    // Before its time nothing is tried; after the first minute, again.
    await h.outbox.deliverDue(queuedAt + 30_000);
    expect((await mine()).attempts).toBe(1);
    await h.outbox.deliverDue(queuedAt + 61_000);
    expect(await mine()).toMatchObject({ status: "pending", attempts: 2 });
    // The other system comes back: the message arrives, with its headers, and is not sent again.
    hookAnswer = 200;
    calls.length = 0;
    await h.outbox.deliverDue(queuedAt + 10 * 60_000);
    expect(await mine()).toMatchObject({ status: "ok", attempts: 3, error: null, nextAt: null });
    await h.outbox.deliverDue(queuedAt + 60 * 60_000);
    expect(to("/erp/avisos")).toHaveLength(1);
    expect(to("/erp/avisos")[0]?.headers.authorization).toBe("Bearer clave-del-erp");

    // One that never arrives ends as failed after its attempts.
    hookAnswer = 500;
    await speed(car);
    let at = Date.now();
    for (const wait of [1, 5, 30, 120, 360]) await h.outbox.deliverDue((at += (wait + 1) * 60_000));
    const last = (await logOf(ana)).filter((d) => d.title === "Camión de reintentos: exceso de velocidad")[0];
    expect(last).toMatchObject({ status: "failed", attempts: 6, error: "Respondió 500" });
  });

  it("Twilio has a monthly cap per account: what goes over it is left in the log, not sent", async () => {
    const car = await addVehicle(ana, "Camión del tope");
    await h.db.core.query(`UPDATE gps.notifications SET active = (name = 'SMS al dueño y a lectores') WHERE org_id = $1`, [ana.orgId]);
    // Four went out this month: two of the event and two of the test.
    await saveChannels({ sms: { ...(await channelsOf()).sms, monthlyCap: 5 } });
    expect((await optionsOf(ana)).usage.find((u) => u.channel === "sms")).toEqual({ channel: "sms", sent: 4, cap: 5 });
    calls.length = 0;
    await speed(car);
    await speed(car);
    await speed(car);
    // One was left of the five of the month.
    expect(to("/twilio/")).toHaveLength(1);
    const mine = (await logOf(ana)).filter((d) => d.title === "Camión del tope: exceso de velocidad");
    expect(mine.map((d) => d.status).sort()).toEqual(["failed", "failed", "ok"]);
    expect(mine.find((d) => d.status === "failed")).toMatchObject({ attempts: 0, error: "La cuenta llegó a su tope mensual de mensajes por este canal" });
    expect((await optionsOf(ana)).usage.find((u) => u.channel === "sms")).toEqual({ channel: "sms", sent: 5, cap: 5 });
    // Without a cap, everything goes out.
    await saveChannels({ sms: { ...(await channelsOf()).sms, monthlyCap: null } });
    await speed(car);
    expect(to("/twilio/")).toHaveLength(2);
    await h.db.core.query(`UPDATE gps.notifications SET active = true WHERE org_id = $1 AND name <> 'Apagado'`, [ana.orgId]);
  });

  it("checks what a notification names, and who may write addresses by hand", async () => {
    const post = (user: TestUser, body: Record<string, unknown>) => h.request("POST", "/api/notifications", { ...as(user), body });
    const ok = { name: "Prueba", channel: "email", everyone: true };
    expect((await post(ana, { ...ok, name: "" })).status).toBe(400);
    expect((await post(ana, { name: "A nadie", channel: "email" })).status).toBe(400);
    expect((await post(ana, { ...ok, channel: "humo" })).status).toBe(400);
    expect((await post(ana, { ...ok, channel: "whatsapp" })).status).toBe(400);
    expect((await post(ana, { ...ok, events: ["geofence_enter"] })).status).toBe(400); // a record, not an alert
    expect((await post(ana, { ...ok, addresses: ["no-es-correo"] })).status).toBe(400);
    expect((await post(ana, { name: "Tel", channel: "sms", addresses: ["99887766"] })).status).toBe(400);
    // The custom channel, like push, only notifies people of the account.
    expect((await post(ana, { name: "W", channel: "webhook", everyone: true, addresses: ["+50499887766"] })).status).toBe(400);
    expect((await post(ana, { name: "P", channel: "push", addresses: ["+50499887766"] })).status).toBe(400);
    expect((await post(ana, { ...ok, roles: ["rol-que-no-existe"], everyone: false })).status).toBe(400);
    expect((await post(ana, { ...ok, userIds: [otherAccount.userId], everyone: false })).status).toBe(400);
    expect((await post(ana, { ...ok, ruleIds: ["01a20100-e157-7b84-b90a-7bc47908ba04"] })).status).toBe(400);
    expect((await post(ana, { ...ok, groupIds: ["01a20100-e157-7b84-b90a-7bc47908ba04"] })).status).toBe(400);
    // A channel the platform turned off is not offered or accepted.
    await saveChannels({ webhook: { ...ERP(), enabled: false } });
    expect((await post(ana, { name: "W", channel: "webhook", everyone: true })).status).toBe(400);
    expect((await optionsOf(ana)).channels).not.toContain("webhook");
    await saveChannels({ webhook: ERP() });

    // Without the permission, nothing; another account sees none of this.
    const reader = await join("Lector sin permiso", "viewer");
    expect((await h.request("GET", "/api/notifications", as(reader))).status).toBe(403);
    expect((await h.request("GET", "/api/notifications", as(otherAccount))).json.notifications).toEqual([]);

    // Someone with the permission who sees one vehicle: creates for it, sees only what covers nothing else and writes no addresses.
    const car = await addVehicle(ana, "El del supervisor");
    const role = (await h.request("POST", "/api/roles", { ...as(ana), body: { name: "Supervisor de avisos", permissions: ["notifications.manage"] } })).json.roles.find((r: { name: string }) => r.name === "Supervisor de avisos");
    const supervisor = await join("Supervisor", role.id, [], [car.id]);
    const own = await post(supervisor, { name: "Del supervisor", channel: "email", userIds: [supervisor.userId] });
    expect(own.status, JSON.stringify(own.json)).toBe(201);
    expect(own.json.notifications).toMatchObject([{ name: "Del supervisor", vehicleIds: [car.id], groupIds: null }]);
    expect((await optionsOf(supervisor)).canAddress).toBe(false);
    expect((await post(supervisor, { name: "A fuera", channel: "email", addresses: ["fuera@empresa.test"] })).status).toBe(403);
    const wide = ((await h.request("GET", "/api/notifications", as(ana))).json.notifications as AccountNotification[]).find((n) => n.name === "Correo a todos") as AccountNotification;
    expect((await h.request("DELETE", `/api/notifications/${wide.id}`, as(supervisor))).status).toBe(404);
    expect((await h.request("DELETE", `/api/notifications/${own.json.notifications[0].id}`, as(supervisor))).status).toBe(204);
    expect((await h.request("DELETE", `/api/notifications/${wide.id}`, as(otherAccount))).status).toBe(404);
  });
});

describe("notifications of the platform", () => {
  const backupFailed = () => h.system.notify("backup_failed", { title: "una copia de seguridad falló", body: "No hubo espacio en el disco.", path: "/admin/system/backups" });

  it("until one is set up, problems reach the server's operations email", async () => {
    h.config.alertEmail = "operacion@empresa.test";
    await backupFailed();
    await h.system.notify("backup_ok", { title: "copia de seguridad hecha", body: "Todo bien." });
    expect(h.mails.map((m) => [m.to, m.subject])).toEqual([["operacion@empresa.test", `${h.config.appName}: una copia de seguridad falló`]]);
    expect(h.mails[0]?.url).toBe(`${h.config.publicUrl}/admin/system/backups`);
  });

  it("each one is a destination and what it wants to hear about", async () => {
    expect((await h.request("GET", "/api/admin/notifications", as(ana))).status).toBe(404);
    expect((await admin("POST", "/api/admin/notifications", { name: "Mal", channel: "sms", target: "no-es-telefono", events: ["backup_failed"] })).status).toBe(400);
    expect((await admin("POST", "/api/admin/notifications", { name: "Sin nada", channel: "email", target: "ops@empresa.test", events: [] })).status).toBe(400);
    expect((await admin("POST", "/api/admin/notifications", { name: "Push", channel: "push", target: "x", events: ["backup_failed"] })).status).toBe(400);
    expect((await admin("POST", "/api/admin/notifications", { name: "Telegram", channel: "telegram", target: "-100500", events: ["backup_failed"] })).status).toBe(400);
    const created = await admin("POST", "/api/admin/notifications", { name: "Guardia por correo", channel: "email", target: "guardia@empresa.test", events: ["backup_failed", "channel_failing", "account_created"] });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    await admin("POST", "/api/admin/notifications", { name: "Guardia por SMS", channel: "sms", target: "+50433445566", events: ["backup_failed"] });
    const list = (await admin("GET", "/api/admin/notifications")).json.notifications as SystemNotification[];
    expect(list.map((n) => [n.name, n.channel, n.target])).toEqual([
      ["Guardia por correo", "email", "guardia@empresa.test"],
      ["Guardia por SMS", "sms", "+50433445566"],
    ]);

    // With one set up, the operations email of the server no longer receives.
    await backupFailed();
    expect(h.mails.map((m) => m.to)).toEqual(["guardia@empresa.test"]);
    expect(to("/twilio/").map((c) => c.form.get("To"))).toEqual(["+50433445566"]);
    // What nobody asked to hear about is not told.
    h.mails.length = 0;
    await h.system.notify("disk_high", { title: "el disco va al 91 %", body: "Quedan 3 GB." });
    expect(h.mails).toEqual([]);
    // A new account, to whoever asked for it.
    const newAccount = await h.signUp("Cuenta Recién Creada");
    await h.outbox.idle();
    expect(h.mails.filter((m) => m.to === "guardia@empresa.test").map((m) => m.subject)).toEqual([`${h.config.appName}: se creó una cuenta nueva`]);
    expect(newAccount.orgId).toBeTruthy();

    const sms = list.find((n) => n.channel === "sms") as SystemNotification;
    const tested = await admin("POST", `/api/admin/notifications/${sms.id}/test`);
    expect((tested.json.deliveries as Delivery[])[0]).toMatchObject({ source: "test", status: "ok", to: "+504…566", name: "Guardia por SMS" });
    const log = (await admin("GET", "/api/admin/notifications")).json.deliveries as Delivery[];
    expect(log.some((d) => d.source === "system" && d.name === "Guardia por correo" && d.status === "ok")).toBe(true);
    // The platform's messages are not an account's.
    expect((await logOf(ana)).some((d) => d.source === "system")).toBe(false);

    expect((await admin("PUT", `/api/admin/notifications/${sms.id}`, { name: "Guardia por SMS", channel: "sms", target: "+50433445566", events: ["backup_failed"], active: false })).status).toBe(200);
    calls.length = 0;
    await backupFailed();
    expect(to("/twilio/")).toEqual([]);
    expect((await admin("DELETE", `/api/admin/notifications/${sms.id}`)).status).toBe(204);
    expect((await admin("DELETE", `/api/admin/notifications/${sms.id}`)).status).toBe(404);

    // Through the custom channel, what is written is an email or a phone that fills its variables.
    expect((await admin("POST", "/api/admin/notifications", { name: "Mal", channel: "webhook", target: `${base}/monitoreo`, events: ["disk_high"] })).status).toBe(400);
    const hook = await admin("POST", "/api/admin/notifications", { name: "Al monitoreo", channel: "webhook", target: "+50477889900", events: ["disk_high"] });
    expect(hook.status, JSON.stringify(hook.json)).toBe(201);
    const listed = (hook.json.notifications as SystemNotification[]).find((n) => n.name === "Al monitoreo") as SystemNotification;
    expect(listed.target).toBe("+50477889900");
    calls.length = 0;
    await h.system.notify("disk_high", { title: "el disco va al 91 %", body: "Quedan 3 GB." });
    expect(query(to("/erp/avisos")[0]).get("tipo")).toBe("disk_high");
    expect(query(to("/erp/avisos")[0]).get("a")).toBe("+50477889900");
    expect(to("/erp/avisos")[0]?.headers.authorization).toBe("Bearer clave-del-erp");
    expect((await admin("DELETE", `/api/admin/notifications/${listed.id}`)).status).toBe(204);
  });

  it("a channel that keeps failing for the accounts is told to the owner", async () => {
    const car = await addVehicle(ana, "Camión del canal caído");
    await h.db.core.query(`UPDATE gps.notifications SET active = (name = 'Al ERP') WHERE org_id = $1`, [ana.orgId]);
    hookAnswer = 500;
    h.mails.length = 0;
    for (let i = 0; i < 3; i++) {
      await speed(car);
      let at = Date.now();
      for (const wait of [1, 5, 30, 120, 360]) await h.outbox.deliverDue((at += (wait + 1) * 60_000));
    }
    await h.outbox.idle();
    const told = h.mails.filter((m) => m.to === "guardia@empresa.test");
    expect(told.map((m) => m.subject)).toEqual([`${h.config.appName}: el canal Personalizado está fallando`]);
    expect(told[0]?.body).toContain("Respondió 500");
    await h.db.core.query(`UPDATE gps.notifications SET active = true WHERE org_id = $1 AND name <> 'Apagado'`, [ana.orgId]);
  });
});
