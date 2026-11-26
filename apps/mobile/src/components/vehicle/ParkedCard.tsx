// Parked mode: if the vehicle moves away from where it was left, a
// notification arrives. Only who manages vehicles turns it on and off; the
// rest see it only while it is on. Same as the web app's (ParkedSwitch).
import type { Vehicle } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleParking } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, Switch, Text, View } from "react-native";
import { errorText, setParked } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { useCan } from "../../lib/session";
import { FONT, useTheme } from "../../lib/theme";
import { Card, Notice } from "../ui";

export function ParkedCard(props: { vehicle: Vehicle; now: number }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const canManage = useCan("vehicles.manage");
  const { vehicle } = props;
  const parked = vehicle.parkedSince !== null;
  const toggle = useMutation({
    mutationFn: (next: boolean) => setParked(vehicle.id, next),
    onSuccess: (saved) => queryClient.setQueryData<Vehicle[]>(["vehicles"], (list) => list?.map((v) => (v.id === saved.id ? saved : v))),
  });
  if (!canManage && !parked) return null;
  const shown = toggle.isPending ? toggle.variables : parked;

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <CircleParking color={shown ? theme.signalInk : theme.muted} size={22} />
        <View style={styles.text}>
          <Text style={[styles.title, { color: theme.ink }]}>{t("detail.parked.title")}</Text>
          <Text style={[styles.note, { color: theme.muted }]}>
            {parked ? t("detail.parked.on", { since: timeAgo(vehicle.parkedSince, props.now) }) : t("detail.parked.off")}
          </Text>
        </View>
        <Switch
          testID="parked-switch"
          accessibilityLabel={t("detail.parked.title")}
          value={shown}
          disabled={!canManage || toggle.isPending}
          onValueChange={(next) => toggle.mutate(next)}
          trackColor={{ true: theme.signal, false: theme.line }}
        />
      </View>
      {toggle.isError ? <Notice text={errorText(toggle.error)} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 14, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  text: { flex: 1, gap: 2 },
  title: { fontFamily: FONT.semibold, fontSize: 16 },
  note: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
});
