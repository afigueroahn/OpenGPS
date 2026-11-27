// Creating a passkey from the app (ADR-0023): the platform's page opens in the
// system's sign-in window, without the app's session, so the person signs in
// again there and creates it with Face ID. The app's own session does not change.
import { APP_PASSKEY_RETURN } from "@opengps/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { passkeyCreateUrl } from "../lib/api";
import { readPasskeyReturn } from "../lib/oauth";
import { useConfig } from "../lib/session";
import { Card, LinkRow, Notice } from "./ui";

export function CreatePasskey() {
  const { t } = useTranslation();
  // Only where the platform has the page for it: one from before it (ADR-0023) would show its home instead.
  const passkeys = useConfig().data?.passkeysFromApp === true;
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; tone: "note" | "error" } | null>(null);
  if (!passkeys) return null;

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    try {
      const WebBrowser = await import("expo-web-browser");
      // Ephemeral: the window starts without a session, so the person signs in again and the session is fresh.
      const result = await WebBrowser.openAuthSessionAsync(passkeyCreateUrl(), APP_PASSKEY_RETURN, { preferEphemeralSession: true });
      if (result.type !== "success") return;
      const back = readPasskeyReturn(result.url);
      if (back && "created" in back) setSaid({ text: t("passkey.created"), tone: "note" });
      // Whoever cancelled on the page knows it already.
      else if (back?.error !== "access_denied") setSaid({ text: t("passkey.failed"), tone: "error" });
    } catch {
      setSaid({ text: t("passkey.failed"), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={styles.card}>
      <LinkRow label={t("passkey.create")} {...(busy ? { value: t("passkey.opening") } : {})} onPress={() => void open()} last testID="create-passkey" />
      {said ? (
        <View style={styles.said}>
          <Notice text={said.text} tone={said.tone} testID="create-passkey-result" />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 12 },
  said: { paddingBottom: 12 },
});
