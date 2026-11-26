// What the history says in words: the totals of the period (or of one trip),
// and its trips and stops with where each one happened.
import type { HistorySummary, Stop, Trip } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { geocodePoint } from "../../lib/api";
import { formatClock, formatCoords, formatDay, formatDuration, formatKm } from "../../lib/format";
import { useConfig } from "../../lib/session";
import { FONT, RADIUS, useTheme } from "../../lib/theme";
import { COLOR_START } from "../../map/HistoryMap";
import { Card } from "../ui";

export function SummaryBlock(props: { summary: HistorySummary; trip: Trip | null; onWhole: () => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { summary, trip } = props;
  const stats: [string, string][] = trip
    ? [
        [t("history.summary.duration"), formatDuration(trip.durationS)],
        [t("history.summary.idle"), formatDuration(trip.idleS)],
        [t("history.summary.maxSpeed"), `${trip.maxSpeedKmh} km/h`],
        [t("history.summary.avgSpeed"), `${trip.avgSpeedKmh} km/h`],
      ]
    : [
        [t("history.summary.moving"), formatDuration(summary.movingS)],
        [t("history.summary.stopped"), formatDuration(summary.stoppedS)],
        [t("history.summary.idle"), formatDuration(summary.idleS)],
        [t("history.summary.engineOn"), formatDuration(summary.movingS + summary.idleS)],
        [t("history.summary.maxSpeed"), `${summary.maxSpeedKmh} km/h`],
        [t("history.summary.avgSpeed"), `${summary.avgSpeedKmh} km/h`],
      ];
  return (
    <Card style={styles.summary}>
      <View style={styles.distanceRow}>
        <Text style={[styles.distance, { color: theme.ink }]} testID="history-distance">
          {formatKm(trip ? trip.distanceM : summary.distanceM)} <Text style={[styles.km, { color: theme.muted }]}>km</Text>
        </Text>
        {trip ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("history.summary.wholePeriod")}
            onPress={props.onWhole}
            style={[styles.tripChip, { backgroundColor: theme.canvas, borderColor: theme.line }]}
            testID="history-whole"
          >
            <Text style={[styles.tripChipText, { color: theme.ink }]}>{t("history.summary.tripAt", { time: formatClock(Date.parse(trip.start)) })}</Text>
            <X color={theme.muted} size={14} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.grid}>
        {stats.map(([label, value]) => (
          <View key={label} style={styles.stat}>
            <Text style={[styles.statLabel, { color: theme.muted }]}>{label}</Text>
            <Text style={[styles.statValue, { color: theme.ink }]}>{value}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

/** Rows that look up their address; the rest show their coordinates, so the slow service is not flooded. */
const PLACES_LOOKED_UP = 12;

/** Where something happened: its address when the platform knows or finds it, if not its coordinates. */
function Place(props: { lat: number; lon: number; known: string | null; lookUp: boolean }) {
  const theme = useTheme();
  const geocoding = useConfig().data?.geocoding ?? false;
  const place = useQuery({
    queryKey: ["place", props.lat.toFixed(4), props.lon.toFixed(4)],
    queryFn: () => geocodePoint(props.lat, props.lon),
    enabled: geocoding && props.known === null && props.lookUp,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return (
    <Text style={[styles.place, { color: theme.muted }]} numberOfLines={1}>
      {props.known ?? place.data ?? formatCoords(props.lat, props.lon)}
    </Text>
  );
}

const clock = (iso: string) => formatClock(Date.parse(iso));

export function TripList(props: { trips: Trip[]; focus: number | null; onFocus: (index: number | null) => void; severalDays: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (props.trips.length === 0) return <Text style={[styles.empty, { color: theme.muted }]}>{t("history.trips.empty")}</Text>;
  return (
    <View style={styles.list}>
      {props.trips.map((trip, i) => {
        const on = props.focus === i;
        return (
          <Pressable
            key={trip.start}
            testID={`trip-${i}`}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => props.onFocus(on ? null : i)}
            style={[styles.row, { backgroundColor: theme.surface, borderColor: on ? theme.signalInk : theme.line, borderWidth: on ? 2 : StyleSheet.hairlineWidth }]}
          >
            <View style={styles.rowHead}>
              <Text style={[styles.rowTitle, { color: theme.ink }]}>
                {props.severalDays ? `${formatDay(Date.parse(trip.start))} · ` : ""}
                {clock(trip.start)} – {clock(trip.end)}
              </Text>
              <Text style={[styles.rowValue, { color: theme.ink }]}>{formatKm(trip.distanceM)} km</Text>
            </View>
            <Text style={[styles.rowSub, { color: theme.muted }]}>
              {[formatDuration(trip.durationS), t("history.trips.max", { speed: trip.maxSpeedKmh }), trip.idleS >= 60 ? t("history.trips.idle", { time: formatDuration(trip.idleS) }) : null]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <View style={styles.ends}>
              <View style={styles.endRow}>
                <View style={[styles.startDot, { backgroundColor: COLOR_START }]} />
                <Place lat={trip.startLat} lon={trip.startLon} known={trip.startAddress} lookUp={i < PLACES_LOOKED_UP} />
              </View>
              <View style={styles.endRow}>
                <View style={[styles.endSquare, { borderColor: theme.ink }]} />
                <Place lat={trip.endLat} lon={trip.endLon} known={trip.endAddress} lookUp={i < PLACES_LOOKED_UP} />
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function StopList(props: { stops: Stop[]; onPick: (stop: Stop) => void; severalDays: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (props.stops.length === 0) return <Text style={[styles.empty, { color: theme.muted }]}>{t("history.stops.empty")}</Text>;
  return (
    <View style={styles.list}>
      {props.stops.map((stop, i) => (
        <Pressable
          key={stop.start}
          testID={`stop-${i}`}
          accessibilityRole="button"
          onPress={() => props.onPick(stop)}
          style={[styles.row, styles.stopRow, { backgroundColor: theme.surface, borderColor: theme.line }]}
        >
          <View style={[styles.number, { borderColor: theme.ink }]}>
            <Text style={[styles.numberText, { color: theme.ink }]}>{i + 1}</Text>
          </View>
          <View style={styles.stopMain}>
            <Text style={[styles.rowTitle, { color: theme.ink }]}>
              {props.severalDays ? `${formatDay(Date.parse(stop.start))} · ` : ""}
              {clock(stop.start)} – {clock(stop.end)} · {formatDuration(stop.durationS)}
            </Text>
            {stop.idleS >= 60 ? <Text style={[styles.rowSub, { color: theme.muted }]}>{t("history.stops.engineOn", { time: formatDuration(stop.idleS) })}</Text> : null}
            <Place lat={stop.lat} lon={stop.lon} known={stop.address} lookUp={i < PLACES_LOOKED_UP} />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { paddingVertical: 14, gap: 12 },
  distanceRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  distance: { fontFamily: FONT.mono, fontSize: 30 },
  km: { fontFamily: FONT.regular, fontSize: 16 },
  tripChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 30, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth },
  tripChipText: { fontFamily: FONT.medium, fontSize: 13 },
  grid: { flexDirection: "row", flexWrap: "wrap", rowGap: 10 },
  stat: { width: "50%", gap: 2 },
  statLabel: { fontFamily: FONT.regular, fontSize: 12 },
  statValue: { fontFamily: FONT.mono, fontSize: 15 },
  empty: { fontFamily: FONT.regular, fontSize: 14, lineHeight: 20, paddingVertical: 12 },
  list: { gap: 8 },
  row: { padding: 14, borderRadius: RADIUS, gap: 4 },
  rowHead: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  rowTitle: { fontFamily: FONT.semibold, fontSize: 15 },
  rowValue: { fontFamily: FONT.mono, fontSize: 14 },
  rowSub: { fontFamily: FONT.regular, fontSize: 13 },
  ends: { gap: 4, marginTop: 4 },
  endRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  startDot: { width: 9, height: 9, borderRadius: 5 },
  endSquare: { width: 9, height: 9, borderWidth: 2, backgroundColor: "#ffffff" },
  place: { flex: 1, fontFamily: FONT.regular, fontSize: 13 },
  stopRow: { flexDirection: "row", gap: 12, borderWidth: StyleSheet.hairlineWidth },
  number: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  numberText: { fontFamily: FONT.bold, fontSize: 12 },
  stopMain: { flex: 1, gap: 3 },
});
