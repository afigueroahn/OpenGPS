// A simulated device against a gateway of its own: a local TCP server that
// answers like the real one. The connections are real; the clock is the test's.
import { type LonLat, simScenarioSchema } from "@opengps/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type DeviceEvent, createDevice } from "../src/simulator/device";
import { alarmsBetween, compile, stateAt } from "../src/simulator/plan";
import { type Protocol, type Report, crc16, h02, teltonika } from "../src/simulator/protocols";
import { closeGateways, gateway, until } from "./sim-gateway";

const LINE: LonLat[] = [
  [-87.2, 14.08],
  [-87.1, 14.08],
];
// 36 km/h: 10 m every second, with nothing to wait for at the ends.
const plan = compile(simScenarioSchema.parse({ cruiseKmh: 36, end: "return", idleS: 0, restS: 0 }), { line: LINE, secs: null });

afterEach(closeGateways);

/** A Codec 12 command as the gateway writes it to a Teltonika. */
function teltonikaCommand(text: string): Buffer {
  const body = Buffer.from(text, "ascii");
  const data = Buffer.concat([Buffer.from([0x0c, 0x01, 0x05, 0, 0, 0, body.length]), body, Buffer.from([0x01])]);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16(data));
  return Buffer.concat([head, data, crc]);
}

/** The first record of a plain Codec 8 frame: where, how fast and its one-byte parameters. */
function teltonikaRecord(frame: Buffer) {
  expect(frame[8]).toBe(0x08);
  const record = frame.subarray(10);
  const io = new Map<number, number>();
  const count = record[26] as number;
  for (let i = 0; i < count; i++) io.set(record[27 + i * 2] as number, record[28 + i * 2] as number);
  return { lon: record.readInt32BE(9) / 1e7, lat: record.readInt32BE(13) / 1e7, speedKmh: record.readUInt16BE(22), io };
}

/** What a test needs around a device: its events, and a clock it moves by hand. */
function bench(over: Partial<Parameters<typeof createDevice>[0]> & Pick<Parameters<typeof createDevice>[0], "protocol" | "port">) {
  const events: DeviceEvent[] = [];
  const clock = { now: 1_800_000_000_000, trip: 0 };
  const device = createDevice({
    id: over.protocol === h02 ? "9170000777" : "356307042441013",
    host: "127.0.0.1",
    intervalS: 5,
    offsetS: 0,
    stateAt: (tripS) => stateAt(plan, tripS),
    now: () => clock.now,
    onEvent: (event) => events.push(event),
    ...over,
  });
  /** Lets `seconds` go by, on the wall and on the trip, and gives the device its turn. */
  const pass = (seconds: number) => {
    clock.now += seconds * 1000;
    clock.trip += seconds;
    device.tick(clock.now, clock.trip);
  };
  const seen = (type: DeviceEvent["type"]) => events.filter((e) => e.type === type).length;
  return { device, events, clock, pass, seen };
}

