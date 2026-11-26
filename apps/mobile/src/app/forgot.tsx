// Forgotten password: the platform emails a link that opens its own page to
// choose a new one. The answer is always the same, so nobody can find out
// which emails have an account.
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text } from "react-native";
import { AuthFrame, authStyles } from "../components/AuthFrame";
import { Button, Field, Notice } from "../components/ui";
import { auth, authMessage } from "../lib/api";
import { useTyped } from "../lib/typed";

export default function ForgotScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string }>();
  const email = useTyped(params.email ?? "");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const typed = email.latest().trim();
    if (!typed) return;
    setBusy(true);
    setError(null);
    try {
      await auth.requestPasswordReset(typed);
      setSent(true);
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title={t("forgot.title")} body={sent ? null : t("forgot.lead")}>
      {sent ? (
        <Notice dark tone="note" text={t("forgot.sent")} testID="forgot-sent" />
      ) : (
        <>
          <Field
            dark
            testID="forgot-email"
            label={t("signIn.email")}
            defaultValue={params.email ?? ""}
            onChangeText={email.change}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            returnKeyType="send"
            onSubmitEditing={() => void submit()}
          />
          {error ? <Notice dark text={error} /> : null}
          <Button kind="signal" label={t("forgot.submit")} busy={busy} disabled={!email.text.trim()} onPress={() => void submit()} testID="forgot-submit" />
        </>
      )}
      <Pressable accessibilityRole="button" onPress={() => router.back()} testID="forgot-back">
        <Text style={authStyles.link}>{t("forgot.back")}</Text>
      </Pressable>
    </AuthFrame>
  );
}
