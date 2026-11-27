// Sheet of the chosen vehicle, over the map: its state now, where it is and,
// on the map behind, its trip of the last hour. Below, its history, the
// engine lock and recovery mode (module A), its fuel (module F), parked mode,
// its latest events and sharing its location.
import { type Vehicle, vehicleStatus } from "@opengps/shared";
import { useFocusEffect, useRouter } from "expo-router";
import { Pencil, X } from "lucide-react-native";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { Button, Card, Notice, Row, StatusDot } from "../../components/ui";
import { DiagCard } from "../../components/vehicle/DiagCard";
import { DriverCard } from "../../components/vehicle/DriverCard";
import { EventsCard } from "../../components/vehicle/EventsCard";
import { FuelCard } from "../../components/vehicle/FuelCard";
import { ParkedCard } from "../../components/vehicle/ParkedCard";
import { SecurityCard } from "../../components/vehicle/SecurityCard";
import { ShareCard } from "../../components/vehicle/ShareCard";
import { decimalMark, formatCoords, formatCourse, formatSpeed, timeAgo } from "../../lib/format";
import { select, setSheetOpen, useSelected } from "../../lib/selection";
import { useCan, useMe, useNow } from "../../lib/session";
import { barStyleFor, FONT, useTheme } from "../../lib/theme";
import { useAddress, useVehicles } from "../../lib/vehicles";

export default function VehicleSheet() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const id = useSelected();
  const now = useNow(5000);
  const vehicles = useVehicles();
  const vehicle = vehicles.data?.find((v) => v.id === id) ?? null;
  const modules = useMe().data?.account.modules ?? [];
  const canManage = useCan("vehicles.manage");

  useEffect(() => {
    setSheetOpen(true);
    return () => {
      setSheetOpen(false);
      select(null);
    };
  }, []);

  // On Android the light map stays under the status bar at every height of the sheet, and the bar does not follow it.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      StatusBar.setBarStyle("dark-content");
      return () => StatusBar.setBarStyle(barStyleFor(theme));
    }, [theme]),
  );

  if (!vehicle) return <View style={[styles.fill, { backgroundColor: theme.surface }]} />;
  const status = vehicleStatus(vehicle, now);

  return (
    // On Android the sheet grows with the drag only if the list lets the gesture through.
    <ScrollView style={{ backgroundColor: theme.surface }} contentContainerStyle={styles.content} nestedScrollEnabled testID="vehicle-sheet">
      <View style={styles.header}>
        <StatusDot color={theme.status[status]} size={14} />
        <View style={styles.title}>
          <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1} testID="vehicle-name">
            {vehicle.name}
          </Text>
          <Text style={[styles.sub, { color: theme.muted }]} numberOfLines={1}>
            {[t(`shared.vehicleStatus.${status}`), vehicle.plate].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {canManage ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("editVehicle.title")}
            hitSlop={12}
            onPress={() => router.push({ pathname: "/edit-vehicle", params: { id: vehicle.id } })}
            style={[styles.close, { backgroundColor: theme.canvas }]}
            testID="vehicle-edit"
          >
            <Pencil color={theme.muted} size={16} />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("detail.close")}
          hitSlop={12}
          onPress={() => router.back()}
          style={[styles.close, { backgroundColor: theme.canvas }]}
          testID="sheet-close"
        >
          <X color={theme.muted} size={18} />
        </Pressable>
      </View>
      {!vehicle.device ? (
        <Card style={styles.notice}>
          <Text style={[styles.noticeTitle, { color: theme.ink }]}>{t("detail.noDevice.title")}</Text>
          <Notice tone="note" text={t("detail.noDevice.body")} />
        </Card>
      ) : status === "pending" ? (
        <Card style={styles.notice}>
          <Text style={[styles.noticeTitle, { color: theme.ink }]}>{t("detail.pending.title")}</Text>
          <Notice tone="note" text={t("detail.pending.body")} />
        </Card>
      ) : (
        <>
          <State key={`state-${vehicle.id}`} vehicle={vehicle} now={now} />
          <Button
            kind="secondary"
            label={t("history.open")}
            onPress={() => router.push({ pathname: "/history", params: { id: vehicle.id } })}
            testID="open-history"
          />
          {modules.includes("A") ? <SecurityCard key={`a-${vehicle.id}`} vehicle={vehicle} now={now} /> : null}
          {modules.includes("B") ? <DriverCard key={`b-${vehicle.id}`} vehicle={vehicle} now={now} /> : null}
          {modules.includes("F") ? <FuelCard key={`f-${vehicle.id}`} vehicle={vehicle} now={now} /> : null}
          {modules.includes("C") ? <DiagCard key={`c-${vehicle.id}`} vehicle={vehicle} now={now} /> : null}
          <ParkedCard vehicle={vehicle} now={now} />
          <EventsCard vehicle={vehicle} now={now} />
          <ShareCard key={`share-${vehicle.id}`} vehicle={vehicle} />
        </>
      )}
    </ScrollView>
  );
}

