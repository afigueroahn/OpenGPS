// A vehicle's diagnostics (module C): the latest reading of each value the
// device takes from the engine, and its fault codes, active and resolved,
// with their explanation. Same as the web app's "Ahora" and "Fallas" tabs.
import type { DiagFault, DiagParam, DiagStatus } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { ModalScreen } from "../../components/ModalScreen";
import { Notice, Segmented } from "../../components/ui";
import { diagValue, useDiagnostics } from "../../components/vehicle/DiagCard";
import { errorText, getDiagFaults } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { FONT, RADIUS, useTheme } from "../../lib/theme";
import { useVehicles } from "../../lib/vehicles";

type Tab = "now" | "faults";

export default function DiagnosticsScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const vehicle = useVehicles().data?.find((v) => v.id === id);
  const status = useDiagnostics(id).data;
  // With active faults it opens on them, as the web app does.
  const [tab, setTab] = useState<Tab | null>(null);
  const shown: Tab = tab ?? (status?.faults.some((f) => f.clearedAt === null) ? "faults" : "now");

  return (
    <ModalScreen title={vehicle ? t("diag.screenTitle", { name: vehicle.name }) : t("diag.title")} testID="diagnostics">
      <Segmented
        testID="diag-tabs"
        value={shown}
        onChange={setTab}
        options={[
          { value: "now", label: t("diag.tabs.now") },
          { value: "faults", label: t("diag.tabs.faults") },
        ]}
      />
      {!status ? <ActivityIndicator /> : shown === "now" ? <Now status={status} /> : <Faults vehicleId={id} />}
    </ModalScreen>
  );
}

function Now({ status }: { status: DiagStatus }) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (status.readings.length === 0) return <Notice tone="note" text={t("diag.nowEmpty")} />;
  const over = (param: DiagParam, value: number) =>
    (param === "rpm" && status.limits.rpmMax !== null && value > status.limits.rpmMax) ||
    (param === "coolantTemp" && status.limits.tempMaxC !== null && value > status.limits.tempMaxC) ||
    (param === "power" && status.limits.voltageMinV !== null && value < status.limits.voltageMinV);
  return (
    <>
      <View style={styles.grid}>
        {status.readings.map((r) => (
          <View key={r.param} style={[styles.tile, { backgroundColor: theme.surface, borderColor: theme.line }]} testID={`diag-${r.param}`}>
            <Text style={[styles.tileLabel, { color: theme.muted }]} numberOfLines={2}>
              {t(`shared.diagParam.${r.param}`).toUpperCase()}
            </Text>
            <Text style={[styles.tileValue, { color: over(r.param, r.value) ? theme.danger : theme.ink }]} adjustsFontSizeToFit numberOfLines={1}>
              {diagValue(r.param, r.value)}
            </Text>
            <Text style={[styles.tileAt, { color: theme.faint }]}>{formatDateTime(r.at)}</Text>
          </View>
        ))}
      </View>
      <Notice tone="note" text={t("diag.nowNote")} />
    </>
  );
}

function Faults({ vehicleId }: { vehicleId: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const faults = useQuery({ queryKey: ["diag", vehicleId, "faults"], queryFn: () => getDiagFaults(vehicleId) });
  if (faults.isPending) return <ActivityIndicator />;
  if (faults.isError) return <Notice text={errorText(faults.error)} />;
  const list = faults.data;
  if (list.length === 0) return <Notice tone="note" text={t("diag.faultsEmpty")} />;
  const active = list.filter((f) => f.clearedAt === null);
  const solved = list.filter((f) => f.clearedAt !== null);
  return (
    <>
      <Text style={[styles.section, { color: theme.ink }]}>{t("diag.faultsActiveTitle")}</Text>
      {active.length === 0 ? <Notice tone="note" text={t("diag.faultsNone")} /> : active.map((f) => <Fault key={`${f.code}-${f.firstSeenAt}`} fault={f} />)}
      {solved.length > 0 ? (
        <>
          <Text style={[styles.section, { color: theme.ink }]}>{t("diag.faultsSolved")}</Text>
          {solved.map((f) => (
            <Fault key={`${f.code}-${f.firstSeenAt}`} fault={f} />
          ))}
        </>
      ) : null}
    </>
  );
}

function Fault({ fault }: { fault: DiagFault }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const activeNow = fault.clearedAt === null;
  return (
    <View style={[styles.fault, { backgroundColor: theme.surface, borderColor: activeNow ? theme.danger : theme.line }]} testID={`fault-${fault.code}`}>
      <View style={styles.faultHead}>
        {activeNow ? <TriangleAlert color={theme.danger} size={18} /> : null}
        <Text style={[styles.faultTitle, { color: theme.ink }]}>
          <Text style={styles.code}>{fault.code}</Text> · {fault.description}
        </Text>
      </View>
      <Text style={[styles.faultNote, { color: theme.muted }]}>
        {fault.clearedAt
          ? t("diag.faultCleared", { system: fault.system, from: formatDateTime(fault.firstSeenAt), to: formatDateTime(fault.clearedAt) })
          : t("diag.faultSeen", { system: fault.system, from: formatDateTime(fault.firstSeenAt), last: formatDateTime(fault.lastSeenAt) })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: { width: "48%", flexGrow: 1, borderRadius: RADIUS, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 4 },
  tileLabel: { fontFamily: FONT.medium, fontSize: 11, letterSpacing: 0.5 },
  tileValue: { fontFamily: FONT.mono, fontSize: 20 },
  tileAt: { fontFamily: FONT.regular, fontSize: 12 },
  section: { fontFamily: FONT.semibold, fontSize: 15, marginTop: 4 },
  fault: { borderRadius: RADIUS, borderWidth: 1, padding: 12, gap: 6 },
  faultHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  faultTitle: { flex: 1, fontFamily: FONT.semibold, fontSize: 15, lineHeight: 20 },
  code: { fontFamily: FONT.mono },
  faultNote: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
});
