// Ingest: reads the new positions from the Traccar database and stores them in the
// platform, exactly once each.
//
// Traccar numbers its positions in order. The platform remembers up to which
// number it has read (the cursor) and asks for what follows. Two simultaneous writes in
// Traccar can commit out of order, so the cursor only advances over
// positions older than a few seconds: the most recent ones are processed
// immediately and read again on the next round. Storing them twice does not
// duplicate anything, because the key is device + GPS time + content checksum.
import type { Bus, Fix } from "../bus";
import { toDevice, toState } from "../core/vehicles";
import { type Db, withTransaction } from "../db";
import { type NormalizedPosition, type TraccarPosition, alarmsOf, normalize } from "./normalize";

const BATCH = 2000;
const SETTLE_SECONDS = 5;
const POLL_MS = 1000;
const ERROR_BACKOFF_MS = 5000;
const DEVICE_RELOAD_MS = 60_000;
const UNKNOWN_RELOAD_MS = 3000;
/** SQL condition: the incoming position is newer than the stored one. */
const NEWER = "(EXCLUDED.fix_time IS NOT NULL AND (s.fix_time IS NULL OR EXCLUDED.fix_time >= s.fix_time))";

interface DeviceRef {
  id: number;
  orgId: string;
  vehicleId: string;
  groupId: string | null;
  pending: boolean;
}

export interface IngestStatus {
  running: boolean;
  cursor: number;
  lastPollAt: string | null;
  lastError: string | null;
  stored: number;
}

export interface Ingest {
  start(): void;
  stop(): Promise<void>;
  /** One full read round. Returns how many new positions it stored. */
  tick(): Promise<number>;
  status(): IngestStatus;
}

/** Traccar position plus the settled flag: old enough to have no gaps behind it. */
export type TraccarRow = TraccarPosition & { settled: boolean };
type Row = TraccarRow;

export interface IngestOptions {
  db: Db;
  bus: Bus;
  /** Cursor name. Tests use their own. */
  source?: string;
  /** Read of positions after the cursor. By default, the Traccar database. */
  read?: (cursor: number, limit: number) => Promise<TraccarRow[]>;
}

