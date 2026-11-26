import type { Vehicle, VehicleGroup } from "@opengps/shared";
import { describe, expect, it } from "vitest";
import { applyFilters, NO_FILTERS } from "./filters";
import { groupTree, indented, withChildren } from "./groups";

const group = (id: string, name: string, parentId: string | null, vehicleCount: number): VehicleGroup => ({ id, name, parentId, vehicleCount });
// Norte, with its subgroup Ruta 1; Sur on its own; and Bodega, whose parent the person cannot see.
const groups = [group("norte", "Norte", null, 1), group("sur", "Sur", null, 2), group("ruta1", "Ruta 1", "norte", 3), group("bodega", "Bodega", "oculto", 1)];

const NOW = Date.parse("2026-11-26T12:00:00Z");
const vehicle = (id: string, groupId: string | null): Vehicle => ({
  id,
  name: id,
  plate: null,
  createdAt: new Date(NOW).toISOString(),
  groupId,
  parkedSince: null,
  device: null,
  state: null,
});
const fleet = [vehicle("a", "norte"), vehicle("b", "ruta1"), vehicle("c", "sur"), vehicle("d", null)];

describe("the group tree", () => {
  it("puts each group before those that hang from it, and counts their vehicles in the parent", () => {
    const tree = groupTree(groups);
    expect(tree.map((g) => g.id)).toEqual(["norte", "ruta1", "sur", "bodega"]);
    expect(tree.find((g) => g.id === "norte")).toMatchObject({ depth: 0, total: 4 });
    expect(indented(tree.find((g) => g.id === "ruta1") as (typeof tree)[number])).toBe("   └ Ruta 1");
  });

  it("shows at the top a group whose parent the person cannot see", () => {
    expect(groupTree(groups).find((g) => g.id === "bodega")).toMatchObject({ depth: 0, total: 1 });
  });

  it("a group takes in its subgroups", () => {
    expect([...withChildren(groups, "norte")].sort()).toEqual(["norte", "ruta1"]);
  });
});

describe("filtering the list by group", () => {
  const ids = (filters: typeof NO_FILTERS) => applyFilters(fleet, filters, NOW, groups).map((v) => v.id);

  it("a group shows its vehicles and those of its subgroups", () => {
    expect(ids({ ...NO_FILTERS, group: "norte" })).toEqual(["a", "b"]);
    expect(ids({ ...NO_FILTERS, group: "ruta1" })).toEqual(["b"]);
  });

  it("«Sin grupo» shows only those without a group, and «Todos» all of them", () => {
    expect(ids({ ...NO_FILTERS, group: "none" })).toEqual(["d"]);
    expect(ids(NO_FILTERS)).toEqual(["a", "b", "c", "d"]);
  });

  it("goes together with the search", () => {
    expect(ids({ ...NO_FILTERS, group: "norte", search: "b" })).toEqual(["b"]);
  });
});
