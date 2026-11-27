// Requests.
import { INCIDENT_RESOLUTIONS } from "./antitheft";
import { confirmWords } from "./confirm";
import { cronProblem } from "./cron";
import { FUEL_KINDS } from "./fuel";
import { GEOFENCE_LIMITS, type GeofenceGeometry, geometryProblem } from "./geo";
import { GEOFENCE_KINDS } from "./geofences";
import { LANGUAGES, type Language } from "./languages";
import type { SharedSay } from "./locales";
import { ALL_MODULES, type ModuleKey } from "./modules";
import { ALL_DASHBOARD_WIDGETS, DASHBOARD_PERIODS, REPORT_FORMATS, REPORT_FREQUENCIES, REPORT_PARAMS_DEFAULT, REPORT_TYPES, SCHEDULE_RECIPIENTS_MAX } from "./reports";
import { ALL_PERMISSIONS, type Permission } from "./roles";
import { isValidZone } from "./schedule";
import { BACKUP_MIN_GAP_MIN, HISTORY_RETENTION_MIN_DAYS, MAIL_SECURITIES, PASSWORD_MIN, UPLOAD_MAX_MB } from "./settings";
import { SHARE_MAX_HOURS } from "./share";
import { STORAGE_FLAGS_MAX, STORAGE_FLAG_MAX_LENGTH, STORAGE_PROVIDERS, STORAGE_PROVIDER_DEFAULT, storageFlagProblem, storageNeedsEndpoint } from "./storage";
import { issueOf, v } from "./validation";
import { z } from "zod";

/** Device identifier: 15-digit IMEI or the short ID of some models. */
export const uniqueIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z]{6,20}$/, v("validation.deviceId"));

const nameSchema = z.string().trim().min(1, v("validation.aNameNeeded")).max(60);
const plateSchema = z
  .string()
  .trim()
  .max(20)
  .transform((s) => (s === "" ? null : s.toUpperCase()))
  .nullable()
  .optional();

/** The model of the family's list, if the person found theirs. */
const modelNameSchema = z.string().trim().min(1).max(60).nullable().default(null);
export const createVehicleSchema = z.object({
  name: nameSchema,
  plate: plateSchema,
  uniqueId: uniqueIdSchema,
  modelId: z.string().min(1),
  modelName: modelNameSchema,
});
export type CreateVehicleInput = z.input<typeof createVehicleSchema>;

export const updateVehicleSchema = z.object({
  name: nameSchema.optional(),
  plate: plateSchema,
  /** Vehicle's group; null leaves it without a group. */
  groupId: z.uuid().nullable().optional(),
});
export type UpdateVehicleInput = z.input<typeof updateVehicleSchema>;

export const attachDeviceSchema = z.object({
  uniqueId: uniqueIdSchema,
  modelId: z.string().min(1),
  modelName: modelNameSchema,
});
export type AttachDeviceInput = z.input<typeof attachDeviceSchema>;

const scopeSchema = z.array(z.uuid()).max(100).nullable();
/** Vehicles a person sees one by one, besides those of their groups. */
const vehicleScopeSchema = z.array(z.uuid()).max(500);

export const inviteSchema = z.object({
  email: z.email(v("validation.emailNeeded")).transform((s) => s.trim().toLowerCase()),
  role: z.string().min(1),
  /** Groups it will be able to see; null = all. */
  groups: scopeSchema.default(null),
  /** Vehicles it will see one by one; only counts when `groups` is not null. */
  vehicles: vehicleScopeSchema.default([]),
});
export type InviteInput = z.input<typeof inviteSchema>;

export const memberUpdateSchema = z.object({
  role: z.string().min(1).optional(),
  groups: scopeSchema.optional(),
  vehicles: vehicleScopeSchema.optional(),
  disabled: z.boolean().optional(),
});
export type MemberUpdateInput = z.input<typeof memberUpdateSchema>;

export const roleSchema = z.object({
  name: z.string().trim().min(1, v("validation.roleName")).max(40),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])).default([]),
});
export type RoleInput = z.input<typeof roleSchema>;

const lonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const geometrySchema = z
  .discriminatedUnion("shape", [
    z.object({ shape: z.literal("circle"), center: lonLat, radiusM: z.number().positive() }),
    z.object({ shape: z.literal("polygon"), ring: z.array(lonLat).max(GEOFENCE_LIMITS.maxVertices) }),
    z.object({ shape: z.literal("corridor"), line: z.array(lonLat).max(GEOFENCE_LIMITS.maxVertices), widthM: z.number().positive() }),
  ])
  .superRefine((geometry, ctx) => {
    const problem = geometryProblem(geometry as GeofenceGeometry);
    if (problem) ctx.addIssue(issueOf(problem));
  });

const dayWindow = z.tuple([z.number().int().min(0).max(1439), z.number().int().min(0).max(1440)]);
export const scheduleSchema = z.object({
  zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")),
  days: z.array(dayWindow.nullable()).length(7).refine((days) => days.some((d) => d !== null), v("validation.dayNeeded")),
});

const stayMinutes = z.number().int().min(1, v("validation.stayMin")).max(30 * 24 * 60, v("validation.stayMax")).nullable().default(null);
export const geofenceSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.geofenceName")).max(60),
    geometry: geometrySchema,
    kind: z.enum(GEOFENCE_KINDS).default("notify"),
    schedule: scheduleSchema.nullable().default(null),
    minStayMin: stayMinutes,
    maxStayMin: stayMinutes,
    groupIds: z.array(z.uuid()).max(200).nullable().default(null),
    vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(500).nullable().default(null),
    active: z.boolean().default(true),
  })
  .refine((g) => g.minStayMin === null || g.maxStayMin === null || g.minStayMin < g.maxStayMin, v("validation.stayOrder"))
  .refine((g) => g.groupIds === null || g.vehicleIds === null, v("validation.groupsOrVehicles"));
export type GeofenceInput = z.input<typeof geofenceSchema>;

const alertBase = {
  name: z.string().trim().min(1, v("validation.alertName")).max(60),
  /** Days and hours when the alert watches; null = always. */
  schedule: scheduleSchema.nullable().default(null),
  /** Vehicles it applies to. With this and groups both null, it applies to all. */
  vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(500).nullable().default(null),
  groupIds: z.array(z.uuid()).min(1, v("validation.groupNeeded")).max(200).nullable().default(null),
  active: z.boolean().default(true),
  /** Time zone used to write times in its notifications. */
  zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")).default("UTC"),
};
const noParams = z.object({}).default({});
const conditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("speed"), op: z.enum(["gt", "lt"]), value: z.number().min(0).max(300) }),
  z.object({ field: z.literal("ignition"), value: z.boolean() }),
  z.object({ field: z.literal("geofence"), inside: z.boolean(), geofenceId: z.uuid() }),
  z.object({ field: z.literal("power"), op: z.enum(["gt", "lt"]), value: z.number().min(0).max(60) }),
  z.object({ field: z.literal("battery"), op: z.literal("lt"), value: z.number().min(1).max(100) }),
]);
export const alertRuleSchema = z.discriminatedUnion("type", [
  z.object({
    ...alertBase,
    type: z.literal("speeding"),
    params: z.object({
      limitKmh: z.number().int().min(10, v("validation.speedLimitMin10")).max(250),
      /** Consecutive time above the limit before notifying. */
      seconds: z.number().int().min(0).max(600).default(20),
      /** If given, the limit only applies inside that geofence. */
      geofenceId: z.uuid().nullable().default(null),
    }),
  }),
  z.object({ ...alertBase, type: z.literal("ignition_off_hours"), params: z.object({ allowed: scheduleSchema }) }),
  z.object({ ...alertBase, type: z.literal("signal_lost"), params: z.object({ minutes: z.number().int().min(5, v("validation.signalLostMin")).max(7 * 24 * 60) }) }),
  z.object({ ...alertBase, type: z.literal("parked_movement"), params: z.object({ meters: z.number().int().min(50).max(2000).default(150) }).default({ meters: 150 }) }),
  z.object({ ...alertBase, type: z.literal("sos"), params: noParams }),
  z.object({ ...alertBase, type: z.literal("power_cut"), params: noParams }),
  z.object({ ...alertBase, type: z.literal("tow"), params: noParams }),
  z.object({ ...alertBase, type: z.literal("harsh_driving"), params: noParams }),
  z.object({
    ...alertBase,
    type: z.literal("geofence"),
    params: z.object({ geofenceIds: z.array(z.uuid()).min(1).max(200).nullable().default(null) }).default({ geofenceIds: null }),
  }),
  z.object({
    ...alertBase,
    type: z.literal("custom"),
    params: z.object({
      conditions: z.array(conditionSchema).min(1, v("validation.conditionNeeded")).max(6),
      /** Consecutive time being met before notifying. */
      seconds: z.number().int().min(0).max(3600).default(0),
    }),
  }),
]);
export type AlertRuleInput = z.input<typeof alertRuleSchema>;
export type AlertRuleData = z.output<typeof alertRuleSchema>;
export type AlertRule = AlertRuleData & { id: string; createdAt: string };

