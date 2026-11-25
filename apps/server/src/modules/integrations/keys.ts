// Integrations: the keys with which another system queries the public API,
// and the query limit of each one.
import { createHash, randomBytes } from "node:crypto";
import { API_KEYS_MAX, API_RATE_PER_MINUTE, type ApiKey, type apiKeySchema } from "@opengps/shared";
import type { z } from "zod";
import { isUuid } from "../../core/access";
import { audit } from "../../core/audit";
import type { Actor } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { badRequest, notFound } from "../../errors";
import { say } from "../../i18n";
import type { ModuleDeps } from "../context";

type Deps = Pick<ModuleDeps, "db">;
export const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
/** A new key, with its recognizable beginning: "gps_" for the API, "sns_" for a sensor, "whsec_" for signing. */
export const newSecret = (kind: "gps" | "sns" | "whsec") => `${kind}_${randomBytes(24).toString("base64url")}`;
/** What is shown of a key in a list. */
export const prefixOf = (secret: string) => `${secret.slice(0, 9)}…`;

interface Row {
  id: string;
  name: string;
  prefix: string;
  can_write: boolean;
  created_at: Date;
  last_used_at: Date | null;
}
const toKey = (r: Row): ApiKey => ({ id: r.id, name: r.name, prefix: r.prefix, canWrite: r.can_write, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null });

export async function listKeys(db: Queryable, orgId: string): Promise<ApiKey[]> {
  const r = await db.query<Row>(`SELECT id, name, prefix, can_write, created_at, last_used_at FROM gps.api_keys WHERE org_id = $1 AND revoked_at IS NULL ORDER BY created_at`, [orgId]);
  return r.rows.map(toKey);
}

/** Creates a key. The full key is returned this one time: afterwards only its fingerprint is stored. */
export async function createKey(deps: Deps, actor: Actor, data: z.output<typeof apiKeySchema>): Promise<{ keys: ApiKey[]; secret: string }> {
  const db = deps.db.core;
  if ((await listKeys(db, actor.orgId)).length >= API_KEYS_MAX) throw badRequest(say("integrations.errors.tooManyKeys", { max: API_KEYS_MAX }));
  const secret = newSecret("gps");
  await db.query(`INSERT INTO gps.api_keys (org_id, name, prefix, key_hash, can_write, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [actor.orgId, data.name, prefixOf(secret), hashOf(secret), data.canWrite, actor.userId]);
  await audit(db, actor, "integrations.key.create", "account", actor.orgId, { name: data.name, canWrite: data.canWrite });
  return { keys: await listKeys(db, actor.orgId), secret };
}

/** Removes a key: it stops working right away. */
export async function revokeKey(deps: Deps, actor: Actor, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound(say("integrations.errors.keyNotFound"));
  const r = await deps.db.core.query<{ name: string }>(`UPDATE gps.api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL RETURNING name`, [id, actor.orgId]);
  if (!r.rows[0]) throw notFound(say("integrations.errors.keyNotFound"));
  await audit(deps.db.core, actor, "integrations.key.revoke", "account", actor.orgId, { name: r.rows[0].name });
}

export interface KeyContext {
  keyId: string;
  orgId: string;
  canWrite: boolean;
  /** Whoever created the key: what is recorded with it is under their name. */
  userId: string;
}

/** Which account a key belongs to, or null if it does not exist or was removed. */
export async function authenticate(db: Queryable, token: string): Promise<KeyContext | null> {
  if (!token.startsWith("gps_") || token.length > 100) return null;
  const r = await db.query<{ id: string; org_id: string; can_write: boolean; created_by: string | null; last_used_at: Date | null }>(
    `SELECT id, org_id, can_write, created_by, last_used_at FROM gps.api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashOf(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  // When it was last used is recorded at most once per minute.
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) await db.query(`UPDATE gps.api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
  return { keyId: row.id, orgId: row.org_id, canWrite: row.can_write, userId: row.created_by ?? "" };
}

/** Queries per minute of each key: a sliding window. */
export function createLimiter(perMinute = API_RATE_PER_MINUTE) {
  const log = new Map<string, number[]>();
  return {
    /** Records a query and says how many are left in this minute; negative if already exceeded. */
    hit(keyId: string, now = Date.now()): { remaining: number; resetS: number } {
      const recent = (log.get(keyId) ?? []).filter((t) => now - t < 60_000);
      if (log.size > 5000) log.clear();
      const resetS = recent[0] === undefined ? 60 : Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
      if (recent.length >= perMinute) {
        log.set(keyId, recent);
        return { remaining: -1, resetS };
      }
      recent.push(now);
      log.set(keyId, recent);
      return { remaining: perMinute - recent.length, resetS };
    },
    limit: perMinute,
  };
}
