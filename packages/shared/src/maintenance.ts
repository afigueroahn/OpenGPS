// Module E · Maintenance.
import type { Language } from "./languages";
import type { SharedKey, SharedSay } from "./locales";
import { es } from "./locales/es";
import { isValidZone } from "./schedule";
import { dateOnly, fleetText, moneyCode, v } from "./validation";
import { z } from "zod";

/** Common plans, to avoid starting from scratch: the values are adjusted to each fleet. */
export const MAINT_TEMPLATES: readonly {
  id: string;
  /** @deprecated Spanish only. Use the catalog: "maintTemplate.<id>". */
  name: string;
  everyKm: number | null;
  everyHours: number | null;
  everyDays: number | null;
  warnKm: number | null;
  warnHours: number | null;
  warnDays: number | null;
}[] = [
  { id: "oil", name: es.maintTemplate.oil, everyKm: 5000, everyHours: 250, everyDays: 180, warnKm: 500, warnHours: 25, warnDays: 15 },
  { id: "tires", name: es.maintTemplate.tires, everyKm: 10000, everyHours: null, everyDays: null, warnKm: 1000, warnHours: null, warnDays: null },
  { id: "air", name: es.maintTemplate.air, everyKm: 15000, everyHours: 500, everyDays: 365, warnKm: 1000, warnHours: 50, warnDays: 30 },
  { id: "brakes", name: es.maintTemplate.brakes, everyKm: 20000, everyHours: null, everyDays: 365, warnKm: 1500, warnHours: null, warnDays: 30 },
  { id: "major", name: es.maintTemplate.major, everyKm: 40000, everyHours: 1000, everyDays: 730, warnKm: 2000, warnHours: 50, warnDays: 30 },
];

/** How often a service is due: by kilometers, engine hours or days; whichever comes first. */
export interface MaintTriggers {
  everyKm: number | null;
  everyHours: number | null;
  everyDays: number | null;
  /** How far in advance to notify, for each measure. */
  warnKm: number | null;
  warnHours: number | null;
  warnDays: number | null;
}
export interface MaintPlan extends MaintTriggers {
  id: string;
  name: string;
  notes: string | null;
  /** Vehicles it applies to. */
  vehicleIds: string[];
}
export type MaintDueStatus = "ok" | "soon" | "due";
/** How much remains until a service. What does not apply or cannot be known is null; what is already past, negative. */
export interface MaintDue {
  remainingKm: number | null;
  remainingHours: number | null;
  remainingDays: number | null;
  dueKm: number | null;
  dueHours: number | null;
  dueOn: string | null;
  status: MaintDueStatus;
}
/** A plan applied to a vehicle. */
export interface MaintSchedule extends MaintDue {
  id: string;
  planId: string;
  planName: string;
  vehicleId: string;
  vehicleName: string;
  /** When it was last done, and with what odometer and engine hours. */
  lastOn: string;
  lastKm: number | null;
  lastHours: number | null;
  /** What `maintReason` says, already written: "faltan 420 km", "se pasó por 3 días" ("420 km left", "overdue by 3 days"). */
  reason: string;
  /** Unfinished work order for this service, if any. */
  openOrderId: string | null;
}

/** How much remains until a service is due, given the odometer, hours and today's date. */
export function maintDue(plan: MaintTriggers, last: { on: string; km: number | null; hours: number | null }, now: { km: number | null; hours: number | null; today: string }): MaintDue {
  const dueKm = plan.everyKm !== null && last.km !== null ? last.km + plan.everyKm : null;
  const dueHours = plan.everyHours !== null && last.hours !== null ? last.hours + plan.everyHours : null;
  const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const dueOn = plan.everyDays !== null ? new Date(day(last.on) + plan.everyDays * 86_400_000).toISOString().slice(0, 10) : null;
  const remainingKm = dueKm !== null && now.km !== null ? Math.round(dueKm - now.km) : null;
  const remainingHours = dueHours !== null && now.hours !== null ? Math.round((dueHours - now.hours) * 10) / 10 : null;
  const remainingDays = dueOn !== null ? Math.round((day(dueOn) - day(now.today)) / 86_400_000) : null;
  const left: [number | null, number | null][] = [
    [remainingKm, plan.warnKm],
    [remainingHours, plan.warnHours],
    [remainingDays, plan.warnDays],
  ];
  const status: MaintDueStatus = left.some(([n]) => n !== null && n <= 0) ? "due" : left.some(([n, warn]) => n !== null && n <= (warn ?? 0)) ? "soon" : "ok";
  return { remainingKm, remainingHours, remainingDays, dueKm, dueHours, dueOn, status };
}

