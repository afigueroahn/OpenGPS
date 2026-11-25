// The frames of each brand the simulator speaks, as a physical device writes
// them, and the commands it understands.
import { SIM_ALARMS, type SimCapability } from "@opengps/shared";
import { describe, expect, it } from "vitest";
import { PROTOCOLS, type Report, crc16, h02, teltonika } from "../src/simulator/protocols";
import { teltonikaIo } from "../src/simulator/protocols/teltonika";

describe("simulator frames", () => {
  it("computes the CRC-16 of the official Teltonika example", () => {
    // Example packet from the Codec 8 documentation; its CRC is 0000C7CF.
    const data = Buffer.from("08010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E000000000000000001", "hex");
    expect(crc16(data)).toBe(0xc7cf);
  });

  it("builds a Teltonika frame with consistent length, count and CRC", () => {
    const fix = { lat: -12.0464, lon: -77.0428, course: 90, speedKmh: 45 };
    const frame = teltonika.encode("356307042441013", [
      { at: new Date("2026-11-21T12:00:00Z"), fix, ignition: true },
      { at: new Date("2026-11-21T12:00:10Z"), fix, ignition: true },
    ]);
    expect(frame.readUInt32BE(0)).toBe(0);
    const length = frame.readUInt32BE(4);
    const data = frame.subarray(8, 8 + length);
    expect(frame.length).toBe(8 + length + 4);
    expect(data[0]).toBe(0x08);
    expect(data[1]).toBe(2);
    expect(data[data.length - 1]).toBe(2);
    expect(frame.readUInt32BE(8 + length)).toBe(crc16(data));
    // First record: time, priority, longitude and latitude in ten-millionths of a degree.
    expect(Number(data.readBigUInt64BE(2))).toBe(Date.parse("2026-11-21T12:00:00Z"));
    expect(data.readInt32BE(11)).toBe(-770428000);
    expect(data.readInt32BE(15)).toBe(-120464000);
  });

  it("builds an H02 frame with hemispheres and speed in knots", () => {
    const frame = h02
      .encode("9170000001", [{ at: new Date("2026-11-21T08:05:09Z"), fix: { lat: -12.05, lon: -77.03, course: 90, speedKmh: 37.04 }, ignition: true }])
      .toString();
    expect(frame).toBe("*HQ,9170000001,V1,080509,A,1203.0000,S,07701.8000,W,020.00,090,211126,FFFFFFFF#");
  });
});

