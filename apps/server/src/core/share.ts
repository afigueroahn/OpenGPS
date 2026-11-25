// Temporary links to share a vehicle's location. Whoever has
// the link sees where the vehicle is, and nothing more, until it expires or is revoked.
import { createHash, randomBytes } from "node:crypto";
import { SHARE_MAX_ACTIVE, type ShareLink, type SharedView, vehicleStatus } from "@opengps/shared";
import type { Bus } from "../bus";
import { type Db, type Queryable, withTransaction } from "../db";
import { badRequest, notFound } from "../errors";
import { say } from "../i18n";
import { type Tenant, isUuid, scopeParam, scopeSql } from "./access";
import { audit } from "./audit";
import { type Actor, getVehicle } from "./vehicles";

export interface ShareDeps {
  db: Db;
  bus: Bus;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

interface Row {
  id: string;
  vehicle_id: string;
  note: string;
  created_by_name: string | null;
  created_at: Date;
  expires_at: Date;
  views: number;
  last_viewed_at: Date | null;
}
const toLink = (r: Row): ShareLink => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  note: r.note,
  createdBy: r.created_by_name,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  views: r.views,
  lastViewedAt: r.last_viewed_at?.toISOString() ?? null,
});

const SELECT = `SELECT l.id, l.vehicle_id, l.note, u.name AS created_by_name, l.created_at, l.expires_at, l.views, l.last_viewed_at
  FROM gps.share_links l
  JOIN gps.vehicles v ON v.id = l.vehicle_id
  LEFT JOIN auth."user" u ON u.id = l.created_by
 WHERE l.org_id = $1 AND ${scopeSql(2)} AND l.revoked_at IS NULL AND l.expires_at > now()`;

/** Current links of a vehicle. */
export async function listShares(db: Queryable, tenant: Tenant, vehicleId: string): Promise<ShareLink[]> {
  await getVehicle(db, tenant, vehicleId);
  const r = await db.query<Row>(`${SELECT} AND l.vehicle_id = $3 ORDER BY l.created_at DESC`, [tenant.orgId, scopeParam(tenant), vehicleId]);
  return r.rows.map(toLink);
}

/**
 * Creates a link. Also returns its key, which is the only thing that cannot be
 * requested again: only its checksum remains in the database.
 */
export async function createShare(deps: ShareDeps, actor: Actor, vehicleId: string, input: { hours: number; note: string }): Promise<{ link: ShareLink; token: string }> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  const token = randomBytes(32).toString("base64url");
  const id = await withTransaction(deps.db.core, async (client) => {
    const active = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM gps.share_links WHERE vehicle_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [vehicleId],
    );
    if ((active.rows[0]?.n ?? 0) >= SHARE_MAX_ACTIVE) {
      throw badRequest(say("core.share.limit", { max: SHARE_MAX_ACTIVE }), "share_limit");
    }
    const r = await client.query<{ id: string }>(
      `INSERT INTO gps.share_links (org_id, vehicle_id, token_hash, note, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6)) RETURNING id`,
      [actor.orgId, vehicleId, hashOf(token), input.note, actor.userId, input.hours],
    );
    const created = (r.rows[0] as { id: string }).id;
    await audit(client, actor, "share.create", "vehicle", vehicleId, { name: vehicle.name, hours: input.hours, note: input.note });
    return created;
  });
  const r = await deps.db.core.query<Row>(`${SELECT} AND l.id = $3`, [actor.orgId, scopeParam(actor), id]);
  return { link: toLink(r.rows[0] as Row), token };
}

/** Revokes a link: it stops working immediately. */
export async function revokeShare(deps: ShareDeps, actor: Actor, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound(say("core.share.notFound"));
  await withTransaction(deps.db.core, async (client) => {
    const r = await client.query<{ vehicle_id: string; name: string }>(
      `UPDATE gps.share_links l SET revoked_at = now()
         FROM gps.vehicles v
        WHERE l.id = $3 AND l.org_id = $1 AND v.id = l.vehicle_id AND ${scopeSql(2)} AND l.revoked_at IS NULL
        RETURNING l.vehicle_id, v.name`,
      [actor.orgId, scopeParam(actor), id],
    );
    const row = r.rows[0];
    if (!row) throw notFound(say("core.share.notFound"));
    await audit(client, actor, "share.revoke", "vehicle", row.vehicle_id, { name: row.name });
  });
}

/**
 * What someone sees when opening a link. Null if it does not exist, expired, was revoked or the
 * account is suspended: from outside one case cannot be told from another.
 */
export async function viewShared(db: Queryable, token: string): Promise<SharedView | null> {
  const r = await db.query<{
    id: string;
    name: string;
    expires_at: Date;
    status: "pending" | "active" | null;
    last_seen_at: Date | null;
    fix_time: Date | null;
    lat: number | null;
    lon: number | null;
    speed_kmh: number | null;
    course: number | null;
    ignition: boolean | null;
  }>(
    `UPDATE gps.share_links l SET views = l.views + 1, last_viewed_at = now()
       FROM gps.vehicles v
       LEFT JOIN gps.devices d ON d.vehicle_id = v.id
       LEFT JOIN gps.device_state s ON s.device_id = d.id
       LEFT JOIN gps.account_settings a ON a.org_id = v.org_id
      WHERE l.token_hash = $1 AND v.id = l.vehicle_id
        AND l.revoked_at IS NULL AND l.expires_at > now() AND NOT COALESCE(a.suspended, false)
      RETURNING l.id, v.name, l.expires_at, d.status, s.last_seen_at, s.fix_time, s.lat, s.lon, s.speed_kmh, s.course, s.ignition`,
    [hashOf(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  const located = row.status === "active" && row.lat !== null && row.lon !== null && row.fix_time !== null && row.last_seen_at !== null;
  if (!located) return { name: row.name, expiresAt: row.expires_at.toISOString(), status: "unknown", position: null, lastSeenAt: null };
  // The same status rule the platform uses, reduced to what matters to someone looking from outside.
  const full = vehicleStatus({
    device: { uniqueId: "", modelId: "", modelName: null, status: "active", claimExpiresAt: null, confirmedAt: null },
    state: {
      lastSeenAt: (row.last_seen_at as Date).toISOString(),
      fixTime: (row.fix_time as Date).toISOString(),
      lat: row.lat,
      lon: row.lon,
      altitude: null,
      speedKmh: row.speed_kmh,
      course: row.course,
      accuracy: null,
      ignition: row.ignition,
      ignitionInferred: false,
      motion: null,
      powerVoltage: null,
      batteryVoltage: null,
      batteryLevel: null,
      satellites: null,
      signalBars: null,
    },
  });
  return {
    name: row.name,
    expiresAt: row.expires_at.toISOString(),
    status: full === "moving" ? "moving" : full === "offline" ? "offline" : "stopped",
    position: {
      lat: row.lat as number,
      lon: row.lon as number,
      speedKmh: Math.round(row.speed_kmh ?? 0),
      course: row.course,
      fixTime: (row.fix_time as Date).toISOString(),
    },
    lastSeenAt: (row.last_seen_at as Date).toISOString(),
  };
}
