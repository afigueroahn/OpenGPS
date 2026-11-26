// The buttons to sign in with the services the platform has (ADR-0013). The
// system's sign-in window opens at the platform, goes to the service and comes
// back to the app with a pass the app exchanges for its session. Whoever has
// no account yet gets one: the terms are shown under the buttons, and
// continuing accepts them, as on the web.
import { LEGAL_VERSION, type OAuthProvider } from "@opengps/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { auth, authMessage, oauthStartUrl } from "../lib/api";
import { problemOf, readAppReturn } from "../lib/oauth";
import { useConfig } from "../lib/session";
import { useSaved } from "../lib/storage";
import { FONT } from "../lib/theme";
import { Notice } from "./ui";

export function ServiceButtons(props: { from: "signIn" | "signUp" }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const server = useSaved((s) => s.server);
  const buttons = useConfig().data?.signIn ?? [];
  const [going, setGoing] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (buttons.length === 0) return null;

  const go = async (provider: OAuthProvider) => {
    setGoing(provider);
    setError(null);
    try {
      // Loaded only here: an app built before it had this module still opens.
      const WebBrowser = await import("expo-web-browser");
      // Ephemeral: the platform's session does not stay in the phone's browser.
      const result = await WebBrowser.openAuthSessionAsync(oauthStartUrl(provider, LEGAL_VERSION), "opengps://oauth", { preferEphemeralSession: true });
      if (result.type !== "success") return;
      const back = readAppReturn(result.url);
      if (!back) return setError(t("services.failed"));
      if ("error" in back) {
        const problem = problemOf(back.error, back.description);
        return setError("text" in problem ? problem.text : t(problem.key));
      }
      await auth.exchangePass(back.token);
      // The session cookie is kept by now: who signed in is asked again.
      await queryClient.resetQueries({ queryKey: ["me"] });
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setGoing(null);
    }
  };

  return (
    <View style={styles.block} testID="service-buttons">
      <View style={styles.divider}>
        <View style={styles.line} />
        <Text style={styles.or}>{t(props.from === "signUp" ? "services.orSignUp" : "services.orSignIn")}</Text>
        <View style={styles.line} />
      </View>
      {buttons.map((b) => (
        <Pressable
          key={b.id}
          accessibilityRole="button"
          accessibilityLabel={t("services.with", { name: b.name })}
          disabled={going !== null}
          onPress={() => void go(b.id)}
          style={({ pressed }) => [styles.button, { opacity: going !== null && going !== b.id ? 0.5 : pressed ? 0.8 : 1 }]}
          testID={`service-${b.id}`}
        >
          {going === b.id ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>{t("services.with", { name: b.name })}</Text>}
        </Pressable>
      ))}
      <Text style={styles.terms}>
        {t("services.termsBefore")}
        <Text style={styles.termsLink} onPress={() => void Linking.openURL(`${server}/terms`)}>
          {t("services.termsLink")}
        </Text>
        {t("services.termsMiddle")}
        <Text style={styles.termsLink} onPress={() => void Linking.openURL(`${server}/privacy`)}>
          {t("services.privacyLink")}
        </Text>
        {t("services.termsAfter")}
      </Text>
      {error ? <Notice dark text={error} testID="service-error" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 12 },
  divider: { flexDirection: "row", alignItems: "center", gap: 12 },
  line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: "#283248" },
  or: { fontFamily: FONT.regular, fontSize: 13, color: "#98a2b3" },
  button: { height: 48, borderRadius: 12, borderWidth: 1, borderColor: "#283248", backgroundColor: "#1a2233", alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  buttonText: { fontFamily: FONT.semibold, fontSize: 16, color: "#ffffff" },
  terms: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 19, color: "#98a2b3" },
  termsLink: { fontFamily: FONT.medium, color: "#3ddc97" },
});
