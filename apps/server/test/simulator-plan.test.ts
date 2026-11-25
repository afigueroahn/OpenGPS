// Where a simulated vehicle is at each second of its trip.
import { type LonLat, SIM_PRESETS, lineLengthM, metersBetween, simPreset, simScenarioSchema } from "@opengps/shared";
import { describe, expect, it } from "vitest";
import { alarmsBetween, compile, placeOn, stateAt, timedLine } from "../src/simulator/plan";

// About 1,112 m to the east and back to the start by another street: a small circuit.
const CIRCUIT: LonLat[] = [
  [-87.2, 14.08],
  [-87.19, 14.08],
  [-87.19, 14.09],
  [-87.2, 14.09],
  [-87.2, 14.08],
];
const OPEN: LonLat[] = CIRCUIT.slice(0, 3);
const scenario = (over: object = {}) => simScenarioSchema.parse({ cruiseKmh: 36, idleS: 10, restS: 30, ...over });
const here = (s: { lon: number; lat: number }): LonLat => [s.lon, s.lat];

describe("simulator plan", () => {
  it("drives the route at its cruising speed, then idles and parks", () => {
    const plan = compile(scenario({ end: "loop" }), { line: CIRCUIT, secs: null });
    const length = lineLengthM(CIRCUIT);
    // 36 km/h are 10 m/s.
    expect(plan.lapM).toBeCloseTo(length, 3);
    expect(plan.lapS).toBeCloseTo(length / 10 + 40, 3);
    expect(plan.repeats).toBe(true);

    const start = stateAt(plan, 0);
    expect(here(start)).toEqual(CIRCUIT[0]);
    expect(start).toMatchObject({ ignition: true, meters: 0 });
    expect(start.speedKmh).toBeCloseTo(36, 3);
    expect(start.course).toBeCloseTo(90, 0); // heading east

    // Ten seconds later it has driven 100 m along the first street.
    const later = stateAt(plan, 10);
    expect(metersBetween(here(start), here(later))).toBeCloseTo(100, 0);
    expect(later.meters).toBeCloseTo(100, 3);

    // At the end it idles with the engine on, then parks with it off, where the route ends.
    const drive = length / 10;
    expect(stateAt(plan, drive + 5)).toMatchObject({ speedKmh: 0, ignition: true });
    expect(stateAt(plan, drive + 20)).toMatchObject({ speedKmh: 0, ignition: false });
    expect(metersBetween(here(stateAt(plan, drive + 20)), CIRCUIT[0] as LonLat)).toBeLessThan(1);
  });

  it("never jumps: between one second and the next it moves what its speed allows, lap after lap", () => {
    for (const end of ["loop", "return"] as const) {
      const plan = compile(scenario({ end }), { line: end === "loop" ? CIRCUIT : OPEN, secs: null });
      let before = stateAt(plan, 0);
      for (let t = 1; t < plan.lapS * 2.5; t++) {
        const now = stateAt(plan, t);
        expect(metersBetween(here(before), here(now)), `${end} at ${t} s`).toBeLessThan(10.5);
        expect(now.meters).toBeGreaterThanOrEqual(before.meters);
        before = now;
      }
      // After a whole lap it is where it began, with a lap more on its odometer.
      const again = stateAt(plan, plan.lapS);
      expect(metersBetween(here(again), here(stateAt(plan, 0)))).toBeLessThan(1);
      expect(again.meters).toBeCloseTo(plan.lapM, 3);
    }
  });

  it("on a route that does not close, going around becomes going back the same way", () => {
    const plan = compile(scenario({ end: "loop" }), { line: OPEN, secs: null });
    expect(plan.lapM).toBeCloseTo(lineLengthM(OPEN) * 2, 3);
    const half = lineLengthM(OPEN) / 10;
    // Halfway through the lap it is at the far end, and starts back with the opposite heading.
    expect(metersBetween(here(stateAt(plan, half)), OPEN[2] as LonLat)).toBeLessThan(1);
    expect(stateAt(plan, half + 41).course).toBeCloseTo(180, 0);
  });

  it("with nothing to go back for, it stays parked where the route ends", () => {
    const plan = compile(scenario({ end: "stay" }), { line: OPEN, secs: null });
    expect(plan.repeats).toBe(false);
    const much = stateAt(plan, plan.lapS + 86_400);
    expect(much).toMatchObject({ speedKmh: 0, ignition: false });
    expect(metersBetween(here(much), OPEN[2] as LonLat)).toBeLessThan(1);
    expect(much.meters).toBeCloseTo(lineLengthM(OPEN), 3);
    // And without a pause at the end, the same.
    const dry = compile(scenario({ end: "stay", idleS: 0, restS: 0 }), { line: OPEN, secs: null });
    expect(stateAt(dry, dry.lapS + 5)).toMatchObject({ speedKmh: 0, ignition: false });
  });

  it("a past second of a plan that repeats is the same place as a lap later", () => {
    const plan = compile(scenario({ end: "loop" }), { line: CIRCUIT, secs: null });
    const past = stateAt(plan, -30);
    const ahead = stateAt(plan, plan.lapS - 30);
    expect(metersBetween(here(past), here(ahead))).toBeLessThan(0.01);
    expect(past.meters).toBeCloseTo(ahead.meters - plan.lapM, 3);
  });

  it("takes each street at the speed the routing service gave it", () => {
    // 60 s for the first street and 200 s for the second: fast, then slow.
    const first = metersBetween(OPEN[0] as LonLat, OPEN[1] as LonLat);
    const second = metersBetween(OPEN[1] as LonLat, OPEN[2] as LonLat);
    const plan = compile(scenario({ end: "stay" }), { line: OPEN, secs: [0, 60, 260] });
    expect(stateAt(plan, 30).speedKmh).toBeCloseTo((first / 60) * 3.6, 3);
    expect(stateAt(plan, 100).speedKmh).toBeCloseTo((second / 200) * 3.6, 3);
    // Times that do not fit the line, or go backwards, are ignored: cruising speed.
    for (const secs of [[0, 60], [0, 60, 50]]) expect(timedLine(OPEN, secs, 36).cumS[2]).toBeCloseTo((first + second) / 10, 3);
    // A stretch the service gave no time for is driven at cruising speed, not in zero seconds.
    expect(timedLine(OPEN, [0, 60, 60], 36).cumS[2]).toBeCloseTo(60 + second / 10, 3);
  });

  // ─── What happens along the way ────────────────────────────────────────────
  // A straight street of about 2.2 km to the east, at 10 m/s: the vehicle is at 10·t meters at second t.
  const STREET: LonLat[] = [
    [-87.2, 14.08],
    [-87.18, 14.08],
  ];
  const street = lineLengthM(STREET);
  const along = (actions: object[], over: object = {}) => compile(scenario({ end: "stay", idleS: 0, restS: 0, actions, ...over }), { line: STREET, secs: null });

  it("stops where the route says, with the engine on or off, and then goes on", () => {
    const plan = along([
      { kind: "stop", atM: 500, seconds: 60, engineOn: false },
      { kind: "stop", atM: 1000, seconds: 30, engineOn: true },
    ]);
    expect(plan.lapS).toBeCloseTo(street / 10 + 90, 3);
    expect(plan.lapM).toBeCloseTo(street, 3);
    expect(stateAt(plan, 40)).toMatchObject({ ignition: true, locked: false });
    expect(stateAt(plan, 40).meters).toBeCloseTo(400, 3);
    // From second 50 to 110 it is parked at 500 m, off.
    for (const t of [50, 80, 109]) {
      const parked = stateAt(plan, t);
      expect(parked).toMatchObject({ speedKmh: 0, ignition: false });
      expect(parked.meters).toBeCloseTo(500, 3);
      expect(metersBetween(here(parked), here(stateAt(plan, 50)))).toBeLessThan(0.01);
    }
    expect(stateAt(plan, 120).meters).toBeCloseTo(600, 3);
    // The second one, with the engine running: from 160 to 190.
    expect(stateAt(plan, 175)).toMatchObject({ speedKmh: 0, ignition: true });
    expect(stateAt(plan, 200).meters).toBeCloseTo(1100, 3);
  });

  it("drives a stretch at another speed, and is towed along another with its engine off", () => {
    // 300 m at 108 km/h take 10 s instead of 30.
    const fast = along([{ kind: "speeding", atM: 200, lengthM: 300, kmh: 108 }]);
    expect(fast.lapS).toBeCloseTo(street / 10 - 20, 3);
    expect(stateAt(fast, 10).speedKmh).toBeCloseTo(36, 3);
    expect(stateAt(fast, 25).speedKmh).toBeCloseTo(108, 3);
    expect(stateAt(fast, 25).meters).toBeCloseTo(350, 3);
    expect(stateAt(fast, 35).speedKmh).toBeCloseTo(36, 3);
    expect(stateAt(fast, 35).meters).toBeCloseTo(550, 3);

    const towed = along([{ kind: "towing", atM: 200, lengthM: 300 }]);
    expect(towed.lapS).toBeCloseTo(street / 10, 3);
    expect(stateAt(towed, 10)).toMatchObject({ ignition: true });
    // It moves, at its pace, with the engine off.
    expect(stateAt(towed, 30)).toMatchObject({ ignition: false });
    expect(stateAt(towed, 30).speedKmh).toBeCloseTo(36, 3);
    expect(stateAt(towed, 60)).toMatchObject({ ignition: true });

    // A stretch that runs past the end of the route ends where the route does.
    const tail = along([{ kind: "towing", atM: street - 100, lengthM: 5000 }]);
    expect(stateAt(tail, street / 10 - 5)).toMatchObject({ ignition: false });
    expect(tail.lapS).toBeCloseTo(street / 10, 3);
  });

  it("the device cuts its own start for a while, and says so", () => {
    const plan = along([{ kind: "engineLock", atM: 300, seconds: 120 }]);
    expect(stateAt(plan, 20)).toMatchObject({ locked: false, ignition: true });
    expect(stateAt(plan, 90)).toMatchObject({ locked: true, ignition: false, speedKmh: 0 });
    expect(stateAt(plan, 151)).toMatchObject({ locked: false, ignition: true });
  });

  it("sends each alarm once every lap, when it passes its place", () => {
    const plan = compile(scenario({ end: "loop", idleS: 0, restS: 0, actions: [{ kind: "alarm", atM: 300, alarm: "sos" }, { kind: "alarm", atM: 300, alarm: "powerCut" }, { kind: "stop", atM: 300, seconds: 40 }, { kind: "alarm", atM: 900, alarm: "tow" }] }), { line: CIRCUIT, secs: null });
    // It reaches the 300 m at second 30: both alarms fall there, on arriving, before the stop.
    expect(alarmsBetween(plan, 25, 30)).toEqual(["sos", "powerCut"]);
    expect(alarmsBetween(plan, 30, 69)).toEqual([]);
    expect(alarmsBetween(plan, 0, 25)).toEqual([]);
    // The stop pushes the next one 40 s later: at 900 m, second 130.
    expect(alarmsBetween(plan, 125, 135)).toEqual(["tow"]);
    // A report that comes late carries all that fell since the last one.
    expect(alarmsBetween(plan, 0, 200)).toEqual(["sos", "powerCut", "tow"]);
    // And again on the next lap, and on a lap in the past.
    expect(alarmsBetween(plan, plan.lapS + 25, plan.lapS + 31)).toEqual(["sos", "powerCut"]);
    expect(alarmsBetween(plan, -plan.lapS + 25, -plan.lapS + 31)).toEqual(["sos", "powerCut"]);
    expect(alarmsBetween(plan, 31, 31)).toEqual([]);

    // A route that ends does not repeat them.
    const once = along([{ kind: "alarm", atM: 300, alarm: "jamming" }]);
    expect(alarmsBetween(once, 0, 40)).toEqual(["jamming"]);
    expect(alarmsBetween(once, once.lapS + 1, once.lapS + 500)).toEqual([]);
  });

  it("loses its signal for a while and keeps moving; the driver and the fault codes change where the route says", () => {
    const plan = along([
      { kind: "signalLoss", atM: 300, seconds: 100 },
      { kind: "driverKey", atM: 500, key: "1F00BC55" },
      { kind: "dtc", atM: 700, codes: ["P0300", "P0171"] },
      { kind: "driverKey", atM: 900, key: "" },
      { kind: "dtc", atM: 1100, codes: [] },
    ], { driverKey: "00AA" });
    expect(stateAt(plan, 29)).toMatchObject({ silent: false, driverKey: "00AA", dtc: [] });
    expect(stateAt(plan, 30).silent).toBe(true);
    expect(stateAt(plan, 129).silent).toBe(true);
    expect(stateAt(plan, 130).silent).toBe(false);
    // Without signal it is still driving.
    expect(stateAt(plan, 100).meters).toBeCloseTo(1000, 3);
    expect(stateAt(plan, 60)).toMatchObject({ driverKey: "1F00BC55", dtc: [] });
    expect(stateAt(plan, 80)).toMatchObject({ driverKey: "1F00BC55", dtc: ["P0300", "P0171"] });
    expect(stateAt(plan, 95)).toMatchObject({ driverKey: "", dtc: ["P0300", "P0171"] });
    expect(stateAt(plan, 115)).toMatchObject({ driverKey: "", dtc: [] });
  });

  it("the tank burns as it drives, fills and is siphoned where the route says, and starts each lap at its level", () => {
    // 10 points every kilometer, to see it on a short street.
    const fuel = { startPct: 70, burnPer100Km: 1000 };
    const plan = compile({ ...scenario({ end: "return", idleS: 0, restS: 60, actions: [{ kind: "refuel", atM: 400, seconds: 60, pct: 30 }, { kind: "drain", atM: 800, seconds: 40, pct: 20 }] }), fuel }, { line: STREET, secs: null });
    expect(stateAt(plan, 0).fuelPct).toBeCloseTo(70, 6);
    expect(stateAt(plan, 20).fuelPct).toBeCloseTo(68, 3);
    // Filling from second 40 to 100, parked with the engine off: 66 → 96.
    expect(stateAt(plan, 40).fuelPct).toBeCloseTo(66, 3);
    expect(stateAt(plan, 70)).toMatchObject({ speedKmh: 0, ignition: false });
    expect(stateAt(plan, 70).fuelPct).toBeCloseTo(81, 3);
    expect(stateAt(plan, 100).fuelPct).toBeCloseTo(96, 3);
    // 400 m more, and the siphoning from 140 to 180: 92 → 72.
    expect(stateAt(plan, 140).fuelPct).toBeCloseTo(92, 3);
    expect(stateAt(plan, 160).fuelPct).toBeCloseTo(82, 3);
    expect(stateAt(plan, 180).fuelPct).toBeCloseTo(72, 3);
    // It never leaves its range, however long the trip.
    for (let t = 0; t < plan.lapS; t += 7) {
      const level = stateAt(plan, t).fuelPct as number;
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(100);
    }
    // Parked at the end of the lap, the tank goes back to where it starts: no jump between laps.
    expect(stateAt(plan, plan.lapS - 0.001).fuelPct).toBeCloseTo(70, 2);
    expect(stateAt(plan, plan.lapS).fuelPct).toBeCloseTo(70, 6);
    expect(stateAt(plan, plan.lapS + 20).fuelPct).toBeCloseTo(68, 3);
    // Without a tank, the device says nothing about fuel.
    expect(stateAt(along([]), 10).fuelPct).toBeNull();
  });

  it("what happens along the way happens on the way out, and past the end of the route, at its end", () => {
    const plan = compile(scenario({ end: "return", idleS: 0, restS: 0, actions: [{ kind: "stop", atM: 500, seconds: 60 }, { kind: "stop", atM: 99_999, seconds: 30 }] }), { line: STREET, secs: null });
    const out = street / 10 + 60;
    // At the far end, the stop written past it.
    expect(stateAt(plan, out + 10)).toMatchObject({ speedKmh: 0, ignition: false });
    expect(stateAt(plan, out + 10).meters).toBeCloseTo(street, 3);
    // On the way back it passes the 500 m without stopping.
    const back = out + 30 + (street - 500) / 10;
    expect(stateAt(plan, back).speedKmh).toBeCloseTo(36, 3);
    expect(plan.lapS).toBeCloseTo((street / 10) * 2 + 90, 3);
    expect(metersBetween(here(placeOn(STREET, 500)), here(stateAt(plan, 50)))).toBeLessThan(0.01);
    expect(here(placeOn(STREET, 99_999))).toEqual(STREET[1]);
  });

  it("can ignore the time of each street and go at its own speed", () => {
    const timed = { line: OPEN, secs: [0, 60, 260] };
    const own = compile(scenario({ end: "stay", roadSpeeds: false }), timed);
    expect(stateAt(own, 30).speedKmh).toBeCloseTo(36, 3);
    expect(stateAt(compile(scenario({ end: "stay" }), timed), 30).speedKmh).not.toBeCloseTo(36, 0);
  });

  it("every ready-made scenario fits its route and lasts what the platform needs to notice it", () => {
    for (const routeM of [800, 11_000, 250_000]) {
      for (const id of SIM_PRESETS) {
        const made = simPreset(id, routeM);
        // As the console sends it: it must be a scenario the server takes.
        const parsed = simScenarioSchema.parse({ actions: made.actions, fuel: made.fuel ?? null });
        expect(parsed.actions.length, `${id} on ${routeM} m`).toBeGreaterThan(0);
        for (const action of parsed.actions) expect(action.atM, `${id} on ${routeM} m`).toBeLessThanOrEqual(routeM);
      }
    }
    const kinds = (id: (typeof SIM_PRESETS)[number]) => simScenarioSchema.parse({ actions: simPreset(id, 11_000).actions }).actions;
    // A stop the platform lists is three minutes or more; a siphoning is only looked for inside one.
    expect(kinds("trip").some((a) => a.kind === "stop" && a.seconds >= 180 && !a.engineOn)).toBe(true);
    expect(kinds("fuel").find((a) => a.kind === "drain")).toMatchObject({ seconds: 360 });
    expect(simPreset("fuel", 11_000).fuel).toBeDefined();
    // The shortest "no signal" alert is five minutes.
    expect(kinds("signalLoss")[0]).toMatchObject({ kind: "signalLoss", seconds: 600 });
    // Over the limit for longer than the twenty seconds an alert waits.
    const speeding = kinds("speeding")[0] as { lengthM: number; kmh: number };
    expect(speeding.lengthM / (speeding.kmh / 3.6)).toBeGreaterThan(40);
    expect(kinds("theft").map((a) => a.kind)).toEqual(expect.arrayContaining(["towing", "alarm"]));
  });
});
