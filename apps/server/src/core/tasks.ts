// Periodic core tasks: confirm and expire GPS additions, clean the
// Traccar database and apply history retention.
import { statfs } from "node:fs/promises";
import { decimalMark } from "./export/format";
import type { Bus } from "../bus";
import type { Config } from "../config";
import type { Db } from "../db";
import { tr } from "../i18n";
import type { Traccar } from "../traccar";
import { audit } from "./audit";
import { purgeDays } from "./days";
import type { Outbox } from "./outbox";
import type { SystemNotifier } from "./system";
import { toDevice } from "./vehicles";

export interface TaskDeps {
  db: Db;
  bus: Bus;
  traccar: Traccar;
  config: Config;
  /** The platform's own notifications, the outbox they leave through and the reader of positions they watch. */
  system?: SystemNotifier;
  outbox?: Outbox;
  ingest?: { status(): { lastPollAt: string | null; lastError: string | null } };
}

/** Group of each vehicle, to notify only those who can see it. */
async function groupsOf(deps: TaskDeps, vehicleIds: string[]): Promise<Map<string, string | null>> {
  if (vehicleIds.length === 0) return new Map();
  const r = await deps.db.core.query<{ id: string; group_id: string | null }>(`SELECT id, group_id FROM gps.vehicles WHERE id = ANY($1::uuid[])`, [vehicleIds]);
  return new Map(r.rows.map((v) => [v.id, v.group_id]));
}

/**
 * Confirms the device additions that have already talked to Traccar even though they do not yet
 * have a position (for example, no GPS signal indoors).
 */
export async function confirmConnected(deps: TaskDeps): Promise<number> {
  const pending = await deps.db.core.query<{ traccar_device_id: number }>(
    `SELECT traccar_device_id FROM gps.devices WHERE status = 'pending'`,
  );
  if (pending.rowCount === 0) return 0;
  const seen = await deps.db.traccar.query<{ id: number }>(
    `SELECT id FROM tc_devices WHERE id = ANY($1::int[]) AND lastupdate IS NOT NULL`,
    [pending.rows.map((r) => r.traccar_device_id)],
  );
  if (seen.rowCount === 0) return 0;
  const activated = await deps.db.core.query<Parameters<typeof toDevice>[0] & { org_id: string; vehicle_id: string }>(
    `UPDATE gps.devices SET status = 'active', confirmed_at = now(), claim_expires_at = NULL
      WHERE traccar_device_id = ANY($1::int[]) AND status = 'pending'
      RETURNING org_id, vehicle_id, unique_id, model_id, model_name, status, claim_expires_at, confirmed_at`,
    [seen.rows.map((r) => r.id)],
  );
  const groups = await groupsOf(deps, activated.rows.map((d) => d.vehicle_id));
  for (const d of activated.rows) {
    deps.bus.emit("device", { orgId: d.org_id, vehicleId: d.vehicle_id, groupId: groups.get(d.vehicle_id) ?? null, device: toDevice(d) });
  }
  if (activated.rowCount) deps.bus.emit("devices_changed", {});
  return activated.rowCount ?? 0;
}

/** Frees the GPS devices that did not report within their deadline: the vehicle is left without a device. */
export async function expireClaims(deps: TaskDeps): Promise<number> {
  const expired = await deps.db.core.query<{ id: number; org_id: string; vehicle_id: string; unique_id: string; traccar_device_id: number }>(
    `DELETE FROM gps.devices
      WHERE status = 'pending' AND claim_expires_at < now()
      RETURNING id, org_id, vehicle_id, unique_id, traccar_device_id`,
  );
  const groups = await groupsOf(deps, expired.rows.map((d) => d.vehicle_id));
  for (const d of expired.rows) {
    await deps.traccar.deleteDevice(d.traccar_device_id).catch(() => {});
    await audit(deps.db.core, { orgId: d.org_id, userId: null }, "device.claim_expired", "vehicle", d.vehicle_id, { uniqueId: d.unique_id });
    deps.bus.emit("device", { orgId: d.org_id, vehicleId: d.vehicle_id, groupId: groups.get(d.vehicle_id) ?? null, device: null });
  }
  if (expired.rowCount) deps.bus.emit("devices_changed", {});
  return expired.rowCount ?? 0;
}

/**
 * Removes from Traccar the devices the platform no longer has. An addition in progress
 * registers in Traccar first, so only what has gone two consecutive passes
 * without an owner is deleted.
 */
let orphanCandidates = new Set<number>();
export async function removeOrphanDevices(deps: TaskDeps): Promise<number> {
  const inTraccar = await deps.db.traccar.query<{ id: number }>(`SELECT id FROM tc_devices`);
  const known = await deps.db.core.query<{ traccar_device_id: number }>(`SELECT traccar_device_id FROM gps.devices`);
  const keep = new Set(known.rows.map((r) => r.traccar_device_id));
  const orphans = inTraccar.rows.map((r) => r.id).filter((id) => !keep.has(id));
  const confirmed = orphans.filter((id) => orphanCandidates.has(id));
  orphanCandidates = new Set(orphans.filter((id) => !confirmed.includes(id)));
  let removed = 0;
  for (const id of confirmed) {
    await deps.traccar.deleteDevice(id).then(
      () => removed++,
      () => orphanCandidates.add(id),
    );
  }
  return removed;
}

