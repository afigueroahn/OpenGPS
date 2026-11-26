// Engine lock and unlock, and recovery mode.
//
// Cutting the engine of a moving vehicle is dangerous. So a lock order
// is not sent as soon as it is requested: it waits until the vehicle is going
// slowly and its location is known, and if that moment does not come, it expires.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  COMMAND_TTL_MIN,
  type CommandKind,
  type CommandStatus,
  LOCK_MAX_FIX_AGE_S,
  LOCK_MAX_SPEED_KMH,
  type LockCheck,
  type VehicleCommand,
  type VehicleSecurity,
  isConfirmWord,
} from "@opengps/shared";
import type { Tenant } from "../../core/access";
import { audit } from "../../core/audit";
import { recordEvent } from "../../core/events";
import { createShare } from "../../core/share";
import { type Actor, getVehicle } from "../../core/vehicles";
import { type Queryable, withTransaction } from "../../db";
import { badRequest, conflict, forbidden, notFound } from "../../errors";
import { type Say, say } from "../../i18n";
import type { ModuleDeps } from "../context";
import { annotate, raise, storedText } from "./incidents";

/** A switched-off vehicle reports only now and then: its last position is valid for this long. */
const PARKED_MAX_AGE_S = 3600;
/** Send attempts before the order is considered failed. */
const MAX_ATTEMPTS = 20;
const CONFIRM_TTL_S = 120;
/** Reporting rate in recovery mode and on leaving it, in seconds. */
const RECOVERY_PERIOD_S = 10;
const NORMAL_PERIOD_S = 30;
const RECOVERY_LINK_HOURS = 72;

/**
 * Data with which each device family says whether its engine is cut.
 * With other models the order is sent, but the device does not confirm it.
 */
const LOCK_SIGNAL: Record<string, string> = { teltonika: "out1", gt06: "blocked" };

interface CommandRow {
  id: string;
  vehicle_id: string;
  device_id: number;
  kind: CommandKind;
  status: CommandStatus;
  requested_by_name: string | null;
  created_at: Date;
  expires_at: Date;
  sent_at: Date | null;
  finished_at: Date | null;
  note: string | null;
}
const toCommand = (r: CommandRow): VehicleCommand => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  kind: r.kind,
  status: r.status,
  requestedBy: r.requested_by_name,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  sentAt: r.sent_at?.toISOString() ?? null,
  finishedAt: r.finished_at?.toISOString() ?? null,
  note: r.note,
});

interface Target {
  orgId: string;
  vehicleId: string;
  vehicleName: string;
  groupId: string | null;
  deviceId: number;
  traccarId: number;
  modelId: string;
  speedKmh: number | null;
  ignition: boolean | null;
  fixTime: Date | null;
  lat: number | null;
  lon: number | null;
}

