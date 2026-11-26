// Editing a vehicle: its name, its plate and its group, and removing its GPS.
// Same rules as the web app's (VehicleDetail.tsx, EditDialog and "Quitar el GPS").
import type { Vehicle } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronDown } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { ModalScreen } from "../../components/ModalScreen";
import { Button, Card, Field, Notice, SectionTitle } from "../../components/ui";
import { errorText, removeDevice, updateVehicle } from "../../lib/api";
import { groupTree, indented } from "../../lib/groups";
import { FONT, RADIUS, useTheme } from "../../lib/theme";
import { useTyped } from "../../lib/typed";
import { useGroups, useVehicles } from "../../lib/vehicles";

export default function EditVehicleScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const vehicle = useVehicles().data?.find((v) => v.id === id) ?? null;
  return <ModalScreen title={t("editVehicle.title")} testID="edit-vehicle">{vehicle ? <EditForm vehicle={vehicle} /> : null}</ModalScreen>;
}

function EditForm({ vehicle }: { vehicle: Vehicle }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const groups = useGroups().data ?? [];
  const tree = groupTree(groups);
  const name = useTyped(vehicle.name);
  const plate = useTyped(vehicle.plate ?? "");
  const [groupId, setGroupId] = useState<string | null>(vehicle.groupId);
  const [problem, setProblem] = useState<string | null>(null);

  const keep = (saved: Vehicle) => queryClient.setQueryData<Vehicle[]>(["vehicles"], (list) => list?.map((v) => (v.id === saved.id ? saved : v)));
  const save = useMutation({
    mutationFn: () => updateVehicle(vehicle.id, { name: name.latest().trim(), plate: plate.latest().trim() || null, groupId }),
    onSuccess: (saved) => {
      keep(saved);
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      router.back();
    },
  });
  const unplug = useMutation({
    mutationFn: () => removeDevice(vehicle.id),
    onSuccess: (saved) => {
      keep(saved);
      void queryClient.invalidateQueries({ queryKey: ["vehicles"] });
    },
  });

  const submit = () => {
    if (!name.latest().trim()) return setProblem(t("wizard.needName"));
    setProblem(null);
    save.mutate();
  };
  const chooseGroup = () => {
    const values = [null, ...tree.map((g) => g.id)];
    const options = [t("list.noGroup"), ...tree.map(indented), t("common.cancel")];
    ActionSheetIOS.showActionSheetWithOptions({ title: t("editVehicle.group"), options, cancelButtonIndex: options.length - 1 }, (i) => {
      if (i < values.length) setGroupId(values[i] ?? null);
    });
  };
  const confirmUnplug = () => {
    Alert.alert(t("editVehicle.unplugTitle"), t("editVehicle.unplugBody", { id: vehicle.device?.uniqueId ?? "" }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("editVehicle.unplugConfirm"), style: "destructive", onPress: () => unplug.mutate() },
    ]);
  };
  const groupLabel = groupId === null ? t("list.noGroup") : (groups.find((g) => g.id === groupId)?.name ?? t("list.noGroup"));

  return (
    <>
      <Field
        label={t("editVehicle.name")}
        value={name.text}
        onChangeText={(text) => {
          name.change(text);
          setProblem(null);
        }}
        maxLength={60}
        testID="edit-name"
      />
      <Field label={t("wizard.plate")} value={plate.text} onChangeText={plate.change} autoCapitalize="characters" maxLength={20} testID="edit-plate" />
      {groups.length > 0 ? (
        <View style={styles.block}>
          <Text style={[styles.label, { color: theme.muted }]}>{t("editVehicle.group")}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t("editVehicle.group")}: ${groupLabel}`}
            onPress={chooseGroup}
            style={({ pressed }) => [styles.picker, { backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.7 : 1 }]}
            testID="edit-group"
          >
            <Text style={[styles.pickerText, { color: theme.ink }]} numberOfLines={1}>
              {groupLabel}
            </Text>
            <ChevronDown color={theme.muted} size={18} />
          </Pressable>
        </View>
      ) : null}
      {problem ? <Notice text={problem} /> : null}
      {save.isError ? <Notice text={errorText(save.error)} /> : null}
      <Button label={t("editVehicle.save")} busy={save.isPending} onPress={submit} testID="edit-save" />

      {vehicle.device ? (
        <>
          <SectionTitle text={t("editVehicle.gps")} />
          <Card style={styles.gps}>
            <Text style={[styles.gpsId, { color: theme.ink }]}>{vehicle.device.uniqueId}</Text>
            <Notice tone="note" text={t("editVehicle.unplugNote")} />
            {unplug.isError ? <Notice text={errorText(unplug.error)} /> : null}
            <Button kind="danger" label={t("editVehicle.unplugTitle")} busy={unplug.isPending} onPress={confirmUnplug} testID="edit-unplug" />
          </Card>
        </>
      ) : (
        <Notice tone="note" text={t("editVehicle.noGps")} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  block: { gap: 6 },
  label: { fontFamily: FONT.medium, fontSize: 13 },
  picker: { height: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 },
  pickerText: { flex: 1, fontFamily: FONT.regular, fontSize: 16 },
  gps: { paddingVertical: 14, gap: 10, borderRadius: RADIUS },
  gpsId: { fontFamily: FONT.mono, fontSize: 16 },
});
