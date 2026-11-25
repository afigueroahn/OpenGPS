// The numbers the administration panel opens with, for one account.
import type { AccountSummary } from "@opengps/shared";
import type { Queryable } from "../db";
import { type Tenant, scopeParam, scopeSql } from "./access";

/** What the person can see of their account: vehicles, the ones reporting, people and alerts of the last day. */
export async function accountSummary(db: Queryable, tenant: Tenant): Promise<AccountSummary> {
  const r = await db.query<{ vehicles: number; reporting: number; users: number; events: number }>(
    `SELECT (SELECT count(*) FROM gps.vehicles v WHERE v.org_id = $1 AND ${scopeSql(2)})::int AS vehicles,
            (SELECT count(*) FROM gps.vehicles v
               JOIN gps.devices d ON d.vehicle_id = v.id
               JOIN gps.device_state s ON s.device_id = d.id
              WHERE v.org_id = $1 AND ${scopeSql(2)} AND s.last_seen_at > now() - interval '10 minutes')::int AS reporting,
            (SELECT count(*) FROM auth.member m WHERE m."organizationId" = $1)::int AS users,
            (SELECT count(*) FROM gps.events e
               JOIN gps.vehicles v ON v.id = e.vehicle_id
              WHERE e.org_id = $1 AND ${scopeSql(2)} AND e.at > now() - interval '24 hours')::int AS events`,
    [tenant.orgId, scopeParam(tenant)],
  );
  const row = r.rows[0];
  return { vehicles: row?.vehicles ?? 0, reportingNow: row?.reporting ?? 0, users: row?.users ?? 0, events24h: row?.events ?? 0 };
}
