// What the app remembers between launches, in the Keychain: the platform, the
// session cookie and the person's preferences.
import { type Language, LANGUAGES, type ThemeMode } from "@opengps/shared";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

export interface Saved {
  /** Platform address, "https://demo.com"; null until the person types it. */
  server: string | null;
  /** Cookie header with the session; empty without a session. */
  cookie: string;
  theme: ThemeMode;
  /** null = the device's. */
  language: Language | null;
}

const THEMES: readonly ThemeMode[] = ["system", "light", "dark"];

function read(key: keyof Saved): string | null {
  try {
    return SecureStore.getItem(key);
  } catch {
    return null;
  }
}

function load(): Saved {
  const theme = read("theme");
  const language = read("language");
  return {
    server: read("server"),
    cookie: read("cookie") ?? "",
    theme: THEMES.find((t) => t === theme) ?? "system",
    language: LANGUAGES.find((l) => l === language) ?? null,
  };
}

let state: Saved = load();
const listeners = new Set<() => void>();

export const getSaved = (): Saved => state;

/** Changes what is remembered and tells the screens. */
export function save(patch: Partial<Saved>): void {
  const next = { ...state, ...patch };
  for (const key of Object.keys(patch) as (keyof Saved)[]) {
    const value = next[key];
    if (value === state[key]) continue;
    if (value === null || value === "") void SecureStore.deleteItemAsync(key);
    else void SecureStore.setItemAsync(key, value);
  }
  state = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A value of what is remembered; the screen repaints when it changes. Select a single value, not an object. */
export function useSaved<T>(select: (saved: Saved) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}
