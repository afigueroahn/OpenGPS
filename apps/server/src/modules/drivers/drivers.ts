// Drivers: their profile, which vehicle they are assigned to and the account settings.
import { DRIVER_SETTINGS_DEFAULT, type Driver, type DriverSettings, type VehicleDriver, type driverSchema } from "@opengps/shared";
import type { z } from "zod";
import { type Tenant, isUuid, scopeParam, scopeSql } from "../../core/access";
import { audit } from "../../core/audit";
import { type Actor, getVehicle } from "../../core/vehicles";
import { type Queryable, withTransaction } from "../../db";
import { badRequest, conflict, notFound } from "../../errors";
import { say } from "../../i18n";
import type { ModuleDeps } from "../context";

type Deps = Pick<ModuleDeps, "db" | "bus">;
type DriverData = z.output<typeof driverSchema>;

/**
 * A key as it is compared: uppercase and without leading zeros. Devices
 * send it padded with zeros and people type it without them.
 */
export function normalizeKey(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const key = String(raw).trim().toUpperCase().replace(/^0+/, "");
  return /^[0-9A-F]{1,32}$/.test(key) ? key : null;
}

interface DriverRow {
  id: string;
  name: string;
  license: string | null;
  phone: string | null;
  key_id: string | null;
  notes: string;
  active: boolean;
  vehicle_id: string | null;
  starts_at: Date | null;
}
const toDriver = (r: DriverRow): Driver => ({
  id: r.id,
  name: r.name,
  license: r.license,
  phone: r.phone,
  keyId: r.key_id,
  notes: r.notes,
  active: r.active,
  vehicleId: r.vehicle_id,
  since: r.starts_at?.toISOString() ?? null,
});

// Someone who only sees some groups is not told about assignments to vehicles of others.
const DRIVER_SELECT = `
  SELECT dr.id, dr.name, dr.license, dr.phone, dr.key_id, dr.notes, dr.active, a.vehicle_id, a.starts_at
    FROM gps.drivers dr
    LEFT JOIN LATERAL (
      SELECT a.vehicle_id, a.starts_at
        FROM gps.driver_assignments a
        JOIN gps.vehicles v ON v.id = a.vehicle_id
       WHERE a.driver_id = dr.id AND a.ends_at IS NULL AND ${scopeSql(2)}
    ) a ON true`;

export async function listDrivers(db: Queryable, tenant: Tenant): Promise<Driver[]> {
  const r = await db.query<DriverRow>(`${DRIVER_SELECT} WHERE dr.org_id = $1 ORDER BY dr.active DESC, lower(dr.name), dr.id`, [tenant.orgId, scopeParam(tenant)]);
  return r.rows.map(toDriver);
}

export async function getDriver(db: Queryable, tenant: Tenant, id: string): Promise<Driver> {
  if (!isUuid(id)) throw notFound(say("drivers.errors.notFound"));
  const r = await db.query<DriverRow>(`${DRIVER_SELECT} WHERE dr.org_id = $1 AND dr.id = $3`, [tenant.orgId, scopeParam(tenant), id]);
  if (!r.rows[0]) throw notFound(say("drivers.errors.notFound"));
  return toDriver(r.rows[0]);
}

const isKeyTaken = (err: unknown) => (err as { code?: string; constraint?: string }).code === "23505" && (err as { constraint?: string }).constraint === "drivers_key";
const keyTaken = () => conflict("driver_key_taken", say("drivers.errors.keyTaken"));

