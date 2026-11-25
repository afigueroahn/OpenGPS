// What the module does on its own: when positions arrive for a vehicle
// with a level sensor, it checks whether there was a fill or a drain and records it as an
// event. A drain with the engine off is a possible theft, and it is notified.
//
// It does not store the level: it re-reads the recent positions, with the same
// calculation the report does, so what it notifies and what the report shows
// come from the same computation. What arrives late is checked at its own time.
import type { CoreEvents } from "../../bus";
import { recordEvent } from "../../core/events";
import type { ModuleDeps } from "../context";
import { analyzeFuel, tankOf } from "./fuel";

const SWEEP_MS = 120_000;
/** How far back the positions are read to have the level from before the stop. */
const LOOKBACK_MS = 12 * 3_600_000;
/** Two detected fills less than this apart are the same one. */
const SAME_REFUEL_MS = 30 * 60_000;
/** A fill is recorded when the level has stopped rising for this long: before that it may be partial. */
const REFUEL_SETTLED_MS = 3 * 60_000;
/** If the device goes silent after filling, once this time passes it is recorded with what there is. */
const REFUEL_WAIT_MS = 10 * 60_000;
const MARGIN_MS = 5 * 60_000;

export interface FuelEngine {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
  /** Checks the vehicles that received positions since last time, and those left waiting. `now` is only changed by tests. */
  sweep(now?: number): Promise<void>;
}

interface Pending {
  orgId: string;
  groupId: string | null;
  deviceId: number;
  /** Time of the oldest and the most recent position that arrived. */
  from: number;
  to: number;
}

export function createFuelEngine(deps: ModuleDeps & { sweepEveryMs?: number | null }): FuelEngine {
  const db = deps.db.core;
  const pending = new Map<string, Pending>();
  let queue: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  const off: (() => void)[] = [];
  const enqueue = (what: string, job: () => Promise<unknown>) => {
    queue = queue.then(job).catch((err: Error) => console.error(`[fuel] ${what}:`, err.message));
  };

  async function onFixes(payload: CoreEvents["fixes"]): Promise<void> {
    const first = payload.fixes[0];
    const last = payload.fixes[payload.fixes.length - 1];
    if (!first || !last || !(await deps.gate.enabled(payload.orgId, "F"))) return;
    const known = pending.get(payload.vehicleId);
    pending.set(payload.vehicleId, {
      orgId: payload.orgId,
      groupId: payload.groupId,
      deviceId: payload.deviceId,
      from: Math.min(known?.from ?? first.t, first.t),
      to: Math.max(known?.to ?? last.t, last.t),
    });
  }

  /** Checks a vehicle. Returns whether something is left to record later: a fill that may be partial. */
  async function check(vehicleId: string, p: Pending, now: number): Promise<boolean> {
    const tank = await tankOf(db, vehicleId);
    if (!tank?.attr) return false;
    const range = { from: new Date(p.from - LOOKBACK_MS), to: new Date(p.to + 1000) };
    const { samples, fills, drains } = await analyzeFuel(db, p.orgId, vehicleId, tank, range);
    if (fills.length + drains.length === 0) return false;
    let waiting = false;
    const noted = await db.query<{ kind: "refuel" | "drain"; at: Date }>(`SELECT kind, at FROM gps.fuel_events WHERE vehicle_id = $1 AND at >= $2 AND at <= $3`, [
      vehicleId,
      new Date(range.from.getTime() - 3_600_000),
      new Date(range.to.getTime() + 3_600_000),
    ]);
    const already = (kind: "refuel" | "drain", from: number, to: number) => noted.rows.some((e) => e.kind === kind && e.at.getTime() >= from && e.at.getTime() <= to);
    const context = { orgId: p.orgId, vehicleId, deviceId: p.deviceId, groupId: p.groupId };
    const note = (kind: "refuel" | "drain", at: number, liters: number, engineOff: boolean) =>
      db.query(`INSERT INTO gps.fuel_events (org_id, vehicle_id, kind, at, liters, engine_off) VALUES ($1, $2, $3, $4, $5, $6)`, [p.orgId, vehicleId, kind, new Date(at), liters, engineOff]);
    const round1 = (n: number) => Math.round(n * 10) / 10;

    const lastReading = samples[samples.length - 1]?.t ?? p.to;
    for (const fill of fills) {
      if (already("refuel", fill.t - SAME_REFUEL_MS, fill.t + SAME_REFUEL_MS)) continue;
      if (lastReading - fill.t < REFUEL_SETTLED_MS && now - fill.t < REFUEL_WAIT_MS) {
        waiting = true;
        continue;
      }
      // Where it was when filling: the position closest to that time.
      const place = samples.reduce((best, s) => (Math.abs(s.t - fill.t) < Math.abs(best.t - fill.t) ? s : best), samples[0] as (typeof samples)[number]);
      await note("refuel", fill.t, fill.l, false);
      await recordEvent(deps, context, { type: "fuel_refuel", at: fill.t, lat: place.lat, lon: place.lon, speedKmh: null, detail: { liters: round1(fill.l) } });
    }
    for (const drain of drains) {
      // Only one per stop: if already recorded, whatever keeps dropping is the same one.
      if (already("drain", drain.pause.from - MARGIN_MS, drain.pause.to + MARGIN_MS)) continue;
      await note("drain", drain.t, drain.l, drain.engineOff);
      const type = drain.engineOff ? "fuel_theft" : "fuel_drain";
      await recordEvent(deps, context, { type, at: drain.t, lat: drain.pause.lat, lon: drain.pause.lon, speedKmh: null, detail: { liters: round1(drain.l), engineOff: drain.engineOff } });
    }
    return waiting;
  }

  async function sweep(now = Date.now()): Promise<void> {
    const batch = [...pending];
    pending.clear();
    for (const [vehicleId, p] of batch) {
      const waiting = await check(vehicleId, p, now).catch((err: Error) => {
        console.error(`[fuel] could not check vehicle ${vehicleId}:`, err.message);
        return false;
      });
      // It stays for the next round, along with whatever arrives in the meantime.
      if (waiting) {
        const newer = pending.get(vehicleId);
        pending.set(vehicleId, newer ? { ...newer, from: Math.min(newer.from, p.from), to: Math.max(newer.to, p.to) } : p);
      }
    }
  }

  return {
    start() {
      off.push(deps.bus.on("fixes", (payload) => enqueue("could not note a position", () => onFixes(payload))));
      const every = deps.sweepEveryMs === undefined ? SWEEP_MS : deps.sweepEveryMs;
      if (every !== null) timer = setInterval(() => enqueue("the periodic check failed", () => sweep()), every);
    },
    stop() {
      for (const stop of off.splice(0)) stop();
      if (timer) clearInterval(timer);
      timer = null;
    },
    idle: () => queue.then(() => undefined),
    sweep: (now) => {
      enqueue("the check failed", () => sweep(now));
      return queue.then(() => undefined);
    },
  };
}
