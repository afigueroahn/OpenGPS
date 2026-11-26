// Notifications by channel.
import { ALERT_EVENTS, EVENT_TYPES, type EventType } from "./geofences";
import { ADDRESS_CHANNELS, type AddressChannel, CUSTOM_METHODS, type CustomMethod, NOTIFY_CHANNELS, type NotifyChannel, WRITTEN_CHANNELS, addressProblem, customHeadersSchema, templateProblem } from "./integrations";
import { isValidZone } from "./schedule";
import { issueOf, v } from "./validation";
import { z } from "zod";

/** The channels as the platform owner connects them. Keys never come back: only whether one is stored. */
export interface ChannelSettings {
  email: { enabled: boolean };
  /** Twilio. */
  sms: {
    enabled: boolean;
    accountSid: string;
    hasToken: boolean;
    /** The sending number, or the identifier of a messaging service (starts with MG). */
    from: string;
    /** Messages each account can send per month; null = no cap. */
    monthlyCap: number | null;
  };
  /**
   * Another system, called the way the owner wrote it: its method, its address, its headers and its body, with
   * variables. Header values never come back: only their names.
   */
  webhook: { enabled: boolean; method: CustomMethod; url: string; headerNames: string[]; body: string };
  /** The mobile app. */
  push: { enabled: boolean };
}
/** Email starts off: without a mail server it has nothing to send with. */
export const CHANNELS_DEFAULT: ChannelSettings = {
  email: { enabled: false },
  sms: { enabled: false, accountSid: "", hasToken: false, from: "", monthlyCap: 500 },
  webhook: { enabled: false, method: "POST", url: "", headerNames: [], body: "" },
  push: { enabled: true },
};
const channelToggle = z.object({ enabled: z.boolean() });
const monthlyCap = z.number().int().min(1).max(1_000_000).nullable();
/** A key that is not sent stays as it is. */
const optionalKey = z.string().trim().max(600).optional();
export const channelSettingsSchema = z.object({
  email: channelToggle,
  sms: z.object({ enabled: z.boolean(), accountSid: z.string().trim().max(60), token: optionalKey, from: z.string().trim().max(40), monthlyCap }),
  webhook: z
    .object({
      enabled: z.boolean(),
      method: z.enum(CUSTOM_METHODS).default("POST"),
      url: z.string().trim().max(1000).default(""),
      /** Without the field, the saved ones stay: their values do not come back to the screen. */
      headers: customHeadersSchema.optional(),
      body: z.string().max(4000).default(""),
    })
    .superRefine((w, ctx) => {
      const parts: [string, "url" | "header" | "body", string][] = [
        ...(w.url ? [[w.url, "url", "url"] as [string, "url", string]] : []),
        ...(w.headers ?? []).map((h) => [h.value, "header", "headers"] as [string, "header", string]),
        [w.body, "body", "body"],
      ];
      for (const [text, part, path] of parts) {
        const problem = templateProblem(text, part);
        if (problem) ctx.addIssue({ ...issueOf(problem), path: [path] });
      }
    }),
  push: channelToggle,
});
export type ChannelSettingsInput = z.input<typeof channelSettingsSchema>;

