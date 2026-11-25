// Users of an account: invitations, roles, group scope, blocking and audit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Harness, ORIGIN, type TestUser, createHarness, traccarRow } from "./harness";

let h: Harness;
let ana: TestUser; // owner of the account
let otherAccount: TestUser; // owner of another account, unrelated

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Dueña");
  otherAccount = await h.signUp("Otra Cuenta");
});
afterAll(async () => {
  await h?.close();
});

const as = (user: TestUser) => ({ cookie: user.cookie });
const addVehicle = async (user: TestUser, name: string) => {
  const uniqueId = h.uniqueId();
  const res = await h.request("POST", "/api/vehicles", { ...as(user), body: { name, uniqueId, modelId: "h02" } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { id: res.json.vehicle.id as string, uniqueId };
};
const addGroup = async (user: TestUser, name: string) =>
  (await h.request("POST", "/api/groups", { ...as(user), body: { name } })).json.group.id as string;

/** Invites a new person, registers them and they accept. Returns their session, already inside Ana's account. */
async function join(name: string, role: string, groups: string[] | null = null, vehicles: string[] = []): Promise<TestUser> {
  const person = await h.signUp(name);
  const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: person.email, role, groups, vehicles } });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);
  const accepted = await h.request("POST", `/api/invitations/${invited.json.invitation.id}/accept`, as(person));
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(204);
  return person;
}
const me = async (user: TestUser) => (await h.request("GET", "/api/me", as(user))).json;

describe("invitations", () => {
  it("invites by email, shows the invitation without a session and the invitee joins the account", async () => {
    const beto = await h.signUp("Beto Invitado");
    const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: beto.email.toUpperCase(), role: "operator" } });
    expect(invited.status).toBe(201);
    const id = invited.json.invitation.id as string;

    const mail = h.mails.findLast((m) => m.to === beto.email);
    expect(mail?.subject).toContain("te invitó");
    expect(mail?.url).toContain(`/invitation?id=${id}`);

    // Whoever opens the link sees what it is about before entering.
    const preview = await h.request("GET", `/api/invitations/${id}`, {});
    expect(preview.json.invitation).toMatchObject({ accountName: "Ana Dueña", email: beto.email, inviterName: "Ana Dueña", roleName: "Operador", status: "pending" });

    const listed = await h.request("GET", "/api/members", as(ana));
    expect(listed.json.invitations.map((i: { email: string }) => i.email)).toContain(beto.email);

    // Another person with the link cannot accept it.
    expect((await h.request("POST", `/api/invitations/${id}/accept`, as(otherAccount))).status).toBe(403);

    expect((await h.request("POST", `/api/invitations/${id}/accept`, as(beto))).status).toBe(204);
    const now = await me(beto);
    expect(now.account).toMatchObject({ id: ana.orgId, role: "operator", roleName: "Operador", groups: null });
    expect(now.accounts).toHaveLength(2); // their own and Ana's

    const members = (await h.request("GET", "/api/members", as(ana))).json;
    expect(members.members.find((m: { email: string }) => m.email === beto.email)).toMatchObject({ role: "operator", disabled: false });
    expect(members.invitations.map((i: { email: string }) => i.email)).not.toContain(beto.email);
    expect((await h.request("GET", `/api/invitations/${id}`, {})).json.invitation.status).toBe("accepted");

    // They can return to their own account and come back.
    expect((await h.request("POST", "/api/accounts/active", { ...as(beto), body: { accountId: beto.orgId } })).status).toBe(204);
    expect((await me(beto)).account).toMatchObject({ id: beto.orgId, role: "owner" });
    expect((await h.request("POST", "/api/accounts/active", { ...as(beto), body: { accountId: otherAccount.orgId } })).status).toBe(404);
  });

  it("does not invite someone who is already a member, and a withdrawn invitation stops working", async () => {
    const carla = await join("Carla Lectora", "viewer");
    const again = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: carla.email, role: "viewer" } });
    expect(again.status).toBe(409);

    const dario = await h.signUp("Darío Pendiente");
    const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: dario.email, role: "viewer" } });
    const id = invited.json.invitation.id as string;
    expect((await h.request("DELETE", `/api/members/invitations/${id}`, as(otherAccount))).status).toBe(404); // it is not from their account
    expect((await h.request("DELETE", `/api/members/invitations/${id}`, as(ana))).status).toBe(204);
    expect((await h.request("GET", `/api/invitations/${id}`, {})).json.invitation.status).toBe("canceled");
    expect((await h.request("POST", `/api/invitations/${id}/accept`, as(dario))).status).toBeGreaterThanOrEqual(400);
    expect((await me(dario)).accounts).toHaveLength(1);

    expect((await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: "no-es-correo", role: "viewer" } })).status).toBe(400);
    expect((await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: "x@prueba.test", role: "inventado" } })).status).toBe(400);
  });
});

