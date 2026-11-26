// Vehicle list filters: by name, plate or device, by status and by group.
// Same rules as the web app's list (apps/web/src/app/VehicleList.tsx).
import { type Vehicle, type VehicleGroup, type VehicleStatus, vehicleStatus } from "@opengps/shared";
import { withChildren } from "./groups";

export interface Filters {
  search: string;
  status: VehicleStatus | "all";
  /** A group's id, "all" or "none" (without a group). A group takes in those that hang from it. */
  group: string;
}

export const NO_FILTERS: Filters = { search: "", status: "all", group: "all" };

/** Statuses offered as a filter, in this order. */
export const FILTER_STATUSES: VehicleStatus[] = ["moving", "idle", "stopped", "offline", "pending", "no_device"];

export function applyFilters(vehicles: Vehicle[], filters: Filters, now: number, groups: VehicleGroup[] = []): Vehicle[] {
  const term = filters.search.trim().toLowerCase();
  const inGroup = filters.group === "all" || filters.group === "none" ? null : withChildren(groups, filters.group);
  return vehicles.filter((v) => {
    if (filters.status !== "all" && vehicleStatus(v, now) !== filters.status) return false;
    if (filters.group === "none" ? v.groupId !== null : inGroup !== null && (v.groupId === null || !inGroup.has(v.groupId))) return false;
    return term === "" || `${v.name} ${v.plate ?? ""} ${v.device?.uniqueId ?? ""}`.toLowerCase().includes(term);
  });
}

/** How many vehicles are in each status. */
export function countByStatus(vehicles: Vehicle[], now: number): Map<VehicleStatus, number> {
  const counts = new Map<VehicleStatus, number>();
  for (const v of vehicles) {
    const status = vehicleStatus(v, now);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return counts;
}
