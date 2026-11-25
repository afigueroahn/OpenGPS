// Module D · Fleet.
import { dateOnly, fleetText, moneyCode, v } from "./validation";
import { z } from "zod";

/** Availability set by hand. "En ruta" (on route) is not set: an available vehicle that is moving is on route. */
export const FLEET_STATUSES = ["available", "workshop", "out_of_service"] as const;
export type FleetStatus = (typeof FLEET_STATUSES)[number];
export type FleetAvailability = FleetStatus | "on_route";
export const FLEET_STATES = ["active", "suspended", "retired"] as const;
export type FleetState = (typeof FLEET_STATES)[number];
export const FLEET_EXPENSE_CATEGORIES = ["fuel", "maintenance", "toll", "fine", "insurance", "tax", "parking", "other"] as const;
export type FleetExpenseCategory = (typeof FLEET_EXPENSE_CATEGORIES)[number];
export const FLEET_DOCUMENT_KINDS = ["photo", "registration", "insurance", "inspection", "permit", "invoice", "other"] as const;
export type FleetDocumentKind = (typeof FLEET_DOCUMENT_KINDS)[number];
export const FLEET_DOCUMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const FLEET_DOCUMENTS_MAX = 40;

export interface FleetDocument {
  id: string;
  vehicleId: string;
  kind: FleetDocumentKind;
  name: string;
  mime: string;
  size: number;
  /** When it expires, if it is a document with a validity period: "2027-03-31". */
  expiresOn: string | null;
  note: string | null;
  createdAt: string;
}
export interface FleetLogEntry {
  at: string;
  field: "status" | "state";
  value: string;
  note: string | null;
  userName: string | null;
}
/** Useful life: straight-line depreciation and what owning the vehicle has cost. */
export interface FleetLife {
  currency: string;
  ageYears: number;
  /** What it loses in value each year. */
  perYear: number;
  depreciated: number;
  bookValue: number;
  /** Share of the useful life already used, from 0 to 100. */
  usedPercent: number;
  /** When its useful life ends: "2031-05-10". */
  endsOn: string;
  /** Expenses recorded in that currency since it was purchased. */
  expenses: number;
  /** Total cost of ownership to date: what was depreciated plus what was spent. */
  totalCost: number;
  /** Kilometers since purchase, if known, and what each one has cost. */
  km: number | null;
  costPerKm: number | null;
}
export interface FleetVehicle {
  vehicleId: string;
  name: string;
  plate: string | null;
  groupId: string | null;
  vin: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  kind: string | null;
  notes: string | null;
  /** Document that is its photo, if any. */
  photoId: string | null;
  status: FleetStatus;
  /** What is shown: "en ruta" (on route) if it is available and moving. */
  availability: FleetAvailability;
  statusNote: string | null;
  statusSince: string;
  state: FleetState;
  stateNote: string | null;
  stateSince: string;
  purchaseDate: string | null;
  purchasePrice: number | null;
  currency: string | null;
  salvageValue: number | null;
  lifeYears: number | null;
  purchaseOdometerKm: number | null;
  /** Who has it assigned now. */
  assignedTo: string | null;
  odometerKm: number | null;
  documents: number;
  /** Documents that are expired or expire within the next 30 days. */
  expiring: number;
  life: FleetLife | null;
}
export interface FleetDetail extends FleetVehicle {
  log: FleetLogEntry[];
  docs: FleetDocument[];
}
export interface FleetAssignment {
  id: string;
  person: string;
  /** With the drivers module it is an instant; without it, a date. */
  from: string;
  to: string | null;
  note: string | null;
}
export interface FleetAssignments {
  /** "drivers": the history comes from the drivers module and is changed from there. "fleet": recorded here. */
  source: "drivers" | "fleet";
  items: FleetAssignment[];
}
export interface FleetExpense {
  /** Null for those that come on their own from another module, such as recorded fills. */
  id: string | null;
  vehicleId: string;
  vehicleName: string;
  date: string;
  category: FleetExpenseCategory;
  amount: number;
  currency: string;
  note: string | null;
}
export interface FleetExpenses {
  items: FleetExpense[];
  /** Totals by currency and, within each, by category. */
  totals: { currency: string; total: number; byCategory: { category: FleetExpenseCategory; total: number }[] }[];
}
export interface FleetUsage {
  vehicleId: string;
  name: string;
  groupId: string | null;
  distanceM: number;
  /** Time on trips and, separately, with the engine on without moving. */
  tripS: number;
  idleS: number;
  trips: number;
  activeDays: number;
  /** Share of the days in the period when it was not used, from 0 to 100. */
  unusedPercent: number;
}
export interface FleetUtilization {
  from: string;
  to: string;
  days: number;
  vehicles: FleetUsage[];
  totals: { distanceM: number; tripS: number; idleS: number; trips: number; unusedPercent: number; withoutUse: number };
}

export const fleetProfileSchema = z
  .object({
    vin: fleetText(40),
    brand: fleetText(40),
    model: fleetText(60),
    year: z.number().int().min(1950).max(2100).nullable().default(null),
    color: fleetText(30),
    kind: fleetText(30),
    notes: fleetText(1000),
    purchaseDate: dateOnly.nullable().default(null),
    purchasePrice: z.number().min(0).max(1_000_000_000).nullable().default(null),
    currency: moneyCode.nullable().default(null),
    salvageValue: z.number().min(0).max(1_000_000_000).nullable().default(null),
    lifeYears: z.number().gt(0).max(60).nullable().default(null),
    purchaseOdometerKm: z.number().min(0).max(5_000_000).nullable().default(null),
  })
  .refine((p) => p.purchasePrice === null || p.currency !== null, v("validation.purchaseCurrency"))
  .refine((p) => p.salvageValue === null || p.purchasePrice === null || p.salvageValue <= p.purchasePrice, v("validation.salvageOverPrice"));
export type FleetProfileInput = z.input<typeof fleetProfileSchema>;
export const fleetStatusSchema = z.object({ status: z.enum(FLEET_STATUSES), note: fleetText(200) });
export const fleetStateSchema = z.object({ state: z.enum(FLEET_STATES), note: fleetText(200) });
export const fleetAssignmentSchema = z
  .object({ person: z.string().trim().min(1, v("validation.assigneeNeeded")).max(80), from: dateOnly, to: dateOnly.nullable().default(null), note: fleetText(200) })
  .refine((a) => a.to === null || a.to >= a.from, v("validation.endBeforeStart"));
export const fleetExpenseSchema = z.object({
  vehicleId: z.uuid(),
  date: dateOnly,
  category: z.enum(FLEET_EXPENSE_CATEGORIES),
  amount: z.number(v("validation.amountNeeded")).gt(0, v("validation.amountPositive")).max(1_000_000_000),
  currency: moneyCode,
  note: fleetText(200),
});
export type FleetExpenseInput = z.input<typeof fleetExpenseSchema>;
export const fleetDocumentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(FLEET_DOCUMENT_KINDS).default("other"),
  expiresOn: dateOnly.optional(),
  note: z.string().trim().max(200).optional(),
});
export const fleetGroupParentSchema = z.object({ parentId: z.uuid().nullable() });