describe("roles and permissions", () => {
  it("the reader sees the vehicles but changes nothing", async () => {
    const v = await addVehicle(ana, "Camión de Ana");
    const reader = await join("Luis Lector", "viewer");

    const list = await h.request("GET", "/api/vehicles", as(reader));
    expect(list.json.vehicles.map((x: { id: string }) => x.id)).toContain(v.id);
    expect((await h.request("GET", `/api/vehicles/${v.id}/track`, as(reader))).status).toBe(200);

    const attempts = [
      await h.request("POST", "/api/vehicles", { ...as(reader), body: { name: "X", uniqueId: h.uniqueId(), modelId: "h02" } }),
      await h.request("PATCH", `/api/vehicles/${v.id}`, { ...as(reader), body: { name: "Cambiado" } }),
      await h.request("DELETE", `/api/vehicles/${v.id}`, as(reader)),
      await h.request("DELETE", `/api/vehicles/${v.id}/device`, as(reader)),
      await h.request("POST", "/api/groups", { ...as(reader), body: { name: "Grupo del lector" } }),
      await h.request("GET", "/api/members", as(reader)),
      await h.request("POST", "/api/members/invitations", { ...as(reader), body: { email: "a@prueba.test", role: "admin" } }),
      await h.request("GET", "/api/audit", as(reader)),
    ];
    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
    expect((await h.request("GET", `/api/vehicles/${v.id}`, as(ana))).json.vehicle.name).toBe("Camión de Ana");
  });

  it("the operator manages vehicles but not users; the administrator, everything", async () => {
    const operator = await join("Olga Operadora", "operator");
    const created = await h.request("POST", "/api/vehicles", { ...as(operator), body: { name: "De la operadora", uniqueId: h.uniqueId(), modelId: "h02" } });
    expect(created.status).toBe(201);
    expect((await h.request("GET", "/api/members", as(operator))).status).toBe(403);
    expect((await h.request("GET", "/api/audit", as(operator))).status).toBe(403);
    // The vehicle ended up in Ana's account, not in the operator's.
    expect((await h.request("GET", `/api/vehicles/${created.json.vehicle.id}`, as(ana))).status).toBe(200);

    const admin = await join("Adán Administrador", "admin");
    expect((await h.request("GET", "/api/members", as(admin))).status).toBe(200);
    expect((await h.request("GET", "/api/audit", as(admin))).status).toBe(200);
    expect((await h.request("POST", "/api/groups", { ...as(admin), body: { name: `Grupo del admin ${Date.now()}` } })).status).toBe(201);
  });

  it("nobody changes the owner or their own access, or touches members of another account", async () => {
    const admin = await join("Alma Administradora", "admin");
    expect((await h.request("PATCH", `/api/members/${ana.userId}`, { ...as(admin), body: { role: "viewer" } })).status).toBe(403);
    expect((await h.request("DELETE", `/api/members/${ana.userId}`, as(admin))).status).toBe(403);
    expect((await h.request("PATCH", `/api/members/${admin.userId}`, { ...as(admin), body: { role: "viewer" } })).status).toBe(403);
    expect((await h.request("PATCH", `/api/members/${ana.userId}`, { ...as(ana), body: { disabled: true } })).status).toBe(403);
    // From another account, Ana's members do not exist.
    expect((await h.request("PATCH", `/api/members/${admin.userId}`, { ...as(otherAccount), body: { role: "viewer" } })).status).toBe(404);
    expect((await h.request("DELETE", `/api/members/${admin.userId}`, as(otherAccount))).status).toBe(404);
    expect((await me(admin)).account.role).toBe("admin");
  });

  it("a custom role gives exactly the permissions ticked for it", async () => {
    const created = await h.request("POST", "/api/roles", { ...as(ana), body: { name: "Auditor", permissions: ["audit.view"] } });
    expect(created.status).toBe(201);
    const role = created.json.roles.find((r: { name: string }) => r.name === "Auditor");
    expect(role).toMatchObject({ builtin: false, permissions: ["audit.view"] });
    expect((await h.request("POST", "/api/roles", { ...as(ana), body: { name: "auditor", permissions: [] } })).status).toBe(409);
    expect((await h.request("POST", "/api/roles", { ...as(ana), body: { name: "Raro", permissions: ["todo.poderoso"] } })).status).toBe(400);

    const auditor = await join("Aura Auditora", role.id);
    expect((await me(auditor)).account).toMatchObject({ role: role.id, roleName: "Auditor", permissions: ["audit.view"] });
    expect((await h.request("GET", "/api/audit", as(auditor))).status).toBe(200);
    expect((await h.request("POST", "/api/vehicles", { ...as(auditor), body: { name: "X", uniqueId: h.uniqueId(), modelId: "h02" } })).status).toBe(403);

    // A role from another account is no use here.
    expect((await h.request("PATCH", `/api/roles/${role.id}`, { ...as(otherAccount), body: { name: "Mío", permissions: [] } })).status).toBe(404);

    // When the role changes, the permissions of whoever has it change; when it is deleted, they become a reader.
    await h.request("PATCH", `/api/roles/${role.id}`, { ...as(ana), body: { name: "Auditor", permissions: ["audit.view", "vehicles.manage"] } });
    expect((await me(auditor)).account.permissions).toEqual(["vehicles.manage", "audit.view"]);
    expect((await h.request("DELETE", `/api/roles/${role.id}`, as(ana))).status).toBe(204);
    expect((await me(auditor)).account).toMatchObject({ role: "viewer", permissions: [] });
  });
});