/**
 * The most urgent thing about a service, as a text to say: in Spanish, "se pasó
 * por 130 km" or "faltan 12 días" ("overdue by 130 km", "12 days left"). The
 * amount goes already written the way `language` writes numbers: say the text
 * in that same language.
 */
export function maintReason(due: MaintDue, plan: MaintTriggers, language: Language): SharedSay {
  const parts: { left: number; warn: number; over: SharedKey; ahead: SharedKey }[] = [];
  if (due.remainingKm !== null) parts.push({ left: due.remainingKm, warn: plan.warnKm ?? 0, over: "maintReason.overKm", ahead: "maintReason.leftKm" });
  if (due.remainingHours !== null) parts.push({ left: due.remainingHours, warn: plan.warnHours ?? 0, over: "maintReason.overHours", ahead: "maintReason.leftHours" });
  if (due.remainingDays !== null) parts.push({ left: due.remainingDays, warn: plan.warnDays ?? 0, over: "maintReason.overDays", ahead: "maintReason.leftDays" });
  if (parts.length === 0) return { key: "maintReason.noData" };
  // `count` chooses between the singular and the plural; `n` is what is read.
  const amount = (n: number) => ({ count: Math.abs(n), n: new Intl.NumberFormat(language, { useGrouping: "always", maximumFractionDigits: 1 }).format(Math.abs(n)) });
  const over = parts.filter((p) => p.left <= 0);
  if (over.length > 0) {
    const worst = over[0] as (typeof parts)[number];
    return worst.left === 0 ? { key: "maintReason.now" } : { key: worst.over, params: amount(worst.left) };
  }
  // Whatever reaches its notification threshold first is what governs.
  const next = parts.toSorted((a, b) => (a.left <= a.warn ? 0 : 1) - (b.left <= b.warn ? 0 : 1))[0] as (typeof parts)[number];
  return { key: next.ahead, params: amount(next.left) };
}

export const MAINT_EXPIRY_KINDS = ["insurance", "inspection", "registration", "license", "permit", "other"] as const;
export type MaintExpiryKind = (typeof MAINT_EXPIRY_KINDS)[number];
export interface MaintExpiry {
  id: string;
  /** "own": recorded here. "fleet": a document from the fleet module with an expiry date; changed there. */
  source: "own" | "fleet";
  vehicleId: string;
  vehicleName: string;
  kind: MaintExpiryKind;
  name: string | null;
  expiresOn: string;
  warnDays: number;
  /** Days remaining; negative if already expired. */
  daysLeft: number;
  status: MaintDueStatus;
  note: string | null;
}

export const MAINT_ORDER_KINDS = ["preventive", "corrective"] as const;
export type MaintOrderKind = (typeof MAINT_ORDER_KINDS)[number];
export const MAINT_ORDER_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type MaintOrderStatus = (typeof MAINT_ORDER_STATUSES)[number];
export const MAINT_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const MAINT_FILES_MAX = 20;
export const MAINT_ORDER_PARTS_MAX = 60;
export interface MaintOrderPart {
  /** Part from the catalog, if it came from it. */
  partId: string | null;
  name: string;
  quantity: number;
  unitCost: number;
}
export interface MaintOrderFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}
export interface MaintOrder {
  id: string;
  number: number;
  vehicleId: string;
  vehicleName: string;
  kind: MaintOrderKind;
  status: MaintOrderStatus;
  title: string;
  description: string | null;
  scheduleId: string | null;
  /** Plan of the scheduled service it fulfills. */
  planName: string | null;
  workshopId: string | null;
  workshopName: string | null;
  openedOn: string;
  doneOn: string | null;
  odometerKm: number | null;
  engineHours: number | null;
  laborCost: number;
  partsCost: number;
  total: number;
  currency: string;
  parts: MaintOrderPart[];
  files: MaintOrderFile[];
}
export const MAINT_WORKSHOP_KINDS = ["workshop", "supplier"] as const;
export type MaintWorkshopKind = (typeof MAINT_WORKSHOP_KINDS)[number];
export interface MaintWorkshop {
  id: string;
  name: string;
  kind: MaintWorkshopKind;
  contact: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  /** Work orders done there. */
  orders: number;
}
export interface MaintPart {
  id: string;
  name: string;
  code: string | null;
  unit: string;
  unitCost: number | null;
  /** Stock; null if not tracked. */
  stock: number | null;
  notes: string | null;
  /** Quantity used in finished orders. */
  used: number;
}
export interface MaintSettings {
  currency: string;
}
/** What needs attention: scheduled services of each vehicle and expiries. */
export interface MaintOverview {
  schedules: MaintSchedule[];
  expiries: MaintExpiry[];
  /** Open or in-progress orders. */
  openOrders: number;
}