export const parkSchema = z.object({ parked: z.boolean() });

export const lockPrepareSchema = z.object({ action: z.enum(["lock", "unlock"]) });
export const lockSchema = z.object({
  action: z.enum(["lock", "unlock"]),
  confirmToken: z.string().min(10).max(400),
  /** The word typed by the person: the one of the action, in any language (see `isConfirmWord`). */
  word: z.string().trim().max(20),
});
export const recoverySchema = z.object({ on: z.boolean() });
export const incidentCreateSchema = z.object({ vehicleId: z.uuid(), note: z.string().trim().min(1, v("validation.incidentDescription")).max(1000) });
export const incidentNoteSchema = z.object({ text: z.string().trim().min(1, v("validation.noteNeeded")).max(2000) });
export const incidentCloseSchema = z.object({ resolution: z.enum(INCIDENT_RESOLUTIONS), note: z.string().trim().max(2000).default("") });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => v || null);
export const driverSchema = z.object({
  name: z.string().trim().min(1, v("validation.driverName")).max(80),
  license: optionalText(40),
  phone: optionalText(30),
  keyId: optionalText(40).refine((v) => v === null || /^[0-9A-Fa-f]{4,32}$/.test(v), v("validation.driverKey")),
  notes: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
});
export type DriverInput = z.input<typeof driverSchema>;
export const assignDriverSchema = z.object({ driverId: z.uuid().nullable() });
export const driverSettingsSchema = z.object({
  speedLimitKmh: z.number().int().min(20).max(200),
  speedingSeconds: z.number().int().min(0).max(300),
  maxContinuousMin: z.number().int().min(30).max(720),
  minRestMin: z.number().int().min(5).max(240),
  maxDailyMin: z.number().int().min(60).max(1440),
});

export const fuelTankSchema = z
  .object({
    capacityL: z.number().min(5, v("validation.tankCapacityMin")).max(5000),
    attr: z
      .string()
      .trim()
      .max(40)
      .regex(/^[A-Za-z0-9_]*$/, v("validation.attrInvalid"))
      .nullable()
      .default(null)
      .transform((v) => v || null),
    kind: z.enum(FUEL_KINDS).default("percent"),
    calibration: z
      .array(z.tuple([z.number(), z.number().min(0)]))
      .min(2, v("validation.calibrationPoints"))
      .max(60)
      .nullable()
      .default(null),
    counterAttr: z
      .string()
      .trim()
      .max(40)
      .regex(/^[A-Za-z0-9_]*$/, v("validation.attrInvalid"))
      .nullable()
      .default(null)
      .transform((v) => v || null),
    counterUnit: z.enum(["l", "dl", "ml"]).default("l"),
    normL100km: z.number().min(0.5).max(200).nullable().default(null),
    normIdleLh: z.number().min(0.1).max(50).nullable().default(null),
  })
  .refine((t) => t.attr !== null || t.counterAttr !== null || t.normL100km !== null || t.normIdleLh !== null, v("validation.tankSource"))
  .refine((t) => t.attr === null || t.kind !== "raw" || t.calibration !== null, v("validation.calibrationNeeded"))
  .refine((t) => t.calibration === null || t.calibration.every((row, i, all) => i === 0 || row[0] > (all[i - 1] as [number, number])[0]), v("validation.calibrationOrder"));
