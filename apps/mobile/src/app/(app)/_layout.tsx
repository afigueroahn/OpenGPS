// Inside the app, with a session: the tabs, the vehicle sheet over them, and
// the live channel open while the person is here.
import { Stack } from "expo-router";
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { AccountGate } from "../../components/AccountGate";
import { AlertBanner } from "../../components/AlertBanner";
import { LiveContext } from "../../components/LiveBadge";
import { pushAlert } from "../../lib/alerts";
import { updateSettings } from "../../lib/api";
import i18n from "../../lib/i18n";
import { useLive } from "../../lib/live";
import { useMe } from "../../lib/session";
import { getSaved, save } from "../../lib/storage";
import { useTheme } from "../../lib/theme";

export default function AppLayout() {
  const theme = useTheme();
  const me = useMe().data ?? null;
  // Alerts that arrive live are shown over the screens.
  const live = useLive(me !== null, pushAlert);
  useAdoptPreferences();

  if (me && (me.needsConsent || me.account.suspended)) return <AccountGate me={me} />;
  return (
    <LiveContext value={live}>
      <View style={styles.fill}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="vehicle"
            options={{
              presentation: "formSheet",
              sheetAllowedDetents: [0.32, 0.62, 1],
              sheetInitialDetentIndex: 0,
              sheetLargestUndimmedDetentIndex: 1,
              sheetGrabberVisible: true,
              sheetCornerRadius: 22,
              contentStyle: { backgroundColor: theme.surface },
            }}
          />
          {/* Over the vehicle sheet, so closing the history goes back to it. */}
          <Stack.Screen name="history" options={{ presentation: "fullScreenModal" }} />
          <Stack.Screen name="add-gps" options={{ presentation: "modal" }} />
          <Stack.Screen name="edit-vehicle" options={{ presentation: "modal" }} />
          <Stack.Screen name="diagnostics" options={{ presentation: "modal" }} />
          <Stack.Screen name="incident" options={{ presentation: "modal" }} />
          <Stack.Screen name="report-incident" options={{ presentation: "modal" }} />
          <Stack.Screen name="profile" options={{ presentation: "modal" }} />
          <Stack.Screen name="password" options={{ presentation: "modal" }} />
          <Stack.Screen name="delete-account" options={{ presentation: "modal" }} />
        </Stack>
        <AlertBanner />
      </View>
    </LiveContext>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });

/**
 * The language and theme the person chose on the web come with them: the first time they sign in on this phone,
 * the app takes them, unless the person already chose something here.
 */
function useAdoptPreferences() {
  const me = useMe().data ?? null;
  const adopted = useRef<string | null>(null);
  useEffect(() => {
    if (!me || adopted.current === me.user.id) return;
    adopted.current = me.user.id;
    const saved = getSaved();
    if (saved.language === null && me.settings.language) {
      save({ language: me.settings.language });
      void i18n.changeLanguage(me.settings.language);
    } else if (saved.language !== null && saved.language !== me.settings.language) {
      void updateSettings({ language: saved.language }).catch(() => undefined);
    }
    if (saved.theme === "system" && me.settings.theme !== "system") save({ theme: me.settings.theme });
  }, [me]);
}
