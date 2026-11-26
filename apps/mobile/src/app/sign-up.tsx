// Creating an account: name, email and a password that meets the platform's
// rules, with the terms accepted. The platform asks to confirm the email first;
// the first account of an installation without mail comes in straight away.
// Same rules as the web app's (routes/auth.tsx, Register).
import { PASSWORD_POLICY_DEFAULT, passwordHint, passwordProblem } from "@opengps/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, StyleSheet, Text, type TextInput, View } from "react-native";
import { AuthFrame, authStyles } from "../components/AuthFrame";
import { ServiceButtons } from "../components/ServiceButtons";
import { Button, Field, Notice } from "../components/ui";
import { auth, authMessage } from "../lib/api";
import { useConfig } from "../lib/session";
import { useSaved } from "../lib/storage";
import { FONT } from "../lib/theme";
import { useTyped } from "../lib/typed";

export default function SignUpScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const config = useConfig().data;
  const server = useSaved((s) => s.server);
  const name = useTyped();
  const email = useTyped();
  const password = useTyped();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  // What is required of the password is set by whoever administers the platform.
  const policy = config?.passwordPolicy ?? PASSWORD_POLICY_DEFAULT;
  const hint = passwordHint(policy);

  const submit = async () => {
    const typed = { name: name.latest().trim(), email: email.latest().trim(), password: password.latest() };
    if (typed.name.length < 2) return setError(t("signUp.nameMissing"));
    if (!typed.email.includes("@")) return setError(t("auth.invalidEmail"));
    const weak = passwordProblem(typed.password, policy);
    if (weak) return setError(t(`shared.${weak.key}`, weak.params ?? {}));
    if (!accepted) return setError(t("signUp.mustAccept"));
    setBusy(true);
    setError(null);
    try {
      const created = await auth.signUp(typed);
      if (created?.user?.emailVerified) {
        // The first account of an installation without mail needs no confirmation: it goes straight in.
        await auth.signIn({ email: typed.email, password: typed.password });
        await queryClient.resetQueries({ queryKey: ["me"] });
        return;
      }
      router.replace({ pathname: "/check-email", params: { email: typed.email } });
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const edit = (change: (text: string) => void) => (text: string) => {
    change(text);
    setError(null);
  };

  return (
    <AuthFrame name={config?.appName ?? "OpenGPS"} title={t("signUp.title")} body={t("signUp.lead")}>
      {config?.registrationOpen === false ? <Notice dark tone="note" text={t("signUp.closed")} testID="sign-up-closed" /> : null}
      <Field
        dark
        testID="sign-up-name"
        label={t("signUp.name")}
        onChangeText={edit(name.change)}
        autoComplete="name"
        textContentType="name"
        maxLength={60}
        returnKeyType="next"
        onSubmitEditing={() => emailRef.current?.focus()}
      />
      <Field
        dark
        ref={emailRef}
        testID="sign-up-email"
        label={t("signIn.email")}
        onChangeText={edit(email.change)}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
      />
      <View style={styles.block}>
        <Field
          dark
          ref={passwordRef}
          testID="sign-up-password"
          label={t("signIn.password")}
          onChangeText={edit(password.change)}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          passwordRules={`minlength: ${policy.minLength};`}
          returnKeyType="done"
        />
        <Text style={styles.hint}>{t(`shared.${hint.key}`, hint.params ?? {})}</Text>
      </View>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: accepted }}
        accessibilityLabel={t("signUp.acceptLabel")}
        onPress={() => {
          setAccepted(!accepted);
          setError(null);
        }}
        style={styles.accept}
        testID="sign-up-accept"
      >
        <View style={[styles.box, accepted && styles.boxOn]}>{accepted ? <Check color="#101623" size={16} strokeWidth={3} /> : null}</View>
        <Text style={styles.acceptText}>
          {t("signUp.acceptBefore")}
          <Text style={styles.link} onPress={() => void Linking.openURL(`${server}/terms`)}>
            {t("services.termsLink")}
          </Text>
          {t("signUp.acceptMiddle")}
          <Text style={styles.link} onPress={() => void Linking.openURL(`${server}/privacy`)}>
            {t("services.privacyLink")}
          </Text>
          .
        </Text>
      </Pressable>
      {error ? <Notice dark text={error} testID="sign-up-error" /> : null}
      <Button kind="signal" label={t("signUp.submit")} busy={busy} onPress={() => void submit()} testID="sign-up-submit" />
      <ServiceButtons from="signUp" />
      <Pressable accessibilityRole="button" onPress={() => router.back()} testID="sign-up-back">
        <Text style={authStyles.link}>{t("signUp.haveAccount")}</Text>
      </Pressable>
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  block: { gap: 6 },
  hint: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18, color: "#98a2b3" },
  accept: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 1.5, borderColor: "#667186", alignItems: "center", justifyContent: "center", marginTop: 1 },
  boxOn: { backgroundColor: "#3ddc97", borderColor: "#3ddc97" },
  acceptText: { flex: 1, fontFamily: FONT.regular, fontSize: 15, lineHeight: 22, color: "#d0d5dd" },
  link: { fontFamily: FONT.semibold, color: "#3ddc97" },
});
