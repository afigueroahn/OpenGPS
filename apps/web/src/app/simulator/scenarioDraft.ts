// The options of a route as a person writes them in the form: numbers as text,
// so a field can be left empty while typing, and each thing along the route
// with a name of its own in the list.
import { SIM_LIMITS, type SimAction, type SimActionInput, type SimActionKind, type SimAlarm, type SimCapability, type SimScenario, type SimScenarioInput, simActionNeeds } from "@opengps/shared";

export interface ActionDraft {
  key: number;
  kind: SimActionKind;
  /** Kilometers from the start of the route. */
  km: string;
  seconds: string;
  pct: string;
  /** Length of a stretch, in meters. */
  meters: string;
  kmh: string;
  engineOn: boolean;
  alarm: SimAlarm;
  driver: string;
  /** Fault codes, separated by commas. */
  codes: string;
}

export interface ScenarioDraft {
  actions: ActionDraft[];
  fuelOn: boolean;
  fuelStart: string;
  fuelBurn: string;
  driverKey: string;
  reportIgnition: boolean;
  roadSpeeds: boolean;
  /** Numbered parameters as "66=11500, 200=1". */
  extraIo: string;
}

let nextKey = 0;
// Rounded down, so a place at the very end of the route is not written past it.
const km = (meters: number) => String(Math.floor(meters / 10) / 100);

export const newAction = (kind: SimActionKind, atM: number, alarm: SimAlarm = "powerCut"): ActionDraft => ({
  key: nextKey++,
  kind,
  km: km(atM),
  seconds: kind === "signalLoss" ? "600" : kind === "stop" ? "120" : "240",
  pct: "20",
  meters: "1000",
  kmh: "130",
  engineOn: false,
  alarm,
  driver: "",
  codes: "P0300",
});

/** An action as it is saved, in the form. */
export function draftOf(action: SimAction | SimActionInput): ActionDraft {
  const draft = newAction(action.kind, action.atM);
  if ("seconds" in action) draft.seconds = String(action.seconds);
  if ("pct" in action) draft.pct = String(action.pct);
  if ("lengthM" in action) draft.meters = String(Math.round(action.lengthM));
  if (action.kind === "speeding") draft.kmh = String(action.kmh);
  if (action.kind === "stop") draft.engineOn = action.engineOn ?? false;
  if (action.kind === "alarm") draft.alarm = action.alarm;
  if (action.kind === "driverKey") draft.driver = action.key;
  if (action.kind === "dtc") draft.codes = action.codes.join(", ");
  return draft;
}

export const scenarioDraft = (scenario: SimScenario | null): ScenarioDraft => ({
  actions: (scenario?.actions ?? []).map(draftOf),
  fuelOn: Boolean(scenario?.fuel),
  fuelStart: String(scenario?.fuel?.startPct ?? 60),
  fuelBurn: String(scenario?.fuel?.burnPer100Km ?? 12),
  driverKey: scenario?.driverKey ?? "",
  reportIgnition: scenario?.reportIgnition ?? true,
  roadSpeeds: scenario?.roadSpeeds ?? true,
  extraIo: (scenario?.extraIo ?? []).map((io) => `${io.id}=${io.value}`).join(", "),
});

/** A number typed by hand; null if it is not one. */
const numberOf = (text: string): number | null => {
  const n = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) ? n : null;
};

/** What went wrong in the form, as a key of the catalog with what it needs. */
export interface DraftProblem {
  key: "km" | "seconds" | "percent" | "stretch" | "speed" | "driver" | "codes" | "fuel" | "extraIo";
  /** The place in the list of the thing along the route it is about, from 1. */
  row?: number;
}