describe("group scope", () => {
  it("whoever sees only one group does not see, touch or receive live what belongs to the others", async () => {
    const north = await addGroup(ana, `Norte ${Date.now()}`);
    const south = await addGroup(ana, `Sur ${Date.now()}`);
    const vNorth = await addVehicle(ana, "Del norte");
    const vSouth = await addVehicle(ana, "Del sur");
    const vFree = await addVehicle(ana, "Sin grupo");
    await h.request("PATCH", `/api/vehicles/${vNorth.id}`, { ...as(ana), body: { groupId: north } });
    await h.request("PATCH", `/api/vehicles/${vSouth.id}`, { ...as(ana), body: { groupId: south } });

    const nora = await join("Nora del Norte", "operator", [north]);
    expect((await me(nora)).account.groups).toEqual([north]);

    const list = await h.request("GET", "/api/vehicles", as(nora));
    expect(list.json.vehicles.map((v: { id: string }) => v.id)).toEqual([vNorth.id]);
    expect((await h.request("GET", "/api/groups", as(nora))).json.groups.map((g: { id: string }) => g.id)).toEqual([north]);

    const outside = [
      await h.request("GET", `/api/vehicles/${vSouth.id}`, as(nora)),
      await h.request("GET", `/api/vehicles/${vFree.id}/track`, as(nora)),
      await h.request("GET", `/api/vehicles/${vSouth.id}/address`, as(nora)),
      await h.request("PATCH", `/api/vehicles/${vSouth.id}`, { ...as(nora), body: { name: "Tomado" } }),
      await h.request("DELETE", `/api/vehicles/${vFree.id}`, as(nora)),
    ];
    expect(outside.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);

    // Within their group they do manage; what they create stays in their group and they cannot take it out.
    expect((await h.request("PATCH", `/api/vehicles/${vNorth.id}`, { ...as(nora), body: { name: "Del norte, editado" } })).status).toBe(200);
    const created = await h.request("POST", "/api/vehicles", { ...as(nora), body: { name: "Nuevo del norte", uniqueId: h.uniqueId(), modelId: "h02" } });
    expect(created.json.vehicle.groupId).toBe(north);
    expect((await h.request("PATCH", `/api/vehicles/${vNorth.id}`, { ...as(nora), body: { groupId: south } })).status).toBe(403);
    expect((await h.request("PATCH", `/api/vehicles/${vNorth.id}`, { ...as(nora), body: { groupId: null } })).status).toBe(403);
    // Managing groups belongs to whoever sees the whole account.
    expect((await h.request("POST", "/api/groups", { ...as(nora), body: { name: "Otro" } })).status).toBe(403);
    expect((await h.request("DELETE", `/api/groups/${north}`, as(nora))).status).toBe(403);

    // Live: only the positions of their group reach them.
    const received: any[] = [];
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/live`, { headers: { cookie: nora.cookie, origin: ORIGIN } });
      ws.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "hello") resolve(ws);
        else if (message.type === "position") received.push(message.vehicleId);
      });
      ws.on("error", reject);
    });
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    await h
      .ingestFrom([
        traccarRow(h.traccar.devices.get(vNorth.uniqueId) as number, { fix: minutesAgo(1) }),
        traccarRow(h.traccar.devices.get(vSouth.uniqueId) as number, { fix: minutesAgo(1) }),
        traccarRow(h.traccar.devices.get(vFree.uniqueId) as number, { fix: minutesAgo(1) }),
      ])
      .tick();
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toEqual([vNorth.id]);

    // If their access is changed, their connection restarts to pick up the new one.
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    await h.request("PATCH", `/api/members/${nora.userId}`, { ...as(ana), body: { groups: [north, south] } });
    expect(await closed).toBe(4001);
    expect((await h.request("GET", "/api/vehicles", as(nora))).json.vehicles).toHaveLength(3);

    // Deleting a group does not widen the scope: they keep the ones they have left.
    await h.request("DELETE", `/api/groups/${south}`, as(ana));
    expect((await me(nora)).account.groups).toEqual([north]);
    await h.request("DELETE", `/api/groups/${north}`, as(ana));
    expect((await me(nora)).account.groups).toEqual([]);
    expect((await h.request("GET", "/api/vehicles", as(nora))).json.vehicles).toEqual([]);
    expect((await h.request("POST", "/api/vehicles", { ...as(nora), body: { name: "X", uniqueId: h.uniqueId(), modelId: "h02" } })).status).toBe(403);

    // Groups of another account are no use as scope.
    const outsider = await addGroup(otherAccount, "Grupo ajeno");
    expect((await h.request("PATCH", `/api/members/${nora.userId}`, { ...as(ana), body: { groups: [outsider] } })).status).toBe(400);
  });
});

describe("scope by single vehicle", () => {
  it("someone limited to one vehicle only sees that one, everywhere", async () => {
    const zone = await addGroup(ana, `Zona ${Date.now()}`);
    const ownVehicle = await addVehicle(ana, "El suyo");
    const fromGroup = await addVehicle(ana, "Del grupo");
    const outsider = await addVehicle(ana, "El de otro");
    await h.request("PATCH", `/api/vehicles/${fromGroup.id}`, { ...as(ana), body: { groupId: zone } });

    const invited = await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: (await h.signUp("Para el listado")).email, role: "viewer", groups: [], vehicles: [ownVehicle.id] } });
    expect(invited.json.invitation).toMatchObject({ groups: [], vehicles: [ownVehicle.id] });
    const listed = (await h.request("GET", "/api/members", as(ana))).json.invitations.find((i: { id: string }) => i.id === invited.json.invitation.id);
    expect(listed).toMatchObject({ groups: [], vehicles: [ownVehicle.id] });

    const saul = await join("Saúl de un vehículo", "operator", [], [ownVehicle.id]);
    expect((await me(saul)).account).toMatchObject({ groups: [], vehicles: [ownVehicle.id] });
    expect((await h.request("GET", "/api/vehicles", as(saul))).json.vehicles.map((v: { id: string }) => v.id)).toEqual([ownVehicle.id]);
    expect((await h.request("GET", "/api/groups", as(saul))).json.groups).toEqual([]);
    const outside = [
      await h.request("GET", `/api/vehicles/${outsider.id}`, as(saul)),
      await h.request("GET", `/api/vehicles/${fromGroup.id}/track`, as(saul)),
      await h.request("PATCH", `/api/vehicles/${outsider.id}`, { ...as(saul), body: { name: "Tomado" } }),
      await h.request("DELETE", `/api/vehicles/${fromGroup.id}`, as(saul)),
    ];
    expect(outside.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    // Their own vehicle they do manage; a new one would fall outside what they see.
    expect((await h.request("PATCH", `/api/vehicles/${ownVehicle.id}`, { ...as(saul), body: { name: "El suyo, editado" } })).status).toBe(200);
    expect((await h.request("POST", "/api/vehicles", { ...as(saul), body: { name: "Nuevo", uniqueId: h.uniqueId(), modelId: "h02" } })).status).toBe(403);
    expect((await h.request("GET", "/api/account/summary", as(saul))).json.summary.vehicles).toBe(1);

    // Live: only the positions of their vehicle reach them.
    const received: string[] = [];
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/live`, { headers: { cookie: saul.cookie, origin: ORIGIN } });
      ws.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "hello") resolve(ws);
        else if (message.type === "position") received.push(message.vehicleId);
      });
      ws.on("error", reject);
    });
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    await h
      .ingestFrom([ownVehicle, fromGroup, outsider].map((v) => traccarRow(h.traccar.devices.get(v.uniqueId) as number, { fix: minutesAgo(1) })))
      .tick();
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toEqual([ownVehicle.id]);

    // A group and a vehicle together: what is in the group, plus that vehicle.
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    expect((await h.request("PATCH", `/api/members/${saul.userId}`, { ...as(ana), body: { groups: [zone] } })).status).toBe(204);
    expect(await closed).toBe(4001);
    expect((await me(saul)).account).toMatchObject({ groups: [zone], vehicles: [ownVehicle.id] });
    expect((await h.request("GET", "/api/vehicles", as(saul))).json.vehicles.map((v: { id: string }) => v.id).sort()).toEqual([ownVehicle.id, fromGroup.id].sort());
    const member = (await h.request("GET", "/api/members", as(ana))).json.members.find((m: { userId: string }) => m.userId === saul.userId);
    expect(member).toMatchObject({ groups: [zone], vehicles: [ownVehicle.id] });

    // Seeing everything leaves no list of single vehicles; an administrator never has one.
    await h.request("PATCH", `/api/members/${saul.userId}`, { ...as(ana), body: { groups: null } });
    expect((await me(saul)).account).toMatchObject({ groups: null, vehicles: [] });
    await h.request("PATCH", `/api/members/${saul.userId}`, { ...as(ana), body: { groups: [], vehicles: [ownVehicle.id, outsider.id] } });
    expect((await h.request("GET", "/api/vehicles", as(saul))).json.vehicles).toHaveLength(2);
    await h.request("PATCH", `/api/members/${saul.userId}`, { ...as(ana), body: { role: "admin" } });
    expect((await me(saul)).account).toMatchObject({ groups: null, vehicles: [] });
    await h.request("PATCH", `/api/members/${saul.userId}`, { ...as(ana), body: { role: "viewer", groups: [], vehicles: [ownVehicle.id, outsider.id] } });

    // Deleting a vehicle does not widen the scope: they keep the ones they have left.
    expect((await h.request("DELETE", `/api/vehicles/${outsider.id}`, as(ana))).status).toBe(204);
    expect((await me(saul)).account.vehicles).toEqual([ownVehicle.id]);

    // Vehicles of another account are no use as scope.
    const foreign = await addVehicle(otherAccount, "Ajeno a la cuenta");
    expect((await h.request("PATCH", `/api/members/${saul.userId}`, { ...as(ana), body: { vehicles: [foreign.id] } })).status).toBe(400);
    expect((await h.request("POST", "/api/members/invitations", { ...as(ana), body: { email: "nadie@prueba.test", role: "viewer", groups: [], vehicles: [foreign.id] } })).status).toBe(400);
  });
});

