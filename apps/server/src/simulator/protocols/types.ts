// What every brand's protocol gives the simulator: how to say hello, how to
// write a frame with positions as a physical device sends it, and how to read
// the commands the gateway sends back.
import type { SimAlarm, SimCapability, SimIdFormat } from "@opengps/shared";

export interface Fix {
  lat: number;
  lon: number;
  /** Heading in degrees, 0 = north. */
  course: number;
  speedKmh: number;
}

/** What the device has to say at an instant. Each protocol writes what it can carry and leaves the rest out. */
export interface Report {
  at: Date;
  fix: Fix;
  /** Engine on. */
  ignition: boolean;
  /** If false, the frame says nothing about the ignition: it only carries the voltage. */
  reportIgnition?: boolean | undefined;
  /** Alarm the device sends with this position. */
  alarm?: SimAlarm | undefined;
  /** The output that cuts the engine start is active. */
  engineCut?: boolean | undefined;
  /** Fuel level, 0 to 100. */
  fuelPct?: number | undefined;
  /** Driver key (iButton), in hexadecimal. */
  driverKey?: string | undefined;
  /** Engine fault codes, such as P0300. */
  dtc?: string[] | undefined;
  rpm?: number | undefined;
  coolantC?: number | undefined;
  /** Parameters written as they are, identifier → value, in the protocols that have numbered parameters. */
  extraIo?: Map<number, bigint> | undefined;
}

/** Command the gateway sent to the device. */
export interface Order {
  /** Text of the command, as it arrived. */
  text: string;
  /** What the command does to the vehicle, if the simulator understands it. */
  effect?: { engineCut: boolean } | { intervalS: number };
  /** Device response, if the protocol has one. */
  reply?: Buffer;
}

export interface Protocol {
  /** The protocol's name in the device catalog and in the gateway. */
  id: string;
  capabilities: ReadonlySet<SimCapability>;
  idFormat: SimIdFormat;
  /** What the device sends on connecting, if the protocol has a handshake. */
  login?(id: string): Buffer;
  /** Reads the gateway's response to the handshake. Returns false if it rejects the device. */
  accepted?(reply: Buffer): boolean;
  /** A frame with one or several positions. */
  encode(id: string, reports: Report[]): Buffer;
  /** Positions that fit in a single frame. */
  batch: number;
  /** Interprets what the gateway sends over the connection: null if it is not a command. */
  order?(id: string, data: Buffer): Order | null;
}
