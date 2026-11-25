// Module I · Integrations.
import { EVENT_TYPES, type EventType } from "./geofences";
import type { SharedSay } from "./locales";
import { es } from "./locales/es";
import type { ModuleKey } from "./modules";
import { scheduleSchema } from "./requests";
import type { WeekSchedule } from "./schedule";
import { fleetText, issueOf, v } from "./validation";
import { z } from "zod";

/** Requests per minute each API key allows. */
export const API_RATE_PER_MINUTE = 120;
export const API_KEYS_MAX = 20;
/** A public API key. The full key is shown only when it is created. */
export interface ApiKey {
  id: string;
  name: string;
  /** Its first characters, to recognize it. */
  prefix: string;
  /** In addition to reading, it can record: a dispatch, a fill. */
  canWrite: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}
export const apiKeySchema = z.object({ name: z.string().trim().min(1, v("validation.apiKeyName")).max(60), canWrite: z.boolean().default(false) });

export const WEBHOOKS_MAX = 20;
/** Attempts made to deliver a notification before giving it up as lost. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
export interface Webhook {
  id: string;
  name: string;
  url: string;
  /** Event types it is interested in; null = all. */
  events: EventType[] | null;
  active: boolean;
  /** Names of the custom headers each delivery carries; their values are not shown. */
  headerNames: string[];
  createdAt: string;
  /** How the last delivery went. */
  last: { status: WebhookDeliveryStatus; at: string; code: number | null } | null;
}
export type WebhookDeliveryStatus = "pending" | "ok" | "failed";
export interface WebhookDelivery {
  id: number;
  topic: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  /** Code the other system responded with, and the failure if there was one. */
  code: number | null;
  error: string | null;
  createdAt: string;
  doneAt: string | null;
  /** When it is retried, if still pending. */
  nextAt: string | null;
}
/** Headers of its own that a message to another system carries, such as the key that system asks for. Their values are not shown again. */
export const CUSTOM_HEADERS_MAX = 8;
export const customHeadersSchema = z
  .array(z.object({ name: z.string().trim().regex(/^[A-Za-z0-9-]{1,60}$/, v("validation.headerName")), value: z.string().trim().min(1).max(1000) }))
  .max(CUSTOM_HEADERS_MAX);
export type CustomHeader = z.output<typeof customHeadersSchema>[number];

export const webhookSchema = z.object({
  name: z.string().trim().min(1, v("validation.giveName")).max(60),
  url: z
    .url(v("validation.urlInvalid"))
    .max(500)
    .refine((u) => /^https?:\/\//i.test(u), v("validation.urlHttps")),
  events: z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length).nullable().default(null),
  active: z.boolean().default(true),
  /** Custom headers, such as the key the other system requires. Without the field, the existing ones are left untouched. */
  headers: customHeadersSchema.optional(),
});
export type WebhookInput = z.input<typeof webhookSchema>;

// The channels a message can leave through. Their settings and the notifications that use them are further down.
// SMS go through Twilio, which is how the owner knows the channel. The custom channel calls another system the way
// its owner wrote it: an address, headers and a body, with variables. Push reaches the mobile app: it is planned,
// and starts delivering once the app exists and people sign in on it.
export const NOTIFY_CHANNELS = ["email", "sms", "webhook", "push"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];
/** Channels an account can also send to addresses written by hand: an email, a phone. */
export const WRITTEN_CHANNELS: readonly NotifyChannel[] = ["email", "sms"];
/**
 * Channels the platform's own notifications and the automations send to a destination written by hand. In the
 * custom one the destination is optional: an email or a phone that fills its variables.
 */