describe("blocking and removal", () => {
  it("a blocked user loses access instantly and regains it when unblocked", async () => {
    const v = await addVehicle(ana, "Para el bloqueado");
    const beto = await join("Bruno Bloqueado", "viewer");
    expect((await me(beto)).account.id).toBe(ana.orgId);

    expect((await h.request("PATCH", `/api/members/${beto.userId}`, { ...as(ana), body: { disabled: true } })).status).toBe(204);
    // Their session stays open, but it no longer enters Ana's account: it falls back to their own.
    const blocked = await me(beto);
    expect(blocked.account.id).toBe(beto.orgId);
    expect(blocked.accounts.map((a: { id: string }) => a.id)).toEqual([beto.orgId]);
    expect((await h.request("GET", `/api/vehicles/${v.id}`, as(beto))).status).toBe(404);
    expect((await h.request("POST", "/api/accounts/active", { ...as(beto), body: { accountId: ana.orgId } })).status).toBe(404);

    await h.request("PATCH", `/api/members/${beto.userId}`, { ...as(ana), body: { disabled: false } });
    expect((await h.request("POST", "/api/accounts/active", { ...as(beto), body: { accountId: ana.orgId } })).status).toBe(204);
    expect((await h.request("GET", `/api/vehicles/${v.id}`, as(beto))).status).toBe(200);

    // When removed, they stop being part of the account.
    expect((await h.request("DELETE", `/api/members/${beto.userId}`, as(ana))).status).toBe(204);
    expect((await me(beto)).accounts.map((a: { id: string }) => a.id)).toEqual([beto.orgId]);
    expect((await h.request("GET", `/api/vehicles/${v.id}`, as(beto))).status).toBe(404);
  });
});

