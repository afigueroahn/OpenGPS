import { type Vehicle, vehicleStatus } from "@opengps/shared";
import { describe, expect, it } from "vitest";
import { type TraccarPosition, alarmsOf, ignitionFromVoltage, normalize, signalBars } from "../src/ingest/normalize";

const base = (over: Partial<TraccarPosition> = {}): TraccarPosition => ({
  id: 1,
  deviceid: 1,
  protocol: "teltonika",
  servertime: new Date("2026-11-21T12:00:05Z"),
  fixtime: new Date("2026-11-21T12:00:00Z"),
  valid: true,
  latitude: -12.05,
  longitude: -77.03,
  altitude: 154.26,
  speed: 20,
  course: 90,
  accuracy: 0,
  attributes: '{"ignition":true,"motion":true,"distance":12.5,"totalDistance":1000}',
  ...over,
});

describe("position normalisation", () => {
  it("converts speed from knots to km/h", () => {
    expect(normalize(base({ speed: 20 }))?.speedKmh).toBe(37);
    expect(normalize(base({ speed: 0 }))?.speedKmh).toBe(0);
    expect(normalize(base({ speed: 54 }))?.speedKmh).toBe(100);
  });

  it("extracts ignition and motion from the attributes", () => {
    const p = normalize(base());
    expect(p?.ignition).toBe(true);
    expect(p?.motion).toBe(true);
    expect(normalize(base({ attributes: "{}" }))?.ignition).toBeNull();
    expect(normalize(base({ attributes: "no es json" }))?.attributes).toEqual({});
  });

  it("discards impossible coordinates", () => {
    expect(normalize(base({ latitude: 91 }))).toBeNull();
    expect(normalize(base({ longitude: -181 }))).toBeNull();
    expect(normalize(base({ latitude: Number.NaN }))).toBeNull();
  });

  it("discards absurd GPS times", () => {
    expect(normalize(base({ fixtime: new Date("2000-01-01T00:00:00Z") }))).toBeNull();
    expect(normalize(base({ fixtime: new Date("2026-11-25T12:00:00Z") }))).toBeNull();
    // Data from weeks ago, downloaded from the device's memory, is accepted.
    expect(normalize(base({ fixtime: new Date("2026-10-01T12:00:00Z") }))).not.toBeNull();
  });

  it("marks the 0,0 coordinate as invalid", () => {
    expect(normalize(base({ latitude: 0, longitude: 0 }))?.valid).toBe(false);
    expect(normalize(base({ valid: false }))?.valid).toBe(false);
  });

  it("gives the same fingerprint to the same resent datum and a different one to a different datum", () => {
    const original = normalize(base());
    // Resent: Traccar recalculates distance and gives it another row number and another arrival time.
    const resent = normalize(
      base({ id: 99, servertime: new Date("2026-11-21T13:00:00Z"), attributes: '{"ignition":true,"motion":false,"distance":0,"totalDistance":2000}' }),
    );
    expect(resent?.hash).toBe(original?.hash);
    expect(normalize(base({ latitude: -12.0501 }))?.hash).not.toBe(original?.hash);
    expect(normalize(base({ attributes: '{"ignition":true,"alarm":"sos"}' }))?.hash).not.toBe(original?.hash);
  });
});

describe("power, signal and ignition", () => {
  it("reads voltage, battery, satellites and signal from the attributes", () => {
    const p = normalize(base({ attributes: '{"ignition":true,"power":13.94,"battery":4.052,"batteryLevel":87,"sat":12,"rssi":4}' }));
    expect(p).toMatchObject({ powerV: 13.9, batteryV: 4.05, batteryPct: 87, satellites: 12, signalBars: 3, ignition: true, ignitionInferred: false });
  });

  it("deduces ignition from voltage when the device does not report it", () => {
    expect(ignitionFromVoltage(13.9)).toBe(true);
    expect(ignitionFromVoltage(12.4)).toBe(false);
    expect(ignitionFromVoltage(27.6)).toBe(true); // 24 V system
    expect(ignitionFromVoltage(24.8)).toBe(false);
    expect(ignitionFromVoltage(3.9)).toBeNull(); // battery-powered device
    expect(ignitionFromVoltage(null)).toBeNull();
    expect(normalize(base({ attributes: '{"power":14.1}' }))).toMatchObject({ ignition: true, ignitionInferred: true });
    expect(normalize(base({ attributes: '{"power":12.3}' }))).toMatchObject({ ignition: false, ignitionInferred: true });
    // What the device says takes precedence over the voltage.
    expect(normalize(base({ attributes: '{"ignition":false,"power":14.1}' }))).toMatchObject({ ignition: false, ignitionInferred: false });
    expect(normalize(base({ attributes: "{}" }))).toMatchObject({ ignition: null, ignitionInferred: false });
  });

  it("deducing the ignition does not change the fingerprint", () => {
    expect(normalize(base({ attributes: '{"power":14.1}' }))?.hash).toBe(normalize(base({ attributes: '{"power":12.1}' }))?.hash);
  });

  it("converts each protocol's signal to bars", () => {
    expect(signalBars(5, "teltonika")).toBe(4);
    expect(signalBars(1, "teltonika")).toBe(1);
    expect(signalBars(4, "gt06")).toBe(4);
    expect(signalBars(2, "gt06")).toBe(2);
    expect(signalBars(25, "h02")).toBe(4); // CSQ
    expect(signalBars(8, "h02")).toBe(1);
    expect(signalBars(99, "h02")).toBeNull();
    expect(signalBars(-65, null)).toBe(4); // dBm
    expect(signalBars(-105, null)).toBe(1);
    expect(signalBars(75, null)).toBe(3); // percentage
    expect(signalBars(null, null)).toBeNull();
  });
});

