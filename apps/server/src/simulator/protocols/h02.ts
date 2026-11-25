// H02: SinoTrack, MiCODUS.
// *HQ,<id>,V1,<HHMMSS>,A,<DDMM.MMMM>,<N|S>,<DDDMM.MMMM>,<E|W>,<knots>,<heading>,<DDMMYY>,<status>#
import type { Protocol } from "./types";

const pad = (n: number, width: number) => String(Math.trunc(n)).padStart(width, "0");

function degreesMinutes(value: number, degreeDigits: number): string {
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutes = (abs - degrees) * 60;
  return `${pad(degrees, degreeDigits)}${minutes.toFixed(4).padStart(7, "0")}`;
}

export const h02: Protocol = {
  id: "h02",
  capabilities: new Set(["ignition", "sos", "powerCut", "engineCut", "interval", "stored"]),
  idFormat: { kind: "digits", length: 10 },
  batch: 1,
  encode(id, reports) {
    return Buffer.from(
      reports
        .map(({ at, fix, ignition, alarm }) => {
          const time = `${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}`;
          const date = `${pad(at.getUTCDate(), 2)}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCFullYear() % 100, 2)}`;
          const knots = (fix.speedKmh / 1.852).toFixed(2).padStart(6, "0");
          // Status: each bit set to 1 means "nothing to report". Bit 10 is engine on,
          // bit 1 the panic button and bit 19 external power.
          let bits = 0xffffffff;
          if (!ignition) bits &= ~(1 << 10);
          if (alarm === "sos") bits &= ~(1 << 1);
          if (alarm === "powerCut") bits &= ~(1 << 19);
          const status = (bits >>> 0).toString(16).toUpperCase().padStart(8, "0");
          return `*HQ,${id},V1,${time},A,${degreesMinutes(fix.lat, 2)},${fix.lat < 0 ? "S" : "N"},${degreesMinutes(fix.lon, 3)},${
            fix.lon < 0 ? "W" : "E"
          },${knots},${pad(Math.round(fix.course) % 360, 3)},${date},${status}#`;
        })
        .join(""),
      "ascii",
    );
  },
  // *HQ,<id>,S20,<time>,1,1# cuts the engine start and …,1,0# gives it back; S71,<time>,22,<s># changes the report rate.
  order(_id, data) {
    const text = data.toString("ascii").trim();
    const m = /^\*HQ,\d+,(\w+),\d+,?([^#]*)#/.exec(text);
    if (!m) return null;
    const args = (m[2] ?? "").split(",");
    if (m[1] === "S20") return { text, effect: { engineCut: args[1] === "1" } };
    if (m[1] === "S71" && Number(args[1]) > 0) return { text, effect: { intervalS: Number(args[1]) } };
    return { text };
  },
};
