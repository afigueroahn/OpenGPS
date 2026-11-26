// Alerts that arrive live, shown over the screens for a few seconds. Only the
// events that ask for attention are alerts: the same ones the web app shows
// as notifications (ALERT_EVENTS).
import { ALERT_EVENTS, type VehicleEvent } from "@opengps/shared";
import { useSyncExternalStore } from "react";

/** Alerts kept at once; older ones give way. */
export const ALERTS_KEPT = 3;
/** Seconds an alert stays on screen. */
export const ALERT_SECONDS = 8;

export const isAlert = (event: Pick<VehicleEvent, "type">) => ALERT_EVENTS.includes(event.type);

let alerts: VehicleEvent[] = [];
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** A new alert goes first; the same event is not shown twice. Events that are not alerts are left out. */
export function pushAlert(event: VehicleEvent): void {
  if (!isAlert(event)) return;
  alerts = [event, ...alerts.filter((a) => a.id !== event.id)].slice(0, ALERTS_KEPT);
  changed();
}

export function dismissAlert(id: number): void {
  alerts = alerts.filter((a) => a.id !== id);
  changed();
}

export function clearAlerts(): void {
  alerts = [];
  changed();
}

export const getAlerts = () => alerts;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useAlerts = () => useSyncExternalStore(subscribe, getAlerts);
