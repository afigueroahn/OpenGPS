// A gateway for the simulator's tests: a local TCP server that receives what a
// simulated device sends and answers what the test says, like the real one.
import { type AddressInfo, type Socket, createServer } from "node:net";

export interface Gateway {
  port: number;
  sockets: Socket[];
  /** Everything received, in order, from every connection. */
  frames: Buffer[];
  close(): Promise<void>;
}

const open: Gateway[] = [];

/** A gateway that answers each thing it receives with what `reply` says. */
export async function gateway(reply: (data: Buffer, socket: Socket) => Buffer | null = () => null): Promise<Gateway> {
  const sockets: Socket[] = [];
  const frames: Buffer[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      const data = Buffer.from(chunk);
      frames.push(data);
      const answer = reply(data, socket);
      if (answer) socket.write(answer);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  let closed: Promise<void> | null = null;
  const gw: Gateway = {
    port: (server.address() as AddressInfo).port,
    sockets,
    frames,
    close: () =>
      (closed ??= new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      })),
  };
  open.push(gw);
  return gw;
}

/** Closes every gateway still open: a test that fails halfway leaves nothing listening. */
export async function closeGateways(): Promise<void> {
  for (const gw of open.splice(0)) await gw.close();
}

/** Waits for something that depends on a real connection. */
export async function until(what: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await what())) {
    if (Date.now() > deadline) throw new Error(`still waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