describe("names", () => {
  it("each person changes their own name, seen in every account they are in", async () => {
    const pedro = await join("Pedro Viejo", "viewer");
    expect((await h.request("PUT", "/api/me/settings", { ...as(pedro), body: { name: "P" } })).status).toBe(400);
    expect((await h.request("PUT", "/api/me/settings", { ...as(pedro), body: { name: "  Pedro Nuevo  " } })).status).toBe(204);
    expect((await me(pedro)).user.name).toBe("Pedro Nuevo");
    // Changing only the name leaves the rest as it was.
    expect((await me(pedro)).settings).toEqual({ theme: "system", language: null, phone: null });
    const members = (await h.request("GET", "/api/members", as(ana))).json.members as { userId: string; name: string }[];
    expect(members.find((m) => m.userId === pedro.userId)?.name).toBe("Pedro Nuevo");
  });

  it("the account's name is changed by its owner and its administrators, and the log says so", async () => {
    const reader = await join("Lector de Nombres", "viewer");
    const boss = await join("Administradora de Nombres", "admin");
    expect((await h.request("PATCH", "/api/account", { ...as(reader), body: { name: "Otro nombre" } })).status).toBe(403);
    expect((await h.request("PATCH", "/api/account", { ...as(ana), body: { name: "X" } })).status).toBe(400);
    expect((await h.request("PATCH", "/api/account", { ...as(ana), body: { name: "Transportes Ana" } })).status).toBe(204);
    expect((await me(reader)).account.name).toBe("Transportes Ana");
    expect((await h.request("PATCH", "/api/account", { ...as(boss), body: { name: "Transportes Ana y Compañía" } })).status).toBe(204);
    expect((await me(ana)).account.name).toBe("Transportes Ana y Compañía");
    const log = (await h.request("GET", "/api/audit", as(ana))).json.entries as { action: string; detail: Record<string, string> }[];
    expect(log.find((e) => e.action === "account.rename")?.detail).toEqual({ name: "Transportes Ana y Compañía", before: "Transportes Ana" });
    // Another account is not touched.
    expect((await me(otherAccount)).account.name).not.toContain("Transportes");
  });
});

