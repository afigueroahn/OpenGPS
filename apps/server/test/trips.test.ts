import { describe, expect, it } from "vitest";
import { type TrackSample, analyze, thin } from "../src/core/trips";

/** Builds a track from stretches, with one position every 10 seconds. */
function track(steps: { kind: "drive" | "idle" | "off" | "gap"; minutes: number; kmh?: number }[], opts: { odometer?: boolean } = {}): TrackSample[] {
  const samples: TrackSample[] = [];
  let t = Date.UTC(2026, 10, 21, 12, 0, 0);
  let lat = 14.0;
  let meters = 0;
  const push = (speedKmh: number, ignition: boolean) =>
    samples.push({ t, lat, lon: -87.2, speedKmh, course: 0, ignition, odometer: opts.odometer ? 500_000 + meters : null });
  push(0, false);
  for (const step of steps) {
    if (step.kind === "gap") {
      t += step.minutes * 60_000;
      continue;
    }
    const speed = step.kind === "drive" ? (step.kmh ?? 36) : 0;
    for (let s = 0; s < step.minutes * 60; s += 10) {
      t += 10_000;
      const advance = (speed / 3.6) * 10;
      lat += advance / 111_320;
      meters += advance;
      push(speed, step.kind !== "off");
    }
  }
  return samples;
}