export const ADDRESS_CHANNELS = ["email", "sms", "webhook"] as const satisfies readonly NotifyChannel[];
export type AddressChannel = (typeof ADDRESS_CHANNELS)[number];
/** Channels charged per message: each account has a monthly cap on them. */
export const PAID_CHANNELS: readonly NotifyChannel[] = ["sms"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Why an address written by hand does not serve for a channel, as a text to say, or null if it does. */
export function addressProblem(channel: NotifyChannel, address: string): SharedSay | null {
  const value = address.trim();
  if (channel === "email") return EMAIL_PATTERN.test(value) ? null : { key: "validation.emailInvalid" };
  if (channel === "sms") return PHONE_PATTERN.test(value) ? null : { key: "validation.phone" };
  if (channel === "webhook") return EMAIL_PATTERN.test(value) || PHONE_PATTERN.test(value) ? null : { key: "validation.emailOrPhone" };
  return { key: "validation.peopleOnly" };
}

/** An address as the logs show it: enough to recognise it, without the part that is a secret. */
export function addressLabel(_channel: NotifyChannel, address: string): string {
  if (PHONE_PATTERN.test(address)) return `${address.slice(0, 4)}…${address.slice(-3)}`;
  return address;
}

/** What the custom channel fills in its address, headers and body: `{{name}}` is replaced by its value. */
export const CUSTOM_VARIABLES = ["type", "event", "title", "body", "message", "vehicle", "time", "latitude", "longitude", "speed", "link", "app", "name", "email", "phone", "phone_digits", "language"] as const;
export type CustomVariable = (typeof CUSTOM_VARIABLES)[number];
/** The ones about whoever receives it: with any of them, each person gets a message of their own. */
export const PERSON_VARIABLES: readonly CustomVariable[] = ["name", "email", "phone", "phone_digits", "language"];
export const CUSTOM_METHODS = ["POST", "GET", "PUT"] as const;
export type CustomMethod = (typeof CUSTOM_METHODS)[number];
/** A variable as it is written; spaces inside the braces are allowed. */
export const CUSTOM_VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** The variables a text uses, in order and without repeats. */
export function variablesIn(text: string): string[] {
  return [...new Set([...text.matchAll(CUSTOM_VARIABLE_PATTERN)].map((m) => m[1] as string))];
}

/**
 * Why a text of the custom channel does not serve, or null if it does: a variable that does not exist or, in the
 * address, one that would change the server it goes to.
 */
export function templateProblem(text: string, part: "url" | "header" | "body"): SharedSay | null {
  const unknown = variablesIn(text).find((name) => !(CUSTOM_VARIABLES as readonly string[]).includes(name));
  if (unknown) return { key: "validation.unknownVariable", params: { name: `{{${unknown}}}` } };
  if (part !== "url") return null;
  const server = /^https?:\/\/([^/?#]+)/i.exec(text)?.[1];
  // Spaces are allowed only inside the braces of a variable.
  if (!server || /\s/.test(text.replace(CUSTOM_VARIABLE_PATTERN, "x"))) return { key: "validation.urlInvalid" };
  return server.includes("{{") ? { key: "validation.variableInHost" } : null;
}

/** Whether the custom channel's texts speak of whoever receives it: then each person gets their own message. */
export const usesPerson = (texts: string[]): boolean => texts.some((text) => variablesIn(text).some((name) => (PERSON_VARIABLES as readonly string[]).includes(name)));

export const AUTOMATIONS_MAX = 50;
/** What an automation does when it is triggered. */
export type AutomationAction =
  /** Notifies some addresses through a channel: emails or phones. In the custom one they are optional and fill its variables. */
  | { type: "notify"; channel: AddressChannel; to: string[] }
  /** Notifies one of the account's webhooks, even if it is not subscribed to that event. */
  | { type: "webhook"; webhookId: string }
  /** Opens a corrective work order for the vehicle. Needs the maintenance module. */
  | { type: "order"; title: string | null };
export interface Automation {
  id: string;
  name: string;
  active: boolean;
  /** Events that trigger it. */
  triggers: EventType[];
  /** Which vehicles it applies to: a group, some vehicles, or all if both are null. */
  groupId: string | null;
  vehicleIds: string[] | null;
  /** Days and hours when it applies; null = always. */
  schedule: WeekSchedule | null;
  /** Minutes it waits before acting again for the same vehicle. */
  cooldownMin: number;
  action: AutomationAction;
  runs: number;
  lastRunAt: string | null;
}
export interface AutomationRun {
  id: number;
  at: string;
  vehicleName: string | null;
  eventType: EventType;
  ok: boolean;
  detail: string | null;
}
export const automationSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.giveName")).max(60),
    active: z.boolean().default(true),
    triggers: z.array(z.enum(EVENT_TYPES)).min(1, v("validation.triggerNeeded")).max(EVENT_TYPES.length),
    groupId: z.uuid().nullable().default(null),
    vehicleIds: z.array(z.uuid()).min(1).max(500).nullable().default(null),
    schedule: scheduleSchema.nullable().default(null),
    cooldownMin: z.number().int().min(0).max(1440).default(0),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("notify"), channel: z.enum(ADDRESS_CHANNELS), to: z.array(z.string().trim().min(1).max(500)).max(5) }),
      z.object({ type: z.literal("webhook"), webhookId: z.uuid() }),
      z.object({ type: z.literal("order"), title: z.string().trim().max(120).nullable().default(null) }),
    ]),
  })
  .refine((a) => a.groupId === null || a.vehicleIds === null, v("validation.groupOrVehicles"))
  .superRefine((a, ctx) => {
    if (a.action.type !== "notify") return;
    if (a.action.to.length === 0 && a.action.channel !== "webhook") ctx.addIssue({ code: "custom", message: v("validation.destinationNeeded") });
    for (const address of a.action.to) {
      const problem = addressProblem(a.action.channel, address);
      if (problem) ctx.addIssue(issueOf(problem));
    }
  });
