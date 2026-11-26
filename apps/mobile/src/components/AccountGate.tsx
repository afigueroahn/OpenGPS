// What stops the person before the app: terms to accept again, or an account
// the platform suspended.
import type { Me } from "@opengps/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, Text } from "react-native";
import { acceptTerms, setActiveAccount } from "../lib/api";
import { useConfig } from "../lib/session";
import { getSaved } from "../lib/storage";
import { signOut } from "../lib/signOut";
import { AuthFrame, authStyles } from "./AuthFrame";
import { Button, Notice } from "./ui";

export function AccountGate(props: { me: Me }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const config = useConfig();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const { me } = props;
  const server = getSaved().server ?? "";

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(false);
    try {
      await action();
      await queryClient.invalidateQueries();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  if (me.needsConsent) {
    return (
      <AuthFrame title={t("consent.title")} body={t("consent.body", { app: config.data?.appName ?? "OpenGPS" })}>
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(`${server}/terms`)}>
          <Text style={authStyles.link}>{t("consent.terms")}</Text>
        </Pressable>
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(`${server}/privacy`)}>
          <Text style={authStyles.link}>{t("consent.privacy")}</Text>
        </Pressable>
        {error ? <Notice dark text={t("errors.network")} /> : null}
        <Button kind="signal" label={t("consent.accept")} busy={busy} onPress={() => void run(acceptTerms)} testID="consent-accept" />
        <Button dark kind="secondary" label={t("account.signOut")} onPress={() => void signOut(queryClient)} />
      </AuthFrame>
    );
  }

  const others = me.accounts.filter((a) => a.id !== me.account.id);
  return (
    <AuthFrame title={t("suspended.title")} body={t("suspended.body", { name: me.account.name })}>
      {error ? <Notice dark text={t("errors.network")} /> : null}
      {others.map((a) => (
        <Button key={a.id} kind="signal" label={t("suspended.goTo", { name: a.name })} busy={busy} onPress={() => void run(() => setActiveAccount(a.id))} />
      ))}
      <Button dark kind="secondary" label={t("account.signOut")} onPress={() => void signOut(queryClient)} />
    </AuthFrame>
  );
}
