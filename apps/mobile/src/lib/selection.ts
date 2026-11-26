// The vehicle chosen on the map or in the list. The map, the list and the
// detail sheet read it from here, so a tap anywhere updates all three.
import { useSyncExternalStore } from "react";

let selected: string | null = null;
const listeners = new Set<() => void>();

export const getSelected = () => selected;

export function select(id: string | null): void {
  if (id === selected) return;
  selected = id;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useSelected = () => useSyncExternalStore(subscribe, getSelected);

/** Whether the vehicle sheet is open: a tap on the map then only changes the vehicle it shows. */
let sheetOpen = false;
export const isSheetOpen = () => sheetOpen;
export const setSheetOpen = (open: boolean) => {
  sheetOpen = open;
};
