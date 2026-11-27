// Sign in with email and password, or with the services the platform has. A
// forgotten password and a confirmation that did not arrive are asked for
// here; both links open the platform's own pages. Whoever has no account yet
// creates one from here.
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, type TextInput } from "react-native";
import { AuthFrame, authStyles } from "../components/AuthFrame";
import { PasskeyButton, ServiceButtons } from "../components/ServiceButtons";
import { Button, Field, Notice } from "../components/ui";
import { ApiRequestError, auth, authMessage } from "../lib/api";
import { useConfig } from "../lib/session";
import { save, useSaved } from "../lib/storage";
import { FONT } from "../lib/theme";
import { useTyped } from "../lib/typed";

export default function SignInScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const config = useConfig();
  const server = useSaved((s) => s.server);
  const email = useTyped();
  const password = useTyped();
  const [error, setError] = useState<string | null>(null);
  /** The account exists but its email is not confirmed yet: the link can be sent again. */
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState<"ok" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  const ready = email.text.trim() !== "" && password.text !== "";

  const submit = async () => {
    if (email.latest().trim() === "" || password.latest() === "") return;
    setBusy(true);
    setError(null);
    setResent(null);
    try {
      await auth.signIn({ email: email.latest().trim(), password: password.latest() });
      // The session cookie is kept by now: who signed in is asked again.
      await queryClient.resetQueries({ queryKey: ["me"] });
    } catch (err) {
      setUnverified(err instanceof ApiRequestError && err.code === "EMAIL_NOT_VERIFIED");
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      await auth.resendVerification(email.latest().trim());
      setResent("ok");
    } catch {
      setResent("failed");
    }
  };

  return (
    <AuthFrame name={config.data?.appName ?? "OpenGPS"} title={t("signIn.title")} body={server?.replace(/^https?:\/\//, "") ?? null}>
      <Field
        dark
        testID="email"
        label={t("signIn.email")}
        onChangeText={email.change}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
      />
      <Field
        dark
        ref={passwordRef}
        testID="password"
        label={t("signIn.password")}
        onChangeText={password.change}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      {error ? <Notice dark text={error} testID="sign-in-error" /> : null}
      {unverified && resent === null ? (
        <Pressable accessibilityRole="button" onPress={() => void resend()} testID="resend-verification">
          <Text style={authStyles.link}>{t("signIn.resend")}</Text>
        </Pressable>
      ) : null}
      {resent ? <Notice dark tone={resent === "ok" ? "note" : "error"} text={resent === "ok" ? t("signIn.resentOk") : t("signIn.resendFailed")} testID="resend-result" /> : null}
      <Button kind="signal" label={t("signIn.submit")} busy={busy} disabled={!ready} onPress={() => void submit()} testID="sign-in-submit" />
      <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/forgot", params: { email: email.latest().trim() } })} testID="forgot-password">
        <Text style={authStyles.link}>{t("signIn.forgot")}</Text>
      </Pressable>
      <PasskeyButton />
      <ServiceButtons from="signIn" />
      <Pressable accessibilityRole="button" onPress={() => router.push("/sign-up")} testID="go-sign-up">
        <Text style={authStyles.link}>
          <Text style={styles.muted}>{t("signIn.noAccount")} </Text>
          {t("signIn.createAccount")}
        </Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => save({ server: null, cookie: "" })} testID="change-server">
        <Text style={authStyles.link}>{t("signIn.changeServer")}</Text>
      </Pressable>
    </AuthFrame>
  );
}

const styles = StyleSheet.create({ muted: { color: "#98a2b3", fontFamily: FONT.regular } });
