// A vehicle's trips and stops in a period: the route on the map, the totals,
// and a player that runs it back. A trip chosen in the list is shown alone;
// a stop chosen takes the map and the player there. Same rules as the web
// app's (apps/web/src/app/history/HistoryPanel.tsx).
import { EXPORT_FORMATS, type ExportFormat, HISTORY_MAX_POINTS, type HistoryPoint, type Stop } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { getCalendars } from "expo-localization";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronDown, Share2 } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Pressable, ScrollView, StatusBar, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { showChoices } from "../../components/Choices";
import { Player, RangePicker } from "../../components/history/HistoryControls";
import { StopList, SummaryBlock, TripList } from "../../components/history/HistoryLists";
import { Button, Card, Notice, Segmented } from "../../components/ui";
import { downloadFile, getHistory, historyExportPath, shareFile } from "../../lib/api";
import { between, momentAt, pickRate, presetRange, type Range, reachesFuture, wholeDays } from "../../lib/history";
import { useConfig } from "../../lib/session";
import { FONT, useTheme } from "../../lib/theme";
import { useVehicles } from "../../lib/vehicles";
import { COLOR_ROUTE, COLOR_START, type HistoryMark, HistoryMap } from "../../map/HistoryMap";

type Tab = "trips" | "stops";
/** The close button and the title over the map, with their gap from the status bar. */
const TITLE_HEIGHT = 46;

