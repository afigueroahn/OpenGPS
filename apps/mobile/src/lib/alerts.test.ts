import type { EventType, VehicleEvent } from "@opengps/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ALERTS_KEPT, clearAlerts, dismissAlert, getAlerts, pushAlert } from "./alerts";

const event = (id: number, type: EventType): VehicleEvent => ({
  id,
  type,
  at: "2026-11-26T12:00:00.000Z",
  vehicleId: "v1",
  vehicleName: "Camión 01",
  geofenceId: null,
  geofenceName: null,
  ruleName: null,
  lat: 14.1,
  lon: -87.2,
  speedKmh: 90,
  detail: {},
});

describe("the live alerts", () => {
  beforeEach(() => clearAlerts());

  it("shows only the events that ask for attention", () => {
    pushAlert(event(1, "geofence_enter"));
    pushAlert(event(2, "speeding"));
    expect(getAlerts().map((a) => a.id)).toEqual([2]);
  });

  it("puts the newest first and does not repeat an event", () => {
    pushAlert(event(1, "sos"));
    pushAlert(event(2, "speeding"));
    pushAlert(event(1, "sos"));
    expect(getAlerts().map((a) => a.id)).toEqual([1, 2]);
  });

  it(`keeps only the latest ${ALERTS_KEPT}`, () => {
    for (let id = 1; id <= ALERTS_KEPT + 2; id++) pushAlert(event(id, "speeding"));
    expect(getAlerts()).toHaveLength(ALERTS_KEPT);
    expect(getAlerts()[0]?.id).toBe(ALERTS_KEPT + 2);
  });

  it("forgets one when the person closes it", () => {
    pushAlert(event(1, "sos"));
    pushAlert(event(2, "tow"));
    dismissAlert(2);
    expect(getAlerts().map((a) => a.id)).toEqual([1]);
  });
});