export async function createDriver(deps: Deps, actor: Actor, data: DriverData): Promise<Driver> {
  let id: string;
  try {
    const r = await deps.db.core.query<{ id: string }>(
      `INSERT INTO gps.drivers (org_id, name, license, phone, key_id, notes, active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [actor.orgId, data.name, data.license, data.phone, normalizeKey(data.keyId), data.notes, data.active],
    );
    id = (r.rows[0] as { id: string }).id;
  } catch (err) {
    throw isKeyTaken(err) ? keyTaken() : err;
  }
  await audit(deps.db.core, actor, "driver.create", "driver", id, { name: data.name });
  deps.bus.emit("drivers", { orgId: actor.orgId });
  return getDriver(deps.db.core, actor, id);
}

export async function updateDriver(deps: Deps, actor: Actor, id: string, data: DriverData): Promise<Driver> {
  await getDriver(deps.db.core, actor, id);
  try {
    await withTransaction(deps.db.core, async (tx) => {
      await tx.query(`UPDATE gps.drivers SET name = $3, license = $4, phone = $5, key_id = $6, notes = $7, active = $8 WHERE org_id = $1 AND id = $2`, [
        actor.orgId,
        id,
        data.name,
        data.license,
        data.phone,
        normalizeKey(data.keyId),
        data.notes,
        data.active,
      ]);
      // A driver who is deactivated leaves the vehicle they had.
      if (!data.active) await tx.query(`UPDATE gps.driver_assignments SET ends_at = GREATEST(now(), starts_at) WHERE driver_id = $1 AND ends_at IS NULL`, [id]);
    });
  } catch (err) {
    throw isKeyTaken(err) ? keyTaken() : err;
  }
  await audit(deps.db.core, actor, "driver.update", "driver", id, { name: data.name });
  deps.bus.emit("drivers", { orgId: actor.orgId });
  return getDriver(deps.db.core, actor, id);
}

/** Deletes the profile and its assignments. What they drove stays as driven without a driver. */
export async function deleteDriver(deps: Deps, actor: Actor, id: string): Promise<void> {
  const driver = await getDriver(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.drivers WHERE org_id = $1 AND id = $2`, [actor.orgId, id]);
  await audit(deps.db.core, actor, "driver.delete", "driver", id, { name: driver.name });
  deps.bus.emit("drivers", { orgId: actor.orgId });
}

// ─── Who drives each vehicle ─────────────────────────────────────────────────

/** Driver of a vehicle at a given moment, according to the assignments. */
export async function driverAt(db: Queryable, vehicleId: string, at: number): Promise<{ id: string; name: string } | null> {
  const r = await db.query<{ id: string; name: string }>(
    `SELECT dr.id, dr.name
       FROM gps.driver_assignments a
       JOIN gps.drivers dr ON dr.id = a.driver_id
      WHERE a.vehicle_id = $1 AND a.starts_at <= $2 AND (a.ends_at IS NULL OR a.ends_at > $2)
      ORDER BY a.starts_at DESC
      LIMIT 1`,
    [vehicleId, new Date(at)],
  );
  return r.rows[0] ?? null;
}

export async function vehicleDriver(db: Queryable, tenant: Tenant, vehicleId: string): Promise<VehicleDriver> {
  await getVehicle(db, tenant, vehicleId);
  const r = await db.query<{ id: string; name: string; starts_at: Date; source: "manual" | "key" }>(
    `SELECT dr.id, dr.name, a.starts_at, a.source
       FROM gps.driver_assignments a
       JOIN gps.drivers dr ON dr.id = a.driver_id
      WHERE a.vehicle_id = $1 AND a.ends_at IS NULL`,
    [vehicleId],
  );
  const key = await db.query<{ unknown_key: string | null; unknown_key_at: Date | null }>(`SELECT unknown_key, unknown_key_at FROM gps.driving_state WHERE vehicle_id = $1`, [vehicleId]);
  const now = r.rows[0];
  const unknown = key.rows[0];
  return {
    driver: now ? { id: now.id, name: now.name, since: now.starts_at.toISOString(), source: now.source } : null,
    unknownKey: unknown?.unknown_key && unknown.unknown_key_at ? { key: unknown.unknown_key, at: unknown.unknown_key_at.toISOString() } : null,
  };
}

/**
 * Puts a driver behind the wheel of a vehicle from `at`, or leaves it without a
 * driver. Closes whatever there was: that vehicle's previous driver and that
 * driver's previous vehicle. Returns whether anything changed.
 */
export async function setDriver(
  deps: Deps,
  orgId: string,
  vehicleId: string,
  driverId: string | null,
  opts: { at: number; source: "manual" | "key" },
): Promise<boolean> {
  const at = new Date(opts.at);
  const changed = await withTransaction(deps.db.core, async (tx) => {
    const current = await tx.query<{ driver_id: string; starts_at: Date }>(
      `SELECT driver_id, starts_at FROM gps.driver_assignments WHERE vehicle_id = $1 AND ends_at IS NULL FOR UPDATE`,
      [vehicleId],
    );
    const open = current.rows[0];
    if ((open?.driver_id ?? null) === driverId) return false;
    // An identification older than the current assignment arrived late: it does not undo it.
    if (open && open.starts_at.getTime() > opts.at) return false;
    const touched = [vehicleId];
    await tx.query(`UPDATE gps.driver_assignments SET ends_at = GREATEST($2, starts_at) WHERE vehicle_id = $1 AND ends_at IS NULL`, [vehicleId, at]);
    if (driverId) {
      const elsewhere = await tx.query<{ vehicle_id: string }>(
        `UPDATE gps.driver_assignments SET ends_at = GREATEST($2, starts_at) WHERE driver_id = $1 AND ends_at IS NULL RETURNING vehicle_id`,
        [driverId, at],
      );
      touched.push(...elsewhere.rows.map((x) => x.vehicle_id));
      await tx.query(`INSERT INTO gps.driver_assignments (org_id, driver_id, vehicle_id, starts_at, source) VALUES ($1, $2, $3, $4, $5)`, [orgId, driverId, vehicleId, at, opts.source]);
    }
    // With another person at the wheel, driving time starts from zero.
    await tx.query(
      `UPDATE gps.driving_state SET stretch_s = 0, stretch_warned = false, shift_s = 0, shift_warned = false, last_moving = NULL WHERE vehicle_id = ANY($1::uuid[])`,
      [touched],
    );
    return true;
  });
  if (changed) deps.bus.emit("drivers", { orgId });
  return changed;
}

/** Assignment made by a person from the platform. */
export async function assignDriver(deps: Deps, actor: Actor, vehicleId: string, driverId: string | null): Promise<VehicleDriver> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  let name: string | null = null;
  if (driverId) {
    const driver = await getDriver(deps.db.core, actor, driverId);
    if (!driver.active) throw badRequest(say("drivers.errors.inactive"), "driver_inactive");
    name = driver.name;
  }
  const changed = await setDriver(deps, actor.orgId, vehicleId, driverId, { at: Date.now(), source: "manual" });
  if (changed) await audit(deps.db.core, actor, driverId ? "driver.assign" : "driver.unassign", "vehicle", vehicleId, { vehicle: vehicle.name, ...(name ? { driver: name } : {}) });
  return vehicleDriver(deps.db.core, actor, vehicleId);
}

