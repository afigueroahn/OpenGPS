// Teltonika, Codec 8.
// Handshake: 2 bytes with the IMEI length + IMEI in ASCII; the gateway replies 01.
// Data: 4 zero bytes, length, codec 08, count, records, count, CRC-16.
import { crc16 } from "./checksums";
import type { Protocol, Report } from "./types";

/** The Teltonika parameters (their identifiers) the simulator writes. */
const IO = {
  ignition: 239,
  movement: 240,
  gsmSignal: 21,
  externalVoltage: 66,
  batteryVoltage: 67,
  /** Digital output 1, the one wired to the relay that cuts the engine start. */
  output1: 179,
  /** Harsh driving: 1 acceleration, 2 braking, 3 cornering. */
  greenDriving: 253,
  jamming: 249,
  /** The alarm input, where a panic button is wired. The gateway reads it as a general alarm, and the platform takes a Teltonika's general alarm for its panic button. */
  alarm: 236,
  towing: 246,
  unplug: 252,
  fuelLevel: 89,
  iButton: 78,
  rpm: 36,
  coolantTemperature: 32,
  dtcCount: 30,
  dtcCodes: 281,
} as const;

const HARSH = { harshAcceleration: 1n, harshBraking: 2n, harshCornering: 3n } as const;

/** Bytes of the parameters that do not take up what their value suggests. */
const IO_BYTES: Record<number, 1 | 2 | 4 | 8> = { 9: 2, 10: 2, 13: 2, 66: 2, 67: 2, 84: 2, 85: 2, 12: 4, 16: 4, 83: 4, 87: 4, 199: 4, 78: 8 };
const bytesOf = (id: number, value: bigint): 1 | 2 | 4 | 8 => IO_BYTES[id] ?? (value < 256n ? 1 : value < 65_536n ? 2 : value < 4_294_967_296n ? 4 : 8);

/** The numbered parameters of a report: the ones every record carries and what this one has to say. */
export function teltonikaIo(report: Report): Map<number, bigint> {
  const { fix, ignition, reportIgnition = true, alarm } = report;
  const io = new Map<number, bigint>([
    ...(reportIgnition ? ([[IO.ignition, ignition ? 1n : 0n]] as [number, bigint][]) : []),
    [IO.movement, fix.speedKmh > 2 ? 1n : 0n],
    [IO.gsmSignal, 4n], // 0 to 5
    [IO.externalVoltage, ignition ? 13_900n : 12_500n], // mV: rises with the engine running
    [IO.batteryVoltage, 4_050n], // mV
  ]);
  if (report.engineCut !== undefined) io.set(IO.output1, report.engineCut ? 1n : 0n);
  if (alarm === "sos") io.set(IO.alarm, 1n);
  if (alarm === "powerCut") io.set(IO.unplug, 1n);
  if (alarm === "tow") io.set(IO.towing, 1n);
  if (alarm === "jamming") io.set(IO.jamming, 1n);
  if (alarm === "harshAcceleration" || alarm === "harshBraking" || alarm === "harshCornering") io.set(IO.greenDriving, HARSH[alarm]);
  if (report.fuelPct !== undefined) io.set(IO.fuelLevel, BigInt(Math.round(Math.min(100, Math.max(0, report.fuelPct)))));
  if (report.driverKey) io.set(IO.iButton, BigInt(`0x${report.driverKey}`));
  if (report.rpm !== undefined) io.set(IO.rpm, BigInt(Math.round(report.rpm)));
  if (report.coolantC !== undefined) io.set(IO.coolantTemperature, BigInt(Math.round(report.coolantC)));
  // Fault codes: how many there are and, as text, which ones, as an OBD-equipped device delivers them.
  // None at all is said too, with a zero: that is how the platform learns they cleared.
  if (report.dtc) io.set(IO.dtcCount, BigInt(report.dtc.length));
  for (const [id, value] of report.extraIo ?? []) io.set(id, value);
  return io;
}

const textOf = (report: Report): Map<number, string> => (report.dtc?.length ? new Map([[IO.dtcCodes, report.dtc.join(",")]]) : new Map());

/** Extended Codec 8 is needed: there are text parameters, or identifiers that do not fit in one byte. */
const needsExtended = (r: Report) => textOf(r).size > 0 || [...teltonikaIo(r).keys()].some((id) => id > 255);

