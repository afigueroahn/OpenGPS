// Brand colors and type, the same as the web app's (apps/web/src/styles.css),
// in a light and a dark palette.
import type { VehicleStatus } from "@opengps/shared";
import { Platform, type StatusBarStyle, useColorScheme } from "react-native";
import { useSaved } from "./storage";

export interface Palette {
  dark: boolean;
  ink: string;
  ink2: string;
  ink3: string;
  muted: string;
  faint: string;
  line: string;
  canvas: string;
  surface: string;
  signal: string;
  signalInk: string;
  danger: string;
  /** What needs a look without being an alarm: a key nobody has, a handled incident. Same as the web's "apricot". */
  warning: string;
  /** Buttons and selected items: dark on light, light on dark. */
  primary: string;
  onPrimary: string;
  /** Always dark, in both modes: the sign-in screens. */
  panel: string;
  panel2: string;
  panel3: string;
  status: Record<VehicleStatus, string>;
}

const LIGHT: Palette = {
  dark: false,
  ink: "#101623",
  ink2: "#1a2233",
  ink3: "#283248",
  muted: "#667186",
  faint: "#98a2b3",
  line: "#e2e6ee",
  canvas: "#f4f6fa",
  surface: "#ffffff",
  signal: "#3ddc97",
  signalInk: "#0c7a4d",
  danger: "#cf3a32",
  warning: "#a85a00",
  primary: "#101623",
  onPrimary: "#ffffff",
  panel: "#101623",
  panel2: "#1a2233",
  panel3: "#283248",
  status: { moving: "#12a065", idle: "#d08700", stopped: "#3f7fd1", offline: "#8a94a6", pending: "#7c6cf0", no_device: "#8a94a6" },
};

const DARK: Palette = {
  dark: true,
  ink: "#e9edf5",
  ink2: "#d4dae6",
  ink3: "#b4bdce",
  muted: "#8d99ae",
  faint: "#6c788e",
  line: "#263044",
  canvas: "#0b0f17",
  surface: "#131a28",
  signal: "#3ddc97",
  signalInk: "#3ddc97",
  danger: "#ff6f66",
  warning: "#ffb86b",
  primary: "#e9edf5",
  onPrimary: "#101623",
  panel: "#101623",
  panel2: "#1a2233",
  panel3: "#283248",
  status: { moving: "#2fc98a", idle: "#f0b429", stopped: "#6aa5f0", offline: "#9aa5b8", pending: "#a79bff", no_device: "#9aa5b8" },
};

export const RADIUS = 14;

/** Instrument Sans for text, JetBrains Mono for numbers (the names expo-font registers). */
export const FONT = {
  regular: "InstrumentSans_400Regular",
  medium: "InstrumentSans_500Medium",
  semibold: "InstrumentSans_600SemiBold",
  bold: "InstrumentSans_700Bold",
  mono: "JetBrainsMono_500Medium",
} as const;

/** The palette in use: the one the person chose, or the device's. */
export function useTheme(): Palette {
  const mode = useSaved((s) => s.theme);
  const system = useColorScheme();
  const dark = mode === "dark" || (mode === "system" && system === "dark");
  return dark ? DARK : LIGHT;
}

/** The status bar over the app's own screens. iOS's "default" follows the theme; Android's is always light icons. */
export const barStyleFor = (theme: Palette): StatusBarStyle => (Platform.OS === "ios" ? "default" : theme.dark ? "light-content" : "dark-content");
