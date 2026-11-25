// Visible state of a vehicle.
import type { Vehicle } from "./vehicles";

export type VehicleStatus = "no_device" | "pending" | "moving" | "idle" | "stopped" | "offline";

/**
 * With the engine on a device reports every few seconds: if it was
 * driving or idling and goes silent for this long, it lost its connection.
 */
export const MOVING_STALE_MS = 5 * 60 * 1000;
/** When off, the device reports only occasionally: it waits longer before being considered disconnected. */
export const OFFLINE_AFTER_MS = 2 * 60 * 60 * 1000;
/** Below this speed it is considered stopped. */
export const MOVING_SPEED_KMH = 3;

export function vehicleStatus(v: Pick<Vehicle, "device" | "state">, now: number = Date.now()): VehicleStatus {
  if (!v.device) return "no_device";
  if (v.device.status === "pending" || !v.state) return "pending";
  const silence = now - Date.parse(v.state.lastSeenAt);
  const moving = v.state.motion ?? (v.state.speedKmh ?? 0) >= MOVING_SPEED_KMH;
  if (moving) return silence > MOVING_STALE_MS ? "offline" : "moving";
  // Idling: engine on without moving.
  if (v.state.ignition === true) return silence > MOVING_STALE_MS ? "offline" : "idle";
  return silence > OFFLINE_AFTER_MS ? "offline" : "stopped";
}


/** Color of each state, the same in the list and on the map. */
export const VEHICLE_STATUS_COLOR: Record<VehicleStatus, string> = {
  moving: "#12a065",
  idle: "#d08700",
  stopped: "#3f7fd1",
  offline: "#8a94a6",
  pending: "#7c6cf0",
  no_device: "#8a94a6",
};
