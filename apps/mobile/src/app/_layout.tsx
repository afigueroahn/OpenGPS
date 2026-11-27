// Root of the app: loads the type and the texts, and decides where the person
// goes: to choose their platform, to sign in, or into the app.
import { InstrumentSans_400Regular, InstrumentSans_500Medium, InstrumentSans_600SemiBold, InstrumentSans_700Bold } from "@expo-google-fonts/instrument-sans";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono";
import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Appearance, Platform, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ChoicesHost } from "../components/Choices";
import { Button } from "../components/ui";
import "../lib/i18n";
import { queryClient } from "../lib/query";
import { useMe } from "../lib/session";
import { save, useSaved } from "../lib/storage";
import { barStyleFor, FONT, useTheme } from "../lib/theme";

/**
 * How long the launch screen waits for the platform to say who the person is. After that the app's own loading
 * screen, the same color with a spinner, shows until it answers (ADR-0029).
 */
const LAUNCH_WAIT_MS = 4000;

// The launch screen, the logo on the app's color, stays until the app has something to show (ADR-0029).
void SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ fade: true, duration: 250 });

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    InstrumentSans_700Bold,
    JetBrainsMono_500Medium,
  });
  useEffect(() => {
    const timer = setTimeout(SplashScreen.hide, LAUNCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeSync />
        {fontsLoaded || fontError ? <Gate /> : <Splash />}
        <ChoicesHost />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/**
 * The system's own parts (the sheet, the keyboard, the status bar) follow the theme the person chose. Android's status
 * bar does not follow it by itself.
 */
function ThemeSync() {
  const theme = useSaved((s) => s.theme);
  const palette = useTheme();
  useEffect(() => {
    Appearance.setColorScheme(theme === "system" ? "unspecified" : theme);
  }, [theme]);
  useEffect(() => {
    if (Platform.OS === "android") StatusBar.setBarStyle(barStyleFor(palette));
  }, [palette]);
  return null;
}

function Gate() {
  const { t } = useTranslation();
  const server = useSaved((s) => s.server);
  const cookie = useSaved((s) => s.cookie);
  const me = useMe();
  const signedIn = server !== null && cookie !== "" && Boolean(me.data);
  // With a session kept, the platform is asked who it is before showing anything.
  const waiting = Boolean(server && cookie && me.isPending);
  useEffect(() => {
    if (!waiting) SplashScreen.hide();
  }, [waiting]);

  if (waiting) return <Splash />;
  // The platform does not answer: the session is kept until it does.
  if (server && cookie && me.isError && !me.data) {
    return (
      <View style={styles.splash}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.offline}>{t("errors.server")}</Text>
        <View style={styles.offlineActions}>
          <Button kind="signal" label={t("errors.retry")} busy={me.isFetching} onPress={() => void me.refetch()} testID="retry" />
          <Button dark kind="secondary" label={t("signIn.changeServer")} onPress={() => save({ server: null, cookie: "" })} testID="change-server" />
        </View>
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={server === null}>
        <Stack.Screen name="server" />
      </Stack.Protected>
      <Stack.Protected guard={server !== null && !signedIn}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="forgot" />
        <Stack.Screen name="sign-up" />
        <Stack.Screen name="check-email" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}

function Splash() {
  return (
    <View style={styles.splash}>
      <StatusBar barStyle="light-content" />
      <ActivityIndicator color="#3ddc97" />
    </View>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#101623", padding: 24, gap: 20 },
  offline: { fontFamily: FONT.regular, fontSize: 16, lineHeight: 22, color: "#e9edf5", textAlign: "center" },
  offlineActions: { alignSelf: "stretch", gap: 10 },
});
