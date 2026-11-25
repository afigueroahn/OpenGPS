// The platform's version against the latest release, only for whoever
// administers the platform (ADR-0003). Anyone else gets a 404.
import type { UpdateStatus } from "@opengps/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionContext } from "../auth";
import type { Updates } from "../core/updates";

/** When the owner opens the platform, a look older than this is repeated. */
const ON_OPEN_MS = 60 * 60_000;
/** "Look now" repeats a look older than this. */
const ON_REQUEST_MS = 60_000;

export function registerUpdates(deps: { app: FastifyInstance; updates: Updates; platformAdmin(request: FastifyRequest): Promise<SessionContext> }) {
  const { app, updates, platformAdmin } = deps;

  app.get("/api/admin/updates", async (request): Promise<{ updates: UpdateStatus }> => {
    await platformAdmin(request);
    return { updates: await updates.check({ maxAgeMs: ON_OPEN_MS }) };
  });

  app.post("/api/admin/updates/check", async (request): Promise<{ updates: UpdateStatus }> => {
    await platformAdmin(request);
    return { updates: await updates.check({ maxAgeMs: ON_REQUEST_MS }) };
  });
}
