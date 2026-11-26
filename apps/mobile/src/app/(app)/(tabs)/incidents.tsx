// Incidents (module A): a panic button, a tow, tampering with the device or a
// parked vehicle that moves, open or all of them. A tap opens its timeline.
// Same as the web app's console (IncidentsPanel.tsx).
import type { Incident } from "@opengps/shared";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Button, Centered, Segmented, text } from "../../../components/ui";
import { errorText } from "../../../lib/api";
import { timeAgo } from "../../../lib/format";
import { INCIDENT_ICON, statusColor, useIncidents } from "../../../lib/incidents";
import { useNow } from "../../../lib/session";
import { FONT, RADIUS, useTheme } from "../../../lib/theme";

export default function IncidentsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const now = useNow();
  const [openOnly, setOpenOnly] = useState(true);
  const incidents = useIncidents(openOnly);
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    setPulling(true);
    await incidents.refetch();
    setPulling(false);
  };

  return (
    <FlatList
      testID="incidents-list"
      data={incidents.data ?? []}
      keyExtractor={(i) => i.id}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.list}
      stickyHeaderIndices={[0]}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void pull()} tintColor={theme.muted} />}
      ListHeaderComponent={
        <View style={[styles.header, { backgroundColor: theme.canvas }]}>
          <Segmented
            testID="incidents-filter"
            value={openOnly ? "open" : "all"}
            onChange={(v) => setOpenOnly(v === "open")}
            options={[
              { value: "open", label: t("incidents.open") },
              { value: "all", label: t("incidents.all") },
            ]}
          />
        </View>
      }
      ListEmptyComponent={
        incidents.isPending ? (
          <ActivityIndicator style={styles.loading} color={theme.muted} />
        ) : incidents.isError ? (
          <Centered>
            <Text style={text(theme).body}>{errorText(incidents.error)}</Text>
            <Button kind="secondary" label={t("errors.retry")} onPress={() => void incidents.refetch()} />
          </Centered>
        ) : (
          <Text style={[text(theme).body, styles.empty]}>{openOnly ? t("incidents.emptyOpen") : t("incidents.emptyAll")}</Text>
        )
      }
      renderItem={({ item }) => <IncidentRow incident={item} now={now} onPress={() => router.push({ pathname: "/incident", params: { id: item.id } })} />}
    />
  );
}

function IncidentRow(props: { incident: Incident; now: number; onPress: () => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { incident } = props;
  const Icon = INCIDENT_ICON[incident.kind];
  const urgent = incident.status !== "closed" && incident.priority === 1;
  return (
    <Pressable
      testID={`incident-${incident.id}`}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[styles.icon, { backgroundColor: urgent ? theme.danger : theme.canvas }]}>
        <Icon color={urgent ? "#ffffff" : theme.signalInk} size={18} />
      </View>
      <View style={styles.main}>
        <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
          {incident.vehicleName}
        </Text>
        <Text style={[styles.sub, { color: theme.muted }]} numberOfLines={1}>
          {t(`shared.incidentKind.${incident.kind}`)} · {timeAgo(incident.openedAt, props.now)}
        </Text>
      </View>
      <Text style={[styles.status, { color: statusColor(incident.status, theme) }]}>{t(`shared.incidentStatus.${incident.status}`)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, paddingTop: 0, gap: 8 },
  header: { paddingTop: 8, paddingBottom: 4 },
  loading: { marginVertical: 24 },
  empty: { textAlign: "center", marginTop: 32, paddingHorizontal: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: RADIUS, borderWidth: StyleSheet.hairlineWidth },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  main: { flex: 1, gap: 2 },
  name: { fontFamily: FONT.semibold, fontSize: 16 },
  sub: { fontFamily: FONT.regular, fontSize: 13 },
  status: { fontFamily: FONT.semibold, fontSize: 13 },
});