function record(report: Report, extended: boolean): Buffer {
  const { at, fix } = report;
  // In the extended one, identifiers and counts take two bytes.
  const wide = extended ? 2 : 1;
  const values = teltonikaIo(report);
  const text = textOf(report);
  const groups = ([1, 2, 4, 8] as const).map((width) => [...values].filter(([id, value]) => bytesOf(id, value) === width));
  const head = Buffer.alloc(8 + 1 + 15 + 2 * wide);
  let o = 0;
  o = head.writeBigUInt64BE(BigInt(at.getTime()), o);
  o = head.writeUInt8(1, o); // high priority
  o = head.writeInt32BE(Math.round(fix.lon * 1e7), o);
  o = head.writeInt32BE(Math.round(fix.lat * 1e7), o);
  o = head.writeInt16BE(150, o); // altitude
  o = head.writeUInt16BE(Math.round(fix.course) % 360, o);
  o = head.writeUInt8(12, o); // satellites
  o = head.writeUInt16BE(Math.round(fix.speedKmh), o);
  o = head.writeUIntBE(0, o, wide); // event that generated the record
  head.writeUIntBE(values.size + (extended ? text.size : 0), o, wide); // total parameters
  const parts = [head];
  groups.forEach((group, g) => {
    const width = ([1, 2, 4, 8] as const)[g] as number;
    const block = Buffer.alloc(wide + group.length * (wide + width));
    let at = block.writeUIntBE(group.length, 0, wide);
    for (const [id, value] of group) {
      at = block.writeUIntBE(id, at, wide);
      at = width === 8 ? block.writeBigUInt64BE(value, at) : block.writeUIntBE(Number(value), at, width);
    }
    parts.push(block);
  });
  if (extended) {
    // Variable-length parameters: how many there are and, for each, identifier, length and content.
    const items = [...text].map(([id, value]) => {
      const body = Buffer.from(value, "ascii");
      const item = Buffer.alloc(4);
      item.writeUInt16BE(id, 0);
      item.writeUInt16BE(body.length, 2);
      return Buffer.concat([item, body]);
    });
    const count = Buffer.alloc(2);
    count.writeUInt16BE(items.length);
    parts.push(count, ...items);
  }
  return Buffer.concat(parts);
}

/** Codec 12 frame: type 5 is a command from the gateway and type 6 the device's response. */
function codec12(type: 5 | 6, text: string): Buffer {
  const payload = Buffer.from(text, "ascii");
  const data = Buffer.alloc(2 + 1 + 4 + payload.length + 1);
  let o = data.writeUInt8(0x0c, 0);
  o = data.writeUInt8(1, o);
  o = data.writeUInt8(type, o);
  o = data.writeUInt32BE(payload.length, o);
  o += payload.copy(data, o);
  data.writeUInt8(1, o);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16(data));
  return Buffer.concat([head, data, crc]);
}

export const teltonika: Protocol = {
  id: "teltonika",
  capabilities: new Set(["ignition", "voltage", "sos", "powerCut", "tow", "jamming", "harshAcceleration", "harshBraking", "harshCornering", "fuel", "driverKey", "engineData", "dtc", "engineCut", "lockState", "stored", "extraIo"]),
  idFormat: { kind: "imei" },
  batch: 20,
  login(id) {
    const imei = Buffer.from(id, "ascii");
    const head = Buffer.alloc(2);
    head.writeUInt16BE(imei.length);
    return Buffer.concat([head, imei]);
  },
  accepted: (reply) => reply[0] === 0x01,
  encode(_id, reports) {
    const extended = reports.some(needsExtended);
    const records = reports.map((report) => record(report, extended));
    const data = Buffer.concat([Buffer.from([extended ? 0x8e : 0x08, records.length]), ...records, Buffer.from([records.length])]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc16(data));
    return Buffer.concat([head, data, crc]);
  },
  // Commands arrive in Codec 12. "setdigout 1" activates the output that cuts the engine start.
  order(_id, data) {
    if (data.length < 16 || data.readUInt32BE(0) !== 0 || data[8] !== 0x0c || data[10] !== 0x05) return null;
    const size = data.readUInt32BE(11);
    const text = data.subarray(15, 15 + size).toString("ascii").trim();
    const m = /^setdigout\s+([01])/.exec(text);
    if (m) return { text, effect: { engineCut: m[1] === "1" }, reply: codec12(6, `DOUT1:${m[1]} Timeout:INFINITY`) };
    return { text, reply: codec12(6, "OK") };
  },
};
