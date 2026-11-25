// What the core lends to each module to serve its routes.
import type { Language, ModuleKey, Permission } from "@opengps/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SessionContext } from "../auth";
import type { Bus } from "../bus";
import type { Config } from "../config";
import type { Actor } from "../core/vehicles";
import type { Db } from "../db";
import type { Outbox } from "../core/outbox";
import type { Mailer } from "../mail";
import type { Traccar } from "../traccar";
import type { ModuleGate } from "./gate";

export interface ModuleDeps {
  db: Db;
  bus: Bus;
  config: Config;
  traccar: Traccar;
  mailer: Mailer;
  gate: ModuleGate;
  /** Where every message that leaves the platform waits and is retried. */
  outbox: Outbox;
}

export interface ModuleContext extends ModuleDeps {
  app: FastifyInstance;
  /** The language a request is answered in. */
  language(request: FastifyRequest): Language;
  /**
   * Session of the request, for an account that has the module enabled. If
   * it does not, the route responds as if it did not exist.
   */
  session(request: FastifyRequest, module: ModuleKey, permission?: Permission): Promise<SessionContext>;
  actorOf(ctx: SessionContext, request: FastifyRequest): Actor;
  /** Brake for routes without a session, those of a public link: throws an error if that address queries too much. */
  publicLimit(request: FastifyRequest): void;
  parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T>;
}

export type IdParams = { Params: { id: string } };