export default function HistoryScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const config = useConfig();
  const vehicle = useVehicles().data?.find((v) => v.id === id) ?? null;
  const [range, setRange] = useState<Range>(() => presetRange("today"));
  const [focus, setFocus] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("trips");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(60);
  const [flyTo, setFlyTo] = useState<{ lat: number; lon: number; n: number } | null>(null);

  const history = useQuery({
    queryKey: ["history", id, range.from.toISOString(), range.to.toISOString()],
    queryFn: () => getHistory(id, range.from, range.to),
    enabled: Boolean(id),
    staleTime: 30_000,
    refetchInterval: reachesFuture(range) ? 60_000 : false,
  });
  const data = history.data;
  const trip = focus !== null ? (data?.trips[focus] ?? null) : null;

  // A long period comes thinned: a trip chosen in it is asked for alone, with all its points.
  const thinned = (data?.points.length ?? 0) >= HISTORY_MAX_POINTS;
  const tripHistory = useQuery({
    queryKey: ["history", id, trip?.start, trip?.end],
    queryFn: () => getHistory(id, new Date(trip?.start ?? 0), new Date(Date.parse(trip?.end ?? "0") + 1000)),
    enabled: trip !== null && thinned,
    staleTime: 300_000,
  });
  const shown = useMemo<HistoryPoint[]>(() => {
    if (!data) return [];
    if (!trip) return data.points;
    if (thinned) return tripHistory.data?.points ?? [];
    return between(data.points, Date.parse(trip.start) / 1000, Date.parse(trip.end) / 1000);
  }, [data, trip, thinned, tripHistory.data]);

  const choose = (next: Range) => {
    setFocus(null);
    setRange(next);
  };
  const pickStop = (stop: Stop) => {
    setPlaying(false);
    setTime(Date.parse(stop.start) / 1000);
    setFlyTo({ lat: stop.lat, lon: stop.lon, n: (flyTo?.n ?? 0) + 1 });
  };

  const marks = useMemo<HistoryMark[]>(() => {
    const first = shown[0];
    const last = shown[shown.length - 1];
    if (!data || !first || !last) return [];
    const out: HistoryMark[] = [];
    data.stops.forEach((s, i) => {
      const at = Date.parse(s.start) / 1000;
      if (at >= first.t - 1 && at <= last.t + 1) out.push({ kind: "stop", lat: s.lat, lon: s.lon, label: String(i + 1), color: COLOR_ROUTE });
    });
    out.push({ kind: "end", lat: last.lat, lon: last.lon, label: t("history.end"), color: COLOR_ROUTE });
    out.push({ kind: "start", lat: first.lat, lon: first.lon, label: t("history.start"), color: COLOR_START });
    return out;
  }, [data, shown, t]);

  const moment = useMemo(() => momentAt(shown, time), [shown, time]);
  const severalDays = (wholeDays(range) ?? 2) > 1;
  const mapHeight = Math.round(height * 0.42);
  const fitKey = [id, range.from.getTime(), range.to.getTime(), focus, data ? 1 : 0, tripHistory.data ? 1 : 0].join("|");

  // Another period or trip starts paused at its beginning, at the rate that plays it in about forty
  // seconds. Refreshing a period that is still going on leaves the playback where it is.
  useEffect(() => {
    setPlaying(false);
    setTime(shown[0]?.t ?? 0);
    setRate(pickRate(shown));
  }, [fitKey]);

  return (
    <View style={[styles.screen, { backgroundColor: theme.canvas }]} testID="history">
      <StatusBar barStyle="dark-content" />
      <View style={{ height: mapHeight }}>
        {config.data ? (
          <HistoryMap
            styleUrl={config.data.mapStyleUrl}
            points={shown}
            marks={marks}
            moment={shown.length > 0 ? moment : null}
            follow={playing}
            fitKey={fitKey}
            flyTo={flyTo}
            topInset={insets.top + TITLE_HEIGHT}
            bottomInset={0}
            around={vehicle?.state?.lat != null && vehicle.state.lon != null ? { lat: vehicle.state.lat, lon: vehicle.state.lon } : null}
          />
        ) : null}
        <View style={[styles.top, { top: insets.top + 6 }]} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            onPress={() => router.back()}
            style={[styles.close, { backgroundColor: theme.surface }]}
            testID="history-close"
          >
            <ChevronDown color={theme.ink} size={22} />
          </Pressable>
          <View style={[styles.titleBox, { backgroundColor: theme.surface }]}>
            <Text style={[styles.title, { color: theme.ink }]} numberOfLines={1}>
              {t("history.title")}
              {vehicle ? ` · ${vehicle.name}` : ""}
            </Text>
          </View>
          <View style={styles.spacer} />
          <ExportButton
            vehicleId={id}
            range={trip ? { from: new Date(trip.start), to: new Date(Date.parse(trip.end) + 1000) } : range}
            what={trip ? "trip" : "period"}
            disabled={!data || data.summary.positions === 0}
          />
        </View>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} testID="history-scroll">
        <RangePicker range={range} onChange={choose} />
        {history.isPending ? (
          <ActivityIndicator style={styles.loading} color={theme.muted} />
        ) : history.isError ? (
          <Card style={styles.message}>
            <Notice text={t("errors.network")} />
            <Button kind="secondary" label={t("errors.retry")} onPress={() => void history.refetch()} />
          </Card>
        ) : data && data.summary.positions === 0 ? (
          <Card style={styles.message}>
            <Text style={[styles.messageTitle, { color: theme.ink }]}>{t("history.noData.title")}</Text>
            <Notice tone="note" text={t("history.noData.lead")} />
          </Card>
        ) : data ? (
          <>
            <SummaryBlock summary={data.summary} trip={trip} onWhole={() => setFocus(null)} />
            {shown.length > 1 ? (
              <Player
                points={shown}
                moment={moment}
                time={time}
                onTime={setTime}
                playing={playing}
                onPlaying={setPlaying}
                rate={rate}
                onRate={setRate}
                severalDays={severalDays}
              />
            ) : null}
            <Segmented
              testID="history-tabs"
              value={tab}
              onChange={setTab}
              options={[
                { value: "trips", label: `${t("history.tabs.trips")} · ${data.trips.length}` },
                { value: "stops", label: `${t("history.tabs.stops")} · ${data.stops.length}` },
              ]}
            />
            {tab === "trips" ? (
              <TripList trips={data.trips} focus={focus} onFocus={setFocus} severalDays={severalDays} />
            ) : (
              <StopList stops={data.stops} onPick={pickStop} severalDays={severalDays} />
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * The period, or the trip chosen, in a file for another app: Excel, PDF, CSV, GPX or KML, with the times in
 * the phone's zone. It comes with the session and leaves through the share menu. Same formats as the web's.
 */
function ExportButton(props: { vehicleId: string; range: { from: Date; to: Date }; what: "trip" | "period"; disabled: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const run = async (format: ExportFormat) => {
    setBusy(true);
    try {
      const zone = getCalendars()[0]?.timeZone ?? "UTC";
      const file = await downloadFile(historyExportPath(props.vehicleId, props.range.from, props.range.to, format, zone));
      await shareFile(file);
    } catch {
      Alert.alert(t("history.export.failed"));
    } finally {
      setBusy(false);
    }
  };
  const choose = () => {
    const options = [...EXPORT_FORMATS.map((f) => t(`history.export.format.${f}`)), t("common.cancel")];
    showChoices({ title: t(`history.export.${props.what}`), options, cancelButtonIndex: options.length - 1 }, (i) => {
      const format = EXPORT_FORMATS[i];
      if (format) void run(format);
    });
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(`history.export.${props.what}`)}
      accessibilityState={{ disabled: props.disabled || busy }}
      disabled={props.disabled || busy}
      onPress={choose}
      style={[styles.close, { backgroundColor: theme.surface, opacity: props.disabled ? 0.5 : 1 }]}
      testID="history-export"
    >
      {busy ? <ActivityIndicator color={theme.ink} /> : <Share2 color={theme.ink} size={20} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { position: "absolute", left: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  close: {
    width: TITLE_HEIGHT - 6,
    height: TITLE_HEIGHT - 6,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  titleBox: { flexShrink: 1, height: TITLE_HEIGHT - 6, paddingHorizontal: 14, borderRadius: 20, justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  title: { fontFamily: FONT.semibold, fontSize: 15 },
  spacer: { flex: 1 },
  content: { padding: 16, gap: 14 },
  loading: { marginVertical: 32 },
  message: { paddingVertical: 14, gap: 8 },
  messageTitle: { fontFamily: FONT.semibold, fontSize: 16 },
});