/** A notification of an account: whom it tells, about what and through which channel. */
export interface AccountNotification {
  id: string;
  name: string;
  channel: NotifyChannel;
  active: boolean;
  /** To whom: everyone in the account, some roles, some people. Each receives only what is about vehicles they see. */
  everyone: boolean;
  roles: string[];
  userIds: string[];
  /** Addresses written by hand: emails or phones. */
  addresses: string[];
  /** About what: event types (null = every alert) and, if given, only the events of those alerts. */
  events: EventType[] | null;
  ruleIds: string[] | null;
  /** Of which vehicles: some groups, some vehicles or, with both null, all. */
  groupIds: string[] | null;
  vehicleIds: string[] | null;
  /** Time zone its messages write times in. */
  zone: string;
  /** How its latest message went. */
  last: { status: DeliveryStatus; at: string } | null;
}
export const NOTIFICATIONS_MAX = 50;
export const accountNotificationSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.notificationName")).max(60),
    channel: z.enum(NOTIFY_CHANNELS),
    active: z.boolean().default(true),
    everyone: z.boolean().default(false),
    roles: z.array(z.string().min(1).max(60)).max(30).default([]),
    userIds: z.array(z.string().min(1).max(80)).max(200).default([]),
    addresses: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    events: z
      .array(z.enum(EVENT_TYPES).refine((type) => ALERT_EVENTS.includes(type), v("validation.eventNotAlert")))
      .min(1, v("validation.alertTypeNeeded"))
      .nullable()
      .default(null),
    ruleIds: z.array(z.uuid()).min(1, v("validation.alertNeeded")).max(100).nullable().default(null),
    groupIds: z.array(z.uuid()).min(1, v("validation.groupNeeded")).max(200).nullable().default(null),
    vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(500).nullable().default(null),
    zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")).default("UTC"),
  })
  .refine((n) => n.groupIds === null || n.vehicleIds === null, v("validation.groupsOrVehicles"))
  .refine((n) => n.everyone || n.roles.length > 0 || n.userIds.length > 0 || n.addresses.length > 0, v("validation.whoNeeded"))
  .refine((n) => WRITTEN_CHANNELS.includes(n.channel) || n.addresses.length === 0, v("validation.peopleOnly"))
  .superRefine((n, ctx) => {
    for (const address of n.addresses) {
      const problem = addressProblem(n.channel, address);
      if (problem) ctx.addIssue({ ...issueOf(problem), path: ["addresses"] });
    }
  });
export type AccountNotificationInput = z.input<typeof accountNotificationSchema>;

/** Things of the platform itself that whoever runs it wants to hear about. */
export const SYSTEM_EVENTS = ["backup_ok", "backup_failed", "restore_done", "disk_high", "ingest_stalled", "channel_failing", "account_created"] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];
export interface SystemNotification {
  id: string;
  name: string;
  channel: AddressChannel;
  /** Where it goes: an email or a phone. In the custom channel it is optional and fills its variables. */
  target: string;
  events: SystemEvent[];
  active: boolean;
  last: { status: DeliveryStatus; at: string } | null;
}
export const SYSTEM_NOTIFICATIONS_MAX = 20;
export const systemNotificationSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.notificationName")).max(60),
    channel: z.enum(ADDRESS_CHANNELS),
    target: z.string().trim().max(500).default(""),
    events: z.array(z.enum(SYSTEM_EVENTS)).min(1, v("validation.systemEventNeeded")),
    active: z.boolean().default(true),
  })
  .superRefine((n, ctx) => {
    if (!n.target) {
      if (n.channel !== "webhook") ctx.addIssue({ code: "custom", message: v("validation.targetNeeded"), path: ["target"] });
      return;
    }
    const problem = addressProblem(n.channel, n.target);
    if (problem) ctx.addIssue({ ...issueOf(problem), path: ["target"] });
  });
export type SystemNotificationInput = z.input<typeof systemNotificationSchema>;

export type DeliveryStatus = "pending" | "ok" | "failed";
/** A message in the log: where it went, why and how it ended. */
export interface Delivery {
  id: number;
  at: string;
  channel: NotifyChannel;
  /** Where it went, as it can be shown: without what is a secret. */
  to: string;
  /** The message's first line. */
  title: string;
  /** What produced it: an account's notification, the platform's, an automation or a test. */
  source: "notification" | "system" | "automation" | "test";
  /** Name of the notification that produced it, if it still exists. */
  name: string | null;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  /** When it will be tried again, while it is pending. */
  nextAt: string | null;
}

/** What the notifications screen of an account needs besides its list. */
export interface NotificationOptions {
  /** Channels the platform has connected and allows. */
  channels: NotifyChannel[];
  people: { userId: string; name: string; role: string; roleName: string; hasPhone: boolean }[];
  roles: { id: string; name: string }[];
  /** The alerts of the account, to notify only about some. */
  rules: { id: string; name: string }[];
  /** Whether this person can write addresses by hand: only who sees the whole account. */
  canAddress: boolean;
  /** Whether the custom channel sends one message per person (its owner used their details) or one for everyone. */
  customPerPerson: boolean;
  /** How many messages the account has sent this month through each capped channel, and its cap. */
  usage: { channel: NotifyChannel; sent: number; cap: number | null }[];
}
