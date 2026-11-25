// Live channel.
import type { VehicleEvent } from "./geofences";
import type { VehicleDevice, VehicleState } from "./vehicles";

export type LiveMessage =
  | { type: "hello"; serverTime: string }
  | { type: "position"; vehicleId: string; state: VehicleState }
  | { type: "device"; vehicleId: string; device: VehicleDevice | null }
  | { type: "vehicles_changed" }
  | { type: "geofences_changed" }
  /** Module A: an incident changed, or a vehicle's security state. */
  | { type: "incidents_changed" }
  | { type: "drivers_changed" }
  | { type: "security_changed"; vehicleId: string }
  | { type: "event"; event: VehicleEvent };