export type AutomationInput = z.input<typeof automationSchema>;

export const SENSORS_MAX = 100;
export const SENSOR_KINDS = ["temperature", "humidity", "door", "level", "weight", "other"] as const;
export type SensorKind = (typeof SENSOR_KINDS)[number];
/** Unit proposed for each class of sensor. */
export const SENSOR_UNIT: Record<SensorKind, string> = { temperature: "°C", humidity: "%", door: "", level: "%", weight: "kg", other: "" };
/** A sensor that is not a GPS and sends its readings over HTTP with its own key. */
export interface Sensor {
  id: string;
  name: string;
  kind: SensorKind;
  unit: string | null;
  /** Vehicle it is on, if it is on one. */
  vehicleId: string | null;
  vehicleName: string | null;
  /** Outside this range, it notifies. */
  minValue: number | null;
  maxValue: number | null;
  keyPrefix: string;
  lastValue: number | null;
  lastAt: string | null;
  /** Its latest reading is out of range. */
  alerting: boolean;
}
export const sensorSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.sensorName")).max(60),
    kind: z.enum(SENSOR_KINDS).default("other"),
    unit: fleetText(12),
    vehicleId: z.uuid().nullable().default(null),
    minValue: z.number().min(-1e9).max(1e9).nullable().default(null),
    maxValue: z.number().min(-1e9).max(1e9).nullable().default(null),
  })
  .refine((v) => v.minValue === null || v.maxValue === null || v.minValue < v.maxValue, v("validation.minBelowMax"));
export type SensorInput = z.input<typeof sensorSchema>;
/** Maximum readings in one delivery. */
export const SENSOR_BATCH_MAX = 500;
const sensorReading = z.object({ value: z.number().min(-1e12).max(1e12), at: z.coerce.date().optional() });
/** What a sensor sends: one reading or several. */
export const sensorPushSchema = z.union([sensorReading, z.array(sensorReading).min(1).max(SENSOR_BATCH_MAX)]);
export interface SensorSeries {
  sensor: Sensor;
  /** Pairs [time in ms, value], from oldest to newest. */
  points: [number, number][];
}

export const TRANSFER_KINDS = ["vehicles", "drivers", "geofences"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];
/** What can be imported and exported, and the module needed for each. */
export const TRANSFER_INFO: Record<
  TransferKind,
  {
    /** @deprecated Spanish only. Use the catalog: "transfer.<kind>". */
    label: string;
    /** @deprecated Spanish only. Use the catalog: "transferColumns.<kind>". */
    columns: string;
    requires?: ModuleKey;
  }
> = {
  vehicles: { label: es.transfer.vehicles, columns: es.transferColumns.vehicles },
  drivers: { label: es.transfer.drivers, columns: es.transferColumns.drivers, requires: "B" },
  geofences: { label: es.transfer.geofences, columns: es.transferColumns.geofences },
};
export const TRANSFER_FORMATS = ["csv", "xlsx"] as const;
export type TransferFormat = (typeof TRANSFER_FORMATS)[number];
/** Maximum rows imported at once. */
export const IMPORT_MAX_ROWS = 2000;
export interface ImportResult {
  created: number;
  /** Rows that already existed and were left as they were. */
  skipped: number;
  errors: { row: number; message: string }[];
}
export const importSchema = z.object({ csv: z.string().min(1, v("validation.fileEmpty")).max(2_000_000, v("validation.fileTooBig")) });
