// The platform's version against the latest release, and installing it from
// the console, only for whoever administers the platform (ADR-0003, ADR-0004).
// Anyone else gets a 404.
import type { UpdateCheck, UpdateInstallMode, UpdateStatus } from "@opengps/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionContext } from "../auth";
import type { Backups } from "../core/backups";
import type { Updates } from "../core/updates";
import { badRequest } from "../errors";
import { say } from "../i18n";

/** When the owner opens the platform, a look older than this is repeated. */
const ON_OPEN_MS = 60 * 60_000;
/** "Look now" repeats a look older than this. */
const ON_REQUEST_MS = 60_000;

const installSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });

export function registerUpdates(deps: {
  app: FastifyInstance;
  updates: Updates;
  backups: Backups;
  platformAdmin(request: FastifyRequest): Promise<SessionContext>;
  clientIp(request: FastifyRequest): string;
  parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T>;
}) {
  const { app, updates, backups, platformAdmin, clientIp, parse } = deps;

  /** A build from the code is not a release image: it is not updated from the console. */
  async function modeOf(check: UpdateCheck): Promise<UpdateInstallMode> {
    if (check.current.includes("-")) return "source";
    const helper = await backups.helper();
    return helper.alive && helper.canUpdate ? "console" : "manual";
  }
  const withInstall = async (check: UpdateCheck): Promise<UpdateStatus> => ({ ...check, install: { mode: await modeOf(check), last: await backups.lastUpdate() } });

  app.get("/api/admin/updates", async (request): Promise<{ updates: UpdateStatus }> => {
    await platformAdmin(request);
    return { updates: await withInstall(await updates.check({ maxAgeMs: ON_OPEN_MS })) };
  });

  app.post("/api/admin/updates/check", async (request): Promise<{ updates: UpdateStatus }> => {
    await platformAdmin(request);
    return { updates: await withInstall(await updates.check({ maxAgeMs: ON_REQUEST_MS })) };
  });

  // Installs the latest version: the backup before it is made after responding, and the helper does the rest.
  app.post("/api/admin/updates/install", async (request, reply): Promise<{ updates: UpdateStatus }> => {
    const admin = await platformAdmin(request);
    const { version } = parse(installSchema, request.body);
    const check = updates.status();
    if (!check.available || check.latest?.version !== version) throw badRequest(say("core.updates.notLatest"));
    if ((await modeOf(check)) !== "console") throw badRequest(say("core.updates.noHelper"));
    await backups.requestUpdate(version, check.current, { userId: admin.userId, ip: clientIp(request) });
    reply.status(202);
    return { updates: await withInstall(check) };
  });
}