async function targetOf(db: Queryable, vehicleId: string): Promise<Target | null> {
  const r = await db.query<{
    org_id: string;
    name: string;
    group_id: string | null;
    device_id: number;
    traccar_device_id: number;
    model_id: string;
    speed_kmh: number | null;
    ignition: boolean | null;
    fix_time: Date | null;
    lat: number | null;
    lon: number | null;
  }>(
    `SELECT v.org_id, v.name, v.group_id, d.id AS device_id, d.traccar_device_id, d.model_id, s.speed_kmh, s.ignition, s.fix_time, s.lat, s.lon
       FROM gps.vehicles v
       JOIN gps.devices d ON d.vehicle_id = v.id AND d.status = 'active'
       LEFT JOIN gps.device_state s ON s.device_id = d.id
      WHERE v.id = $1`,
    [vehicleId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    orgId: row.org_id,
    vehicleId,
    vehicleName: row.name,
    groupId: row.group_id,
    deviceId: row.device_id,
    traccarId: row.traccar_device_id,
    modelId: row.model_id,
    speedKmh: row.speed_kmh,
    ignition: row.ignition,
    fixTime: row.fix_time,
    lat: row.lat,
    lon: row.lon,
  };
}

/** Orders each device supports. Traccar is asked once and the answer is remembered for a while. */
const typesCache = new Map<number, { at: number; types: string[] }>();
async function typesOf(deps: ModuleDeps, traccarId: number): Promise<string[]> {
  const hit = typesCache.get(traccarId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.types;
  const types = await deps.traccar.commandTypes(traccarId).catch(() => []);
  // An empty list may mean the device has not reported yet: it is not remembered.
  if (types.length > 0) typesCache.set(traccarId, { at: Date.now(), types });
  return types;
}
const canLock = (types: string[]) => types.includes("engineStop") && types.includes("engineResume");

/**
 * Is it safe to cut the engine now? Yes with the vehicle slow and a
 * position from moments ago; or switched off, with its last report within the last hour.
 */
export function lockSafety(state: { speedKmh: number | null; ignition: boolean | null; fixAgeS: number | null }): { safe: boolean; reason: Say | null } {
  if (state.fixAgeS === null) return { safe: false, reason: say("antitheft.command.waitingFix") };
  if ((state.speedKmh ?? 0) > LOCK_MAX_SPEED_KMH) return { safe: false, reason: say("antitheft.command.waitingSlower", { kmh: LOCK_MAX_SPEED_KMH }) };
  if (state.fixAgeS <= LOCK_MAX_FIX_AGE_S) return { safe: true, reason: null };
  if (state.ignition !== true && state.fixAgeS <= PARKED_MAX_AGE_S) return { safe: true, reason: null };
  return { safe: false, reason: say("antitheft.command.waitingRecentFix") };
}

const SELECT_COMMANDS = `SELECT c.id, c.vehicle_id, c.device_id, c.kind, c.status, u.name AS requested_by_name, c.created_at, c.expires_at, c.sent_at, c.finished_at, c.note
  FROM gps.commands c LEFT JOIN auth."user" u ON u.id = c.requested_by`;

export async function getSecurity(deps: ModuleDeps, tenant: Tenant, vehicleId: string): Promise<VehicleSecurity> {
  await getVehicle(deps.db.core, tenant, vehicleId);
  const target = await targetOf(deps.db.core, vehicleId);
  const types = target ? await typesOf(deps, target.traccarId) : [];
  const state = await deps.db.core.query<{ lock_state: "locked" | "unlocked" | null; lock_confirmed: boolean; lock_changed_at: Date | null; recovery_since: Date | null }>(
    `SELECT lock_state, lock_confirmed, lock_changed_at, recovery_since FROM gps.vehicle_security WHERE vehicle_id = $1`,
    [vehicleId],
  );
  const commands = await deps.db.core.query<CommandRow>(`${SELECT_COMMANDS} WHERE c.vehicle_id = $1 ORDER BY c.created_at DESC LIMIT 10`, [vehicleId]);
  const row = state.rows[0];
  const list = commands.rows.map(toCommand);
  return {
    lockSupported: target === null || types.length === 0 ? null : canLock(types),
    lock: row?.lock_state && row.lock_changed_at ? { state: row.lock_state, confirmed: row.lock_confirmed, changedAt: row.lock_changed_at.toISOString() } : null,
    pending: list.find((c) => c.finishedAt === null && (c.status === "waiting" || c.status === "sent")) ?? null,
    recovery: row?.recovery_since ? { since: row.recovery_since.toISOString() } : null,
    commands: list,
  };
}

// ─── Two-step confirmation ───────────────────────────────────────────────────

function sign(deps: ModuleDeps, payload: string): string {
  return createHmac("sha256", deps.config.authSecret).update(`orden:${payload}`).digest("base64url");
}
function confirmToken(deps: ModuleDeps, userId: string, vehicleId: string, action: CommandKind): string {
  const payload = `${userId}.${vehicleId}.${action}.${Math.floor(Date.now() / 1000) + CONFIRM_TTL_S}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(deps, payload)}`;
}
function checkToken(deps: ModuleDeps, token: string, userId: string, vehicleId: string, action: CommandKind): boolean {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;
  const payload = Buffer.from(encoded, "base64url").toString();
  const expected = Buffer.from(sign(deps, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const [u, v, a, exp] = payload.split(".");
  return u === userId && v === vehicleId && a === action && Number(exp) >= Date.now() / 1000;
}

async function requireTarget(deps: ModuleDeps, tenant: Tenant, vehicleId: string): Promise<Target> {
  await getVehicle(deps.db.core, tenant, vehicleId);
  const target = await targetOf(deps.db.core, vehicleId);
  if (!target) throw badRequest(say("antitheft.errors.noGps"));
  if (!canLock(await typesOf(deps, target.traccarId))) throw badRequest(say("antitheft.errors.lockUnsupported"), "lock_unsupported");
  return target;
}
const ageOf = (fixTime: Date | null) => (fixTime ? Math.max(0, Math.round((Date.now() - fixTime.getTime()) / 1000)) : null);

/** First step: checks that it is possible and returns what the person must see before confirming. */
export async function prepareLock(deps: ModuleDeps, actor: Actor, vehicleId: string, action: CommandKind): Promise<LockCheck> {
  const target = await requireTarget(deps, actor, vehicleId);
  const fixAgeS = ageOf(target.fixTime);
  return {
    confirmToken: confirmToken(deps, actor.userId, vehicleId, action),
    speedKmh: target.speedKmh === null ? null : Math.round(target.speedKmh),
    fixAgeS,
    safeNow: action === "unlock" || lockSafety({ speedKmh: target.speedKmh, ignition: target.ignition, fixAgeS }).safe,
  };
}

/** Second step: with the recent check and the typed word, creates the order and tries to send it. */
export async function requestLock(deps: ModuleDeps, actor: Actor, vehicleId: string, input: { action: CommandKind; confirmToken: string; word: string }): Promise<VehicleSecurity> {
  const target = await requireTarget(deps, actor, vehicleId);
  if (!checkToken(deps, input.confirmToken, actor.userId, vehicleId, input.action)) {
    throw forbidden(say("antitheft.errors.confirmExpired"));
  }
  // The word of any language the platform speaks confirms it.
  if (!isConfirmWord(input.action, input.word)) throw badRequest(say(input.action === "lock" ? "shared.validation.confirmLock" : "shared.validation.confirmUnlock"));

  const id = await withTransaction(deps.db.core, async (client) => {
    // A new order replaces the one that was waiting.
    await client.query(`UPDATE gps.commands SET status = 'cancelled', finished_at = now(), note = $2 WHERE vehicle_id = $1 AND finished_at IS NULL`, [
      vehicleId,
      storedText(deps, say("antitheft.command.replaced")),
    ]);
    const r = await client.query<{ id: string }>(
      `INSERT INTO gps.commands (org_id, vehicle_id, device_id, kind, status, requested_by, expires_at)
       VALUES ($1, $2, $3, $4, 'waiting', $5, now() + make_interval(mins => $6)) RETURNING id`,
      [actor.orgId, vehicleId, target.deviceId, input.action, actor.userId, COMMAND_TTL_MIN],
    );
    await audit(client, actor, input.action === "lock" ? "command.lock" : "command.unlock", "vehicle", vehicleId, { name: target.vehicleName });
    return (r.rows[0] as { id: string }).id;
  });
  await annotate(deps, target, "command", say(input.action === "lock" ? "antitheft.entry.lockRequested" : "antitheft.entry.unlockRequested"), actor.userId);
  await dispatch(deps, id, target);
  deps.bus.emit("security", { orgId: target.orgId, groupId: target.groupId, vehicleId });
  return getSecurity(deps, actor, vehicleId);
}

export async function cancelCommand(deps: ModuleDeps, actor: Actor, vehicleId: string): Promise<VehicleSecurity> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  const r = await deps.db.core.query(
    `UPDATE gps.commands SET status = 'cancelled', finished_at = now(), note = $2 WHERE vehicle_id = $1 AND status = 'waiting' AND finished_at IS NULL`,
    [vehicleId, storedText(deps, say("antitheft.command.cancelled"))],
  );
  if (r.rowCount === 0) throw conflict("command_sent", say("antitheft.errors.nothingWaiting"));
  await audit(deps.db.core, actor, "command.cancel", "vehicle", vehicleId, { name: vehicle.name });
  deps.bus.emit("security", { orgId: actor.orgId, groupId: vehicle.groupId, vehicleId });
  return getSecurity(deps, actor, vehicleId);
}

// ─── Sending and confirmation ────────────────────────────────────────────────

/**
 * Tries to send a waiting order. If it is not safe or the device is not there, notes why and keeps waiting.
 *
 * The request that creates an order and the next position (or the periodic check) can try to send it at the
 * same moment. So the order is held while it is sent: whoever finds it held leaves it, and the device
 * receives it only once. Everything that changes the order is written with that same hold.
 */
export async function dispatch(deps: ModuleDeps, commandId: string, target: Target): Promise<void> {
  const outcome = await withTransaction(deps.db.core, async (client): Promise<CommandKind | "failed" | null> => {
    const r = await client.query<{ kind: CommandKind; attempts: number }>(
      `SELECT kind, attempts FROM gps.commands WHERE id = $1 AND status = 'waiting' AND finished_at IS NULL FOR UPDATE SKIP LOCKED`,
      [commandId],
    );
    const command = r.rows[0];
    if (!command) return null;

    if (command.kind === "lock") {
      const check = lockSafety({ speedKmh: target.speedKmh, ignition: target.ignition, fixAgeS: ageOf(target.fixTime) });
      if (!check.safe) {
        await client.query(`UPDATE gps.commands SET note = $2 WHERE id = $1`, [commandId, storedText(deps, check.reason as Say)]);
        return null;
      }
    }
    try {
      await deps.traccar.sendCommand(target.traccarId, command.kind === "lock" ? "engineStop" : "engineResume");
    } catch (err) {
      const attempts = command.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await client.query(`UPDATE gps.commands SET status = 'failed', finished_at = now(), attempts = $2, note = $3 WHERE id = $1`, [commandId, attempts, (err as Error).message]);
        return "failed";
      }
      await client.query(`UPDATE gps.commands SET attempts = $2, note = $3 WHERE id = $1`, [commandId, attempts, storedText(deps, say("antitheft.command.retrying", { error: (err as Error).message }))]);
      return null;
    }
    const signal = LOCK_SIGNAL[target.modelId];
    // Without data that confirms it, the order ends here: sent, without knowing whether the device applied it.
    await client.query(
      `UPDATE gps.commands SET status = 'sent', sent_at = now(), attempts = attempts + 1, note = $2, finished_at = CASE WHEN $3 THEN NULL ELSE now() END WHERE id = $1`,
      [commandId, signal ? null : storedText(deps, say("antitheft.command.noFeedback")), signal !== undefined],
    );
    await client.query(
      `INSERT INTO gps.vehicle_security (vehicle_id, lock_state, lock_confirmed, lock_changed_at) VALUES ($1, $2, false, now())
       ON CONFLICT (vehicle_id) DO UPDATE SET lock_state = EXCLUDED.lock_state, lock_confirmed = false, lock_changed_at = now()`,
      [target.vehicleId, command.kind === "lock" ? "locked" : "unlocked"],
    );
    return command.kind;
  });
  if (outcome === "failed") await annotate(deps, target, "command", say("antitheft.entry.sendFailed"));
  if (outcome === null || outcome === "failed") return;
  await recordEvent(deps, target, {
    type: outcome === "lock" ? "engine_locked" : "engine_unlocked",
    at: Date.now(),
    lat: target.lat,
    lon: target.lon,
    speedKmh: target.speedKmh,
  });
  await annotate(deps, target, "command", say(outcome === "lock" ? "antitheft.entry.lockSent" : "antitheft.entry.unlockSent"));
  deps.bus.emit("security", { orgId: target.orgId, groupId: target.groupId, vehicleId: target.vehicleId });
}

/** With each new position: sends what was waiting for the safe moment and checks what the device says about its engine. */
export async function onPosition(deps: ModuleDeps, vehicleId: string, attributes: Record<string, unknown>): Promise<void> {
  const open = await deps.db.core.query<{ id: string; kind: CommandKind; status: CommandStatus }>(
    `SELECT id, kind, status FROM gps.commands WHERE vehicle_id = $1 AND finished_at IS NULL ORDER BY created_at`,
    [vehicleId],
  );
  if (open.rows.length === 0) return;
  const target = await targetOf(deps.db.core, vehicleId);
  if (!target) return;
  const signal = LOCK_SIGNAL[target.modelId];
  for (const command of open.rows) {
    if (command.status === "waiting") {
      await dispatch(deps, command.id, target);
    } else if (command.status === "sent" && signal && typeof attributes[signal] === "boolean") {
      if (attributes[signal] !== (command.kind === "lock")) continue;
      await withTransaction(deps.db.core, async (client) => {
        await client.query(`UPDATE gps.commands SET status = 'confirmed', finished_at = now(), note = NULL WHERE id = $1`, [command.id]);
        await client.query(`UPDATE gps.vehicle_security SET lock_confirmed = true WHERE vehicle_id = $1`, [vehicleId]);
      });
      await annotate(deps, target, "command", say(command.kind === "lock" ? "antitheft.entry.lockConfirmed" : "antitheft.entry.unlockConfirmed"));
      deps.bus.emit("security", { orgId: target.orgId, groupId: target.groupId, vehicleId });
    }
  }
}

/** Periodic check: retries what is waiting and marks as expired what remained unsent or unconfirmed. */
export async function sweepCommands(deps: ModuleDeps, now = Date.now(), orgId: string | null = null): Promise<void> {
  const expired = await deps.db.core.query<{ id: string; vehicle_id: string; org_id: string; status: CommandStatus; group_id: string | null }>(
    `UPDATE gps.commands c SET
            status = CASE WHEN c.status = 'waiting' THEN 'expired' ELSE 'unconfirmed' END,
            finished_at = $1,
            note = CASE WHEN c.status = 'waiting' THEN COALESCE(c.note, $3::text) ELSE $4::text END
       FROM gps.vehicles v
      WHERE v.id = c.vehicle_id AND c.finished_at IS NULL AND c.expires_at <= $1 AND ($2::text IS NULL OR c.org_id = $2)
      RETURNING c.id, c.vehicle_id, c.org_id, c.status, v.group_id`,
    [new Date(now), orgId, storedText(deps, say("antitheft.command.noSafeMoment")), storedText(deps, say("antitheft.command.unconfirmed"))],
  );
  for (const row of expired.rows) {
    await annotate(deps, { orgId: row.org_id, vehicleId: row.vehicle_id, groupId: row.group_id }, "command", say(row.status === "expired" ? "antitheft.entry.commandExpired" : "antitheft.command.unconfirmed"));
    deps.bus.emit("security", { orgId: row.org_id, groupId: row.group_id, vehicleId: row.vehicle_id });
  }
  const waiting = await deps.db.core.query<{ id: string; vehicle_id: string }>(`SELECT id, vehicle_id FROM gps.commands WHERE status = 'waiting' AND finished_at IS NULL AND ($1::text IS NULL OR org_id = $1)`, [orgId]);
  for (const row of waiting.rows) {
    const target = await targetOf(deps.db.core, row.vehicle_id);
    if (target && (await deps.gate.enabled(target.orgId, "A"))) await dispatch(deps, row.id, target);
  }
}

// ─── Recovery mode ───────────────────────────────────────────────────────────

/**
 * Recovery mode: the device reports more often (if its model allows it) and
 * a link is created to hand it to the authorities. When turned off, the link
 * is revoked. Returns the link key, which exists only at this moment.
 */
export async function setRecovery(deps: ModuleDeps, actor: Actor, vehicleId: string, on: boolean): Promise<{ security: VehicleSecurity; shareToken: string | null }> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  const target = await targetOf(deps.db.core, vehicleId);
  if (!target) throw badRequest(say("antitheft.errors.noGps"));
  const current = await deps.db.core.query<{ recovery_since: Date | null; recovery_share_id: string | null }>(`SELECT recovery_since, recovery_share_id FROM gps.vehicle_security WHERE vehicle_id = $1`, [vehicleId]);
  const active = Boolean(current.rows[0]?.recovery_since);
  if (on === active) throw conflict("recovery_state", say(on ? "antitheft.errors.recoveryAlreadyOn" : "antitheft.errors.recoveryAlreadyOff"));

  // Changing the reporting rate depends on the model; if it cannot be done, the mode still holds through the link.
  const periodic = (await typesOf(deps, target.traccarId)).includes("positionPeriodic");
  const faster = periodic
    ? await deps.traccar.sendCommand(target.traccarId, "positionPeriodic", { frequency: on ? RECOVERY_PERIOD_S : NORMAL_PERIOD_S }).then(
        () => true,
        () => false,
      )
    : false;

  let shareToken: string | null = null;
  if (on) {
    const share = await createShare(deps, actor, vehicleId, { hours: RECOVERY_LINK_HOURS, note: storedText(deps, say("antitheft.recovery.shareNote")) });
    shareToken = share.token;
    await deps.db.core.query(
      `INSERT INTO gps.vehicle_security (vehicle_id, recovery_since, recovery_share_id) VALUES ($1, now(), $2)
       ON CONFLICT (vehicle_id) DO UPDATE SET recovery_since = now(), recovery_share_id = EXCLUDED.recovery_share_id`,
      [vehicleId, share.link.id],
    );
    // Recovering a vehicle is an incident: if none is open, one is opened.
    await raise(deps, target, "manual", { at: Date.now(), lat: target.lat, lon: target.lon, text: say("antitheft.entry.recoveryStarted"), userId: actor.userId });
    await annotate(
      deps,
      target,
      "recovery",
      say(faster ? "antitheft.entry.recoveryOnFaster" : periodic ? "antitheft.entry.recoveryOnNotSent" : "antitheft.entry.recoveryOnFixedRate", { hours: RECOVERY_LINK_HOURS, seconds: RECOVERY_PERIOD_S }),
      actor.userId,
    );
  } else {
    await withTransaction(deps.db.core, async (client) => {
      await client.query(`UPDATE gps.share_links SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [current.rows[0]?.recovery_share_id ?? null]);
      await client.query(`UPDATE gps.vehicle_security SET recovery_since = NULL, recovery_share_id = NULL WHERE vehicle_id = $1`, [vehicleId]);
    });
    await annotate(deps, target, "recovery", say("antitheft.entry.recoveryOff"), actor.userId);
  }
  await audit(deps.db.core, actor, on ? "recovery.on" : "recovery.off", "vehicle", vehicleId, { name: vehicle.name });
  deps.bus.emit("security", { orgId: actor.orgId, groupId: vehicle.groupId, vehicleId });
  return { security: await getSecurity(deps, actor, vehicleId), shareToken };
}

export { notFound };