describe("extra data and commands", () => {
  const report = { at: new Date("2026-11-22T12:00:00Z"), fix: { lat: 14.08, lon: -87.2, speedKmh: 40, course: 90 }, ignition: true };

  it("teltonika: each parameter takes the bytes it should", () => {
    const extraIo = new Map<number, bigint>([
      [253, 2n], // 1 byte
      [9, 2500n], // 2 bytes
      [16, 250_000n], // 4 bytes
      [78, 0x1f00bc55n], // 8 bytes
    ]);
    const frame = teltonika.encode("356307042441013", [{ ...report, extraIo }]);
    // Record: 26 header bytes, then the four groups by width.
    const record = frame.subarray(10, frame.length - 5);
    expect(record[24]).toBe(0); // event
    expect(record[25]).toBe(9); // parameters in total: 5 of its own and 4 added
    let o = 26;
    const one = record[o++] as number;
    expect(one).toBe(4);
    const ids1 = Array.from({ length: one }, (_, i) => record[o + i * 2]);
    expect(ids1).toEqual([239, 240, 21, 253]);
    o += one * 2;
    const two = record[o++] as number;
    expect(two).toBe(3);
    expect(Array.from({ length: two }, (_, i) => record[o + i * 3])).toEqual([66, 67, 9]);
    expect(record.readUInt16BE(o + 2 * 3 + 1)).toBe(2500);
    o += two * 3;
    expect(record[o++]).toBe(1);
    expect(record[o]).toBe(16);
    expect(record.readUInt32BE(o + 1)).toBe(250_000);
    o += 5;
    expect(record[o++]).toBe(1);
    expect(record[o]).toBe(78);
    expect(record.readBigUInt64BE(o + 1)).toBe(0x1f00bc55n);
    expect(o + 9).toBe(record.length);
    // The checksum covers from the codec to the final count.
    expect(frame.readUInt32BE(frame.length - 4)).toBe(crc16(frame.subarray(8, frame.length - 4)));
  });

  it("teltonika: understands the engine-cut command and answers it", () => {
    // Frame as Traccar sends it for "engineStop": Codec 12 with the text "setdigout 1".
    const text = Buffer.from("setdigout 1", "ascii");
    const data = Buffer.concat([Buffer.from([0x0c, 0x01, 0x05, 0, 0, 0, text.length]), text, Buffer.from([0x01])]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc16(data));
    const order = teltonika.order?.("1", Buffer.concat([head, data, crc]));
    expect(order).toMatchObject({ text: "setdigout 1", effect: { engineCut: true } });
    expect(order?.reply?.[8]).toBe(0x0c);
    expect(order?.reply?.[10]).toBe(0x06);
    expect(order?.reply?.subarray(15, 15 + 7).toString("ascii")).toBe("DOUT1:1");
    // The acknowledgement of positions is not a command.
    expect(teltonika.order?.("1", Buffer.from([0, 0, 0, 1]))).toBeNull();
  });

  it("h02: understands the engine cut and the change of reporting rate", () => {
    expect(h02.order?.("9170000777", Buffer.from("*HQ,9170000777,S20,081516,1,1#"))).toMatchObject({ effect: { engineCut: true } });
    expect(h02.order?.("9170000777", Buffer.from("*HQ,9170000777,S20,081522,1,0#"))).toMatchObject({ effect: { engineCut: false } });
    expect(h02.order?.("9170000777", Buffer.from("*HQ,9170000777,S71,081521,22,10#"))).toMatchObject({ effect: { intervalS: 10 } });
    expect(h02.order?.("9170000777", Buffer.from("cualquier cosa"))).toBeNull();
  });

  it("teltonika: what the device has to say goes in the parameters a real one uses", () => {
    const io = teltonikaIo({ ...report, engineCut: true, alarm: "harshBraking", fuelPct: 72.4, driverKey: "1F00BC55", rpm: 2200, coolantC: 90, dtc: ["P0300", "P0171"] });
    expect(Object.fromEntries(io)).toMatchObject({ 239: 1n, 240: 1n, 179: 1n, 253: 2n, 89: 72n, 78: 0x1f00bc55n, 36: 2200n, 32: 90n, 30: 2n });
    expect(teltonikaIo({ ...report, alarm: "powerCut" }).get(252)).toBe(1n);
    expect(teltonikaIo({ ...report, alarm: "tow" }).get(246)).toBe(1n);
    expect(teltonikaIo({ ...report, alarm: "jamming" }).get(249)).toBe(1n);
    // Without the ignition, the frame only carries the voltage; without a word about the output, nothing about it.
    const quiet = teltonikaIo({ ...report, reportIgnition: false });
    expect(quiet.has(239)).toBe(false);
    expect(quiet.has(179)).toBe(false);
    // Fault codes travel as text: the frame goes in extended Codec 8.
    const frame = teltonika.encode("356307042441013", [{ ...report, dtc: ["P0300", "P0171"] }]);
    expect(frame[8]).toBe(0x8e);
    expect(frame.includes(Buffer.from("P0300,P0171", "ascii"))).toBe(true);
    expect(frame.readUInt32BE(frame.length - 4)).toBe(crc16(frame.subarray(8, frame.length - 4)));
  });

  it("every brand writes what it says it can carry", () => {
    // What each capability adds to a report. The ones that are about commands or stored data add nothing to a frame.
    const adds: Partial<Record<SimCapability, Partial<Report>>> = {
      ignition: { ignition: false },
      lockState: { engineCut: true },
      fuel: { fuelPct: 40 },
      driverKey: { driverKey: "1F00BC55" },
      engineData: { rpm: 2200, coolantC: 90 },
      dtc: { dtc: ["P0300"] },
      extraIo: { extraIo: new Map([[200, 1n]]) },
      ...Object.fromEntries(SIM_ALARMS.map((alarm) => [alarm, { alarm }])),
    };
    for (const protocol of Object.values(PROTOCOLS)) {
      const plain = protocol.encode("356307042441013", [report]).toString("hex");
      for (const [capability, extra] of Object.entries(adds) as [SimCapability, Partial<Report>][]) {
        const changed = protocol.encode("356307042441013", [{ ...report, ...extra }]).toString("hex") !== plain;
        expect(changed, `${protocol.id}: ${capability}`).toBe(protocol.capabilities.has(capability));
      }
    }
  });
});
