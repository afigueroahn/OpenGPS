// Who is driving the vehicle (module B): the one assigned by hand or the one
// whose key the device read. Whoever manages drivers changes it from the
// system's menu. Same as the web app's (VehicleDriverCard).
import type { Vehicle, VehicleDriver } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IdCard, KeyRound } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { errorText, getDrivers, getVehicleDriver, setVehicleDriver } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { useCan } from "../../lib/session";
import { FONT, useTheme } from "../../lib/theme";
import { showChoices } from "../Choices";
import { Button, Card, Notice } from "../ui";

export function DriverCard(props: { vehicle: Vehicle; now: number }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const canManage = useCan("drivers.manage");
  const { vehicle, now } = props;
  const key = ["vehicle-driver", vehicle.id];
  const current = useQuery({ queryKey: key, queryFn: () => getVehicleDriver(vehicle.id) });
  const drivers = useQuery({ queryKey: ["drivers", "list"], queryFn: getDrivers, enabled: canManage });
  const assign = useMutation({
    mutationFn: (driverId: string | null) => setVehicleDriver(vehicle.id, driverId),
    onSuccess: (data: VehicleDriver) => {
      queryClient.setQueryData(key, data);
      void queryClient.invalidateQueries({ queryKey: ["drivers"] });
    },
  });
  if (!current.data) return null;
  const { driver, unknownKey } = current.data;
  const active = (drivers.data ?? []).filter((d) => d.active || d.id === driver?.id);

  const choose = () => {
    const values = [...active.map((d) => d.id), null];
    const options = [...active.map((d) => (d.id === driver?.id ? `✓ ${d.name}` : d.name)), t("driver.noDriver"), t("common.cancel")];
    showChoices({ title: t("driver.select"), options, cancelButtonIndex: options.length - 1 }, (i) => {
      if (i >= values.length) return;
      const next = values[i] ?? null;
      if (next !== (driver?.id ?? null)) assign.mutate(next);
    });
  };

  return (
    <Card style={styles.card} testID="driver-card">
      <View style={styles.row}>
        <IdCard color={driver ? theme.signalInk : theme.muted} size={22} />
        <View style={styles.text}>
          <Text style={[styles.title, { color: theme.ink }]} testID="driver-name">
            {driver ? driver.name : t("driver.none")}
          </Text>
          <Text style={[styles.note, { color: theme.muted }]}>
            {driver ? t(driver.source === "key" ? "driver.sinceKey" : "driver.since", { when: timeAgo(driver.since, now) }) : t("driver.noneNote")}
          </Text>
        </View>
      </View>
      {canManage && active.length > 0 ? (
        <Button kind="secondary" label={driver ? t("driver.change") : t("driver.assign")} busy={assign.isPending} onPress={choose} testID="driver-change" />
      ) : null}
      {canManage && drivers.isSuccess && active.length === 0 ? <Notice tone="note" text={t("driver.noDrivers")} /> : null}
      {assign.isError ? <Notice text={errorText(assign.error)} /> : null}
      {unknownKey ? (
        <View style={[styles.key, { backgroundColor: theme.canvas }]}>
          <View style={styles.keyTitle}>
            <KeyRound color={theme.warning} size={16} />
            <Text style={[styles.keyText, { color: theme.ink }]}>{t("driver.unknownKey")}</Text>
          </View>
          <Text style={[styles.note, { color: theme.muted }]}>{t("driver.unknownKeyBody", { key: unknownKey.key, when: timeAgo(unknownKey.at, now) })}</Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 14, gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  text: { flex: 1, gap: 2 },
  title: { fontFamily: FONT.semibold, fontSize: 16 },
  note: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
  key: { borderRadius: 10, padding: 12, gap: 4 },
  keyTitle: { flexDirection: "row", alignItems: "center", gap: 6 },
  keyText: { fontFamily: FONT.semibold, fontSize: 14 },
});
