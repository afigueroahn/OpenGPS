// Vehicles.

export type DeviceStatus = "pending" | "active";

export interface VehicleState {
  lastSeenAt: string;
  fixTime: string | null;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  speedKmh: number | null;
  course: number | null;
  accuracy: number | null;
  ignition: boolean | null;
  /** The ignition does not come from the device: it was inferred from the vehicle's voltage. */
  ignitionInferred: boolean;
  motion: boolean | null;
  /** Vehicle battery voltage, in volts. */
  powerVoltage: number | null;
  /** Device internal battery: volts and, if it reports it, percentage. */
  batteryVoltage: number | null;
  batteryLevel: number | null;
  satellites: number | null;
  /** Cellular signal in bars, from 0 to 4. */
  signalBars: number | null;
}

export interface VehicleDevice {
  uniqueId: string;
  modelId: string;
  /** The model chosen from the family's list when it was added; null = only the family is known. */
  modelName: string | null;
  status: DeviceStatus;
  claimExpiresAt: string | null;
  confirmedAt: string | null;
}

export interface Vehicle {
  id: string;
  name: string;
  plate: string | null;
  createdAt: string;
  groupId: string | null;
  /** Since when it has been in parked mode; null = it is not. */
  parkedSince: string | null;
  device: VehicleDevice | null;
  state: VehicleState | null;
}

export interface VehicleGroup {
  id: string;
  name: string;
  /** Group it hangs from, if it is a subgroup. What applies to a group applies to those that hang from it. */
  parentId: string | null;
  vehicleCount: number;
}

export interface TrackPoint {
  t: string;
  lat: number;
  lon: number;
  speedKmh: number | null;
  course: number | null;
}
