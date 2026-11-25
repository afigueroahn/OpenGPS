// Stored days: splitting the track by days and joining it back must give the
// same result as analysing it whole.
import { describe, expect, it } from "vitest";
import { DAY_MS, PAD_MS, assemble, dayOf, dayPieces } from "../src/core/days";
import { type TrackSample, analyze } from "../src/core/trips";

/** Random numbers that repeat identically on every run. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Step = { kind: "drive" | "idle" | "off" | "gap"; minutes: number; kmh?: number };

function track(start: number, steps: Step[], opts: { odometer?: boolean; every?: number } = {}): TrackSample[] {
  const every = opts.every ?? 30;
  const samples: TrackSample[] = [];
  let t = start;
  let lat = 14.0;
  let meters = 0;
  const push = (speedKmh: number, ignition: boolean) => samples.push({ t, lat, lon: -87.2, speedKmh, course: 0, ignition, odometer: opts.odometer ? 500_000 + meters : null });
  push(0, false);
  for (const step of steps) {
    if (step.kind === "gap") {
      t += step.minutes * 60_000;
      continue;
    }
    const speed = step.kind === "drive" ? (step.kmh ?? 36) : 0;
    for (let s = 0; s < step.minutes * 60; s += every) {
      t += every * 1000;
      const advance = (speed / 3.6) * every;
      lat += advance / 111_320;
      meters += advance;
      push(speed, step.kind !== "off");
    }
  }
  return samples;
}

/** Same as the platform does: each day with its margin, and then everything joined. */
function byDays(samples: TrackSample[]) {
  const first = samples[0] as TrackSample;
  const last = samples[samples.length - 1] as TrackSample;
  const days = [];
  for (let day = dayOf(first.t); day <= dayOf(last.t); day++) {
    const d0 = day * DAY_MS;
    days.push(
      dayPieces(
        samples.filter((s) => s.t >= d0 - PAD_MS && s.t < d0 + DAY_MS + PAD_MS),
        d0,
        d0 + DAY_MS,
      ),
    );
  }
  return assemble(days);
}

const plain = <T extends object>(list: T[], drop: string[]) => list.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !drop.includes(k))));

function expectSame(samples: TrackSample[]) {
  const whole = analyze(samples);
  const joined = byDays(samples);
  expect(plain(joined.trips, ["movingS", "openStart"])).toEqual(whole.trips);
  expect(plain(joined.stops, ["openStart", "openEnd"])).toEqual(whole.stops);
}

const NOON = Date.UTC(2026, 10, 18, 12, 0, 0);

describe("stored days", () => {
  it("a trip that crosses midnight becomes a single trip again", () => {
    const samples = track(NOON, [{ kind: "off", minutes: 11 * 60 + 40 }, { kind: "drive", minutes: 50, kmh: 60 }, { kind: "off", minutes: 60 }]);
    const joined = byDays(samples);
    expect(joined.trips).toHaveLength(1);
    expect(joined.trips[0]?.durationS).toBe(50 * 60);
    expect(joined.trips[0]?.distanceM).toBeGreaterThan(49_500);
    expect(joined.trips[0]?.distanceM).toBeLessThan(50_500);
    expectSame(samples);
  });

  it("a multi-day stop is a single stop, even if the device goes quiet", () => {
    const samples = track(NOON, [{ kind: "drive", minutes: 30 }, { kind: "off", minutes: 20 }, { kind: "gap", minutes: 2 * 24 * 60 + 300 }, { kind: "off", minutes: 10 }, { kind: "drive", minutes: 20 }]);
    const joined = byDays(samples);
    expect(joined.trips).toHaveLength(2);
    expect(joined.stops).toHaveLength(1);
    expect(joined.stops[0]?.durationS).toBe((20 + 2 * 24 * 60 + 300 + 10) * 60);
    expectSame(samples);
  });

  it("an overnight stop with the device reporting stays whole", () => {
    const samples = track(NOON, [{ kind: "drive", minutes: 45 }, { kind: "off", minutes: 16 * 60 }, { kind: "drive", minutes: 30 }], { odometer: true });
    const joined = byDays(samples);
    expect(joined.stops).toHaveLength(1);
    expect(joined.stops[0]?.durationS).toBe(16 * 3600);
    expectSame(samples);
  });

  it("gives the same as analysing the whole track, with random tracks", () => {
    const rnd = random(Number(process.env.SEED ?? 20261122));
    const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)] as T;
    for (let n = 0; n < Number(process.env.ROUNDS ?? 250); n++) {
      const steps: Step[] = [];
      let minutes = 0;
      // Starts at any hour and lasts between one and four days.
      const total = (1 + rnd() * 3) * 24 * 60;
      while (minutes < total) {
        const kind = pick<Step["kind"]>(["drive", "drive", "drive", "idle", "off", "off", "gap"]);
        const length =
          kind === "drive"
            ? pick([1, 2, 5, 20, 45, 120, 300])
            : kind === "idle"
              ? pick([1, 2, 3, 4, 10, 40])
              : kind === "off"
                ? pick([1, 2, 3, 5, 30, 240, 600])
                : pick([5, 11, 60, 200, 500, 1500]);
        steps.push({ kind, minutes: length, kmh: pick([3, 8, 20, 36, 60, 90, 110]) });
        minutes += length;
      }
      const start = NOON + Math.floor(rnd() * 24 * 60) * 60_000;
      expectSame(track(start, steps, { odometer: rnd() < 0.5, every: pick([10, 30, 60]) }));
    }
  });
});
