// After signing up: the platform sent an email to confirm the account. Its
// link opens the platform's own page; from there the person comes back and
// signs in. The link can be sent again. Same as the web app's (CheckEmail).
import { useLocalSearchParams, useRouter } from "expo-router";
import { MailCheck } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AuthFrame, authStyles } from "../components/AuthFrame";
import { Button, Notice } from "../components/ui";
import { auth } from "../lib/api";
import { FONT } from "../lib/theme";

export default function CheckEmailScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const resend = async () => {
    if (!email) return;
    setStatus("sending");
    try {
      await auth.resendVerification(email);
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  };

  return (
    <AuthFrame title={t("checkEmail.title")}>
      <View style={styles.icon}>
        <MailCheck color="#3ddc97" size={24} />
      </View>
      <Text style={styles.body} testID="check-email-sent">
        {t("checkEmail.sentBefore")}
        <Text style={styles.email}>{email ?? ""}</Text>
        {t("checkEmail.sentAfter")}
      </Text>
      <Notice dark tone="note" text={t("checkEmail.slow")} />
      {status === "sent" ? <Notice dark tone="note" text={t("signIn.resentOk")} testID="check-email-resent" /> : null}
      {status === "error" ? <Notice dark text={t("signIn.resendFailed")} /> : null}
      <Button dark kind="secondary" label={t("checkEmail.resend")} busy={status === "sending"} onPress={() => void resend()} testID="check-email-resend" />
      <Pressable accessibilityRole="button" onPress={() => router.dismissTo("/sign-in")} testID="check-email-sign-in">
        <Text style={authStyles.link}>{t("checkEmail.signIn")}</Text>
      </Pressable>
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  icon: { width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(61,220,151,0.15)", alignItems: "center", justifyContent: "center" },
  body: { fontFamily: FONT.regular, fontSize: 16, lineHeight: 23, color: "#d0d5dd" },
  email: { fontFamily: FONT.semibold, color: "#ffffff" },
});
