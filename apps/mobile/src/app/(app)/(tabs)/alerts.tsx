// Every event of the account, the most recent first, a page at a time: what
// happened, to which vehicle, where and when. "Solo avisos" keeps the ones
// that ask for attention. Same rules as the web app's (Events.tsx).
import type { VehicleEvent } from "@opengps/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Button, Centered, Segmented, StatusDot, text } from "../../../components/ui";
import { isAlert } from "../../../lib/alerts";
import { EVENTS_PAGE, getEventsPage } from "../../../lib/api";
import { eventNote } from "../../../lib/eventNote";
import { formatDateTime } from "../../../lib/format";
import { isSheetOpen, select } from "../../../lib/selection";
import { FONT, RADIUS, useTheme } from "../../../lib/theme";

type Filter = "all" | "alerts";

export default function AlertsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [pulling, setPulling] = useState(false);
  const alertsOnly = filter === "alerts";

  const events = useInfiniteQuery({
    queryKey: ["events", "feed", alertsOnly],
    queryFn: ({ pageParam }) => getEventsPage({ before: pageParam, alerts: alertsOnly }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === EVENTS_PAGE ? last[last.length - 1]?.id : undefined),
  });
  const list = events.data?.pages.flat() ?? [];

  const pull = async () => {
    setPulling(true);
    await events.refetch();
    setPulling(false);
  };
  const show = (event: VehicleEvent) => {
    select(event.vehicleId);
    router.navigate("/");
    if (!isSheetOpen()) router.push("/vehicle");
  };

  return (
    <FlatList
      testID="alerts-list"
      data={list}
      keyExtractor={(e) => String(e.id)}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void pull()} tintColor={theme.muted} />}
      stickyHeaderIndices={[0]}
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (events.hasNextPage && !events.isFetchingNextPage) void events.fetchNextPage();
      }}
      ListHeaderComponent={
        <View style={[styles.header, { backgroundColor: theme.canvas }]}>
          <Segmented
            testID="alerts-filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: t("feed.all") },
              { value: "alerts", label: t("feed.alertsOnly") },
            ]}
          />
        </View>
      }
      ListEmptyComponent={
        events.isPending ? (
          <ActivityIndicator style={styles.loading} color={theme.muted} />
        ) : events.isError ? (
          <Centered>
            <Text style={text(theme).body}>{t("feed.failed")}</Text>
            <Button kind="secondary" label={t("errors.retry")} onPress={() => void events.refetch()} />
          </Centered>
        ) : (
          <Text style={[text(theme).body, styles.empty]}>{alertsOnly ? t("feed.noAlerts") : t("feed.empty")}</Text>
        )
      }
      ListFooterComponent={events.isFetchingNextPage ? <ActivityIndicator style={styles.loading} color={theme.muted} /> : null}
      renderItem={({ item }) => <EventRow event={item} onPress={() => show(item)} />}
    />
  );
}

function EventRow(props: { event: VehicleEvent; onPress: () => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { event } = props;
  const place = event.geofenceName ?? (event.type === "custom" ? event.ruleName : null);
  const note = eventNote(event);
  return (
    <Pressable
      testID={`feed-${event.id}`}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.dot}>
        <StatusDot color={isAlert(event) ? theme.danger : theme.faint} size={10} />
      </View>
      <View style={styles.main}>
        <Text style={[styles.title, { color: theme.ink }]} numberOfLines={2}>
          <Text style={styles.vehicle}>{event.vehicleName}</Text> · {t(`shared.event.${event.type}`)}
          {place ? `: ${place}` : ""}
        </Text>
        <Text style={[styles.sub, { color: theme.muted }]} numberOfLines={2}>
          {[formatDateTime(event.at), note].filter(Boolean).join(" · ")}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, paddingTop: 0, gap: 8 },
  header: { paddingTop: 8, paddingBottom: 4 },
  loading: { marginVertical: 24 },
  empty: { textAlign: "center", marginTop: 32, paddingHorizontal: 16 },
  row: { flexDirection: "row", gap: 12, padding: 14, borderRadius: RADIUS, borderWidth: StyleSheet.hairlineWidth },
  dot: { paddingTop: 5 },
  main: { flex: 1, gap: 3 },
  title: { fontFamily: FONT.regular, fontSize: 15, lineHeight: 20 },
  vehicle: { fontFamily: FONT.semibold },
  sub: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
});