describe("audit", () => {
  it("records who did what, is queried by pages and cannot be altered", async () => {
    const v = await addVehicle(ana, "Auditado");
    await h.request("PATCH", `/api/vehicles/${v.id}`, { ...as(ana), body: { name: "Auditado y renombrado" } });

    const first = await h.request("GET", "/api/audit?limit=2", as(ana));
    expect(first.json.entries).toHaveLength(2);
    expect(first.json.entries[0]).toMatchObject({ action: "vehicle.update", userName: "Ana Dueña", detail: { name: "Auditado y renombrado" } });
    const next = await h.request("GET", `/api/audit?limit=2&before=${first.json.entries[1].id}`, as(ana));
    expect(next.json.entries[0].id).toBeLessThan(first.json.entries[1].id);

    // The other account sees none of this.
    const foreign = await h.request("GET", "/api/audit?limit=200", as(otherAccount));
    expect(foreign.json.entries.filter((e: { detail: { name?: string } }) => e.detail.name?.startsWith("Auditado"))).toEqual([]);

    // Not even the platform itself can change or delete a row.
    await expect(h.db.core.query(`UPDATE gps.audit_log SET action = 'otra' WHERE org_id = $1`, [ana.orgId])).rejects.toThrow(/cannot be changed/);
    await expect(h.db.core.query(`DELETE FROM gps.audit_log WHERE org_id = $1`, [ana.orgId])).rejects.toThrow(/cannot be changed/);
  });
});

describe("API surface", () => {
  it("the account routes of the session library are not exposed", async () => {
    for (const [method, url] of [
      ["POST", "/api/auth/organization/create"],
      ["POST", "/api/auth/organization/invite-member"],
      ["POST", "/api/auth/organization/remove-member"],
      ["POST", "/api/auth/organization/delete"],
      ["GET", "/api/auth/organization/list-members"],
      ["GET", "/api/auth/admin/list-users"],
    ] as const) {
      const res = await h.request(method, url, method === "POST" ? { ...as(ana), body: {} } : as(ana));
      expect(res.status, url).toBe(404);
    }
    // The rest of the session keeps working.
    expect((await h.request("GET", "/api/auth/get-session", as(ana))).status).toBe(200);
  });
});
