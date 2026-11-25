// Module H · Routes and logistics.
import { fleetText, v } from "./validation";
import { z } from "zod";

export const POI_CATEGORIES = ["client", "warehouse", "branch", "fuel", "workshop", "parking", "other"] as const;
export type PoiCategory = (typeof POI_CATEGORIES)[number];
/** A place the account visits. */
export interface Poi {
  id: string;
  name: string;
  category: PoiCategory;
  lat: number;
  lon: number;
  /** How close a vehicle must be to be considered at the place. */
  radiusM: number;
  address: string | null;
  phone: string | null;
  notes: string | null;
}
const routeLat = z.number().min(-90).max(90);
const routeLon = z.number().min(-180).max(180);
export const poiSchema = z.object({
  name: z.string().trim().min(1, v("validation.placeName")).max(80),
  category: z.enum(POI_CATEGORIES).default("other"),
  lat: routeLat,
  lon: routeLon,
  radiusM: z.number().int().min(20).max(2000).default(100),
  address: fleetText(200),
  phone: fleetText(40),
  notes: fleetText(300),
});
export type PoiInput = z.input<typeof poiSchema>;

export const ROUTE_LINE_MAX = 2000;
export const ROUTE_STOPS_MAX = 50;
/** A stop on a planned route. */
export interface RoutePlanStop {
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  /** Minutes after departure at which arrival is expected, and minutes of stay. */
  etaMin: number | null;
  stayMin: number | null;
  contact: string | null;
}
export interface RoutePlan {
  id: string;
  name: string;
  /** The path, as [lon, lat] points; empty if the route is only its stops. */
  line: [number, number][];
  /** How far a vehicle may stray from the path before notifying. */
  toleranceM: number;
  lengthM: number;
  notes: string | null;
  stops: RoutePlanStop[];
}
const routeStopSchema = z.object({
  name: z.string().trim().min(1, v("validation.stopName")).max(80),
  lat: routeLat,
  lon: routeLon,
  radiusM: z.number().int().min(20).max(2000).default(100),
  etaMin: z.number().int().min(0).max(100_000).nullable().default(null),
  stayMin: z.number().int().min(0).max(10_000).nullable().default(null),
  contact: fleetText(80),
});
const routeLineSchema = z.array(z.tuple([routeLon, routeLat])).max(ROUTE_LINE_MAX);
export const routePlanSchema = z.object({
  name: z.string().trim().min(1, v("validation.routeName")).max(80),
  line: routeLineSchema.default([]),
  toleranceM: z.number().int().min(30).max(2000).default(150),
  notes: fleetText(500),
  stops: z.array(routeStopSchema).min(1, v("validation.routeStopNeeded")).max(ROUTE_STOPS_MAX),
});
export type RoutePlanInput = z.input<typeof routePlanSchema>;

export const ROUTE_TRIP_STATUSES = ["assigned", "in_progress", "done", "cancelled"] as const;
export type RouteTripStatus = (typeof ROUTE_TRIP_STATUSES)[number];
export const ROUTE_STOP_STATUSES = ["pending", "arrived", "done", "failed", "skipped"] as const;
export type RouteStopStatus = (typeof ROUTE_STOP_STATUSES)[number];
export const ROUTE_PROOF_KINDS = ["photo", "signature"] as const;
export type RouteProofKind = (typeof ROUTE_PROOF_KINDS)[number];
export const ROUTE_PROOF_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export interface RouteTripStop {
  id: string;
  seq: number;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  plannedAt: string | null;
  contact: string | null;
  status: RouteStopStatus;
  arrivedAt: string | null;
  doneAt: string | null;
  /** Proof of delivery. */
  recipient: string | null;
  note: string | null;
  hasPhoto: boolean;
  hasSignature: boolean;
}
/** A dispatch: some stops assigned to a vehicle. */
export interface RouteTrip {
  id: string;
  name: string;
  planId: string | null;
  vehicleId: string;
  vehicleName: string;
  driver: string | null;
  startsAt: string;
  status: RouteTripStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Is outside its route's corridor at the moment. */
  offRoute: boolean;
  toleranceM: number;
  line: [number, number][];
  stops: RouteTripStop[];
}
export const routeTripSchema = z.object({
  name: z.string().trim().min(1, v("validation.dispatchName")).max(80),
  /** Planned route it comes from; with it, the stops and the path may be omitted. */
  planId: z.uuid().nullable().default(null),
  vehicleId: z.uuid(),
  driver: fleetText(80),
  startsAt: z.coerce.date(v("validation.departureNeeded")),
  line: routeLineSchema.optional(),
  toleranceM: z.number().int().min(30).max(2000).optional(),
  stops: z
    .array(routeStopSchema.omit({ etaMin: true, stayMin: true }).extend({ plannedAt: z.coerce.date().nullable().default(null) }))
    .max(ROUTE_STOPS_MAX)
    .optional(),
});
export type RouteTripInput = z.input<typeof routeTripSchema>;
/** What is recorded for a stop: from dispatch or from the driver's link. */
export const routeStopUpdateSchema = z.object({ status: z.enum(ROUTE_STOP_STATUSES), recipient: fleetText(80), note: fleetText(300) });
export const routeTokenSchema = z.object({ token: z.string().min(20).max(100) });
export const routeDriverStopSchema = routeTokenSchema.extend({ stopId: z.uuid(), status: z.enum(["arrived", "done", "failed"]), recipient: fleetText(80), note: fleetText(300) });
export const routeDriverStatusSchema = routeTokenSchema.extend({ status: z.enum(["in_progress", "done"]) });
/** A vehicle as a candidate for a destination. */
export interface NearbyVehicle {
  vehicleId: string;
  name: string;
  /** In a straight line, from its last position. Null if it has not reported. */
  distanceM: number | null;
  lat: number | null;
  lon: number | null;
  lastSeenAt: string | null;
  /** Is reporting and has no other route in progress. */
  available: boolean;
  /** Why not: its route in progress, or that it is not reporting. */
  busy: string | null;
}
/** What the driver sees with their link, without an account. */
export interface DriverTripView {
  account: string;
  name: string;
  vehicleName: string;
  driver: string | null;
  status: RouteTripStatus;
  startsAt: string;
  line: [number, number][];
  stops: RouteTripStop[];
}
/** What whoever is waiting for a delivery sees, with the link to their stop. */
export interface DeliveryView {
  account: string;
  stopName: string;
  status: RouteStopStatus;
  tripStatus: RouteTripStatus;
  plannedAt: string | null;
  arrivedAt: string | null;
  doneAt: string | null;
  /** Stops the vehicle has before this one. */
  stopsBefore: number;
  destination: { lat: number; lon: number };
  /** Where the vehicle is; only while the route is in progress and the delivery pending. */
  vehicle: { lat: number; lon: number; course: number | null; fixTime: string | null; moving: boolean } | null;
}
