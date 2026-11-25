// Odometer and engine hours.
import { v } from "./validation";
import { z } from "zod";

/** Odometer and engine hours of a vehicle: the vehicle's own if the device reads them, or those the platform keeps. */
export interface VehicleMeters {
  odometerKm: number;
  /** "ecu": the device reads it from the vehicle's computer. "gps": the platform adds it up from the distance driven. */
  odometerSource: "ecu" | "gps";
  engineHours: number;
  /** "ecu": from the vehicle. "ignition": the platform adds it up from engine-on time. */
  hoursSource: "ecu" | "ignition";
  /** Since when the platform has been keeping count. */
  since: string;
}
export const vehicleMetersSchema = z
  .object({
    /** What the dashboard shows now. Without the value, it is left untouched. */
    odometerKm: z.number().min(0).max(5_000_000).optional(),
    engineHours: z.number().min(0).max(500_000).optional(),
  })
  .refine((m) => m.odometerKm !== undefined || m.engineHours !== undefined, v("validation.metersNeeded"));
