// Core internal events. Ingest and the API publish; the live channel
// and, later, the optional modules listen. Today everything runs in a single
// process; when processes are split, this same contract travels over LISTEN/NOTIFY.
import { EventEmitter } from "node:events";
import type { VehicleDevice, VehicleEvent, VehicleState } from "@opengps/shared";

/** What the rules need from a position. */
export interface Fix {
  /** GPS time in milliseconds. */
  t: number;
  lat: number;
  lon: number;
  speedKmh: number | null;
  ignition: boolean | null;
  /** Vehicle battery voltage and device battery charge. */
  powerV: number | null;
  batteryPct: number | null;
  /** Alarms the device sent with this position: "sos", "powerCut"… */
  alarms: string[];
  /** Everything else the device sent, as Traccar delivers it. Modules read it. */
  attributes: Record<string, unknown>;
}

export interface CoreEvents {
  /** Last position of a device after saving a batch. */
  position: { orgId: string; vehicleId: string; groupId: string | null; deviceId: number; state: VehicleState };
  /** A vehicle's device changed: confirmed, expired or removed. */
  device: { orgId: string; vehicleId: string; groupId: string | null; device: VehicleDevice | null };
  /** What a person can see or do in an account changed: their live connection restarts. */
  access_changed: { orgId: string; userId: string };
  /** A vehicle of the account was created, edited or deleted. */
  vehicles_changed: { orgId: string };
  /** The device list changed: ingest reloads its map. */
  devices_changed: Record<string, never>;
  /** New, valid positions of a device, from oldest to most recent. */
  fixes: { orgId: string; vehicleId: string; groupId: string | null; deviceId: number; fixes: Fix[] };
  /** A geofence of the account was created, edited or deleted. */
  geofences_changed: { orgId: string };
  /** The account's alerts changed, or a vehicle's parked mode. */
  alerts_changed: { orgId: string };
  /** A whole account was deleted: whoever keeps something of theirs outside the database deletes it. */
  account_deleted: { orgId: string };
  /** The modules enabled for an account changed. */
  modules_changed: { orgId: string };
  /** A section of the platform settings changed. */
  settings_changed: { section: string };
  /** Module H: a dispatch was created, changed or closed. */
  routes_changed: { orgId: string };
  /** Module A: an incident was opened or changed. */
  incident: { orgId: string; groupId: string | null; vehicleId: string };
  /** Module A: a vehicle's lock or recovery mode changed. */
  security: { orgId: string; groupId: string | null; vehicleId: string };
  /** Module B: the drivers or who drives each vehicle changed. */
  drivers: { orgId: string };
  /** Something to record or notify happened: an entry, an exit, a dwell. */
  event: {
    orgId: string;
    groupId: string | null;
    event: VehicleEvent;
    /** Alert that generated it, if it came from one. */
    ruleId: string | null;
  };
}

export class Bus {
  private readonly emitter = new EventEmitter().setMaxListeners(100);

  emit<K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof CoreEvents>(event: K, listener: (payload: CoreEvents[K]) => void): () => void {
    const wrapped = (payload: CoreEvents[K]) => {
      try {
        listener(payload);
      } catch (err) {
        console.error(`[bus] a listener of "${event}" failed:`, err);
      }
    };
    this.emitter.on(event, wrapped);
    return () => this.emitter.off(event, wrapped);
  }
}
