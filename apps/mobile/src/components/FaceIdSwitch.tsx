// The switch to unlock the app with Face ID (ADR-0019), with the person's own
// data. It only shows on a phone with Face ID or Touch ID set up.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Switch, Text, View } from "react-native";
import { askToUnlock, useUnlockMethod } from "../lib/biometrics";
import { save, useSaved } from "../lib/storage";
import { FONT, useTheme } from "../lib/theme";
import { Card } from "./ui";

export function FaceIdSwitch() {
  const { t } = useTranslation();
  const theme = useTheme();
  const method = useUnlockMethod();
  const on = useSaved((s) => s.faceId);
  const [busy, setBusy] = useState(false);
  if (!method) return null;

  const change = async (value: boolean) => {
    if (!value) {
      save({ faceId: false });
      return;
    }
    // Turning it on is confirmed with Face ID itself, so it is known to work before the app locks.
    setBusy(true);
    const passed = await askToUnlock({ prompt: t("lock.confirm", { method }), cancel: t("lock.cancel"), passcode: t("lock.passcode") });
    setBusy(false);
    if (passed) save({ faceId: true });
  };

  const label = t("lock.toggle", { method });
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={[styles.label, { color: theme.ink }]}>{label}</Text>
          <Text style={[styles.note, { color: theme.muted }]}>{t("lock.toggleNote")}</Text>
        </View>
        <Switch
          value={on}
          onValueChange={(value) => void change(value)}
          disabled={busy}
          trackColor={{ true: theme.signal }}
          accessibilityLabel={label}
          testID="face-id"
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 12 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12, gap: 12 },
  text: { flex: 1 },
  label: { fontFamily: FONT.medium, fontSize: 15 },
  note: { fontFamily: FONT.regular, fontSize: 12, marginTop: 2 },
});