/** Active driver of the account who has that key. */
export async function driverByKey(db: Queryable, orgId: string, key: string): Promise<string | null> {
  const r = await db.query<{ id: string }>(`SELECT id FROM gps.drivers WHERE org_id = $1 AND key_id = $2 AND active`, [orgId, key]);
  return r.rows[0]?.id ?? null;
}

// ─── Account settings ────────────────────────────────────────────────────────

interface SettingsRow {
  speed_limit_kmh: number;
  speeding_seconds: number;
  max_continuous_min: number;
  min_rest_min: number;
  max_daily_min: number;
}

export async function getSettings(db: Queryable, orgId: string): Promise<DriverSettings> {
  const r = await db.query<SettingsRow>(`SELECT speed_limit_kmh, speeding_seconds, max_continuous_min, min_rest_min, max_daily_min FROM gps.driver_settings WHERE org_id = $1`, [orgId]);
  const row = r.rows[0];
  if (!row) return DRIVER_SETTINGS_DEFAULT;
  return {
    speedLimitKmh: row.speed_limit_kmh,
    speedingSeconds: row.speeding_seconds,
    maxContinuousMin: row.max_continuous_min,
    minRestMin: row.min_rest_min,
    maxDailyMin: row.max_daily_min,
  };
}

export async function saveSettings(deps: Deps, actor: Actor, s: DriverSettings): Promise<DriverSettings> {
  if (s.minRestMin >= s.maxContinuousMin) throw badRequest(say("drivers.errors.restTooLong"));
  if (s.maxDailyMin < s.maxContinuousMin) throw badRequest(say("drivers.errors.dailyBelowContinuous"));
  await deps.db.core.query(
    `INSERT INTO gps.driver_settings (org_id, speed_limit_kmh, speeding_seconds, max_continuous_min, min_rest_min, max_daily_min)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id) DO UPDATE SET speed_limit_kmh = EXCLUDED.speed_limit_kmh, speeding_seconds = EXCLUDED.speeding_seconds,
       max_continuous_min = EXCLUDED.max_continuous_min, min_rest_min = EXCLUDED.min_rest_min, max_daily_min = EXCLUDED.max_daily_min`,
    [actor.orgId, s.speedLimitKmh, s.speedingSeconds, s.maxContinuousMin, s.minRestMin, s.maxDailyMin],
  );
  await audit(deps.db.core, actor, "driver.settings", "account", actor.orgId, { ...s });
  deps.bus.emit("drivers", { orgId: actor.orgId });
  return s;
}