export type FuelTankInput = z.input<typeof fuelTankSchema>;
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, v("validation.currencyCode"));
const shortText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => v || null);
export const fuelFillSchema = z
  .object({
    at: z.coerce.date(v("validation.fillDateNeeded")).refine((d) => d.getTime() <= Date.now() + 86_400_000, v("validation.dateInFuture")),
    liters: z.number(v("validation.litersNeeded")).gt(0, v("validation.litersPositive")).max(5000),
    total: z.number().min(0).max(100_000_000).nullable().default(null),
    currency: currencySchema.nullable().default(null),
    odometerKm: z.number().min(0).max(5_000_000).nullable().default(null),
    station: shortText(80),
    note: shortText(200),
    /** "detected" when recording a refueling the sensor saw. */
    source: z.enum(["manual", "detected"]).default("manual"),
  })
  .refine((f) => f.total === null || f.currency !== null, v("validation.totalCurrency"));
export type FuelFillInput = z.input<typeof fuelFillSchema>;
export const fuelImportSchema = z.object({
  csv: z.string().min(1, v("validation.fileEmpty")).max(1_000_000, v("validation.fileTooBig")),
  /** Time zone for the file's dates that do not carry their own. */
  zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")),
});
export const fuelSettingsSchema = z.object({
  currency: currencySchema,
  zone: z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone")),
});
const zoneSchema = z.string().trim().min(1).max(64).refine(isValidZone, v("validation.zone"));
export const reportParamsSchema = z.object({
  groupId: z.uuid().nullable().default(null),
  vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(300).nullable().default(null),
  speedLimitKmh: z.number().int().min(20, v("validation.speedLimitMin20")).max(200).default(REPORT_PARAMS_DEFAULT.speedLimitKmh),
  minStopMin: z.number().int().min(3, v("validation.stopMin")).max(1440).default(REPORT_PARAMS_DEFAULT.minStopMin),
});
export const reportScheduleSchema = z.object({
  name: z.string().trim().min(1, v("validation.reportName")).max(60),
  type: z.enum(REPORT_TYPES),
  params: reportParamsSchema,
  frequency: z.enum(REPORT_FREQUENCIES),
  atMinute: z.number().int().min(0).max(1439),
  weekday: z.number().int().min(0).max(6).default(1),
  monthDay: z.number().int().min(1).max(28).default(1),
  zone: zoneSchema,
  format: z.enum(REPORT_FORMATS),
  recipients: z.array(z.string().min(1).max(64)).min(1, v("validation.recipientNeeded")).max(SCHEDULE_RECIPIENTS_MAX),
  active: z.boolean().default(true),
});
export type ReportScheduleInput = z.input<typeof reportScheduleSchema>;
export const dashboardSchema = z
  .object({
    name: z.string().trim().min(1, v("validation.dashboardName")).max(40),
    period: z.enum(DASHBOARD_PERIODS),
    groupId: z.uuid().nullable().default(null),
    vehicleIds: z.array(z.uuid()).min(1, v("validation.vehicleNeeded")).max(300).nullable().default(null),
    widgets: z
      .array(z.enum(ALL_DASHBOARD_WIDGETS))
      .min(1, v("validation.widgetNeeded"))
      .max(ALL_DASHBOARD_WIDGETS.length)
      .refine((list) => new Set(list).size === list.length, v("validation.widgetRepeated")),
  })
  .refine((d) => d.groupId === null || d.vehicleIds === null, v("validation.groupOrVehicles"));
