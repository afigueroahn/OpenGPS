// Map tab: the account's vehicles live. A tap on a vehicle opens its sheet;
// a tap on the empty map closes it.
import type { TrackPoint } from "@opengps/shared";
import { useFocusEffect, useRouter } from "expo-router";
import { Maximize } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StatusBar, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LiveBadge } from "../../../components/LiveBadge";
import { Notice } from "../../../components/ui";
import { VehicleMap } from "../../../map/VehicleMap";
import { getTrack } from "../../../lib/api";
import { isSheetOpen, select, useSelected } from "../../../lib/selection";
import { useConfig, useNow } from "../../../lib/session";
import { barStyleFor, useTheme } from "../../../lib/theme";
import { mergeTrack, TRACK_MINUTES, trackPoint } from "../../../lib/track";
import { useVehicles } from "../../../lib/vehicles";

/** Share of the screen the sheet covers when it opens. */
const SHEET_SHARE = 0.32;

export default function MapScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const config = useConfig();
  const vehicles = useVehicles();
  const selectedId = useSelected();
  const now = useNow(15_000);
  const [fitKey, setFitKey] = useState(0);
  const list = vehicles.data ?? [];
  const selected = list.find((v) => v.id === selectedId) ?? null;

  // The map is light: the status bar is dark over it.
  useFocusEffect(
    useCallback(() => {
      StatusBar.setBarStyle("dark-content");
      return () => StatusBar.setBarStyle(barStyleFor(theme));
    }, [theme]),
  );

  // The trip of the last hour, asked for once per vehicle, with each position that arrives live after it.
  const [trail, setTrail] = useState<TrackPoint[]>([]);
  useEffect(() => {
    setTrail([]);
    if (!selectedId) return;
    let cancelled = false;
    getTrack(selectedId, TRACK_MINUTES)
      .then((points) => {
        if (!cancelled) setTrail((live) => mergeTrack(points, live));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId]);
  const latest = trackPoint(selected?.state);
  useEffect(() => {
    if (latest) setTrail((points) => mergeTrack(points, [latest]));
  }, [latest?.t]);

  const onSelect = (id: string | null) => {
    select(id);
    if (id && !isSheetOpen()) router.push("/vehicle");
    if (!id && isSheetOpen()) router.back();
  };

  const placed = list.some((v) => v.state?.lat != null);

  return (
    <View style={styles.screen} testID="map-screen">
      {config.data ? (
        <VehicleMap
          styleUrl={config.data.mapStyleUrl}
          vehicles={list}
          selectedId={selectedId}
          track={selectedId ? trail : []}
          now={now}
          onSelect={onSelect}
          bottomInset={selectedId ? height * SHEET_SHARE : 0}
          fitKey={fitKey}
        />
      ) : null}
      <View pointerEvents="box-none" style={[styles.top, { top: insets.top + 8 }]}>
        <LiveBadge />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("map.fit")}
          onPress={() => setFitKey((k) => k + 1)}
          style={[styles.round, { backgroundColor: theme.surface }]}
          testID="map-fit"
        >
          <Maximize color={theme.ink} size={18} />
        </Pressable>
      </View>
      {vehicles.isSuccess && list.length > 0 && !placed ? (
        <View style={[styles.empty, { backgroundColor: theme.surface }]}>
          <Notice tone="note" text={t("map.noPosition")} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { position: "absolute", left: 12, right: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  empty: { position: "absolute", left: 16, right: 16, bottom: 16, padding: 14, borderRadius: 14 },
});
