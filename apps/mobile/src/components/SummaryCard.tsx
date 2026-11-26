// The account at a glance: its vehicles and how many report now, the events
// of the last day and its people. Same numbers as the web console's overview.
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { getAccountSummary } from "../lib/api";
import { formatCount } from "../lib/format";
import { FONT, RADIUS, useTheme } from "../lib/theme";

export function SummaryCard() {
  const { t } = useTranslation();
  const theme = useTheme();
  const summary = useQuery({ queryKey: ["account", "summary"], queryFn: getAccountSummary, refetchInterval: 60_000 });
  const s = summary.data;
  const tiles = [
    { label: t("summary.vehicles"), value: s?.vehicles, note: s ? t("summary.reporting", { count: s.reportingNow }) : " ", id: "vehicles" },
    { label: t("summary.events"), value: s?.events24h, note: t("summary.eventsNote"), id: "events" },
    { label: t("summary.users"), value: s?.users, note: t("summary.usersNote"), id: "users" },
  ];
  return (
    <View style={styles.row} testID="account-summary">
      {tiles.map((tile) => (
        <View key={tile.id} style={[styles.tile, { backgroundColor: theme.surface, borderColor: theme.line }]} testID={`summary-${tile.id}`}>
          <Text style={[styles.label, { color: theme.muted }]} numberOfLines={1}>
            {tile.label}
          </Text>
          <Text style={[styles.value, { color: theme.ink }]}>{tile.value === undefined ? "–" : formatCount(tile.value)}</Text>
          <Text style={[styles.note, { color: theme.faint }]} numberOfLines={2}>
            {tile.note}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  tile: { flex: 1, padding: 12, borderRadius: RADIUS, borderWidth: StyleSheet.hairlineWidth, gap: 2 },
  label: { fontFamily: FONT.medium, fontSize: 12 },
  value: { fontFamily: FONT.mono, fontSize: 24 },
  note: { fontFamily: FONT.regular, fontSize: 11, lineHeight: 14 },
});
