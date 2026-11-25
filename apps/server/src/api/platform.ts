// Admin console: settings, mail, external storage and backups.
// Only for those who administer the platform.
import {
  type Language,
  type MailTemplateInfo,
  NOTIFY_CHANNELS,
  type NotifyChannel,
  type PlatformSettings,
  addressLabel,
  addressProblem,
  backupSettingsSchema,
  channelSettingsSchema,
  generalSettingsSchema,
  mailSettingsSchema,
  mailTemplatesSchema,
  oauthSettingsSchema,
  passwordPolicySchema,
  restoreSchema,
  storageSettingsSchema,
  systemNotificationSchema,
} from "@opengps/shared";
import { say, shared, tr } from "../i18n";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionContext } from "../auth";
import type { Bus } from "../bus";
import type { Config } from "../config";
import type { Backups } from "../core/backups";
import { type Message, channelProblem, customAudience, recipientTarget, writtenRecipient } from "../core/channels";
import { mailTemplateInfo, writeMail } from "../core/mail-templates";
import { type Outbox, listDeliveries } from "../core/outbox";
import { S3Error, testStorage } from "../core/s3";
import type { Section, Settings, SettingsInput } from "../core/settings";
import type { SystemNotifier } from "../core/system";
import { syncRetention } from "../core/tasks";
import type { Db } from "../db";
import { badRequest, notFound } from "../errors";
import type { Mailer } from "../mail";
import type { Traccar } from "../traccar";

const SCHEMAS = {
  general: generalSettingsSchema,
  passwords: passwordPolicySchema,
  mail: mailSettingsSchema,
  storage: storageSettingsSchema,
  backups: backupSettingsSchema,
  channels: channelSettingsSchema,
  oauth: oauthSettingsSchema,
  mailTemplates: mailTemplatesSchema,
} satisfies Record<Section, z.ZodType>;

export interface PlatformRoutes {
  app: FastifyInstance;
  db: Db;
  bus: Bus;
  config: Config;
  traccar: Traccar;
  mailer: Mailer;
  settings: Settings;
  backups: Backups;
  outbox: Outbox;
  system: SystemNotifier;
  platformAdmin(request: FastifyRequest): Promise<SessionContext>;
  clientIp(request: FastifyRequest): string;
  /** The language a request is answered in. */
  language(request: FastifyRequest): Language;
  parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T>;
}

/** The email that checks the mail server, in a language. */
export const mailTestMail = (config: Pick<Config, "appName" | "smtp" | "mailTemplates">, language: Language) =>
  writeMail(config.mailTemplates, "mailTest", language, { app: config.appName, host: config.smtp.host });

/** The message that checks a channel, in a language. */
export function channelTestMessage(config: Pick<Config, "appName" | "publicUrl">, language: Language): Message {
  return {
    title: tr(language, "mail.channelTest.title", { app: config.appName }),
    body: tr(language, "mail.channelTest.body"),
    action: { label: tr(language, "mail.action.console"), url: `${config.publicUrl}/admin/system/channels` },
    language,
    data: { type: "test", label: tr(language, "mail.channelTest.label"), createdAt: new Date().toISOString() },
  };
}

