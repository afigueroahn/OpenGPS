// Color mode of the interface: the device's, or one the person chooses. The
// choice is kept in this browser, so the first paint is already right
// (public/theme.js applies it), and in the person's settings, so it follows
// them to another device.
import type { ThemeMode } from "@opengps/shared";
import { useSyncExternalStore } from "react";

const KEY = "theme";
const listeners = new Set<() => void>();
const deviceDark = () => window.matchMedia("(prefers-color-scheme: dark)");

/** What this browser has chosen; "system" when it has chosen nothing. */
export function storedMode(): ThemeMode {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(mode: ThemeMode): void {
  const dark = mode === "dark" || (mode === "system" && deviceDark().matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  for (const listener of listeners) listener();
}

export function setMode(mode: ThemeMode): void {
  try {
    if (mode === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    // Without storage the choice lasts until the page is closed.
  }
  apply(mode);
}

/** Takes the mode saved in the person's settings when this browser has none of its own. */
export function adoptMode(saved: ThemeMode): void {
  if (saved !== "system" && storedMode() === "system") setMode(saved);
}

// While the choice is "system", the device switching between light and dark is followed.
deviceDark().addEventListener("change", () => apply(storedMode()));

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => `${storedMode()}:${document.documentElement.dataset.theme ?? "light"}`;

/** The chosen mode and whether the interface is dark right now. */
export function useTheme(): { mode: ThemeMode; dark: boolean } {
  const [mode, theme] = useSyncExternalStore(subscribe, snapshot).split(":");
  return { mode: mode as ThemeMode, dark: theme === "dark" };
}