export type DashboardInput = z.input<typeof dashboardSchema>;

const optionalCount = z.number().int().min(1).max(100_000).nullable().default(null);
const optionalEmail = z.union([z.literal(""), z.email(v("validation.emailInvalid"))]).default("");
export const generalSettingsSchema = z.object({
  registrationOpen: z.boolean(),
  passkeysEnabled: z.boolean().default(true),
  newAccountMaxVehicles: optionalCount,
  newAccountMaxUsers: optionalCount,
  newAccountModules: z.array(z.enum(ALL_MODULES as [ModuleKey, ...ModuleKey[]])).max(ALL_MODULES.length).default([]),
  mapStyleUrl: z.url(v("validation.mapUrl")).max(500),
  geocoderUrl: z.union([z.literal(""), z.url(v("validation.geocoderUrl")).max(500)]).default(""),
  geocoderUserAgent: z.string().trim().max(200).default(""),
  geocoderIntervalMs: z.number().int().min(0).max(60_000).default(1100),
  routingUrl: z.union([z.literal(""), z.url(v("validation.routingUrl")).max(500)]).default(""),
  claimWindowMinutes: z.number().int().min(5, v("validation.claimWindowMin")).max(24 * 60),
  maxPendingDevices: z.number().int().min(1).max(1000).default(20),
  historyRetentionDays: z
    .number()
    .int()
    .min(0)
    .max(3650)
    .refine((n) => n === 0 || n >= HISTORY_RETENTION_MIN_DAYS, { message: v("validation.historyRetention"), params: { days: HISTORY_RETENTION_MIN_DAYS } }),
  traccarRetentionDays: z.number().int().min(2).max(90),
  alertEmail: optionalEmail,
  diskAlertPercent: z.number().int().min(50).max(99),
  defaultLanguage: z.enum(LANGUAGES).default("es"),
  alertEmailsPerHour: z.number().int().min(1).max(1000),
  maxUploadMb: z.number().int().min(1).max(UPLOAD_MAX_MB),
  legalEntity: z.string().trim().max(120).default(""),
  legalCountry: z.string().trim().max(80).default(""),
  legalContactEmail: optionalEmail,
});
export type GeneralSettingsInput = z.input<typeof generalSettingsSchema>;
export const passwordPolicySchema = z.object({
  minLength: z
    .number()
    .int()
    .refine((n) => n >= PASSWORD_MIN, { message: v("validation.passwordMinLength"), params: { min: PASSWORD_MIN } })
    .max(64),
  number: z.boolean(),
  symbol: z.boolean(),
  lowercase: z.boolean(),
  uppercase: z.boolean(),
});
export const mailSettingsSchema = z
  .object({
    custom: z.boolean(),
    host: z.string().trim().max(200).default(""),
    port: z.number().int().min(1).max(65535).default(587),
    security: z.enum(MAIL_SECURITIES).default("starttls"),
    user: z.string().trim().max(200).default(""),
    /** Without this value, or empty, the saved key is kept. */
    password: z.string().max(500).optional(),
    from: z.string().trim().max(200).default(""),
  })
  .refine((m) => !m.custom || (m.host !== "" && m.from !== ""), v("validation.mailServer"));
export type MailSettingsInput = z.input<typeof mailSettingsSchema>;

/**
 * The emails the platform writes with words of its own, which the console can
 * rewrite. The notices of alerts and events are written from what happened, by
 * whoever sets them up, and are not here.
 */