describe("visible vehicle status", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const vehicle = (
    minutesAgo: number,
    speedKmh: number,
    motion: boolean | null = null,
    ignition: boolean | null = null,
  ): Pick<Vehicle, "device" | "state"> => ({
    device: { uniqueId: "1", modelId: "h02", modelName: null, status: "active", claimExpiresAt: null, confirmedAt: null },
    state: {
      lastSeenAt: new Date(now - minutesAgo * 60_000).toISOString(),
      fixTime: null, lat: 0, lon: 0, altitude: null, speedKmh, course: null, accuracy: null, ignition, motion,
      ignitionInferred: false, powerVoltage: null, batteryVoltage: null, batteryLevel: null, satellites: null, signalBars: null,
    },
  });

  it("distinguishes moving, stopped and offline", () => {
    expect(vehicleStatus(vehicle(1, 40), now)).toBe("moving");
    expect(vehicleStatus(vehicle(1, 0), now)).toBe("stopped");
    // It was moving and has been silent for minutes: it lost the connection.
    expect(vehicleStatus(vehicle(6, 40), now)).toBe("offline");
    // Stopped, a device may take a while to report again.
    expect(vehicleStatus(vehicle(45, 0), now)).toBe("stopped");
    expect(vehicleStatus(vehicle(180, 0), now)).toBe("offline");
    expect(vehicleStatus(vehicle(1, 0, true), now)).toBe("moving");
  });

  it("distinguishes idling: engine on without moving", () => {
    expect(vehicleStatus(vehicle(1, 0, false, true), now)).toBe("idle");
    expect(vehicleStatus(vehicle(1, 0, false, false), now)).toBe("stopped");
    expect(vehicleStatus(vehicle(1, 40, true, true), now)).toBe("moving");
    // With the engine on the device reports often: if it goes silent, it disconnected.
    expect(vehicleStatus(vehicle(8, 0, false, true), now)).toBe("offline");
  });

  it("distinguishes no GPS from waiting for signal", () => {
    expect(vehicleStatus({ device: null, state: null }, now)).toBe("no_device");
    expect(vehicleStatus({ device: { uniqueId: "1", modelId: "h02", modelName: null, status: "pending", claimExpiresAt: null, confirmedAt: null }, state: null }, now)).toBe("pending");
  });
});

describe("device alarms", () => {
  it("splits the alarms that Traccar joins into one text", () => {
    expect(alarmsOf("h02", { alarm: "sos, powerCut" })).toEqual(["sos", "powerCut"]);
    expect(alarmsOf("h02", {})).toEqual([]);
    expect(alarmsOf("h02", { alarm: 7 })).toEqual([]);
  });

  it("translates the parameters a Teltonika uses to report", () => {
    // As Traccar 6.17 delivers them for a device without a model: checked with real frames.
    expect(alarmsOf("teltonika", { io249: 1 })).toEqual(["jamming"]);
    expect(alarmsOf("teltonika", { io246: 1, io252: 1 })).toEqual(["tow", "powerCut"]);
    expect(alarmsOf("teltonika", { io249: 0, io246: 0, io252: 0 })).toEqual([]);
    expect(alarmsOf("teltonika", { alarm: "hardBraking", io249: 1 })).toEqual(["hardBraking", "jamming"]);
    // The panic input arrives as a "general" alarm.
    expect(alarmsOf("teltonika", { alarm: "general" })).toEqual(["sos"]);
    // In other protocols those names mean nothing.
    expect(alarmsOf("h02", { io249: 1, alarm: "general" })).toEqual(["general"]);
  });
});