const maintInt = (max: number) => z.number().int().min(1).max(max).nullable().default(null);
const maintWarn = (max: number) => z.number().int().min(0).max(max).nullable().default(null);
export const maintPlanSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.planName")).max(80),
    everyKm: maintInt(1_000_000),
    everyHours: maintInt(100_000),
    everyDays: maintInt(3650),
    warnKm: maintWarn(100_000),
    warnHours: maintWarn(10_000),
    warnDays: maintWarn(365),
    notes: fleetText(500),
    vehicleIds: z.array(z.uuid()).max(2000).default([]),
  })
  .refine((p) => p.everyKm !== null || p.everyHours !== null || p.everyDays !== null, v("validation.planInterval"));
export type MaintPlanInput = z.input<typeof maintPlanSchema>;
/** When the service was last done: counting starts from there. */
export const maintBaselineSchema = z.object({ lastOn: dateOnly, lastKm: z.number().min(0).max(5_000_000).nullable(), lastHours: z.number().min(0).max(500_000).nullable() });
export const maintOrderSchema = z
  .object({
    vehicleId: z.uuid(),
    kind: z.enum(MAINT_ORDER_KINDS),
    status: z.enum(MAINT_ORDER_STATUSES).default("open"),
    title: z.string().trim().min(1, v("validation.orderTitle")).max(120),
    description: fleetText(2000),
    scheduleId: z.uuid().nullable().default(null),
    workshopId: z.uuid().nullable().default(null),
    openedOn: dateOnly,
    doneOn: dateOnly.nullable().default(null),
    odometerKm: z.number().min(0).max(5_000_000).nullable().default(null),
    engineHours: z.number().min(0).max(500_000).nullable().default(null),
    laborCost: z.number().min(0).max(1_000_000_000).default(0),
    currency: moneyCode,
    parts: z
      .array(z.object({ partId: z.uuid().nullable().default(null), name: z.string().trim().min(1, v("validation.partName")).max(120), quantity: z.number().gt(0, v("validation.quantityPositive")).max(100_000), unitCost: z.number().min(0).max(1_000_000_000).default(0) }))
      .max(MAINT_ORDER_PARTS_MAX)
      .default([]),
  })
  .refine((o) => o.doneOn === null || o.doneOn >= o.openedOn, v("validation.doneBeforeOpened"));
export type MaintOrderInput = z.input<typeof maintOrderSchema>;
export const maintFileSchema = z.object({ name: z.string().trim().min(1).max(200) });
export const maintWorkshopSchema = z.object({
  name: z.string().trim().min(1, v("validation.nameNeeded")).max(80),
  kind: z.enum(MAINT_WORKSHOP_KINDS).default("workshop"),
  contact: fleetText(80),
  phone: fleetText(40),
  email: fleetText(120),
  address: fleetText(200),
  notes: fleetText(500),
});
export type MaintWorkshopInput = z.input<typeof maintWorkshopSchema>;
export const maintPartSchema = z.object({
  name: z.string().trim().min(1, v("validation.nameNeeded")).max(120),
  code: fleetText(40),
  unit: z.string().trim().min(1).max(20).default("unidad"),
  unitCost: z.number().min(0).max(1_000_000_000).nullable().default(null),
  stock: z.number().min(-1_000_000).max(1_000_000).nullable().default(null),
  notes: fleetText(500),
});
export type MaintPartInput = z.input<typeof maintPartSchema>;
export const maintExpirySchema = z.object({
  vehicleId: z.uuid(),
  kind: z.enum(MAINT_EXPIRY_KINDS),
  name: fleetText(80),
  expiresOn: dateOnly,
  warnDays: z.number().int().min(0).max(365).default(30),
  note: fleetText(200),
});
export type MaintExpiryInput = z.input<typeof maintExpirySchema>;
export const maintSettingsSchema = z.object({ currency: moneyCode, zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")).default("UTC") });
