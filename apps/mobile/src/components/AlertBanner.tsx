// The latest live alert, over the screens for a few seconds. A tap shows the
// vehicle on the map with its sheet.
import { useRouter } from "expo-router";
import { BellRing, X } from "lucide-react-native";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ALERT_SECONDS, dismissAlert, useAlerts } from "../lib/alerts";
import { timeAgo } from "../lib/format";
import { isSheetOpen, select } from "../lib/selection";
import { useNow } from "../lib/session";
import { FONT } from "../lib/theme";

export function AlertBanner() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const now = useNow(5000);
  const alert = useAlerts()[0];

  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => dismissAlert(alert.id), ALERT_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [alert]);

  if (!alert) return null;
  const place = alert.geofenceName ?? (alert.type === "custom" ? alert.ruleName : null);
  const open = () => {
    dismissAlert(alert.id);
    select(alert.vehicleId);
    router.navigate("/");
    if (!isSheetOpen()) router.push("/vehicle");
  };

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 52 }]}>
      <Pressable accessibilityRole="alert" onPress={open} style={styles.card} testID="alert-banner">
        <BellRing color="#ffffff" size={20} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {alert.vehicleName} · {t(`shared.event.${alert.type}`)}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {[place, timeAgo(alert.at, now)].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={t("events.dismiss")} hitSlop={12} onPress={() => dismissAlert(alert.id)}>
          <X color="rgba(255,255,255,0.85)" size={18} />
        </Pressable>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 12, right: 12 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "#cf3a32",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  text: { flex: 1, gap: 2 },
  title: { fontFamily: FONT.semibold, fontSize: 15, color: "#ffffff" },
  sub: { fontFamily: FONT.regular, fontSize: 13, color: "rgba(255,255,255,0.85)" },
});
