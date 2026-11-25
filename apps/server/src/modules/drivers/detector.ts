// What the module records while positions arrive: the device's harsh
// driving alerts, speeding, time behind the wheel
// and the key the driver identifies with.
import { type DriverEventType, type DriverSettings, SHIFT_REST_MIN } from "@opengps/shared";
import type { CoreEvents, Fix } from "../../bus";
import { recordEvent } from "../../core/events";
import { MAX_GAP_S, MIN_STOP_S, TRIP_MOVING_KMH } from "../../core/trips";
import type { ModuleDeps } from "../context";
import { driverAt, driverByKey, normalizeKey, setDriver } from "./drivers";

type Deps = Pick<ModuleDeps, "db" | "bus">;

/** Device alerts that count as a driving event. */
const HARSH: Record<string, DriverEventType> = { hardAcceleration: "accel", hardBraking: "brake", hardCornering: "corner" };

interface State {
  lastT: number;
  lastMoving: number | null;
  stretchS: number;
  stretchWarned: boolean;
  shiftS: number;
  shiftWarned: boolean;
  overSince: number | null;
  overMax: number | null;
  overEventId: string | null;
  unknownKey: string | null;
  unknownKeyAt: number | null;
}

interface StateRow {
  last_t: Date;
  last_moving: Date | null;
  stretch_s: number;
  stretch_warned: boolean;
  shift_s: number;
  shift_warned: boolean;
  over_since: Date | null;
  over_max: number | null;
  over_event_id: string | null;
  unknown_key: string | null;
  unknown_key_at: Date | null;
}

async function loadState(deps: Deps, vehicleId: string): Promise<State> {
  const r = await deps.db.core.query<StateRow>(`SELECT * FROM gps.driving_state WHERE vehicle_id = $1`, [vehicleId]);
  const row = r.rows[0];
  if (!row) return { lastT: 0, lastMoving: null, stretchS: 0, stretchWarned: false, shiftS: 0, shiftWarned: false, overSince: null, overMax: null, overEventId: null, unknownKey: null, unknownKeyAt: null };
  return {
    lastT: row.last_t.getTime(),
    lastMoving: row.last_moving?.getTime() ?? null,
    stretchS: row.stretch_s,
    stretchWarned: row.stretch_warned,
    shiftS: row.shift_s,
    shiftWarned: row.shift_warned,
    overSince: row.over_since?.getTime() ?? null,
    overMax: row.over_max,
    overEventId: row.over_event_id,
    unknownKey: row.unknown_key,
    unknownKeyAt: row.unknown_key_at?.getTime() ?? null,
  };
}

const date = (ms: number | null) => (ms === null ? null : new Date(ms));

async function saveState(deps: Deps, vehicleId: string, s: State): Promise<void> {
  await deps.db.core.query(
    `INSERT INTO gps.driving_state (vehicle_id, last_t, last_moving, stretch_s, stretch_warned, shift_s, shift_warned, over_since, over_max, over_event_id, unknown_key, unknown_key_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      WHERE EXISTS (SELECT 1 FROM gps.vehicles WHERE id = $1)
     ON CONFLICT (vehicle_id) DO UPDATE SET last_t = EXCLUDED.last_t, last_moving = EXCLUDED.last_moving, stretch_s = EXCLUDED.stretch_s,
       stretch_warned = EXCLUDED.stretch_warned, shift_s = EXCLUDED.shift_s, shift_warned = EXCLUDED.shift_warned, over_since = EXCLUDED.over_since,
       over_max = EXCLUDED.over_max, over_event_id = EXCLUDED.over_event_id, unknown_key = EXCLUDED.unknown_key, unknown_key_at = EXCLUDED.unknown_key_at`,
    [vehicleId, date(s.lastT), date(s.lastMoving), Math.round(s.stretchS), s.stretchWarned, Math.round(s.shiftS), s.shiftWarned, date(s.overSince), s.overMax, s.overEventId, s.unknownKey, date(s.unknownKeyAt)],
  );
}

/** Records a driving event in the name of whoever was driving at that moment. If already recorded, returns the same one. */
async function addEvent(deps: Deps, ctx: CoreEvents["fixes"], type: DriverEventType, fix: Pick<Fix, "t" | "lat" | "lon">, speedKmh: number | null, detail: Record<string, unknown> = {}): Promise<string> {
  const driver = await driverAt(deps.db.core, ctx.vehicleId, fix.t);
  const r = await deps.db.core.query<{ id: string }>(
    `INSERT INTO gps.driver_events (org_id, vehicle_id, driver_id, type, at, lat, lon, speed_kmh, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (vehicle_id, type, at) DO UPDATE SET detail = gps.driver_events.detail
     RETURNING id`,
    [ctx.orgId, ctx.vehicleId, driver?.id ?? null, type, new Date(fix.t), fix.lat, fix.lon, speedKmh, JSON.stringify(detail)],
  );
  return (r.rows[0] as { id: string }).id;
}

const minutes = (seconds: number) => Math.round(seconds / 60);

/**
 * Processes a vehicle's new positions, in order. `known` remembers the
 * last key seen on each vehicle so it is not looked up on every position.
 */
