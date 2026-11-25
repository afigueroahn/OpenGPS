// The brands the simulator speaks, by the protocol name the device catalog gives them.
import { h02 } from "./h02";
import { teltonika } from "./teltonika";
import type { Protocol } from "./types";

export type { Fix, Order, Protocol, Report } from "./types";
export { crc16 } from "./checksums";
export { h02, teltonika };

export const PROTOCOLS: Record<string, Protocol> = { h02, teltonika };
