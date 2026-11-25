// Live channel: one WebSocket per tab, which receives only its own account's data.
// The client fetches the full list through the API on connect and on reconnect;
// changes arrive through here.
import type { LiveMessage } from "@opengps/shared";
import type { WebSocket } from "ws";
import type { Bus } from "../bus";
import { seesVehicle } from "../core/access";

const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED_BYTES = 1_000_000;

/** A person's live connection: their account and the vehicles they can see. */
export interface LiveClient {
  orgId: string;
  userId: string;
  /** Visible groups; null = all. */
  groups: string[] | null;
  /** Vehicles visible one by one, besides those of the groups. */
  vehicles: string[];
}

export interface LiveHub {
  add(client: LiveClient, socket: WebSocket): void;
  connections(): number;
  close(): void;
}

export function createLiveHub(bus: Bus): LiveHub {
  const byOrg = new Map<string, Map<WebSocket, LiveClient>>();
  const alive = new WeakMap<WebSocket, boolean>();

  function send(socket: WebSocket, message: LiveMessage): void {
    // A client that does not read must not accumulate memory on the server.
    if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    socket.send(JSON.stringify(message));
  }

  /** Sends to the account. With a vehicle, only to those who can see it. */
  function broadcast(orgId: string, message: LiveMessage, vehicle?: { id: string; groupId: string | null }): void {
    const sockets = byOrg.get(orgId);
    if (!sockets) return;
    for (const [socket, client] of sockets) {
      if (vehicle && !seesVehicle(client, vehicle)) continue;
      send(socket, message);
    }
  }

  const unsubscribe = [
    bus.on("position", (e) => broadcast(e.orgId, { type: "position", vehicleId: e.vehicleId, state: e.state }, { id: e.vehicleId, groupId: e.groupId })),
    bus.on("device", (e) => broadcast(e.orgId, { type: "device", vehicleId: e.vehicleId, device: e.device }, { id: e.vehicleId, groupId: e.groupId })),
    bus.on("vehicles_changed", (e) => broadcast(e.orgId, { type: "vehicles_changed" })),
    bus.on("geofences_changed", (e) => broadcast(e.orgId, { type: "geofences_changed" })),
    bus.on("incident", (e) => broadcast(e.orgId, { type: "incidents_changed" }, { id: e.vehicleId, groupId: e.groupId })),
    bus.on("drivers", (e) => broadcast(e.orgId, { type: "drivers_changed" })),
    bus.on("security", (e) => broadcast(e.orgId, { type: "security_changed", vehicleId: e.vehicleId }, { id: e.vehicleId, groupId: e.groupId })),
    bus.on("event", (e) => broadcast(e.orgId, { type: "event", event: e.event }, { id: e.event.vehicleId, groupId: e.groupId })),
    // If someone's access changes, their connection is closed: on reconnecting they get the new access.
    bus.on("access_changed", (e) => {
      for (const [socket, client] of byOrg.get(e.orgId) ?? []) if (client.userId === e.userId) socket.close(4001, "access changed");
    }),
  ];

  const heartbeat = setInterval(() => {
    for (const sockets of byOrg.values()) {
      for (const socket of sockets.keys()) {
        if (alive.get(socket) === false) {
          socket.terminate();
          continue;
        }
        alive.set(socket, false);
        socket.ping();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    add(client, socket) {
      const sockets = byOrg.get(client.orgId) ?? new Map<WebSocket, LiveClient>();
      sockets.set(socket, client);
      byOrg.set(client.orgId, sockets);
      alive.set(socket, true);
      socket.on("pong", () => alive.set(socket, true));
      socket.on("error", () => socket.terminate());
      socket.on("close", () => {
        sockets.delete(socket);
        if (sockets.size === 0) byOrg.delete(client.orgId);
      });
      send(socket, { type: "hello", serverTime: new Date().toISOString() });
    },
    connections() {
      let n = 0;
      for (const sockets of byOrg.values()) n += sockets.size;
      return n;
    },
    close() {
      clearInterval(heartbeat);
      for (const off of unsubscribe) off();
      for (const sockets of byOrg.values()) for (const socket of sockets.keys()) socket.close(1001);
      byOrg.clear();
    },
  };
}
