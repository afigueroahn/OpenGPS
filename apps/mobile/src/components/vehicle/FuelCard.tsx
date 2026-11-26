// Fuel (module F): how much the tank holds now, as the web app's card shows
// it (apps/web/src/app/fuel/FuelCard.tsx). The tank is set up on the web.
import type { Vehicle } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { Fuel } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { getFuel } from "../../lib/api";
import { decimalMark, timeAgo } from "../../lib/format";
import { useCan } from "../../lib/session";
import { FONT, useTheme } from "../../lib/theme";
import { Card } from "../ui";

/** At or below this share of the tank the bar turns red. */
const LOW_PERCENT = 15;

export function FuelCard(props: { vehicle: Vehicle; now: number }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const canManage = useCan("vehicles.manage");
  const fuel = useQuery({ queryKey: ["fuel", props.vehicle.id], queryFn: () => getFuel(props.vehicle.id), refetchInterval: 60_000 });
  const f = fuel.data;
  if (!f || (!f.tank && !canManage)) return null;

  if (f.level && f.tank) {
    const low = f.level.percent <= LOW_PERCENT;
    return (
      <Card style={styles.card}>
        <View style={styles.head}>
          <Fuel color={low ? theme.danger : theme.signalInk} size={20} />
          <Text style={[styles.level, { color: theme.ink }]} testID="fuel-level">
            {t("fuel.level", { liters: decimalMark(f.level.liters.toFixed(1)) })} · {f.level.percent} %
          </Text>
        </View>
        <View
          style={[styles.track, { backgroundColor: theme.line }]}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: f.level.percent }}
        >
          <View style={[styles.bar, { width: `${Math.max(2, Math.min(100, f.level.percent))}%`, backgroundColor: low ? theme.danger : theme.signal }]} />
        </View>
        <Text style={[styles.note, { color: theme.muted }]}>
          {t("fuel.tank", { capacity: decimalMark(f.tank.capacityL), when: timeAgo(f.level.at, props.now) })}
        </Text>
      </Card>
    );
  }

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Fuel color={theme.muted} size={20} />
        <Text style={[styles.title, { color: theme.ink }]}>{t("fuel.title")}</Text>
      </View>
      <Text style={[styles.note, { color: theme.muted }]}>{!f.tank ? t("fuel.noTank") : f.tank.attr ? t("fuel.noLevel") : t("fuel.noSensor")}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 14, gap: 10 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontFamily: FONT.semibold, fontSize: 16 },
  level: { fontFamily: FONT.semibold, fontSize: 16 },
  track: { height: 8, borderRadius: 4, overflow: "hidden" },
  bar: { height: 8, borderRadius: 4 },
  note: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
});