export const MAIL_TEMPLATES = ["verifyEmail", "resetPassword", "existingAccount", "invitation", "panic", "panicUnattended", "scheduledReport", "mailTest"] as const;
export type MailTemplateId = (typeof MAIL_TEMPLATES)[number];
/** What each one may say with `{{variable}}`: the platform fills it in when it sends. `app` is the platform's name. */
export const MAIL_TEMPLATE_VARIABLES = {
  verifyEmail: ["app"],
  resetPassword: ["app"],
  existingAccount: ["app"],
  invitation: ["app", "inviter", "account", "role", "days"],
  panic: ["app", "vehicle"],
  panicUnattended: ["app", "vehicle", "minutes"],
  scheduledReport: ["app", "schedule", "headline", "title", "summary", "every", "who"],
  mailTest: ["app", "host"],
} as const satisfies Record<MailTemplateId, readonly string[]>;
export type MailTemplateVariable = (typeof MAIL_TEMPLATE_VARIABLES)[MailTemplateId][number];
/** Whether the email carries a button. The test only says the mail server works. */
export const mailTemplateHasAction = (id: MailTemplateId): boolean => id !== "mailTest";
/** The words of an email: its subject, the heading inside it, its text and the label of its button (empty when it has none). */
export interface MailTemplateText {
  subject: string;
  heading: string;
  body: string;
  action: string;
}
/** What the console rewrote, by email and language. What is not here goes as the platform writes it. */
export type MailTemplates = Partial<Record<MailTemplateId, Partial<Record<Language, MailTemplateText>>>>;
/** An email as the console shows it to be rewritten: what it may say and how the platform writes it in each language. */
export interface MailTemplateInfo {
  id: MailTemplateId;
  variables: readonly MailTemplateVariable[];
  action: boolean;
  defaults: Record<Language, MailTemplateText>;
}

/** What is wrong with an email's words: an empty field, or a `{{variable}}` the email does not have. Null if nothing. */
export function mailTemplateProblem(id: MailTemplateId, text: MailTemplateText): SharedSay | null {
  const action = mailTemplateHasAction(id);
  if (!text.subject.trim() || !text.heading.trim() || !text.body.trim() || (action && !text.action.trim())) return { key: "validation.mailTemplateField" };
  const known: readonly string[] = MAIL_TEMPLATE_VARIABLES[id];
  for (const field of [text.subject, text.heading, text.body, ...(action ? [text.action] : [])]) {
    for (const m of field.matchAll(/\{\{([^{}]*)\}\}/g)) {
      if (!known.includes((m[1] ?? "").trim())) return { key: "validation.mailTemplateVariable", params: { variable: m[0] } };
    }
  }
  return null;
}
const mailTemplateTextSchema = z.object({
  subject: z
    .string()
    .max(200)
    .transform((s) => s.replace(/\s+/g, " ").trim()),
  heading: z
    .string()
    .max(200)
    .transform((s) => s.replace(/\s+/g, " ").trim()),
  body: z
    .string()
    .max(4000)
    .transform((s) => s.replace(/\r\n?/g, "\n").trim()),
  action: z
    .string()
    .max(80)
    .transform((s) => s.trim())
    .default(""),
});
export const mailTemplatesSchema = z.partialRecord(z.enum(MAIL_TEMPLATES), z.partialRecord(z.enum(LANGUAGES), mailTemplateTextSchema)).superRefine((all, ctx) => {
  for (const id of MAIL_TEMPLATES) {
    for (const language of LANGUAGES) {
      const text = all[id]?.[language];
      const problem = text && mailTemplateProblem(id, text);
      if (problem) ctx.addIssue({ ...issueOf(problem), path: [id, language] });
    }
  }
});
export type MailTemplatesInput = z.input<typeof mailTemplatesSchema>;
export const storageSettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider: z
      .string()
      .refine((id) => STORAGE_PROVIDERS.some((p) => p.id === id), v("validation.storageProvider"))
      .default(STORAGE_PROVIDER_DEFAULT),
    endpoint: z.union([z.literal(""), z.url(v("validation.storageEndpoint")).max(300)]).default(""),
    region: z.string().trim().max(60).default("us-east-1"),
    bucket: z
      .string()
      .trim()
      .max(63)
      .refine((b) => b === "" || /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b), v("validation.bucketName"))
      .default(""),
    prefix: z
      .string()
      .trim()
      .max(200)
      .transform((p) => p.replace(/^\/+|\/+$/g, ""))
      .refine((p) => /^[A-Za-z0-9._\-/]*$/.test(p) && !p.includes("//"), v("validation.storagePrefix"))
      .default(""),
    accessKeyId: z.string().trim().max(200).default(""),
    /** Without this value, or empty, the saved key is kept. */
    secretAccessKey: z.string().max(500).optional(),
    /** Additional arguments for rclone. Empty lines are discarded. */
    flags: z
      .array(z.string().max(STORAGE_FLAG_MAX_LENGTH * 2))
      .max(STORAGE_FLAGS_MAX * 2)
      .default([])
      .transform((list) => list.map((f) => f.trim()).filter((f) => f !== ""))
      .superRefine((list, ctx) => {
        if (list.length > STORAGE_FLAGS_MAX) ctx.addIssue(issueOf({ key: "validation.storageFlagsMax", params: { max: STORAGE_FLAGS_MAX } }));
        for (const flag of list) {
          const problem = storageFlagProblem(flag);
          if (problem) ctx.addIssue(issueOf(problem));
        }
      }),
  })
  .refine((v) => !v.enabled || (v.bucket !== "" && v.accessKeyId !== ""), v("validation.storageBucketAndKey"))
  .refine((v) => !v.enabled || v.endpoint !== "" || !storageNeedsEndpoint(v.provider), v("validation.storageEndpointNeeded"));