export async function processFixes(deps: Deps, ctx: CoreEvents["fixes"], settings: DriverSettings, known: Map<string, string>): Promise<void> {
  const state = await loadState(deps, ctx.vehicleId);
  const before = JSON.stringify(state);
  /** Already-recorded speeding whose maximum or duration changed in this batch. */
  let overDirty = false;
  const flushOver = async (endedAt: number | null) => {
    if (state.overEventId !== null && state.overSince !== null && (overDirty || endedAt !== null)) {
      await deps.db.core.query(`UPDATE gps.driver_events SET speed_kmh = GREATEST(speed_kmh, $2), detail = detail || $3::jsonb WHERE id = $1`, [
        state.overEventId,
        state.overMax,
        JSON.stringify({ seconds: Math.round(((endedAt ?? state.lastT) - state.overSince) / 1000), limitKmh: settings.speedLimitKmh }),
      ]);
    }
    overDirty = false;
  };

  for (const fix of ctx.fixes) {
    // 1. The driver's key: whoever identifies themselves starts driving the vehicle.
    const key = normalizeKey(fix.attributes.driverUniqueId);
    if (key && fix.t > state.lastT && known.get(ctx.vehicleId) !== key) {
      known.set(ctx.vehicleId, key);
      const driverId = await driverByKey(deps.db.core, ctx.orgId, key);
      if (driverId) {
        const changed = await setDriver(deps, ctx.orgId, ctx.vehicleId, driverId, { at: fix.t, source: "key" });
        if (changed) Object.assign(state, { lastMoving: null, stretchS: 0, stretchWarned: false, shiftS: 0, shiftWarned: false });
        state.unknownKey = state.unknownKeyAt = null;
      } else {
        state.unknownKey = key;
        state.unknownKeyAt = fix.t;
      }
    }

    // 2. The device's own alerts. They count even if the position arrives late.
    for (const alarm of fix.alarms) {
      const type = HARSH[alarm];
      if (type) await addEvent(deps, ctx, type, fix, fix.speedKmh);
    }
    if (fix.t <= state.lastT) continue;

    const speed = fix.speedKmh ?? 0;
    const silence = state.lastT === 0 ? 0 : (fix.t - state.lastT) / 1000;

    // 3. Speeding: counts once per episode, when it lasts as long as the settings require.
    if (state.overSince !== null && (speed <= settings.speedLimitKmh || silence > MAX_GAP_S)) {
      await flushOver(silence > MAX_GAP_S ? state.lastT : fix.t);
      state.overSince = state.overMax = state.overEventId = null;
    }
    if (speed > settings.speedLimitKmh) {
      if (state.overSince === null) {
        state.overSince = fix.t;
        state.overMax = speed;
      } else if (speed > (state.overMax ?? 0)) {
        state.overMax = speed;
        overDirty = state.overEventId !== null;
      }
      if (state.overEventId === null && fix.t - state.overSince >= settings.speedingSeconds * 1000) {
        state.overEventId = await addEvent(deps, ctx, "speeding", { t: state.overSince, lat: fix.lat, lon: fix.lon }, state.overMax, { limitKmh: settings.speedLimitKmh });
      } else if (state.overEventId !== null) {
        overDirty = true;
      }
    }

    // 4. Time behind the wheel: stretch without rest and shift.
    if (speed >= TRIP_MOVING_KMH) {
      const pause = state.lastMoving === null ? Number.POSITIVE_INFINITY : (fix.t - state.lastMoving) / 1000;
      if (pause >= SHIFT_REST_MIN * 60) {
        Object.assign(state, { stretchS: 0, stretchWarned: false, shiftS: 0, shiftWarned: false });
      } else if (pause >= settings.minRestMin * 60) {
        state.stretchS = 0;
        state.stretchWarned = false;
      } else if ((state.lastMoving === state.lastT && pause <= MAX_GAP_S) || pause < MIN_STOP_S) {
        // It was moving, or took a break so short that it is still the same stretch.
        state.stretchS += pause;
        state.shiftS += pause;
      }
      state.lastMoving = fix.t;
      const warn = async (kind: "continuous" | "daily", seconds: number, limitMin: number) => {
        const driver = await driverAt(deps.db.core, ctx.vehicleId, fix.t);
        await recordEvent(deps, ctx, {
          type: "driving_time",
          at: fix.t,
          lat: fix.lat,
          lon: fix.lon,
          speedKmh: fix.speedKmh,
          detail: { kind, minutes: minutes(seconds), limitMinutes: limitMin, ...(driver ? { driverId: driver.id, driverName: driver.name } : {}) },
        });
      };
      if (!state.stretchWarned && state.stretchS >= settings.maxContinuousMin * 60) {
        state.stretchWarned = true;
        await warn("continuous", state.stretchS, settings.maxContinuousMin);
      }
      if (!state.shiftWarned && state.shiftS >= settings.maxDailyMin * 60) {
        state.shiftWarned = true;
        await warn("daily", state.shiftS, settings.maxDailyMin);
      }
    }
    state.lastT = fix.t;
  }

  await flushOver(null);
  if (JSON.stringify(state) !== before) await saveState(deps, ctx.vehicleId, state);
}
