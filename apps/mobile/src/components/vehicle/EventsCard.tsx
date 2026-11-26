// The vehicle's latest events: what happened, where and how long ago. Those
// that ask for attention are marked; a new one arrives live and the list is
// asked again (apps/mobile/src/lib/live.ts).
import type { Vehicle } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { isAlert } from "../../lib/alerts";
import { getEvents } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { FONT, useTheme } from "../../lib/theme";
import { Card, StatusDot } from "../ui";

/** Events shown in the sheet. */
const EVENTS_SHOWN = 5;

export function EventsCard(props: { vehicle: Vehicle; now: number }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const events = useQuery({ queryKey: ["events", props.vehicle.id], queryFn: () => getEvents(props.vehicle.id, EVENTS_SHOWN), refetchInterval: 60_000 });
  if (!events.isSuccess) return null;

  return (
    <Card style={styles.card}>
      <Text style={[styles.title, { color: theme.ink }]}>{t("events.title")}</Text>
      {events.data.length === 0 ? <Text style={[styles.sub, { color: theme.muted }]}>{t("events.none")}</Text> : null}
      {events.data.map((event, i) => {
        const place = event.geofenceName ?? (event.type === "custom" ? event.ruleName : null);
        return (
          <View key={event.id} style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]} testID={`event-${event.id}`}>
            <StatusDot color={isAlert(event) ? theme.danger : theme.faint} size={8} />
            <View style={styles.text}>
              <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
                {t(`shared.event.${event.type}`)}
                {place ? `: ${place}` : ""}
              </Text>
              <Text style={[styles.sub, { color: theme.muted }]}>{timeAgo(event.at, props.now)}</Text>
            </View>
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 14, gap: 6 },
  title: { fontFamily: FONT.semibold, fontSize: 16, marginBottom: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  text: { flex: 1, gap: 2 },
  name: { fontFamily: FONT.medium, fontSize: 14 },
  sub: { fontFamily: FONT.regular, fontSize: 13 },
});