export type StorageSettingsInput = z.input<typeof storageSettingsSchema>;
export const backupSettingsSchema = z.object({
  scheduled: z.boolean(),
  cron: z
    .string()
    .trim()
    .max(100)
    .transform((text) => text.replace(/\s+/g, " "))
    .superRefine((text, ctx) => {
      const problem = cronProblem(text, BACKUP_MIN_GAP_MIN);
      if (problem) ctx.addIssue(issueOf(problem));
    }),
  retentionDays: z.number().int().min(1).max(365),
  upload: z.boolean().default(false),
});
/** The word goes as the screen shows it, in capitals; the one of any language confirms. */
export const restoreSchema = z.object({ word: z.literal(confirmWords("restore"), v("validation.confirmRestore")) });
export type BackupSettingsInput = z.input<typeof backupSettingsSchema>;

export const shareSchema = z.object({
  hours: z.number().int().min(1, v("validation.shareMin")).max(SHARE_MAX_HOURS, v("validation.shareMax")),
  note: z.string().trim().max(60).default(""),
});
export type ShareInput = z.input<typeof shareSchema>;
/** The link is long and random; anything else is not even looked up. */
export const shareViewSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
/** Color mode of the interface: the device's, or one chosen by the person. */
export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
/** Only what is sent changes; `language: null` goes back to the platform's default. */
export const userSettingsSchema = z.object({
  /** How the person is called, everywhere: in every account they are in. */
  name: z.string().trim().min(2, v("validation.personName")).max(60).optional(),
  /** Where SMS notifications reach this person, with its country code; null = none. */
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, v("validation.phone"))
    .nullable()
    .optional(),
  theme: z.enum(THEME_MODES).optional(),
  language: z.enum(LANGUAGES).nullable().optional(),
});
/** The person's photo: the web app and the mobile apps send it already cut to a small square. */
export const USER_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type UserPhotoType = (typeof USER_PHOTO_TYPES)[number];
export const USER_PHOTO_MAX_BYTES = 512 * 1024;
/**
 * The type the photo is sent as, from the type of the picture the person chose: a PNG or a WebP may have a
 * transparent background, which only PNG keeps; any other picture goes as JPEG, lighter.
 */
export const photoTypeFor = (picture: string): "image/png" | "image/jpeg" =>
  picture === "image/png" || picture === "image/webp" ? "image/png" : "image/jpeg";

/** The account's own name, as its people and the platform's console see it. */
export const accountNameSchema = z.object({
  name: z.string().trim().min(2, v("validation.accountName")).max(60),
});

export const groupSchema = z.object({
  name: z.string().trim().min(1, v("validation.groupName")).max(40),
});
