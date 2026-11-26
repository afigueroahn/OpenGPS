// The vehicle's engine (module C): the latest it read of revolutions,
// temperature and battery, its active fault codes, and the odometer and
// engine hours. The whole of it opens in its own screen. Same as the web
// app's card (DiagCard).
import { DIAG_PARAMS, type DiagParam, type DiagStatus, type Vehicle } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Activity } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { getDiagnostics } from "../../lib/api";
import { formatNumber, timeAgo } from "../../lib/format";
import { FONT, useTheme } from "../../lib/theme";
import { Button, Card } from "../ui";

/** A reading with its unit: "1.850 rpm", "13,9 V". */
export const diagValue = (param: DiagParam, value: number) => `${formatNumber(value, DIAG_PARAMS[param].decimals)} ${DIAG_PARAMS[param].unit}`;

/** The vehicle's diagnostics, shared by the card and its screen. */
export const useDiagnostics = (vehicleId: string) =>
  useQuery<DiagStatus>({ queryKey: ["diag", vehicleId], queryFn: () => getDiagnostics(vehicleId), refetchInterval: 30_000 });

export function DiagCard(props: { vehicle: Vehicle; now: number }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const status = useDiagnostics(props.vehicle.id).data;
  if (!status) return null;
  const active = status.faults.filter((f) => f.clearedAt === null);
  const headline = (["rpm", "coolantTemp", "power"] as const).flatMap((p) => status.readings.find((r) => r.param === p) ?? []);
  const newest = status.readings.reduce<string | null>((latest, r) => (latest === null || r.at > latest ? r.at : latest), null);
  const hours = formatNumber(status.meters.engineHours, 1);

  return (
    <Card style={styles.card} testID="diag-card">
      <View style={styles.row}>
        <Activity color={active.length > 0 ? theme.danger : theme.signalInk} size={22} />
        <View style={styles.text}>
          <Text style={[styles.title, { color: active.length > 0 ? theme.danger : theme.ink }]} testID="diag-title">
            {active.length > 0 ? t("diag.faultsActive", { count: active.length }) : t("diag.title")}
          </Text>
          {headline.length > 0 ? (
            <Text style={[styles.readings, { color: theme.ink }]}>{headline.map((r) => diagValue(r.param, r.value)).join(" · ")}</Text>
          ) : (
            <Text style={[styles.note, { color: theme.muted }]}>{t("diag.noData")}</Text>
          )}
          <Text style={[styles.note, { color: theme.muted }]}>
            {formatNumber(status.meters.odometerKm, 0)} km · {newest ? t("diag.engineHoursRead", { hours, when: timeAgo(newest, props.now) }) : t("diag.engineHours", { hours })}
          </Text>
        </View>
      </View>
      <Button kind="secondary" label={t("diag.open")} onPress={() => router.push({ pathname: "/diagnostics", params: { id: props.vehicle.id } })} testID="diag-open" />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 14, gap: 12 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  text: { flex: 1, gap: 3 },
  title: { fontFamily: FONT.semibold, fontSize: 16 },
  readings: { fontFamily: FONT.mono, fontSize: 14 },
  note: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
});
