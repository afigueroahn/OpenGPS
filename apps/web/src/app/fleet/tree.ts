// The group tree: each group can hang from another.
import type { VehicleGroup } from "@opengps/shared";

export interface GroupNode extends VehicleGroup {
  depth: number;
  /** Vehicles of the group and of all those that hang from it. */
  total: number;
}

/** Groups in tree order: each one followed by those that hang from it. */
export function groupTree(groups: VehicleGroup[]): GroupNode[] {
  const known = new Set(groups.map((g) => g.id));
  const children = new Map<string | null, VehicleGroup[]>();
  for (const g of groups) {
    // A group whose parent is not visible (due to permissions) is shown as top level.
    const parent = g.parentId && known.has(g.parentId) ? g.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), g]);
  }
  const out: GroupNode[] = [];
  const walk = (parent: string | null, depth: number): number => {
    let sum = 0;
    for (const g of children.get(parent) ?? []) {
      const node: GroupNode = { ...g, depth, total: g.vehicleCount };
      out.push(node);
      node.total += walk(g.id, depth + 1);
      sum += node.total;
    }
    return sum;
  };
  walk(null, 0);
  return out;
}

/** The group and all those that hang from it. */
export function withChildren(groups: VehicleGroup[], id: string): Set<string> {
  const found = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (g.parentId && found.has(g.parentId) && !found.has(g.id)) {
        found.add(g.id);
        grew = true;
      }
    }
  }
  return found;
}

/** Name with indentation, for a dropdown. */
export const indented = (node: GroupNode) => `${"   ".repeat(node.depth)}${node.depth > 0 ? "└ " : ""}${node.name}`;
