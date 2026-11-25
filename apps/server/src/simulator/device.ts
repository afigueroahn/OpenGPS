// One simulated device: a TCP connection to the gateway that says hello,
// sends its position every so often and obeys the commands it receives, as a
// physical device does. It has no timers of its own: whoever runs it calls
// `tick` and tells it what time it is on the trip clock.
import { type Socket, connect as tcpConnect } from "node:net";
import type { SimAlarm } from "@opengps/shared";
import type { SimState } from "./plan";
import type { Protocol, Report } from "./protocols";

export type DeviceStatus = "connecting" | "online" | "rejected" | "unreachable" | "offline" | "noSignal" | "stopped";

export type DeviceEvent =
  | { type: "connected" }
  /** The gateway refused the handshake, or keeps closing the connection without a word. */
  | { type: "rejected" }
  | { type: "unreachable"; reason: string }
  | { type: "closed" }
  | { type: "report"; at: number }
  /** An alarm of its route went out with a report. */
  | { type: "alarm"; alarm: SimAlarm }
  /** It lost its signal: from now on it stores what it would send. */
  | { type: "signalLost" }
  /** The signal is back, and it uploaded that many stored reports. */
  | { type: "signalBack"; stored: number }
  /** Its start was cut or given back by hand, from the console. */
  | { type: "lock"; on: boolean }
  | { type: "command"; text: string; effect: "engineCut" | "engineResume" | "interval" | null; intervalS?: number };

/** What a device remembers between restarts. */
export interface DeviceMemory {
  /** The engine start is cut by a command. */
  cut: boolean;
  /** Seconds of trip it lost standing still with the start cut. */
  heldS: number;
  /** The report rate a command gave it, if any. */
  intervalS: number | null;
}

export interface DeviceOptions {
  id: string;
  protocol: Protocol;
  host: string;
  port: number;
  /** Seconds between two reports. */
  intervalS: number;
  /** Seconds this device is ahead of the trip clock, so several share a route without riding on top of each other. */
  offsetS: number;
  /** Where the vehicle is at a second of its trip. */
  stateAt(tripS: number): SimState;
  /** The alarms of its route that fall after one second of its trip and up to another. */
  alarmsBetween?: ((fromS: number, toS: number) => SimAlarm[]) | undefined;
  /** If false, its frames say nothing about the ignition: only the voltage. */
  reportIgnition?: boolean | undefined;
  /** Numbered parameters written as they are in every report. */
  extraIo?: Map<number, bigint> | undefined;
  /** Its route has engine fault codes: it reports them, and reports when there are none. */
  faults?: boolean | undefined;
  memory?: Partial<DeviceMemory> | undefined;
  /** When it may connect for the first time, so many devices do not all knock at once. */
  startAt?: number | undefined;
  connect?: ((host: string, port: number) => Socket) | undefined;
  now?: (() => number) | undefined;
  onEvent?: ((event: DeviceEvent) => void) | undefined;
}

/** Something done to a running device by hand, from the console, to see how the platform takes it. */
export type DeviceInjection =
  /** It sends that alarm with its next report, at once. */
  | { kind: "alarm"; alarm: SimAlarm }
  /** Its start is cut, or given back, as a command would do. */
  | { kind: "engineLock"; on: boolean }
  /** A theft: its power is cut and for a while it moves with the engine off, with a jammer on along the way. */
  | { kind: "theft"; seconds: number }
  /** It stops with the engine off while its tank gains or loses that many points of its level. */
  | { kind: "fuel"; pct: number; seconds: number }
  /** It loses its signal for a while: it stores its reports and uploads them when it is back. */
  | { kind: "disconnect"; seconds: number };

/** What a device says about a vehicle in that state, at that instant. */
export function reportOf(state: SimState, at: Date, options: Pick<DeviceOptions, "reportIgnition" | "extraIo" | "faults">, cut = false): Report {
  return {
    at,
    fix: { lat: state.lat, lon: state.lon, course: state.course, speedKmh: state.speedKmh },
    ignition: state.ignition,
    reportIgnition: options.reportIgnition,
    // Cut by a command, or by the device itself at that point of its route.
    engineCut: cut || state.locked,
    fuelPct: state.fuelPct ?? undefined,
    driverKey: state.driverKey || undefined,
    // On a route with fault codes, the device also says when there are none.
    dtc: options.faults ? state.dtc : undefined,
    extraIo: options.extraIo,
  };
}

