// What the module does on its own while positions arrive: notes the fault
// codes that appear and those that are resolved, and notifies when the engine
// over-revs, overheats or the vehicle's battery is low.
import type { EventType } from "@opengps/shared";
import type { CoreEvents, Fix } from "../../bus";
import { recordEvent } from "../../core/events";
import { readFaults, readParam } from "../../core/readings";
import type { ModuleDeps } from "../context";
import { limitsFor, voltageLimit } from "./diag";
import { describeDtc } from "./dtc";

/** How long each condition must last to notify: an isolated peak does not count. */
const OVERREV_S = 5;
const OVERHEAT_S = 30;
/** On start-up the voltage drops for a moment: the battery is low if it stays that way for several minutes. */
const LOW_BATTERY_S = 300;
/** After notifying, the same notification for the same vehicle is not repeated within this time. */
const COOLDOWN_MS = 30 * 60_000;
/** The last time an active fault was seen is saved at most this often. */
const TOUCH_MS = 5 * 60_000;

export interface DiagnosticsEngine {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
}

/** A condition that must be held for a while to notify, and fully released to notify again. */
interface Hold {
  since: number | null;
  alerted: boolean;
}
interface State {
  rev: Hold;
  heat: Hold;
  low: Hold;
  /** Active codes, with the last time it was saved that they were still there. `null`: not yet read from the database. */
  faults: Map<string, number> | null;
}