export function registerPlatformSettings(ctx: PlatformRoutes): void {
  const { app, config, settings, backups, outbox, system, platformAdmin, clientIp, parse } = ctx;
  const actorOf = (admin: SessionContext, request: FastifyRequest) => ({ userId: admin.userId, ip: clientIp(request) });

  app.get("/api/admin/settings", async (request): Promise<{ settings: PlatformSettings }> => {
    await platformAdmin(request);
    return { settings: settings.view() };
  });

  app.put<{ Params: { section: string } }>("/api/admin/settings/:section", async (request) => {
    const admin = await platformAdmin(request);
    const section = request.params.section as Section;
    if (!Object.hasOwn(SCHEMAS, section)) throw notFound();
    const retention = config.historyRetentionDays;
    const data = parse(SCHEMAS[section], request.body) as SettingsInput[Section];
    const saved = await settings.save(section, data, actorOf(admin, request));
    // The database applies the history retention period: it is notified as soon as it changes.
    if (section === "general" && config.historyRetentionDays !== retention && !config.disableBackground) {
      await syncRetention({ db: ctx.db, bus: ctx.bus, traccar: ctx.traccar, config });
    }
    return { settings: saved };
  });

  /** Resets a section to how it was: what was saved is forgotten and the server's values apply again. */
  app.delete<{ Params: { section: string } }>("/api/admin/settings/:section", async (request) => {
    const admin = await platformAdmin(request);
    const section = request.params.section as Section;
    if (!Object.hasOwn(SCHEMAS, section)) throw notFound();
    const retention = config.historyRetentionDays;
    const saved = await settings.reset(section, actorOf(admin, request));
    if (section === "general" && config.historyRetentionDays !== retention && !config.disableBackground) {
      await syncRetention({ db: ctx.db, bus: ctx.bus, traccar: ctx.traccar, config });
    }
    return { settings: saved };
  });

  /** The emails the platform writes, with their variables and how it writes them in each language, to rewrite them. */
  app.get("/api/admin/settings/mail/templates", async (request): Promise<{ templates: MailTemplateInfo[] }> => {
    await platformAdmin(request);
    return { templates: mailTemplateInfo() };
  });

  /** Sends a test email to whoever requests it, using the current mail server. */
  app.post("/api/admin/settings/mail/test", async (request) => {
    const admin = await platformAdmin(request);
    if (!config.smtp.host) throw badRequest(say("api.platform.noMailServer"));
    try {
      // It goes to whoever asks for it: in the language they are using.
      await ctx.mailer.send({ to: admin.email, ...mailTestMail(config, ctx.language(request)) });
    } catch (err) {
      throw badRequest(say("api.platform.mailRefused", { reason: (err as Error).message }));
    }
    return { sentTo: admin.email };
  });

  /**
   * Writes, reads and deletes a test file in the external storage.
   * With the form data in the body, those are tested, without saving them;
   * with no body, the ones already saved.
   */
  app.post("/api/admin/settings/storage/test", async (request, reply) => {
    await platformAdmin(request);
    const body = request.body as Record<string, unknown> | null | undefined;
    const target = body && Object.keys(body).length > 0 ? await settings.storageTarget(parse(storageSettingsSchema, body)) : config.storage;
    if (!target) throw badRequest(say("api.platform.storageNeeded"));
    try {
      await testStorage(target);
    } catch (err) {
      if (err instanceof S3Error) throw badRequest(err.text);
      throw err;
    }
    return reply.status(204).send();
  });

  // ─── Channels and notifications of the platform ────────────────────────────

  /** Sends a test message through a channel, with what is saved, to an address written right there. */
  app.post<{ Params: { channel: string } }>("/api/admin/channels/:channel/test", async (request) => {
    await platformAdmin(request);
    const channel = NOTIFY_CHANNELS.find((c) => c === request.params.channel) as NotifyChannel | undefined;
    if (!channel) throw notFound();
    if (channel === "push") throw badRequest(say("api.platform.pushNotYet"));
    // In the custom channel what is written only fills its variables, and may be left empty.
    const { to } = parse(z.object({ to: z.string().trim().max(500).default("") }), request.body);
    if (!to && channel !== "webhook") throw badRequest(say("api.validation.testTarget"));
    const wrong = to ? addressProblem(channel, to) : null;
    if (wrong) throw badRequest(shared(wrong));
    const problem = channelProblem(config, channel);
    if (problem) throw badRequest(problem);
    const custom = channel === "webhook" ? { target: recipientTarget(writtenRecipient(to)), label: to ? addressLabel(channel, to) : customAudience(config.channels.webhook).label } : { target: to };
    const [id] = await outbox.enqueue([
      {
        orgId: null,
        source: "test",
        sourceId: null,
        channel,
        ...custom,
        topic: "test",
        message: channelTestMessage(config, ctx.language(request)),
        once: true,
      },
    ]);
    await outbox.deliverDue();
    const delivery = (await listDeliveries(ctx.db.core, { orgId: null, limit: 20 })).find((d) => d.id === id);
    if (delivery?.status !== "ok") throw badRequest(delivery?.error ?? say("api.platform.testNotSent"));
    return { sentTo: delivery.to };
  });

  app.get("/api/admin/notifications", async (request) => {
    await platformAdmin(request);
    return { notifications: await system.list(), deliveries: await system.log() };
  });

  app.post("/api/admin/notifications", async (request, reply) => {
    const admin = await platformAdmin(request);
    return reply.status(201).send({ notifications: await system.save(null, parse(systemNotificationSchema, request.body), actorOf(admin, request)) });
  });

  app.put<{ Params: { id: string } }>("/api/admin/notifications/:id", async (request) => {
    const admin = await platformAdmin(request);
    return { notifications: await system.save(request.params.id, parse(systemNotificationSchema, request.body), actorOf(admin, request)) };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/notifications/:id", async (request, reply) => {
    const admin = await platformAdmin(request);
    await system.remove(request.params.id, actorOf(admin, request));
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/admin/notifications/:id/test", async (request) => {
    await platformAdmin(request);
    return { deliveries: await system.test(request.params.id) };
  });

  // ─── Backups ───────────────────────────────────────────────────────────────

  app.get("/api/admin/backups", async (request) => {
    await platformAdmin(request);
    return { info: await backups.info() };
  });

  /** Starts a backup now. It takes a while: the response returns right away and the console polls its progress. */
  app.post("/api/admin/backups", async (request, reply) => {
    const admin = await platformAdmin(request);
    if (!(await backups.info()).available) throw badRequest(say("api.platform.backupsUnavailable"));
    backups.run("manual", actorOf(admin, request)).catch((err: Error) => request.log.error(err));
    return reply.status(202).send({ info: await backups.info() });
  });

  /**
   * Looks in the external storage for backups that are not in the list and
   * adds them: on a new installation, the backups of the one it replaces, to restore them.
   */
  app.post("/api/admin/backups/discover", async (request) => {
    const admin = await platformAdmin(request);
    try {
      const result = await backups.discover(actorOf(admin, request));
      return { ...result, info: await backups.info() };
    } catch (err) {
      if (err instanceof S3Error) throw badRequest(err.text);
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/admin/backups/:id", async (request, reply) => {
    const admin = await platformAdmin(request);
    await backups.remove(request.params.id, actorOf(admin, request));
    return reply.status(204).send();
  });

  /**
   * Requests restoring a backup: the platform goes back to how it was then. The
   * restore helper does it, stopping the platform while it runs; before that, a
   * backup of the current state is saved. The confirmation word must be typed.
   */
  app.post<{ Params: { id: string } }>("/api/admin/backups/:id/restore", async (request, reply) => {
    const admin = await platformAdmin(request);
    parse(restoreSchema, request.body);
    await backups.restore(request.params.id, actorOf(admin, request));
    return reply.status(202).send({ info: await backups.info() });
  });

  app.get<{ Params: { id: string; name: string } }>("/api/admin/backups/:id/files/:name", async (request, reply) => {
    const admin = await platformAdmin(request);
    const file = await backups.open(request.params.id, request.params.name, actorOf(admin, request));
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", file.bytes)
      .header("Content-Disposition", `attachment; filename="${file.name}"`)
      .header("Cache-Control", "private, no-store")
      .send(file.stream);
  });
}