/** Deletes from Traccar the already-read positions and events past their retention period. */
export async function purgeTraccar(deps: TaskDeps): Promise<number> {
  const cursor = await deps.db.core.query<{ last_id: number }>(`SELECT last_id FROM gps.ingest_cursor WHERE source = 'traccar'`);
  const lastId = cursor.rows[0]?.last_id ?? 0;
  if (lastId === 0) return 0;
  const days = deps.config.traccar.retentionDays;
  let total = 0;
  for (let i = 0; i < 50; i++) {
    // In batches, and without touching each device's last position.
    const r = await deps.db.traccar.query(
      `DELETE FROM tc_positions
        WHERE id IN (
          SELECT p.id FROM tc_positions p
           WHERE p.id <= $1
             AND p.servertime < (now() AT TIME ZONE 'UTC') - make_interval(days => $2)
             AND NOT EXISTS (SELECT 1 FROM tc_devices d WHERE d.positionid = p.id)
           ORDER BY p.id
           LIMIT 10000)`,
      [lastId, days],
    );
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < 10000) break;
  }
  await deps.db.traccar.query(`DELETE FROM tc_events WHERE eventtime < (now() AT TIME ZONE 'UTC') - make_interval(days => $1)`, [days]);
  return total;
}

/** Applies the position history retention. 0 days = no limit. */
export async function syncRetention(deps: TaskDeps): Promise<void> {
  const days = deps.config.historyRetentionDays;
  await deps.db.core.query(`SELECT remove_retention_policy('gps.positions', if_exists => true)`);
  if (days > 0) await deps.db.core.query(`SELECT add_retention_policy('gps.positions', make_interval(days => $1))`, [days]);
}

/**
 * Watches the server's disk. With no per-account limits, the space depends on
 * how many are registered: past the threshold a notification is sent, at most once a day.
 */
let lastDiskAlert = 0;
export async function checkDisk(deps: TaskDeps): Promise<number | null> {
  let stats: Awaited<ReturnType<typeof statfs>>;
  try {
    stats = await statfs(deps.config.filesDir);
  } catch {
    return null; // in development the folder may not exist
  }
  const used = Math.round((1 - stats.bavail / stats.blocks) * 100);
  if (used < deps.config.diskAlertPercent || Date.now() - lastDiskAlert < 24 * 60 * 60_000) return used;
  lastDiskAlert = Date.now();
  const freeGb = ((stats.bavail * stats.bsize) / 1e9).toFixed(1);
  console.warn(`[disk] ${used} % used; ${freeGb} GB left`);
  const language = deps.config.defaultLanguage; // The platform's own notifications are written in its language.
  await deps.system?.notify("disk_high", {
    title: tr(language, "core.tasks.diskTitle", { used }),
    body: tr(language, "core.tasks.diskBody", { free: decimalMark(language, freeGb) }),
    path: "/admin/system/logs",
  });
  return used;
}

/** Minutes the reader of positions has to be failing before it is told. */
const INGEST_STALLED_MIN = 10;
let ingestWarned = false;
/**
 * Watches the reader of positions. If it has been failing for a while, the
 * vehicles stop moving on every map: it is told once, and again only after it recovers.
 */
export async function checkIngest(deps: TaskDeps, now = Date.now()): Promise<boolean> {
  const status = deps.ingest?.status();
  if (!status) return false;
  const stalled = status.lastError !== null && (status.lastPollAt === null || now - Date.parse(status.lastPollAt) > INGEST_STALLED_MIN * 60_000);
  if (!stalled) {
    ingestWarned = false;
    return false;
  }
  if (ingestWarned) return true;
  ingestWarned = true;
  const language = deps.config.defaultLanguage; // The platform's own notifications are written in its language.
  await deps.system?.notify("ingest_stalled", {
    title: tr(language, "core.tasks.ingestTitle"),
    body: tr(language, "core.tasks.ingestBody", { minutes: INGEST_STALLED_MIN, error: String(status.lastError) }),
    path: "/admin/system/logs",
  });
  return true;
}

export interface Tasks {
  start(): void;
  stop(): void;
}

export function createTasks(deps: TaskDeps): Tasks {
  const timers: NodeJS.Timeout[] = [];
  const every = (name: string, ms: number, fn: () => Promise<unknown>, firstDelay = ms) => {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        await fn();
      } catch (err) {
        console.error(`[tasks] ${name} failed:`, (err as Error).message);
      } finally {
        busy = false;
      }
    };
    timers.push(setTimeout(run, firstDelay), setInterval(run, ms));
  };

  return {
    start() {
      every("confirm additions", 10_000, () => confirmConnected(deps));
      every("expire additions", 30_000, () => expireClaims(deps));
      every("orphan devices", 15 * 60_000, () => removeOrphanDevices(deps), 60_000);
      every("clean Traccar", 60 * 60_000, () => purgeTraccar(deps), 5 * 60_000);
      every("watch disk", 60 * 60_000, () => checkDisk(deps), 30_000);
      every("watch ingest", 5 * 60_000, () => checkIngest(deps));
      // What could not go out is retried on the clock; the log is trimmed once an hour.
      if (deps.outbox) {
        const outbox = deps.outbox;
        every("pending deliveries", 30_000, () => outbox.deliverDue());
        every("prune deliveries", 60 * 60_000, () => outbox.prune(), 10 * 60_000);
      }
      every("stored days", 6 * 60 * 60_000, () => purgeDays(deps.db.core, deps.config.historyRetentionDays), 2 * 60_000);
    },
    stop() {
      for (const t of timers) clearTimeout(t);
    },
  };
}