export function createIngest(deps: IngestOptions): Ingest {
  const { db, bus } = deps;
  const SOURCE = deps.source ?? "traccar";
  let devices = new Map<number, DeviceRef>();
  let devicesLoadedAt = 0;
  let devicesStale = true;
  let cursor = -1;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<unknown> | null = null;
  const stats = { lastPollAt: null as string | null, lastError: null as string | null, stored: 0 };

  bus.on("devices_changed", () => {
    devicesStale = true;
  });
  // A vehicle may have changed group.
  bus.on("vehicles_changed", () => {
    devicesStale = true;
  });

  async function loadDevices(): Promise<void> {
    const r = await db.core.query<{ id: number; org_id: string; vehicle_id: string; group_id: string | null; traccar_device_id: number; status: string }>(
      `SELECT d.id, d.org_id, d.vehicle_id, v.group_id, d.traccar_device_id, d.status
         FROM gps.devices d JOIN gps.vehicles v ON v.id = d.vehicle_id`,
    );
    devices = new Map(
      r.rows.map((d) => [
        d.traccar_device_id,
        { id: d.id, orgId: d.org_id, vehicleId: d.vehicle_id, groupId: d.group_id, pending: d.status === "pending" },
      ]),
    );
    devicesLoadedAt = Date.now();
    devicesStale = false;
  }

  async function loadCursor(): Promise<void> {
    const r = await db.core.query<{ last_id: number }>(`SELECT last_id FROM gps.ingest_cursor WHERE source = $1`, [SOURCE]);
    cursor = r.rows[0]?.last_id ?? 0;
  }

  async function readBatch(): Promise<Row[]> {
    if (deps.read) return deps.read(cursor, BATCH);
    // Traccar stores its times without a zone, in UTC.
    const r = await db.traccar.query<Row>(
      `SELECT id, deviceid, protocol,
              servertime AT TIME ZONE 'UTC' AS servertime,
              fixtime AT TIME ZONE 'UTC' AS fixtime,
              valid, latitude, longitude, altitude, speed, course, accuracy, attributes,
              servertime < (now() AT TIME ZONE 'UTC') - make_interval(secs => $3) AS settled
         FROM tc_positions
        WHERE id > $1
        ORDER BY id
        LIMIT $2`,
      [cursor, BATCH, SETTLE_SECONDS],
    );
    return r.rows;
  }

  async function store(rows: Row[], nextCursor: number): Promise<number> {
    const items: { device: DeviceRef; p: NormalizedPosition }[] = [];
    for (const row of rows) {
      const device = devices.get(row.deviceid);
      if (!device) continue;
      const p = normalize(row);
      if (p) items.push({ device, p });
    }

    const result = await withTransaction(db.core, async (client) => {
      let fresh = new Set<string>();
      if (items.length > 0) {
        const inserted = await client.query<{ device_id: number; fix_time: Date; hash: string }>(
          `INSERT INTO gps.positions
             (device_id, fix_time, hash, received_at, valid, lat, lon, altitude, speed_kmh, course, accuracy, protocol, attributes)
           SELECT * FROM unnest(
             $1::bigint[], $2::timestamptz[], $3::bigint[], $4::timestamptz[], $5::boolean[],
             $6::float8[], $7::float8[], $8::real[], $9::real[], $10::real[], $11::real[], $12::text[], $13::jsonb[])
           ON CONFLICT (device_id, fix_time, hash) DO NOTHING
           RETURNING device_id, fix_time, hash::text AS hash`,
          [
            items.map((i) => i.device.id),
            items.map((i) => i.p.fixTime),
            items.map((i) => i.p.hash),
            items.map((i) => i.p.receivedAt),
            items.map((i) => i.p.valid),
            items.map((i) => i.p.lat),
            items.map((i) => i.p.lon),
            items.map((i) => i.p.altitude),
            items.map((i) => i.p.speedKmh),
            items.map((i) => i.p.course),
            items.map((i) => i.p.accuracy),
            items.map((i) => i.p.protocol),
            items.map((i) => JSON.stringify(i.p.attributes)),
          ],
        );
        fresh = new Set(inserted.rows.map((r) => `${r.device_id}|${r.fix_time.getTime()}|${r.hash}`));
      }

      // For each device with new positions: the most recent valid one and the last contact.
      const latest = new Map<number, { device: DeviceRef; lastSeen: Date; best: NormalizedPosition | null }>();
      for (const { device, p } of items) {
        if (!fresh.has(`${device.id}|${p.fixTime.getTime()}|${p.hash}`)) continue;
        const entry = latest.get(device.id) ?? { device, lastSeen: p.receivedAt, best: null };
        if (p.receivedAt > entry.lastSeen) entry.lastSeen = p.receivedAt;
        if (p.valid && (!entry.best || p.fixTime >= entry.best.fixTime)) entry.best = p;
        latest.set(device.id, entry);
      }

      const states: { device: DeviceRef; state: ReturnType<typeof toState> }[] = [];
      if (latest.size > 0) {
        const list = [...latest.values()];
        // Late data does not overwrite a newer position: it only counts as contact.
        const updated = await client.query<Parameters<typeof toState>[0] & { device_id: number }>(
          `INSERT INTO gps.device_state AS s
             (device_id, last_seen_at, fix_time, lat, lon, altitude, speed_kmh, course, accuracy, ignition, motion, attributes,
              ignition_inferred, power_v, battery_v, battery_pct, satellites, signal_bars)
           SELECT * FROM unnest(
             $1::bigint[], $2::timestamptz[], $3::timestamptz[], $4::float8[], $5::float8[],
             $6::real[], $7::real[], $8::real[], $9::real[], $10::boolean[], $11::boolean[], $12::jsonb[],
             $13::boolean[], $14::real[], $15::real[], $16::real[], $17::smallint[], $18::smallint[])
           ON CONFLICT (device_id) DO UPDATE SET
             last_seen_at = GREATEST(s.last_seen_at, EXCLUDED.last_seen_at),
             fix_time   = CASE WHEN ${NEWER} THEN EXCLUDED.fix_time   ELSE s.fix_time   END,
             lat        = CASE WHEN ${NEWER} THEN EXCLUDED.lat        ELSE s.lat        END,
             lon        = CASE WHEN ${NEWER} THEN EXCLUDED.lon        ELSE s.lon        END,
             altitude   = CASE WHEN ${NEWER} THEN EXCLUDED.altitude   ELSE s.altitude   END,
             speed_kmh  = CASE WHEN ${NEWER} THEN EXCLUDED.speed_kmh  ELSE s.speed_kmh  END,
             course     = CASE WHEN ${NEWER} THEN EXCLUDED.course     ELSE s.course     END,
             accuracy   = CASE WHEN ${NEWER} THEN EXCLUDED.accuracy   ELSE s.accuracy   END,
             motion     = CASE WHEN ${NEWER} THEN EXCLUDED.motion     ELSE s.motion     END,
             attributes = CASE WHEN ${NEWER} THEN EXCLUDED.attributes ELSE s.attributes END,
             -- Power, signal and ignition: some devices send them only now and then;
             -- when the new position does not carry them, the last known value is kept.
             ignition          = CASE WHEN ${NEWER} THEN COALESCE(EXCLUDED.ignition, s.ignition) ELSE s.ignition END,
             ignition_inferred = CASE WHEN ${NEWER} AND EXCLUDED.ignition IS NOT NULL THEN EXCLUDED.ignition_inferred ELSE s.ignition_inferred END,
             power_v     = CASE WHEN ${NEWER} THEN COALESCE(EXCLUDED.power_v, s.power_v)         ELSE s.power_v     END,
             battery_v   = CASE WHEN ${NEWER} THEN COALESCE(EXCLUDED.battery_v, s.battery_v)     ELSE s.battery_v   END,
             battery_pct = CASE WHEN ${NEWER} THEN COALESCE(EXCLUDED.battery_pct, s.battery_pct) ELSE s.battery_pct END,
             satellites  = CASE WHEN ${NEWER} THEN COALESCE(EXCLUDED.satellites, s.satellites)   ELSE s.satellites  END,
             signal_bars = CASE WHEN ${NEWER} THEN COALESCE(EXCLUDED.signal_bars, s.signal_bars) ELSE s.signal_bars END,
             updated_at = now()
           RETURNING device_id, last_seen_at, fix_time, lat, lon, altitude, speed_kmh, course, accuracy, ignition, motion,
                     ignition_inferred, power_v, battery_v, battery_pct, satellites, signal_bars`,
          [
            list.map((e) => e.device.id),
            list.map((e) => e.lastSeen),
            list.map((e) => e.best?.fixTime ?? null),
            list.map((e) => e.best?.lat ?? null),
            list.map((e) => e.best?.lon ?? null),
            list.map((e) => e.best?.altitude ?? null),
            list.map((e) => e.best?.speedKmh ?? null),
            list.map((e) => e.best?.course ?? null),
            list.map((e) => e.best?.accuracy ?? null),
            list.map((e) => e.best?.ignition ?? null),
            list.map((e) => e.best?.motion ?? null),
            list.map((e) => JSON.stringify(e.best?.attributes ?? {})),
            list.map((e) => e.best?.ignitionInferred ?? false),
            list.map((e) => e.best?.powerV ?? null),
            list.map((e) => e.best?.batteryV ?? null),
            list.map((e) => e.best?.batteryPct ?? null),
            list.map((e) => e.best?.satellites ?? null),
            list.map((e) => e.best?.signalBars ?? null),
          ],
        );
        for (const row of updated.rows) {
          const entry = latest.get(row.device_id);
          if (entry) states.push({ device: entry.device, state: toState(row) });
        }
      }

      // The first report confirms the device's addition.
      const reporting = [...new Set(items.filter((i) => i.device.pending).map((i) => i.device.id))];
      const activated =
        reporting.length > 0
          ? (
              await client.query<Parameters<typeof toDevice>[0] & { id: number; org_id: string; vehicle_id: string }>(
                `UPDATE gps.devices SET status = 'active', confirmed_at = now(), claim_expires_at = NULL
                  WHERE id = ANY($1::bigint[]) AND status = 'pending'
                  RETURNING id, org_id, vehicle_id, unique_id, model_id, status, claim_expires_at, confirmed_at`,
                [reporting],
              )
            ).rows
          : [];

      if (nextCursor > cursor) {
        await client.query(
          `INSERT INTO gps.ingest_cursor (source, last_id) VALUES ($1, $2)
           ON CONFLICT (source) DO UPDATE SET last_id = GREATEST(gps.ingest_cursor.last_id, EXCLUDED.last_id), updated_at = now()`,
          [SOURCE, nextCursor],
        );
      }
      // For the rules (geofences, alerts): each device's new, valid data, in order.
      const fixes = new Map<number, { device: DeviceRef; fixes: Fix[] }>();
      for (const { device, p } of items) {
        if (!p.valid || !fresh.has(`${device.id}|${p.fixTime.getTime()}|${p.hash}`)) continue;
        const entry = fixes.get(device.id) ?? { device, fixes: [] };
        entry.fixes.push({
          t: p.fixTime.getTime(),
          lat: p.lat,
          lon: p.lon,
          speedKmh: p.speedKmh,
          ignition: p.ignition,
          powerV: p.powerV,
          batteryPct: p.batteryPct,
          alarms: alarmsOf(p.protocol, p.attributes),
          attributes: p.attributes,
        });
        fixes.set(device.id, entry);
      }
      for (const entry of fixes.values()) entry.fixes.sort((a, b) => a.t - b.t);
      return { stored: fresh.size, states, activated, fixes: [...fixes.values()] };
    });

    // Notifications go out after the transaction commits.
    cursor = Math.max(cursor, nextCursor);
    for (const d of result.activated) {
      const ref = [...devices.values()].find((x) => x.id === d.id);
      if (ref) ref.pending = false;
      bus.emit("device", { orgId: d.org_id, vehicleId: d.vehicle_id, groupId: ref?.groupId ?? null, device: toDevice(d) });
    }
    for (const { device, state } of result.states) {
      bus.emit("position", { orgId: device.orgId, vehicleId: device.vehicleId, groupId: device.groupId, deviceId: device.id, state });
    }
    for (const { device, fixes } of result.fixes) {
      bus.emit("fixes", { orgId: device.orgId, vehicleId: device.vehicleId, groupId: device.groupId, deviceId: device.id, fixes });
    }
    return result.stored;
  }

  async function tick(): Promise<number> {
    if (cursor < 0) await loadCursor();
    if (devicesStale || Date.now() - devicesLoadedAt > DEVICE_RELOAD_MS) await loadDevices();

    let stored = 0;
    for (;;) {
      const rows = await readBatch();
      if (rows.length === 0) break;

      // A newly added device may not yet be in the in-memory map.
      if (rows.some((r) => !devices.has(r.deviceid)) && Date.now() - devicesLoadedAt > UNKNOWN_RELOAD_MS) await loadDevices();

      // The cursor advances only up to the last settled position with no gaps.
      let nextCursor = cursor;
      for (const row of rows) {
        if (!row.settled) break;
        nextCursor = row.id;
      }
      stored += await store(rows, nextCursor);
      // With a full batch and everything settled there is more to read; otherwise, wait for the next round.
      if (rows.length < BATCH || nextCursor !== (rows[rows.length - 1] as Row).id) break;
    }
    stats.stored += stored;
    stats.lastPollAt = new Date().toISOString();
    stats.lastError = null;
    return stored;
  }

  function schedule(delay: number): void {
    if (!running) return;
    timer = setTimeout(() => {
      inFlight = tick()
        .then(() => schedule(POLL_MS))
        .catch((err: Error) => {
          stats.lastError = err.message;
          console.error("[ingest] the read failed:", err.message);
          schedule(ERROR_BACKOFF_MS);
        });
    }, delay);
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await inFlight?.catch(() => {});
    },
    tick,
    status: () => ({ running, cursor: Math.max(cursor, 0), ...stats }),
  };
}