describe("trip engine", () => {
  it("separates trips and stops and adds up distance and times", () => {
    const r = analyze(track([{ kind: "drive", minutes: 10, kmh: 36 }, { kind: "off", minutes: 10 }, { kind: "drive", minutes: 5, kmh: 72 }]));
    expect(r.trips).toHaveLength(2);
    expect(r.stops).toHaveLength(1);
    expect(r.trips[0]?.distanceM).toBeGreaterThan(5900);
    expect(r.trips[0]?.distanceM).toBeLessThan(6100);
    expect(r.trips[0]).toMatchObject({ maxSpeedKmh: 36, avgSpeedKmh: 36 });
    expect(r.trips[1]).toMatchObject({ maxSpeedKmh: 72 });
    expect(r.stops[0]?.durationS).toBeGreaterThanOrEqual(590);
    expect(r.stops[0]?.durationS).toBeLessThanOrEqual(610);
    expect(r.summary.trips).toBe(2);
    expect(r.summary.distanceM).toBe((r.trips[0]?.distanceM ?? 0) + (r.trips[1]?.distanceM ?? 0));
    expect(r.summary.maxSpeedKmh).toBe(72);
    expect(Math.round(r.summary.movingS / 60)).toBe(15);
    // The whole period is divided among moving, idling and stopped.
    expect(r.summary.movingS + r.summary.idleS + r.summary.stoppedS).toBe(25 * 60);
  });

  it("a traffic light does not cut the trip, but counts as idling", () => {
    const r = analyze(track([{ kind: "drive", minutes: 5 }, { kind: "idle", minutes: 1 }, { kind: "drive", minutes: 5 }]));
    expect(r.trips).toHaveLength(1);
    expect(r.stops).toHaveLength(0);
    expect(r.trips[0]?.idleS).toBe(60);
    expect(r.trips[0]?.durationS).toBe(11 * 60);
    expect(r.summary.idleS).toBe(60);
  });

  it("distinguishes idling from engine off within a stop", () => {
    const r = analyze(track([{ kind: "drive", minutes: 5 }, { kind: "idle", minutes: 5 }, { kind: "off", minutes: 5 }, { kind: "drive", minutes: 5 }]));
    expect(r.trips).toHaveLength(2);
    expect(r.stops).toHaveLength(1);
    expect(r.stops[0]?.durationS).toBe(600);
    // The ignition change is known to the precision of the report interval (10 s).
    expect(Math.abs((r.stops[0]?.idleS ?? 0) - 300)).toBeLessThanOrEqual(10);
    expect(Math.abs(r.summary.idleS - 300)).toBeLessThanOrEqual(10);
    expect(r.summary.idleS + r.summary.stoppedS).toBe(600);
  });

  it("a gap without reports ends the trip and adds no kilometres", () => {
    const r = analyze(track([{ kind: "drive", minutes: 5 }, { kind: "gap", minutes: 30 }, { kind: "drive", minutes: 5 }]));
    expect(r.trips).toHaveLength(2);
    expect(r.stops).toHaveLength(1);
    expect(r.stops[0]?.durationS).toBeGreaterThanOrEqual(30 * 60);
    expect(r.summary.distanceM).toBeLessThan(6100); // 10 min at 36 km/h, without the gap
  });

  it("GPS noise with the vehicle parked does not create trips", () => {
    const samples = track([{ kind: "off", minutes: 20 }]);
    // Three readings with false speed that move away about 65 m and return suddenly.
    for (const [n, i] of [30, 31, 32].entries()) {
      const s = samples[i] as TrackSample;
      s.speedKmh = 7;
      s.lat += 0.0002 * (n + 1);
    }
    const r = analyze(samples);
    expect(r.trips).toHaveLength(0);
    expect(r.summary.distanceM).toBe(0);
    expect(r.summary.movingS).toBe(0);
    expect(r.stops).toHaveLength(1);
  });

  it("an impossible GPS jump does not inflate the mileage", () => {
    const samples = track([{ kind: "drive", minutes: 10 }]);
    (samples[30] as TrackSample).lat += 0.5; // about 55 km in 10 seconds
    const r = analyze(samples);
    expect(r.summary.distanceM).toBeLessThan(6500);
  });

  it("uses the device's odometer when it provides one and it is consistent", () => {
    const withOdometer = track([{ kind: "drive", minutes: 10, kmh: 54 }], { odometer: true });
    // The odometer measures 5 % more than the straight line between points.
    const first = (withOdometer[0] as TrackSample).odometer as number;
    for (const s of withOdometer) s.odometer = first + ((s.odometer as number) - first) * 1.05;
    const r = analyze(withOdometer);
    expect(r.trips[0]?.distanceM).toBeGreaterThan(9300);
    expect(r.trips[0]?.distanceM).toBeLessThan(9600);
    // A nonsensical odometer is ignored.
    for (const s of withOdometer) s.odometer = (s.odometer as number) * 10;
    expect(analyze(withOdometer).trips[0]?.distanceM).toBeLessThan(9100);
  });

  it("recognises driving by advance even if the device does not send speed", () => {
    const samples = track([{ kind: "drive", minutes: 10, kmh: 40 }, { kind: "off", minutes: 10 }]);
    for (const s of samples) s.speedKmh = 0;
    const r = analyze(samples);
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0]?.distanceM).toBeGreaterThan(6500);
    expect(r.stops).toHaveLength(1);
  });

  it("the last report while driving followed by silence does not lengthen the trip", () => {
    const samples = track([{ kind: "drive", minutes: 5 }]);
    const last = samples[samples.length - 1] as TrackSample;
    // The device stops reporting frequently and sends a still position five minutes later.
    samples.push({ ...last, t: last.t + 5 * 60_000, speedKmh: 0, ignition: false });
    const r = analyze(samples);
    expect(r.trips[0]?.durationS).toBe(300);
    expect(r.summary.movingS).toBe(300);
  });

  it("without data it returns zeros", () => {
    expect(analyze([]).summary).toMatchObject({ trips: 0, stops: 0, distanceM: 0, movingS: 0, positions: 0 });
    expect(analyze(track([])).trips).toEqual([]);
  });

  it("thins out a long track keeping the ends", () => {
    const points = Array.from({ length: 10_000 }, (_, i) => i);
    const light = thin(points, 500);
    expect(light).toHaveLength(500);
    expect(light[0]).toBe(0);
    expect(light[499]).toBe(9999);
    expect(thin([1, 2, 3], 500)).toEqual([1, 2, 3]);
  });
});
