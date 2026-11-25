// Modules enabled per account. A switched-off module does not respond in the API nor
// act on that account's positions.
import type { ModuleKey } from "@opengps/shared";
import type { Bus } from "../bus";
import type { Queryable } from "../db";

export interface ModuleGate {
  enabled(orgId: string, key: ModuleKey): Promise<boolean>;
}

const TTL_MS = 30_000;

export function createModuleGate(db: Queryable, bus: Bus): ModuleGate {
  const cache = new Map<string, { at: number; modules: string[] }>();
  bus.on("modules_changed", (e) => {
    cache.delete(e.orgId);
  });
  return {
    async enabled(orgId, key) {
      const hit = cache.get(orgId);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.modules.includes(key);
      const r = await db.query<{ modules: string[]; suspended: boolean }>(`SELECT modules, suspended FROM gps.account_settings WHERE org_id = $1`, [orgId]);
      // A suspended account has no module running.
      const modules = r.rows[0] && !r.rows[0].suspended ? r.rows[0].modules : [];
      cache.set(orgId, { at: Date.now(), modules });
      return modules.includes(key);
    },
  };
}
