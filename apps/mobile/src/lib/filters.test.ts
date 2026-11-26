import type { Vehicle } from "@opengps/shared";
import { describe, expect, it } from "vitest";
import { applyFilters, countByStatus, NO_FILTERS } from "./filters";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function vehicle(id: string, name: string, plate: string | null, state: Partial<NonNullable<Vehicle["state"]>> | null, uniqueId = `dev-${id}`): Vehicle {
  return {
    id,
    name,
    plate,
    createdAt: ago(86_400_000),
    groupId: null,
    parkedSince: null,
    device: { uniqueId, modelId: "teltonika", modelName: null, status: "active", claimExpiresAt: null, confirmedAt: ago(86_400_000) },
    state:
      state === null
        ? null
        : {
            lastSeenAt: ago(10_000),
            fixTime: ago(10_000),
            lat: 14.1,
            lon: -87.2,
            altitude: null,
            speedKmh: 0,
            course: 0,
            accuracy: null,
            ignition: false,
            ignitionInferred: false,
            motion: false,
            powerVoltage: null,
            batteryVoltage: null,
            batteryLevel: null,
            satellites: null,
            signalBars: null,
            ...state,
          },
  };
}

const truck = vehicle("1", "Camión 1", "HAA-1234", { speedKmh: 60, motion: true });
const pickup = vehicle("2", "Pickup", "PCD-9876", { ignition: false });
const van = vehicle("3", "Van reparto", null, { ignition: true, motion: false, speedKmh: 0 }, "862011");
const all = [truck, pickup, van];

describe("the vehicle list filters", () => {
  it("shows everything without filters", () => {
    expect(applyFilters(all, NO_FILTERS, NOW)).toEqual(all);
  });

  it("finds by name, plate or device, without minding capitals or spaces", () => {
    expect(applyFilters(all, { ...NO_FILTERS, search: "  camión ", status: "all" }, NOW)).toEqual([truck]);
    expect(applyFilters(all, { ...NO_FILTERS, search: "pcd", status: "all" }, NOW)).toEqual([pickup]);
    expect(applyFilters(all, { ...NO_FILTERS, search: "8620", status: "all" }, NOW)).toEqual([van]);
  });

  it("filters by status", () => {
    expect(applyFilters(all, { ...NO_FILTERS, search: "", status: "moving" }, NOW)).toEqual([truck]);
    expect(applyFilters(all, { ...NO_FILTERS, search: "", status: "idle" }, NOW)).toEqual([van]);
    expect(applyFilters(all, { ...NO_FILTERS, search: "", status: "stopped" }, NOW)).toEqual([pickup]);
  });

  it("combines the search and the status", () => {
    expect(applyFilters(all, { ...NO_FILTERS, search: "pickup", status: "moving" }, NOW)).toEqual([]);
  });

  it("counts the vehicles in each status", () => {
    const counts = countByStatus(all, NOW);
    expect(counts.get("moving")).toBe(1);
    expect(counts.get("idle")).toBe(1);
    expect(counts.get("stopped")).toBe(1);
    expect(counts.get("offline")).toBeUndefined();
  });
});
