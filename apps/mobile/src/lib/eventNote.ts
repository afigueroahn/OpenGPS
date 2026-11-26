// What an event says beyond its name: how fast it went, how long it stayed,
// how much fuel left the tank. Same rules as the web app's (Events.tsx, noteOf).
import { SUBJECT_EVENTS, type VehicleEvent } from "@opengps/shared";
import { decimalMark, formatDuration } from "./format";
import i18n from "./i18n";

interface Detail {
  stayedMin?: number;
  minimumMin?: number;
  maximumMin?: number;
  bySchedule?: boolean;
  speedKmh?: number;
  limitKmh?: number;
  silentMin?: number;
  meters?: number;
  kind?: string;
  minutes?: number;
  limitMinutes?: number;
  driverName?: string;
  liters?: number;
  code?: string;
  description?: string;
  rpm?: number;
  tempC?: number;
  volts?: number;
  limit?: number;
  subject?: string;
  reason?: string;
}

/** "Iba a 98 km/h; el límite es 80 km/h", or null when the event says nothing more. */
export function eventNote(event: Pick<VehicleEvent, "type" | "detail">): string | null {
  const t = (key: string, params: Record<string, unknown> = {}) => i18n.t(`eventNote.${key}`, params);
  const d = event.detail as Detail;
  if (event.type === "route_deviation" && d.meters) return t("routeDeviation", { meters: d.meters });
  if (SUBJECT_EVENTS.includes(event.type) && d.subject) return d.reason ? `${d.subject}: ${d.reason}` : d.subject;
  if ((event.type === "engine_fault" || event.type === "engine_fault_cleared") && d.code) return `${d.code}: ${d.description ?? t("noDescription")}`;
  if (event.type === "engine_overrev" && d.rpm && d.limit) return t("overrev", { rpm: d.rpm, limit: d.limit });
  if (event.type === "engine_overheat" && d.tempC && d.limit) return t("overheat", { temp: decimalMark(d.tempC), limit: decimalMark(d.limit) });
  if (event.type === "battery_low" && d.volts && d.limit) return t("batteryLow", { volts: decimalMark(d.volts), limit: decimalMark(d.limit) });
  const liters = typeof d.liters === "number" ? decimalMark(d.liters) : null;
  if (event.type === "fuel_theft" && liters) return t("fuelTheft", { liters });
  if (event.type === "fuel_drain" && liters) return t("fuelDrain", { liters });
  if (event.type === "fuel_refuel" && liters) return t("fuelRefuel", { liters });
  if (event.type === "driving_time" && d.minutes && d.limitMinutes) {
    const times = { driver: d.driverName, time: formatDuration(d.minutes * 60), max: formatDuration(d.limitMinutes * 60) };
    if (d.kind === "daily") return d.driverName ? t("drivingDailyDriver", times) : t("drivingDaily", times);
    return d.driverName ? t("drivingNonstopDriver", times) : t("drivingNonstop", times);
  }
  if (event.type === "speeding" && d.speedKmh && d.limitKmh) return t("speeding", { speed: d.speedKmh, limit: d.limitKmh });
  if (event.type === "signal_lost" && d.silentMin) return t("signalLost", { time: formatDuration(d.silentMin * 60) });
  if (event.type === "unauthorized_movement" && d.meters) return t("unauthorizedMovement", { meters: d.meters });
  if (event.type === "tow" && d.speedKmh) return t("tow", { speed: d.speedKmh });
  const stayed = typeof d.stayedMin === "number" ? (d.stayedMin < 1 ? t("lessThanMinute") : formatDuration(d.stayedMin * 60)) : null;
  if (event.type === "stay_short" && stayed && d.minimumMin) return t("stayShort", { stayed, min: formatDuration(d.minimumMin * 60) });
  if (event.type === "stay_long" && stayed && d.maximumMin) return t("stayLong", { stayed, max: formatDuration(d.maximumMin * 60) });
  if (d.bySchedule) return t("bySchedule");
  if (stayed && event.type !== "stay_short") return t("stayed", { stayed });
  return null;
}