export interface DeviceSnapshot {
  id: string;
  status: DeviceStatus;
  state: SimState | null;
  engineCut: boolean;
  sent: number;
  lastSentAt: number | null;
  /** Reports it is keeping for lack of signal. */
  stored: number;
}

export interface SimDevice {
  /** Does what is due at this moment: connect, give up on a handshake, send a report. */
  tick(now: number, tripS: number): void;
  snapshot(): DeviceSnapshot;
  memory(): DeviceMemory;
  /** Does something to it by hand. */
  inject(action: DeviceInjection): void;
  /** Reports of the past, the oldest first, sent as a real device uploads what it stored. Without a connection, they wait with the rest. */
  upload(reports: Report[]): void;
  stop(): void;
}

const CONNECT_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 5_000;
const RETRY_UNREACHABLE_MS = 5_000;
const RETRY_CLOSED_MS = 3_000;
const RETRY_REJECTED_MS = 10_000;
/** Closed this many times within the window without ever hearing from the gateway: it does not want this device. */
const QUICK_CLOSES = 3;
const QUICK_CLOSE_WINDOW_MS = 30_000;
/** Reports a device keeps while it has no signal; past that, the oldest are lost, as in a real one's memory. */
const STORED_MAX = 5000;

export function createDevice(options: DeviceOptions): SimDevice {
  const { id, protocol, host, port } = options;
  const clock = options.now ?? Date.now;
  const open = options.connect ?? ((h: string, p: number) => tcpConnect({ host: h, port: p }));
  const emit = (event: DeviceEvent) => options.onEvent?.(event);

  let status: DeviceStatus = "connecting";
  let socket: Socket | null = null;
  let connectAt = options.startAt ?? 0;
  let connectDeadline = 0;
  let loginDeadline: number | null = null;
  let reportAt = 0;
  let heard = false;
  let closes: number[] = [];

  let cut = options.memory?.cut ?? false;
  let heldS = options.memory?.heldS ?? 0;
  let ordered = options.memory?.intervalS ?? null;
  let lastTrip: number | null = null;
  /** When its last turn was, to know how much of the time since it stood still. */
  let lastTick: number | null = null;
  let sent = 0;
  let lastSentAt: number | null = null;
  let last: SimState | null = null;
  /** The second of its trip its last report was about, to know which alarms fell since. */
  let reportedTrip: number | null = null;
  /** What it could not send for lack of signal, the oldest first. */
  let stored: Report[] = [];

  // What was done to it by hand. None of it outlives a restart, except the cut of its start.
  /** Alarms waiting for the next report, and those due at an instant. */
  let pending: SimAlarm[] = [];
  let timed: { at: number; alarm: SimAlarm }[] = [];
  /** Until when it stands still with the engine off, moves with the engine off, and has no signal. */
  let holdUntil = 0;
  let towUntil = 0;
  let silentUntil = 0;
  /** Changes of its tank level over a while, on top of what its route says. */
  let shifts: { t0: number; t1: number; pct: number }[] = [];

  function drop(next: DeviceStatus, retryMs: number): void {
    const s = socket;
    socket = null;
    loginDeadline = null;
    s?.removeAllListeners();
    // A socket that is being torn down can still complain: nobody is listening any more.
    s?.on("error", () => {});
    s?.destroy();
    status = next;
    connectAt = clock() + retryMs;
  }

  function reject(): void {
    drop("rejected", RETRY_REJECTED_MS);
    emit({ type: "rejected" });
  }

  function online(): void {
    status = "online";
    loginDeadline = null;
    reportAt = clock();
    emit({ type: "connected" });
  }

  function onData(data: Buffer): void {
    heard = true;
    if (loginDeadline !== null) {
      if (protocol.accepted && !protocol.accepted(data)) return reject();
      return online();
    }
    const order = protocol.order?.(id, data);
    if (!order) return;
    if (order.reply) socket?.write(order.reply);
    if (order.effect && "engineCut" in order.effect) {
      cut = order.effect.engineCut;
      emit({ type: "command", text: order.text, effect: cut ? "engineCut" : "engineResume" });
      // The device says so right away, as a real one reports a change of its output.
      reportAt = clock();
    } else if (order.effect && "intervalS" in order.effect) {
      ordered = Math.max(1, Math.round(order.effect.intervalS));
      emit({ type: "command", text: order.text, effect: "interval", intervalS: ordered });
      reportAt = clock();
    } else {
      emit({ type: "command", text: order.text, effect: null });
    }
  }

  function onClose(reason: string | null): void {
    if (!socket) return;
    const wasOnline = status === "online";
    const now = clock();
    if (!wasOnline && loginDeadline === null) {
      drop("unreachable", RETRY_UNREACHABLE_MS);
      return emit({ type: "unreachable", reason: reason ?? "closed" });
    }
    closes = [...closes.filter((at) => now - at < QUICK_CLOSE_WINDOW_MS), now];
    if (!heard && closes.length >= QUICK_CLOSES) {
      closes = [];
      return reject();
    }
    drop("offline", RETRY_CLOSED_MS);
    emit({ type: "closed" });
  }

  function dial(): void {
    status = "connecting";
    heard = false;
    connectDeadline = clock() + CONNECT_TIMEOUT_MS;
    let failure: string | null = null;
    const s = open(host, port);
    socket = s;
    s.setNoDelay?.(true);
    s.once("connect", () => {
      if (socket !== s) return;
      connectDeadline = 0;
      if (protocol.login) {
        loginDeadline = clock() + LOGIN_TIMEOUT_MS;
        s.write(protocol.login(id));
      } else {
        online();
      }
    });
    s.on("data", (data) => {
      if (socket === s && Buffer.isBuffer(data)) onData(data);
    });
    s.on("error", (err: NodeJS.ErrnoException) => {
      failure = err.code ?? err.message;
    });
    s.on("close", () => {
      if (socket === s) onClose(failure);
    });
  }

  /** Whether it stands still with the engine off: its start is cut, or it was stopped by hand to fill or empty its tank. */
  const held = (now: number) => cut || now < holdUntil;

  /** What the device has to say at this second of its trip: one report, and one more for each alarm that fell since the last. */
  function frames(tripS: number): Report[] {
    const now = clock();
    const state = options.stateAt(tripS);
    let shown = held(now) ? { ...state, speedKmh: 0, ignition: false } : state;
    // Stolen: it moves, if its route has it moving, with the engine off.
    if (now < towUntil) shown = { ...shown, ignition: false };
    if (now < silentUntil) shown = { ...shown, silent: true };
    if (shown.fuelPct !== null && shifts.length > 0) {
      const moved = shifts.reduce((sum, shift) => sum + (now >= shift.t1 ? shift.pct : (shift.pct * (now - shift.t0)) / (shift.t1 - shift.t0)), 0);
      shown = { ...shown, fuelPct: Math.min(100, Math.max(0, shown.fuelPct + moved)) };
    }
    last = shown;
    const due = timed.filter((item) => item.at <= now).map((item) => item.alarm);
    timed = timed.filter((item) => item.at > now);
    const alarms = [...pending, ...due, ...(reportedTrip === null ? [] : (options.alarmsBetween?.(reportedTrip, tripS) ?? []))].filter((alarm) => protocol.capabilities.has(alarm));
    pending = [];
    reportedTrip = tripS;
    for (const alarm of alarms) emit({ type: "alarm", alarm });
    const at = (secondsAgo: number) => reportOf(shown, new Date(now - secondsAgo * 1000), options, cut);
    // Each alarm travels in a report of its own, a second apart, so none hides another.
    return alarms.length === 0 ? [at(0)] : alarms.map((alarm, i) => ({ ...at(alarms.length - 1 - i), alarm }));
  }

  function send(reports: Report[]): void {
    const now = clock();
    for (let i = 0; i < reports.length; i += protocol.batch) socket?.write(protocol.encode(id, reports.slice(i, i + protocol.batch)));
    sent += reports.length;
    lastSentAt = now;
    for (const _ of reports) emit({ type: "report", at: now });
  }

  /** What is due at a report time: send, or store for lack of signal. */
  function report(now: number, tripS: number): void {
    const due = frames(tripS);
    if (last?.silent) {
      // No signal here: the connection drops and what it would send, it keeps.
      if (status !== "noSignal") {
        drop("noSignal", Number.POSITIVE_INFINITY);
        emit({ type: "signalLost" });
      }
      stored.push(...due);
      // A memory that fills up loses its oldest reports.
      if (stored.length > STORED_MAX) stored = stored.slice(stored.length - STORED_MAX);
      return;
    }
    if (status === "noSignal") {
      // The signal is back: it connects again, and uploads what it kept once it is in.
      stored.push(...due);
      status = "offline";
      connectAt = now;
      return;
    }
    if (stored.length === 0) return send(due);
    // The stored ones go first, the oldest first, as a real device empties its memory.
    const kept = stored;
    stored = [];
    send([...kept, ...due]);
    emit({ type: "signalBack", stored: kept.length });
  }

  return {
    tick(now, tripS) {
      if (status === "stopped") return;
      // The trip clock keeps running for everyone; a vehicle that stands still falls behind it,
      // by as much of the time since its last turn as it stood still.
      if (lastTrip !== null && lastTick !== null && now > lastTick) {
        const still = cut ? 1 : Math.min(1, Math.max(0, (Math.min(now, holdUntil) - lastTick) / (now - lastTick)));
        heldS += Math.max(0, tripS - lastTrip) * still;
      }
      lastTrip = tripS;
      lastTick = now;
      if (status === "noSignal") {
        // Without signal it keeps its report times: that is when it stores.
        if (now >= reportAt) {
          reportAt = now + (ordered ?? options.intervalS) * 1000;
          report(now, tripS + options.offsetS - heldS);
        }
        return;
      }
      if (!socket) {
        if (now >= connectAt) dial();
        return;
      }
      if (status === "connecting" && connectDeadline && now >= connectDeadline) {
        drop("unreachable", RETRY_UNREACHABLE_MS);
        return emit({ type: "unreachable", reason: "timeout" });
      }
      // A gateway that does not answer the handshake does not know this device.
      if (loginDeadline !== null && now >= loginDeadline) return reject();
      if (status === "online" && now >= reportAt) {
        reportAt = now + (ordered ?? options.intervalS) * 1000;
        report(now, tripS + options.offsetS - heldS);
      }
    },
    snapshot: () => ({ id, status, state: last, engineCut: cut || Boolean(last?.locked), sent, lastSentAt, stored: stored.length }),
    memory: () => ({ cut, heldS, intervalS: ordered }),
    inject(action) {
      const now = clock();
      if (action.kind === "alarm") pending.push(action.alarm);
      else if (action.kind === "engineLock") {
        cut = action.on;
        emit({ type: "lock", on: cut });
      } else if (action.kind === "theft") {
        pending.push("powerCut", "tow");
        towUntil = now + action.seconds * 1000;
        // The jammer comes on a minute into it, or halfway if it is shorter.
        timed.push({ at: now + Math.min(60, action.seconds / 2) * 1000, alarm: "jamming" });
      } else if (action.kind === "fuel") {
        holdUntil = Math.max(holdUntil, now + action.seconds * 1000);
        shifts.push({ t0: now, t1: now + action.seconds * 1000, pct: action.pct });
      } else {
        silentUntil = now + action.seconds * 1000;
      }
      // It says so right away, as a real device reports what just happened to it.
      reportAt = now;
    },
    upload(reports) {
      if (reports.length === 0) return;
      if (status === "online") return send(reports);
      stored = [...reports, ...stored].sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-STORED_MAX);
    },
    stop() {
      const s = socket;
      socket = null;
      status = "stopped";
      s?.removeAllListeners();
      s?.on("error", () => {});
      // What was written goes out before closing.
      s?.destroySoon();
    },
  };
}
