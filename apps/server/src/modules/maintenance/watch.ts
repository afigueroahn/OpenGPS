// What the module does on its own: every so often it checks which services
// are about to be due or already were and which documents expire, and notifies once for
// each one. If the service is later done or the document renewed, the
// count starts over and it will notify again when the time comes.
import type { EventType, Language, MaintDueStatus } from "@opengps/shared";
import { recordEvent } from "../../core/events";
import { tr } from "../../i18n";
import type { ModuleDeps } from "../context";
import { expiriesOf, schedulesOf, settingsOf } from "./due";
import { dropAccountFiles } from "./orders";

const SWEEP_MS = 15 * 60_000;

export interface MaintenanceEngine {
  start(): void;
  stop(): void;
  idle(): Promise<void>;
  /** Checks now, without waiting for the clock. */
  sweep(now?: number): Promise<void>;
}

interface Due {
  kind: "schedule" | "expiry" | "document";
  ref: string;
  vehicleId: string;
  stage: Exclude<MaintDueStatus, "ok">;
  /** Which expiry it refers to: if it changes, it is a different notification. */
  target: string;
  type: EventType;
  subject: string;
  reason: string;
}

const dayLabel = (date: string, language: Language) => new Intl.DateTimeFormat(language, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

export function createMaintenanceEngine(deps: ModuleDeps & { sweepEveryMs?: number | null }): MaintenanceEngine {
  const db = deps.db.core;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  const off: (() => void)[] = [];
  const enqueue = (what: string, job: () => Promise<unknown>) => {
    queue = queue.then(job).catch((err: Error) => console.error(`[maintenance] ${what}:`, err.message));
  };

  async function sweepAccount(orgId: string, now: number): Promise<void> {
    const settings = await settingsOf(db, orgId);
    // What is notified is stored with the event and read later.
    const language = deps.config.defaultLanguage; // i18n: stored text
    const cars = await db.query<{ id: string; name: string; group_id: string | null; device_id: string | null }>(
      `SELECT v.id, v.name, v.group_id, d.id AS device_id FROM gps.vehicles v LEFT JOIN gps.devices d ON d.vehicle_id = v.id WHERE v.org_id = $1`,
      [orgId],
    );
    const byId = new Map(cars.rows.map((c) => [c.id, c]));
    const due: Due[] = [];
    for (const s of await schedulesOf(db, cars.rows, settings.zone, now, language)) {
      if (s.status === "ok") continue;
      due.push({ kind: "schedule", ref: s.id, vehicleId: s.vehicleId, stage: s.status, target: `${s.lastOn}|${s.lastKm ?? ""}|${s.lastHours ?? ""}`, type: s.status === "due" ? "service_due" : "service_soon", subject: s.planName, reason: s.reason });
    }
    for (const e of await expiriesOf(deps, orgId, cars.rows, settings.zone, now)) {
      if (e.status === "ok") continue;
      const kind = tr(language, `shared.maintExpiry.${e.kind}`);
      const label = e.name ? `${kind} · ${e.name}` : kind;
      const reason =
        e.daysLeft < 0
          ? tr(language, "maintenance.notices.expired", { date: dayLabel(e.expiresOn, language) })
          : e.daysLeft === 0
            ? tr(language, "maintenance.notices.dueToday")
            : tr(language, "maintenance.notices.expires", { date: dayLabel(e.expiresOn, language) });
      due.push({ kind: e.source === "fleet" ? "document" : "expiry", ref: e.id, vehicleId: e.vehicleId, stage: e.status, target: e.expiresOn, type: e.status === "due" ? "expiry_due" : "expiry_soon", subject: label, reason });
    }
    if (due.length === 0) return;
    const told = await db.query<{ kind: string; ref: string; stage: string; target: string }>(`SELECT kind, ref, stage, target FROM gps.maint_notices WHERE org_id = $1`, [orgId]);
    const seen = new Map(told.rows.map((n) => [`${n.kind}:${n.ref}`, n]));
    for (const item of due) {
      const before = seen.get(`${item.kind}:${item.ref}`);
      // This was already notified, or something more serious: "overdue" does not go back to "upcoming".
      if (before && before.target === item.target && (before.stage === item.stage || before.stage === "due")) continue;
      const car = byId.get(item.vehicleId);
      // Notifications go with the vehicle's device: without a device, it stays visible in the section and will be notified when it has one.
      if (!car?.device_id) continue;
      await recordEvent(
        deps,
        { orgId, vehicleId: car.id, deviceId: Number(car.device_id), groupId: car.group_id },
        { type: item.type, at: now, lat: null, lon: null, speedKmh: null, detail: { subject: item.subject, reason: item.reason } },
      );
      await db.query(
        `INSERT INTO gps.maint_notices (kind, ref, org_id, stage, target) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (kind, ref) DO UPDATE SET stage = EXCLUDED.stage, target = EXCLUDED.target, at = now()`,
        [item.kind, item.ref, orgId, item.stage, item.target],
      );
    }
  }

  async function sweep(now = Date.now()): Promise<void> {
    const accounts = await db.query<{ org_id: string }>(`SELECT org_id FROM gps.maint_schedules UNION SELECT org_id FROM gps.maint_expiries UNION SELECT org_id FROM gps.fleet_documents WHERE expires_on IS NOT NULL`);
    for (const { org_id: orgId } of accounts.rows) {
      if (!(await deps.gate.enabled(orgId, "E"))) continue;
      await sweepAccount(orgId, now).catch((err: Error) => console.error(`[maintenance] could not check account ${orgId}:`, err.message));
    }
  }

  return {
    start() {
      off.push(deps.bus.on("account_deleted", (e) => enqueue("could not delete an account's files", () => dropAccountFiles(deps, e.orgId))));
      const every = deps.sweepEveryMs === undefined ? SWEEP_MS : deps.sweepEveryMs;
      if (every !== null) timer = setInterval(() => enqueue("the periodic check failed", () => sweep()), every);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const stop of off.splice(0)) stop();
    },
    idle: () => queue.then(() => undefined),
    sweep: (now) => {
      enqueue("the check failed", () => sweep(now));
      return queue.then(() => undefined);
    },
  };
}
