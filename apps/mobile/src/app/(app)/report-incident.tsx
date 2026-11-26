// Reporting an incident by hand: what the GPS does not report on its own, like
// a theft someone tells you about by phone, a crash or a vehicle being held.
// Same as the web app's (IncidentsPanel.tsx, ReportDialog).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ChevronDown } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ModalScreen } from "../../components/ModalScreen";
import { Button, Notice } from "../../components/ui";
import { errorText, reportIncident } from "../../lib/api";
import { FONT, useTheme } from "../../lib/theme";
import { useTyped } from "../../lib/typed";
import { useVehicles } from "../../lib/vehicles";

export default function ReportIncidentScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const vehicles = useVehicles().data ?? [];
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const note = useTyped();
  const chosen = vehicles.find((v) => v.id === vehicleId) ?? vehicles[0] ?? null;

  const create = useMutation({
    mutationFn: (body: { vehicleId: string; note: string }) => reportIncident(body.vehicleId, body.note),
    onSuccess: (incident) => {
      void queryClient.invalidateQueries({ queryKey: ["incidents", "list"] });
      queryClient.setQueryData(["incidents", "detail", incident.id], incident);
      router.replace({ pathname: "/incident", params: { id: incident.id } });
    },
  });
  const chooseVehicle = () => {
    const options = [...vehicles.map((v) => (v.plate ? `${v.name} · ${v.plate}` : v.name)), t("common.cancel")];
    ActionSheetIOS.showActionSheetWithOptions({ title: t("incidents.vehicle"), options, cancelButtonIndex: options.length - 1 }, (i) => {
      const v = vehicles[i];
      if (v) setVehicleId(v.id);
    });
  };
  const submit = () => {
    const text = note.latest().trim();
    if (chosen && text) create.mutate({ vehicleId: chosen.id, note: text });
  };

  return (
    <ModalScreen title={t("incidents.reportTitle")} testID="report-incident-screen">
      <Text style={[styles.lead, { color: theme.ink }]}>{t("incidents.reportLead")}</Text>
      <View style={styles.block}>
        <Text style={[styles.label, { color: theme.muted }]}>{t("incidents.vehicle")}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("incidents.vehicle")}: ${chosen?.name ?? ""}`}
          onPress={chooseVehicle}
          style={({ pressed }) => [styles.picker, { backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.7 : 1 }]}
          testID="report-vehicle"
        >
          <Text style={[styles.pickerText, { color: theme.ink }]} numberOfLines={1}>
            {chosen ? (chosen.plate ? `${chosen.name} · ${chosen.plate}` : chosen.name) : "—"}
          </Text>
          <ChevronDown color={theme.muted} size={18} />
        </Pressable>
      </View>
      <View style={styles.block}>
        <Text style={[styles.label, { color: theme.muted }]}>{t("incidents.what")}</Text>
        <TextInput
          value={note.text}
          onChangeText={note.change}
          multiline
          maxLength={1000}
          style={[styles.area, { color: theme.ink, backgroundColor: theme.surface, borderColor: theme.line }]}
          testID="report-note"
        />
      </View>
      {create.isError ? <Notice text={errorText(create.error)} /> : null}
      <Button kind="signal" label={t("incidents.report")} busy={create.isPending} disabled={!chosen || !note.text.trim()} onPress={submit} testID="report-submit" />
    </ModalScreen>
  );
}

const styles = StyleSheet.create({
  lead: { fontFamily: FONT.regular, fontSize: 16, lineHeight: 22 },
  block: { gap: 6 },
  label: { fontFamily: FONT.medium, fontSize: 13 },
  picker: { height: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 },
  pickerText: { flex: 1, fontFamily: FONT.regular, fontSize: 16 },
  area: { minHeight: 120, borderRadius: 12, borderWidth: 1, padding: 12, fontFamily: FONT.regular, fontSize: 16, textAlignVertical: "top" },
});