function actionOf(draft: ActionDraft, routeM: number): SimActionInput | DraftProblem["key"] {
  const at = numberOf(draft.km);
  // A hundredth of a kilometer of slack: the length shown is rounded.
  if (at === null || at < 0 || at * 1000 > routeM + 10) return "km";
  const atM = Math.min(routeM, Math.round(at * 1000));
  const seconds = numberOf(draft.seconds);
  const okSeconds = seconds !== null && Number.isInteger(seconds) && seconds >= 1 && seconds <= 86_400;
  const pct = numberOf(draft.pct);
  const okPct = pct !== null && pct >= 1 && pct <= 100;
  const meters = numberOf(draft.meters);
  const okMeters = meters !== null && meters >= 50;
  switch (draft.kind) {
    case "stop":
      return okSeconds ? { kind: "stop", atM, seconds, engineOn: draft.engineOn } : "seconds";
    case "refuel":
    case "drain":
      if (!okSeconds) return "seconds";
      return okPct ? { kind: draft.kind, atM, seconds, pct } : "percent";
    case "speeding": {
      const kmh = numberOf(draft.kmh);
      if (!okMeters) return "stretch";
      return kmh !== null && kmh >= 5 && kmh <= 250 ? { kind: "speeding", atM, lengthM: meters, kmh } : "speed";
    }
    case "engineLock":
    case "signalLoss":
      return okSeconds ? { kind: draft.kind, atM, seconds } : "seconds";
    case "towing":
      return okMeters ? { kind: "towing", atM, lengthM: meters } : "stretch";
    case "alarm":
      return { kind: "alarm", atM, alarm: draft.alarm };
    case "driverKey": {
      const key = draft.driver.trim().toUpperCase();
      return key === "" || /^[0-9A-F]{4,16}$/.test(key) ? { kind: "driverKey", atM, key } : "driver";
    }
    case "dtc": {
      const codes = draft.codes.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
      return codes.length <= 8 && codes.every((c) => /^[PCBU][0-9A-F]{4}$/.test(c)) ? { kind: "dtc", atM, codes } : "codes";
    }
  }
}

/** The options as they are saved, or what is wrong with them. */
export function scenarioOf(draft: ScenarioDraft, routeM: number): { options: Pick<SimScenarioInput, "actions" | "fuel" | "driverKey" | "reportIgnition" | "roadSpeeds" | "extraIo"> } | { problem: DraftProblem } {
  const actions: SimActionInput[] = [];
  for (const [i, row] of draft.actions.entries()) {
    const action = actionOf(row, routeM);
    if (typeof action === "string") return { problem: { key: action, row: i + 1 } };
    actions.push(action);
  }
  let fuel: { startPct: number; burnPer100Km: number } | null = null;
  if (draft.fuelOn) {
    const startPct = numberOf(draft.fuelStart);
    const burnPer100Km = numberOf(draft.fuelBurn);
    if (startPct === null || startPct < 0 || startPct > 100 || burnPer100Km === null || burnPer100Km < 0 || burnPer100Km > 100) return { problem: { key: "fuel" } };
    fuel = { startPct, burnPer100Km };
  }
  const driverKey = draft.driverKey.trim().toUpperCase();
  if (driverKey !== "" && !/^[0-9A-F]{4,16}$/.test(driverKey)) return { problem: { key: "driver" } };
  const extraIo: { id: number; value: number }[] = [];
  for (const pair of draft.extraIo.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d{1,5})=(\d{1,15})$/.exec(pair);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 65_535 || extraIo.length >= SIM_LIMITS.extraIo) return { problem: { key: "extraIo" } };
    extraIo.push({ id: Number(m[1]), value: Number(m[2]) });
  }
  return { options: { actions, fuel, driverKey, reportIgnition: draft.reportIgnition, roadSpeeds: draft.roadSpeeds, extraIo } };
}

/** Whether a brand carries what a thing along the route needs. */
export const carried = (capabilities: readonly SimCapability[], kind: SimActionKind, alarm?: SimAlarm): boolean => {
  const needs = simActionNeeds(alarm ? { kind, alarm } : { kind });
  return needs === null || capabilities.includes(needs);
};