export function createDiagnosticsEngine(deps: ModuleDeps): DiagnosticsEngine {
  const db = deps.db.core;
  let queue: Promise<unknown> = Promise.resolve();
  const off: (() => void)[] = [];
  const states = new Map<string, State>();
  const protocols = new Map<number, string | null>();

  async function protocolOf(deviceId: number): Promise<string | null> {
    if (protocols.has(deviceId)) return protocols.get(deviceId) ?? null;
    const r = await db.query<{ protocol: string }>(`SELECT m.protocol FROM gps.devices d JOIN gps.device_models m ON m.id = d.model_id WHERE d.id = $1`, [deviceId]);
    const protocol = r.rows[0]?.protocol ?? null;
    protocols.set(deviceId, protocol);
    return protocol;
  }

  const stateOf = (vehicleId: string): State => {
    let state = states.get(vehicleId);
    if (!state) {
      state = { rev: { since: null, alerted: false }, heat: { since: null, alerted: false }, low: { since: null, alerted: false }, faults: null };
      states.set(vehicleId, state);
    }
    return state;
  };

  /** Advances a condition with a reading. Returns whether it is time to notify now. */
  function step(hold: Hold, t: number, over: boolean, clear: boolean, seconds: number): boolean {
    if (over) {
      hold.since ??= t;
      if (!hold.alerted && t - hold.since >= seconds * 1000) {
        hold.alerted = true;
        return true;
      }
    } else if (clear) {
      hold.since = null;
      hold.alerted = false;
    } else if (!hold.alerted) {
      // It dropped below the limit without fully releasing: the count starts over.
      hold.since = null;
    }
    return false;
  }

  async function onFixes(payload: CoreEvents["fixes"]): Promise<void> {
    if (payload.fixes.length === 0 || !(await deps.gate.enabled(payload.orgId, "C"))) return;
    const protocol = await protocolOf(payload.deviceId);
    const limits = await limitsFor(db, payload.orgId, payload.vehicleId);
    const state = stateOf(payload.vehicleId);
    const context = { orgId: payload.orgId, vehicleId: payload.vehicleId, deviceId: payload.deviceId, groupId: payload.groupId };

    async function raise(type: EventType, fix: Fix, detail: Record<string, unknown>): Promise<void> {
      // If the server restarted mid-condition, what was already notified a short while ago is not repeated.
      const recent = await db.query(`SELECT 1 FROM gps.events WHERE vehicle_id = $1 AND type = $2 AND at > $3 LIMIT 1`, [payload.vehicleId, type, new Date(fix.t - COOLDOWN_MS)]);
      if (recent.rowCount) return;
      await recordEvent(deps, context, { type, at: fix.t, lat: fix.lat, lon: fix.lon, speedKmh: fix.speedKmh, detail });
    }

    for (const fix of payload.fixes) {
      const rpm = readParam("rpm", fix.attributes, protocol);
      if (rpm !== null && limits.rpmMax !== null && step(state.rev, fix.t, rpm > limits.rpmMax, rpm < limits.rpmMax * 0.9, OVERREV_S)) {
        await raise("engine_overrev", fix, { rpm: Math.round(rpm), limit: limits.rpmMax });
      }
      const temp = readParam("coolantTemp", fix.attributes, protocol);
      if (temp !== null && limits.tempMaxC !== null && step(state.heat, fix.t, temp > limits.tempMaxC, temp < limits.tempMaxC - 5, OVERHEAT_S)) {
        await raise("engine_overheat", fix, { tempC: Math.round(temp), limit: limits.tempMaxC });
      }
      // Below 6 V it is not a low battery: it is disconnected, and the core notifies that.
      const volts = fix.powerV;
      if (volts !== null && volts >= 6 && limits.voltageMinV !== null) {
        const limit = voltageLimit(limits.voltageMinV, volts);
        if (step(state.low, fix.t, volts < limit, volts > limit + 0.3, LOW_BATTERY_S)) await raise("battery_low", fix, { volts: Math.round(volts * 10) / 10, limit });
      }

      const reported = readFaults(fix.attributes, protocol);
      if (reported === null) continue;
      if (state.faults === null) {
        const active = await db.query<{ code: string; last_seen: Date }>(`SELECT code, last_seen FROM gps.vehicle_faults WHERE vehicle_id = $1 AND cleared_at IS NULL`, [payload.vehicleId]);
        state.faults = new Map(active.rows.map((r) => [r.code, r.last_seen.getTime()]));
      }
      for (const code of reported) {
        const seen = state.faults.get(code);
        if (seen === undefined) {
          const added = await db.query(
            `INSERT INTO gps.vehicle_faults (org_id, vehicle_id, code, first_seen, last_seen) VALUES ($1, $2, $3, $4, $4) ON CONFLICT (vehicle_id, code) WHERE cleared_at IS NULL DO NOTHING`,
            [payload.orgId, payload.vehicleId, code, new Date(fix.t)],
          );
          state.faults.set(code, fix.t);
          if (added.rowCount) {
            const info = describeDtc(code, deps.config.defaultLanguage); // i18n: stored text
            await recordEvent(deps, context, { type: "engine_fault", at: fix.t, lat: fix.lat, lon: fix.lon, speedKmh: fix.speedKmh, detail: { code, description: info.description } });
          }
        } else if (fix.t - seen > TOUCH_MS) {
          await db.query(`UPDATE gps.vehicle_faults SET last_seen = $3 WHERE vehicle_id = $1 AND code = $2 AND cleared_at IS NULL`, [payload.vehicleId, code, new Date(fix.t)]);
          state.faults.set(code, fix.t);
        }
      }
      // With the engine on, a code the vehicle no longer reports is considered resolved. When off, the reading may come back empty without anything having changed.
      if (fix.ignition !== true) continue;
      const gone = Array.from(state.faults.keys()).filter((code) => !reported.includes(code));
      for (const code of gone) {
        await db.query(`UPDATE gps.vehicle_faults SET cleared_at = $3 WHERE vehicle_id = $1 AND code = $2 AND cleared_at IS NULL`, [payload.vehicleId, code, new Date(fix.t)]);
        state.faults.delete(code);
        await recordEvent(deps, context, { type: "engine_fault_cleared", at: fix.t, lat: fix.lat, lon: fix.lon, speedKmh: fix.speedKmh, detail: { code, description: describeDtc(code, deps.config.defaultLanguage).description } }); // i18n: stored text
      }
    }
  }

  return {
    start() {
      off.push(
        deps.bus.on("fixes", (payload) => {
          queue = queue.then(() => onFixes(payload)).catch((err: Error) => console.error("[diagnostics] could not check a position:", err.message));
        }),
        deps.bus.on("devices_changed", () => protocols.clear()),
        deps.bus.on("vehicles_changed", () => {
          // A vehicle deleted and recreated does not inherit what was known about the previous one.
          for (const state of states.values()) state.faults = null;
        }),
      );
    },
    stop() {
      for (const stop of off.splice(0)) stop();
    },
    idle: () => queue.then(() => undefined),
  };
}