function State(props: { vehicle: Vehicle; now: number }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { vehicle, now } = props;
  const s = vehicle.state;
  const at = s?.lat != null && s?.lon != null ? `${s.lat.toFixed(3)},${s.lon.toFixed(3)}` : null;
  const lookup = useAddress(vehicle.id, at, vehicleStatus(vehicle, now) === "moving");
  // The first time it is still on its way, its place is kept, so the rows below do not move when it arrives.
  const address = lookup.data ?? (lookup.isFetching ? t("detail.findingAddress") : null);
  if (!s) return null;

  // Speed and course are always there, so the rows do not jump each time it stops or starts again.
  const moving = vehicleStatus(vehicle, now) === "moving";
  const rows: { label: string; value: string; note?: string | null; mono?: boolean }[] = [];
  rows.push({ label: t("detail.speed"), value: formatSpeed(moving ? s.speedKmh : 0), mono: true });
  rows.push({ label: t("detail.lastReport"), value: timeAgo(s.lastSeenAt, now) });
  rows.push({ label: t("detail.course"), value: moving && s.course !== null ? formatCourse(s.course) : "—" });
  if (s.ignition !== null) {
    rows.push({
      label: t("detail.engine"),
      value: s.ignition ? t("detail.engineOn") : t("detail.engineOff"),
      note: s.ignitionInferred ? t("detail.engineEstimated") : null,
    });
  }
  if (s.powerVoltage !== null) rows.push({ label: t("detail.vehicleBattery"), value: `${decimalMark(s.powerVoltage.toFixed(1))} V`, mono: true });
  if (s.batteryLevel !== null || s.batteryVoltage !== null) {
    rows.push({
      label: t("detail.deviceBattery"),
      value: s.batteryLevel !== null ? `${Math.round(s.batteryLevel)} %` : `${decimalMark((s.batteryVoltage as number).toFixed(2))} V`,
      mono: true,
    });
  }
  if (s.satellites !== null) rows.push({ label: t("detail.satellites"), value: String(s.satellites), mono: true });
  if (s.signalBars !== null) rows.push({ label: t("detail.cellSignal"), value: t("detail.signalBars", { bars: s.signalBars }) });
  rows.push({ label: t("detail.coordinates"), value: formatCoords(s.lat, s.lon), mono: true });

  return (
    <View style={styles.state}>
      {address ? (
        <View style={styles.address}>
          <Text style={[styles.near, { color: theme.muted }]}>{t("detail.near")}</Text>
          <Text style={[styles.addressText, { color: lookup.data ? theme.ink : theme.faint }]} testID="vehicle-address">
            {address}
          </Text>
        </View>
      ) : null}
      <Card>
        {rows.map((r, i) => (
          <Row key={r.label} label={r.label} value={r.value} note={r.note ?? null} mono={r.mono ?? false} last={i === rows.length - 1} />
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, paddingTop: 22, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { flex: 1, gap: 2 },
  name: { fontFamily: FONT.bold, fontSize: 22 },
  sub: { fontFamily: FONT.regular, fontSize: 14 },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  notice: { paddingVertical: 14, gap: 6 },
  noticeTitle: { fontFamily: FONT.semibold, fontSize: 16 },
  state: { gap: 14 },
  address: { gap: 2 },
  near: { fontFamily: FONT.medium, fontSize: 12 },
  addressText: { fontFamily: FONT.regular, fontSize: 15, lineHeight: 21 },
});