describe("simulated device", () => {
  it("teltonika: says hello with its IMEI, reports, and stops while its start is cut", async () => {
    const gw = await gateway((data) => (data.length === 17 ? Buffer.from([0x01]) : null));
    const { device, events, pass, seen } = bench({ protocol: teltonika, port: gw.port });

    pass(0);
    await until(() => seen("connected") === 1, "the handshake");
    expect(gw.frames[0]?.subarray(2).toString("ascii")).toBe("356307042441013");
    expect(device.snapshot().status).toBe("online");

    // It reports as soon as it is in, and again when its interval comes around: not before.
    pass(0);
    await until(() => gw.frames.length === 2, "the first report");
    pass(4);
    pass(1);
    await until(() => gw.frames.length === 3, "the second report");
    const moving = teltonikaRecord(gw.frames[2] as Buffer);
    expect(moving.speedKmh).toBe(36);
    expect(moving.io.get(239)).toBe(1);
    expect(moving.io.get(179)).toBe(0);
    expect(device.snapshot()).toMatchObject({ sent: 2, engineCut: false });

    // The gateway cuts the start: the device answers, says so at once and stays where it is.
    gw.sockets[0]?.write(teltonikaCommand("setdigout 1"));
    await until(() => seen("command") === 1, "the command");
    expect(events.find((e) => e.type === "command")).toMatchObject({ text: "setdigout 1", effect: "engineCut" });
    await until(() => gw.frames.length === 4, "the answer to the command");
    expect((gw.frames[3] as Buffer)[10]).toBe(0x06);
    pass(0);
    await until(() => gw.frames.length === 5, "the report after the cut");
    const cut = teltonikaRecord(gw.frames[4] as Buffer);
    expect(cut).toMatchObject({ speedKmh: 0 });
    expect(cut.io.get(179)).toBe(1);
    expect(cut.io.get(239)).toBe(0);
    pass(60);
    await until(() => gw.frames.length === 6, "a report while cut");
    expect(teltonikaRecord(gw.frames[5] as Buffer).lon).toBeCloseTo(cut.lon, 6);
    expect(device.memory()).toMatchObject({ cut: true, heldS: 60 });

    // Given back, it goes on from where it stopped: it does not jump to where it would have been.
    gw.sockets[0]?.write(teltonikaCommand("setdigout 0"));
    await until(() => seen("command") === 2, "the second command");
    pass(0);
    await until(() => gw.frames.length === 8, "the report after giving it back");
    const back = teltonikaRecord(gw.frames[7] as Buffer);
    expect(back.speedKmh).toBe(36);
    expect(back.io.get(179)).toBe(0);
    expect(back.lon).toBeCloseTo(cut.lon, 5);
    device.stop();
    await gw.close();
  });

  it("teltonika: a gateway that does not know the IMEI rejects it, and the device tries again later", async () => {
    const gw = await gateway(() => Buffer.from([0x00]));
    const { device, pass, seen } = bench({ protocol: teltonika, port: gw.port });
    pass(0);
    await until(() => seen("rejected") === 1, "the rejection");
    expect(device.snapshot()).toMatchObject({ status: "rejected", sent: 0 });
    // Not before ten seconds.
    pass(9);
    expect(gw.sockets.length).toBe(1);
    pass(1);
    await until(() => seen("rejected") === 2, "the second try");
    device.stop();
    await gw.close();
  });

  it("teltonika: a gateway that never answers the handshake counts as a rejection", async () => {
    const gw = await gateway();
    const { device, pass, seen } = bench({ protocol: teltonika, port: gw.port });
    pass(0);
    await until(() => gw.frames.length === 1, "the handshake");
    pass(4);
    expect(seen("rejected")).toBe(0);
    pass(1);
    expect(seen("rejected")).toBe(1);
    expect(device.snapshot().status).toBe("rejected");
    device.stop();
    await gw.close();
  });

  it("h02: reports without a handshake and obeys the engine cut and the report rate", async () => {
    const gw = await gateway();
    const { device, events, pass, seen } = bench({ protocol: h02, port: gw.port });
    pass(0);
    await until(() => seen("connected") === 1, "the connection");
    pass(0);
    await until(() => gw.frames.length === 1, "the first report");
    expect(gw.frames[0]?.toString("ascii")).toMatch(/^\*HQ,9170000777,V1,\d{6},A,1404\.8000,N,08712\.0000,W,019\.44,090,\d{6},FFFFFFFF#$/);

    gw.sockets[0]?.write("*HQ,9170000777,S71,081521,22,30#");
    await until(() => seen("command") === 1, "the rate command");
    expect(events.at(-1)).toMatchObject({ effect: "interval", intervalS: 30 });
    pass(0);
    await until(() => gw.frames.length === 2, "the report after the command");
    pass(29);
    expect(gw.frames.length).toBe(2);
    pass(1);
    await until(() => gw.frames.length === 3, "the report at the new rate");

    gw.sockets[0]?.write("*HQ,9170000777,S20,081516,1,1#");
    await until(() => seen("command") === 2, "the cut");
    pass(0);
    await until(() => gw.frames.length === 4, "the report after the cut");
    // Stopped, with the engine off: bit 10 of the status goes to zero.
    expect(gw.frames[3]?.toString("ascii")).toMatch(/,000\.00,\d{3},\d{6},FFFFFBFF#$/);
    expect(device.memory()).toMatchObject({ cut: true, intervalS: 30 });
    device.stop();
    await gw.close();
  });

  it("with nobody listening it says so and keeps trying", async () => {
    const gw = await gateway();
    const port = gw.port;
    await gw.close();
    const { device, events, pass, seen } = bench({ protocol: h02, port });
    pass(0);
    await until(() => seen("unreachable") === 1, "the failure");
    expect(events[0]).toMatchObject({ type: "unreachable", reason: "ECONNREFUSED" });
    expect(device.snapshot().status).toBe("unreachable");
    pass(4);
    expect(seen("unreachable")).toBe(1);
    pass(1);
    await until(() => seen("unreachable") === 2, "the second try");
    device.stop();
  });

  it("reconnects when the gateway hangs up; if it does so again and again without a word, it is a rejection", async () => {
    const gw = await gateway();
    const { device, pass, seen } = bench({ protocol: h02, port: gw.port });
    for (let round = 1; round <= 3; round++) {
      pass(round === 1 ? 0 : 3);
      await until(() => seen("connected") === round, `connection ${round}`);
      gw.sockets.at(-1)?.destroy();
      await until(() => seen("closed") + seen("rejected") === round, `hang-up ${round}`);
    }
    expect(seen("closed")).toBe(2);
    expect(seen("rejected")).toBe(1);
    expect(device.snapshot().status).toBe("rejected");
    device.stop();
    await gw.close();
  });

  it("remembers the cut and the rate it was given, and starts where it is told", async () => {
    const gw = await gateway();
    const { device, pass, seen } = bench({ protocol: h02, port: gw.port, offsetS: 100, memory: { cut: true, heldS: 40, intervalS: 60 }, startAt: 1_800_000_002_000 });
    pass(0);
    pass(1);
    expect(gw.sockets.length).toBe(0); // not yet its turn to connect
    pass(1);
    await until(() => seen("connected") === 1, "the connection");
    pass(0);
    await until(() => gw.frames.length === 1, "the report");
    // 100 s ahead on the route, less the 40 s it had lost standing still: 600 m from the start, and
    // still there, because the seconds that went by since found it with its start cut.
    const state = device.snapshot().state;
    expect(state).toMatchObject({ speedKmh: 0, ignition: false });
    expect(state?.meters).toBeCloseTo(600, 3);
    expect(device.snapshot().engineCut).toBe(true);
    pass(59);
    expect(gw.frames.length).toBe(1);
    device.stop();
    await gw.close();
  });

  // ─── What happens along its route ──────────────────────────────────────────

  /** A brand's protocol that also keeps what it was asked to write, to read a device's reports as it meant them. */
  function recording(base: Protocol) {
    const reports: Report[] = [];
    const protocol: Protocol = {
      ...base,
      encode(id, list) {
        reports.push(...list);
        return base.encode(id, list);
      },
    };
    return { protocol, reports };
  }
  /** A device traveling a route with those things along it: 10 m every second, without pauses. */
  function traveling(base: Protocol, port: number, actions: object[], over: object = {}) {
    const scenario = simScenarioSchema.parse({ cruiseKmh: 36, end: "stay", idleS: 0, restS: 0, actions, ...over });
    const route = compile(scenario, { line: LINE, secs: null });
    const { protocol, reports } = recording(base);
    return { reports, ...bench({ protocol, port, stateAt: (tripS) => stateAt(route, tripS), alarmsBetween: (from, to) => alarmsBetween(route, from, to), faults: route.faults.length > 1 }) };
  }

  it("says what happens on its route: each alarm once, the tank, the driver, the fault codes and its own lock", async () => {
    const gw = await gateway((data) => (data.length === 17 ? Buffer.from([0x01]) : null));
    const { device, reports, pass, seen, events } = traveling(
      teltonika,
      gw.port,
      [
        { kind: "alarm", atM: 80, alarm: "powerCut" },
        { kind: "alarm", atM: 80, alarm: "jamming" },
        { kind: "driverKey", atM: 80, key: "1F00BC55" },
        { kind: "dtc", atM: 80, codes: ["P0300"] },
        { kind: "engineLock", atM: 200, seconds: 30 },
        { kind: "dtc", atM: 250, codes: [] },
      ],
      { fuel: { startPct: 70, burnPer100Km: 20 } },
    );
    pass(0);
    await until(() => seen("connected") === 1, "the handshake");
    pass(0);
    pass(5);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ ignition: true, engineCut: false, dtc: [] });
    expect(reports[1]?.driverKey).toBeUndefined();
    expect(reports[1]?.alarm).toBeUndefined();
    expect(reports[1]?.fuelPct).toBeCloseTo(70 - 0.01, 3);

    // At 80 m both alarms fall: the next report brings them, each in a report of its own a second apart.
    pass(5);
    expect(reports).toHaveLength(4);
    expect(reports.slice(2).map((r) => r.alarm)).toEqual(["powerCut", "jamming"]);
    expect((reports[3] as Report).at.getTime() - (reports[2] as Report).at.getTime()).toBe(1000);
    expect(reports[3]).toMatchObject({ driverKey: "1F00BC55", dtc: ["P0300"] });
    expect(events.filter((e) => e.type === "alarm")).toEqual([
      { type: "alarm", alarm: "powerCut" },
      { type: "alarm", alarm: "jamming" },
    ]);
    // And not again.
    pass(5);
    expect(reports).toHaveLength(5);
    expect(reports[4]?.alarm).toBeUndefined();

    // At 200 m the device cuts its own start for 30 s: stopped, off and saying so.
    pass(5);
    pass(5);
    expect(reports[6]).toMatchObject({ ignition: false, engineCut: true, fix: { speedKmh: 0 } });
    expect(device.snapshot()).toMatchObject({ engineCut: true, stored: 0 });
    for (let i = 0; i < 6; i++) pass(5);
    expect(reports.at(-1)).toMatchObject({ ignition: true, engineCut: false });
    // Past the 250 m the codes clear, and the device says there are none.
    pass(5);
    expect(reports.at(-1)).toMatchObject({ dtc: [], driverKey: "1F00BC55" });
    // All of it went out on the wire: the handshake and one record of 0x08 for each report.
    const wire = teltonika.encode("356307042441013", reports.slice(0, 1)).length;
    await until(() => Buffer.concat(gw.frames).length > 17 + wire, "the reports on the wire");
    device.stop();
    await gw.close();
  });

  it("an alarm its brand does not carry never goes out", async () => {
    const gw = await gateway();
    // An H02 has a panic button and knows when its power is cut; of a jammer it knows nothing.
    const { device, reports, pass, seen, events } = traveling(h02, gw.port, [{ kind: "alarm", atM: 30, alarm: "jamming" }, { kind: "alarm", atM: 30, alarm: "sos" }]);
    pass(0);
    await until(() => seen("connected") === 1, "the connection");
    pass(0);
    pass(5);
    expect(reports.map((r) => r.alarm)).toEqual([undefined, "sos"]);
    expect(events.filter((e) => e.type === "alarm")).toEqual([{ type: "alarm", alarm: "sos" }]);
    device.stop();
    await gw.close();
  });

  it("without signal it hangs up and keeps its reports; when the signal is back it uploads them, the oldest first", async () => {
    for (const base of [teltonika, h02]) {
      const gw = await gateway((data) => (data.length === 17 ? Buffer.from([0x01]) : null));
      const { device, reports, pass, seen, events } = traveling(base, gw.port, [{ kind: "signalLoss", atM: 100, seconds: 30 }]);
      pass(0);
      await until(() => seen("connected") === 1, "the connection");
      pass(0);
      pass(5);
      expect(reports).toHaveLength(2);

      // At 100 m the signal goes: it hangs up, and from here on what it would send it keeps.
      pass(5);
      expect(device.snapshot()).toMatchObject({ status: "noSignal", stored: 1, sent: 2 });
      expect(seen("signalLost")).toBe(1);
      await until(() => gw.sockets[0]?.destroyed === true || gw.sockets[0]?.readyState !== "open", "the hang-up");
      for (let i = 0; i < 5; i++) pass(5);
      expect(device.snapshot()).toMatchObject({ status: "noSignal", stored: 6, sent: 2 });
      expect(reports).toHaveLength(2);
      // It kept moving all the while.
      expect(device.snapshot().state?.meters).toBeCloseTo(350, 3);

      // Thirty seconds later the signal is back: it connects again and empties its memory.
      pass(5);
      expect(device.snapshot().status).toBe("offline");
      pass(0);
      await until(() => seen("connected") === 2, "the reconnection");
      pass(0);
      expect(events.at(-1)).toEqual({ type: "signalBack", stored: 7 });
      expect(device.snapshot()).toMatchObject({ status: "online", stored: 0, sent: 10 });
      // What it kept goes first and in order, and then where it is now.
      const uploaded = reports.slice(2);
      expect(uploaded).toHaveLength(8);
      const times = uploaded.map((r) => r.at.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(times[6]! - times[0]!).toBe(30_000);
      if (base === teltonika) {
        // A Teltonika sends several records in one frame.
        await until(() => (gw.frames.at(-1)?.length ?? 0) > 200, "the upload");
        expect((gw.frames.at(-1) as Buffer)[9]).toBe(8);
      } else {
        // An H02 sends them one after another.
        await until(() => Buffer.concat(gw.frames).toString("ascii").split("#").length - 1 === 10, "the upload");
      }
      device.stop();
      await gw.close();
    }
  });

  // ─── Done to it by hand ────────────────────────────────────────────────────

  it("by hand: an alarm at once, its start cut and given back, a theft, the tank and a disconnection", async () => {
    const gw = await gateway((data) => (data.length === 17 ? Buffer.from([0x01]) : null));
    const { device, reports, pass, seen, events } = traveling(teltonika, gw.port, [], { fuel: { startPct: 50, burnPer100Km: 0 } });
    pass(0);
    await until(() => seen("connected") === 1, "the handshake");
    pass(0);
    expect(reports).toHaveLength(1);

    // An alarm goes out with a report of its own, without waiting for the next one.
    device.inject({ kind: "alarm", alarm: "sos" });
    pass(0);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ alarm: "sos", ignition: true });

    // Its start cut by hand: it stops where it is, says so, and stays until it is given back.
    pass(5);
    device.inject({ kind: "engineLock", on: true });
    pass(0);
    expect(events.at(-2)).toEqual({ type: "lock", on: true });
    expect(reports.at(-1)).toMatchObject({ engineCut: true, ignition: false, fix: { speedKmh: 0 } });
    const where = device.snapshot().state?.meters;
    pass(30);
    expect(device.snapshot().state?.meters).toBeCloseTo(where as number, 3);
    expect(device.memory().cut).toBe(true);
    device.inject({ kind: "engineLock", on: false });
    pass(0);
    expect(reports.at(-1)).toMatchObject({ engineCut: false, ignition: true });
    pass(10);
    expect(device.snapshot().state?.meters).toBeCloseTo((where as number) + 100, 3);

    // A theft: its power is cut and it moves with the engine off; a jammer comes on along the way.
    const before = reports.length;
    device.inject({ kind: "theft", seconds: 100 });
    pass(0);
    expect(reports.slice(before).map((r) => r.alarm)).toEqual(["powerCut", "tow"]);
    expect(reports.at(-1)).toMatchObject({ ignition: false });
    expect(reports.at(-1)?.fix.speedKmh).toBeCloseTo(36, 3);
    for (let i = 0; i < 9; i++) pass(5);
    expect(reports.some((r) => r.alarm === "jamming")).toBe(false);
    pass(5);
    expect(reports.at(-1)).toMatchObject({ alarm: "jamming", ignition: false });
    for (let i = 0; i < 10; i++) pass(5);
    expect(reports.at(-1)).toMatchObject({ ignition: true });
    expect(reports.at(-1)?.alarm).toBeUndefined();

    // The tank: it stops with the engine off while the level goes down, and then goes on.
    const parked = device.snapshot().state?.meters as number;
    device.inject({ kind: "fuel", pct: -20, seconds: 100 });
    pass(0);
    expect(reports.at(-1)).toMatchObject({ ignition: false, fix: { speedKmh: 0 } });
    expect(reports.at(-1)?.fuelPct).toBeCloseTo(50, 3);
    for (let i = 0; i < 10; i++) pass(5);
    expect(reports.at(-1)?.fuelPct).toBeCloseTo(40, 3);
    for (let i = 0; i < 10; i++) pass(5);
    expect(reports.at(-1)?.fuelPct).toBeCloseTo(30, 3);
    expect(device.snapshot().state?.meters).toBeCloseTo(parked, 0);
    pass(5);
    pass(5);
    expect(reports.at(-1)).toMatchObject({ ignition: true });
    expect(reports.at(-1)?.fuelPct).toBeCloseTo(30, 3);

    // Disconnected for a while: it keeps its reports and uploads them when it is back.
    device.inject({ kind: "disconnect", seconds: 20 });
    pass(0);
    expect(device.snapshot()).toMatchObject({ status: "noSignal", stored: 1 });
    for (let i = 0; i < 3; i++) pass(5);
    expect(device.snapshot()).toMatchObject({ status: "noSignal", stored: 4 });
    pass(5);
    pass(0);
    await until(() => seen("connected") === 2, "the reconnection");
    pass(0);
    expect(events.at(-1)).toEqual({ type: "signalBack", stored: 5 });
    expect(device.snapshot()).toMatchObject({ status: "online", stored: 0 });
    device.stop();
    await gw.close();
  });

  it("uploads reports of the past in batches, the oldest first; without a connection they wait", async () => {
    const past = (count: number, from: number): Report[] => Array.from({ length: count }, (_, i) => ({ at: new Date(from + i * 5000), fix: { lat: 14.08, lon: -87.2 + i * 0.0001, course: 90, speedKmh: 36 }, ignition: true }));
    const gw = await gateway((data) => (data.length === 17 ? Buffer.from([0x01]) : null));
    const { device, reports, pass, seen } = traveling(teltonika, gw.port, []);
    // Before it is connected, what it is given waits in its memory, in order of time whatever order it came in.
    device.upload(past(3, 1_700_000_100_000));
    device.upload(past(2, 1_700_000_000_000));
    expect(device.snapshot().stored).toBe(5);
    pass(0);
    await until(() => seen("connected") === 1, "the handshake");
    pass(0);
    // On connecting it empties its memory, and then says where it is.
    expect(reports).toHaveLength(6);
    expect(reports.slice(0, 5).map((r) => r.at.getTime())).toEqual([1_700_000_000_000, 1_700_000_005_000, 1_700_000_100_000, 1_700_000_105_000, 1_700_000_110_000]);
    expect(device.snapshot()).toMatchObject({ stored: 0, sent: 6 });

    // Connected, a whole past trip goes out at once: a Teltonika takes twenty records in a frame.
    await until(() => gw.frames.length >= 2, "what it had in its memory, on the wire");
    const frames = gw.frames.length;
    device.upload(past(45, 1_700_100_000_000));
    expect(device.snapshot().sent).toBe(51);
    await until(() => Buffer.concat(gw.frames.slice(frames)).length >= teltonika.encode("356307042441013", past(20, 0)).length * 2, "the upload");
    const uploaded = Buffer.concat(gw.frames.slice(frames));
    // Three frames: 20, 20 and 5 records.
    expect(uploaded[9]).toBe(20);
    const one = teltonika.encode("356307042441013", past(20, 0)).length;
    expect(uploaded[one + 9]).toBe(20);
    await until(() => Buffer.concat(gw.frames.slice(frames)).length > one * 2 + 9, "the last frame");
    expect(Buffer.concat(gw.frames.slice(frames))[one * 2 + 9]).toBe(5);
    device.stop();
    await gw.close();
  });
});
