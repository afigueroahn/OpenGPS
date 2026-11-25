// How an event is told: its own data in words, its text for a message and its
// shape as data for another system. Who receives it is decided by the
// account's notifications.
import { type Language, SUBJECT_EVENTS, type VehicleEvent } from "@opengps/shared";
import { tr } from "../i18n";
import { decimalMark, duration } from "./export/format";

/** An event's own data, without its title, in a language: speed and limit, how long it lasted, how far it moved away. */
export function eventFacts(event: Pick<VehicleEvent, "type" | "detail">, language: Language): string[] {
  const d = event.detail as {
    stayedMin?: number;
    minimumMin?: number;
    maximumMin?: number;
    speedKmh?: number;
    limitKmh?: number;
    silentMin?: number;
    meters?: number;
    liters?: number;
    code?: string;
    description?: string;
    rpm?: number;
    tempC?: number;
    volts?: number;
    limit?: number;
    subject?: string;
    reason?: string;
  };
  const comma = (n: number) => decimalMark(language, n);
  const liters = d.liters === undefined ? "" : decimalMark(language, d.liters);
  const parts: string[] = [];
  if (event.type === "speeding" && d.speedKmh && d.limitKmh) parts.push(tr(language, "mail.facts.speeding", { speed: d.speedKmh, limit: d.limitKmh }));
  if (event.type === "stay_short" && d.stayedMin !== undefined && d.minimumMin) parts.push(tr(language, "mail.facts.stayShort", { stayed: duration(d.stayedMin * 60), minimum: duration(d.minimumMin * 60) }));
  if (event.type === "stay_long" && d.stayedMin !== undefined && d.maximumMin) parts.push(tr(language, "mail.facts.stayLong", { stayed: duration(d.stayedMin * 60), maximum: duration(d.maximumMin * 60) }));
  if (event.type === "signal_lost" && d.silentMin) parts.push(tr(language, "mail.facts.signalLost", { silent: duration(d.silentMin * 60) }));
  if (event.type === "route_deviation" && d.meters) parts.push(tr(language, "mail.facts.routeDeviation", { meters: d.meters }));
  if (event.type === "unauthorized_movement" && d.meters) parts.push(tr(language, "mail.facts.unauthorizedMovement", { meters: d.meters }));
  if (event.type === "tow" && d.speedKmh) parts.push(tr(language, "mail.facts.tow", { speed: d.speedKmh }));
  if (event.type === "fuel_theft" && liters) parts.push(tr(language, "mail.facts.fuelTheft", { liters }));
  if (event.type === "fuel_drain" && liters) parts.push(tr(language, "mail.facts.fuelDrain", { liters }));
  if (event.type === "fuel_refuel" && liters) parts.push(tr(language, "mail.facts.fuelRefuel", { liters }));
  if ((event.type === "engine_fault" || event.type === "engine_fault_cleared") && d.code) parts.push(`${d.code}: ${d.description ?? tr(language, "mail.facts.noDescription")}`);
  if (event.type === "engine_overrev" && d.rpm && d.limit) parts.push(tr(language, "mail.facts.engineOverrev", { rpm: d.rpm, limit: d.limit }));
  if (event.type === "engine_overheat" && d.tempC && d.limit) parts.push(tr(language, "mail.facts.engineOverheat", { temp: comma(d.tempC), limit: comma(d.limit) }));
  if (event.type === "battery_low" && d.volts && d.limit) parts.push(tr(language, "mail.facts.batteryLow", { volts: comma(d.volts), limit: comma(d.limit) }));
  if (SUBJECT_EVENTS.includes(event.type) && d.subject) parts.push(d.reason ? `${d.subject}: ${d.reason}` : d.subject);
  return parts;
}

/** Notification text, in a language: what happened, where and with what data. */
export function describeEvent(event: VehicleEvent, language: Language): string {
  const label = tr(language, `shared.event.${event.type}`);
  const title = event.geofenceName ? `${label}: ${event.geofenceName}` : label;
  return [title, ...eventFacts(event, language)].join(". ");
}

/** An event as another system receives it. Its `label` and `summary` are written in `language`. */
export function eventPayload(event: VehicleEvent, language: Language): Record<string, unknown> {
  return {
    type: event.type,
    label: tr(language, `shared.event.${event.type}`),
    createdAt: event.at,
    event: {
      id: event.id,
      at: event.at,
      vehicleId: event.vehicleId,
      vehicleName: event.vehicleName,
      geofenceName: event.geofenceName,
      ruleName: event.ruleName,
      lat: event.lat,
      lon: event.lon,
      speedKmh: event.speedKmh,
      // The same as a notification says in words: "was going 112 km/h with a limit of 90 km/h".
      summary: eventFacts(event, language).join("; ") || null,
      detail: event.detail,
    },
  };
}
