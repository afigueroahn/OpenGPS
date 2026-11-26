// Whether the live channel is connected, shown on the map.
import { createContext, use } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type { LiveStatus } from "../lib/live";
import { FONT } from "../lib/theme";

export const LiveContext = createContext<LiveStatus>("connecting");
export const useLiveStatus = () => use(LiveContext);

export function LiveBadge() {
  const { t } = useTranslation();
  const status = useLiveStatus();
  const online = status === "online";
  return (
    <View testID="live-badge" accessibilityRole="text" style={[styles.badge, { backgroundColor: online ? "rgba(16,22,35,0.88)" : "rgba(207,58,50,0.92)" }]}>
      <View style={[styles.dot, { backgroundColor: online ? "#3ddc97" : "#ffffff" }]} />
      <Text style={styles.text}>{online ? t("live.online") : t("live.offline")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, height: 32, borderRadius: 16 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { fontFamily: FONT.semibold, fontSize: 13, color: "#ffffff" },
});
