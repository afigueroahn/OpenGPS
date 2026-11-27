// The person's account: who they are (and their photo, which they change
// here), their passkeys, which account they are using, their language and theme, the
// platform, and signing out.
import { type Language, type ThemeMode } from "@opengps/shared";
import { useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { PasskeysSection } from "../../../components/Passkeys";
import { ProfilePhoto } from "../../../components/ProfilePhoto";
import { SummaryCard } from "../../../components/SummaryCard";
import { Button, Card, LinkRow, Row, SectionTitle, Segmented } from "../../../components/ui";
import { setActiveAccount, updateSettings } from "../../../lib/api";
import i18n from "../../../lib/i18n";
import { select } from "../../../lib/selection";
import { useConfig, useMe } from "../../../lib/session";
import { signOut } from "../../../lib/signOut";
import { save, useSaved } from "../../../lib/storage";
import { FONT, useTheme } from "../../../lib/theme";

export default function AccountScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const router = useRouter();
  const me = useMe().data;
  const config = useConfig().data;
  const server = useSaved((s) => s.server);
  const mode = useSaved((s) => s.theme);
  const [language, setLanguage] = useState(i18n.language as Language);
  const [switching, setSwitching] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  if (!me) return null;

  const chooseLanguage = (next: Language) => {
    setLanguage(next);
    save({ language: next });
    void i18n.changeLanguage(next);
    // What the platform words (the role's name, for example) comes again in the new language.
    void updateSettings({ language: next })
      .then(() => queryClient.invalidateQueries({ queryKey: ["me"] }))
      .catch(() => undefined);
  };
  const chooseTheme = (next: ThemeMode) => {
    save({ theme: next });
    void updateSettings({ theme: next }).catch(() => undefined);
  };
  const switchAccount = async (id: string) => {
    setSwitching(id);
    try {
      await setActiveAccount(id);
      select(null);
      await queryClient.invalidateQueries();
    } finally {
      setSwitching(null);
    }
  };
  const leave = async (forgetServer: boolean) => {
    setLeaving(true);
    await signOut(queryClient, { forgetServer });
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} testID="account">
      <View style={styles.profile}>
        <ProfilePhoto user={me.user} size={56} />
        <View style={styles.who}>
          <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
            {me.user.name}
          </Text>
          <Text style={[styles.email, { color: theme.muted }]} numberOfLines={1}>
            {me.user.email}
          </Text>
        </View>
      </View>

      <SectionTitle text={t("summary.title")} />
      <SummaryCard />

      <SectionTitle text={t("profile.title")} />
      <Pressable accessibilityRole="button" accessibilityLabel={t("profile.edit")} onPress={() => router.push("/profile")} testID="edit-profile">
        {({ pressed }) => (
          <Card style={{ opacity: pressed ? 0.7 : 1 }}>
            <Row label={t("profile.name")} value={me.user.name} />
            <Row label={t("profile.phone")} value={me.settings.phone ?? t("profile.noPhone")} mono={me.settings.phone !== null} last />
          </Card>
        )}
      </Pressable>
      <Card style={styles.password}>
        <LinkRow label={t("password.title")} {...(me.user.hasPassword ? {} : { value: t("password.none") })} onPress={() => router.push("/password")} last testID="password" />
      </Card>
      <PasskeysSection />

      <SectionTitle text={t("account.accounts")} />
      <Card>
        {me.accounts.map((a, i) => {
          const current = a.id === me.account.id;
          return (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityState={{ selected: current }}
              disabled={current || switching !== null}
              onPress={() => void switchAccount(a.id)}
              style={[styles.accountRow, i < me.accounts.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line }]}
            >
              <View style={styles.who}>
                <Text style={[styles.accountName, { color: theme.ink }]}>{a.name}</Text>
                {current ? <Text style={[styles.email, { color: theme.muted }]}>{me.account.roleName}</Text> : null}
              </View>
              {current ? <Check color={theme.signalInk} size={20} /> : null}
            </Pressable>
          );
        })}
      </Card>

      <SectionTitle text={t("account.preferences")} />
      <Card style={styles.prefs}>
        <Text style={[styles.prefLabel, { color: theme.muted }]}>{t("language.label")}</Text>
        <Segmented
          testID="language"
          value={language}
          onChange={chooseLanguage}
          options={[
            { value: "es", label: t("language.es") },
            { value: "en", label: t("language.en") },
          ]}
        />
        <Text style={[styles.prefLabel, { color: theme.muted }]}>{t("theme.label")}</Text>
        <Segmented
          testID="theme"
          value={mode}
          onChange={chooseTheme}
          options={[
            { value: "system", label: t("theme.system") },
            { value: "light", label: t("theme.light") },
            { value: "dark", label: t("theme.dark") },
          ]}
        />
      </Card>

      <SectionTitle text={t("account.server")} />
      <Card>
        <Row label={t("account.server")} value={server?.replace(/^https?:\/\//, "") ?? ""} />
        <Row label={t("account.platformVersion")} value={config?.version ?? "—"} mono />
        <LinkRow label={t("account.terms")} onPress={() => void Linking.openURL(`${server}/terms`)} testID="terms" />
        <LinkRow label={t("account.privacy")} onPress={() => void Linking.openURL(`${server}/privacy`)} last testID="privacy" />
      </Card>

      <View style={styles.actions}>
        <Button kind="secondary" label={t("account.changeServer")} disabled={leaving} onPress={() => void leave(true)} />
        <Button kind="danger" label={t("account.signOut")} busy={leaving} onPress={() => void leave(false)} testID="sign-out" />
      </View>
      <Pressable accessibilityRole="button" onPress={() => router.push("/delete-account")} hitSlop={8} testID="delete-account">
        <Text style={[styles.deleteLink, { color: theme.danger }]}>{t("deleteAccount.open")}</Text>
      </Pressable>
      <Text style={[styles.version, { color: theme.faint }]}>{t("account.version", { version: Constants.expoConfig?.version ?? "" })}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  profile: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 8 },
  who: { flex: 1, gap: 2 },
  password: { marginTop: 10 },
  name: { fontFamily: FONT.bold, fontSize: 20 },
  email: { fontFamily: FONT.regular, fontSize: 14 },
  accountRow: { flexDirection: "row", alignItems: "center", paddingVertical: 14, gap: 12 },
  accountName: { fontFamily: FONT.medium, fontSize: 16 },
  prefs: { paddingVertical: 14, gap: 10 },
  prefLabel: { fontFamily: FONT.medium, fontSize: 13 },
  actions: { gap: 10, marginTop: 28 },
  version: { fontFamily: FONT.regular, fontSize: 12, textAlign: "center", marginTop: 20 },
  deleteLink: { fontFamily: FONT.medium, fontSize: 14, textAlign: "center", marginTop: 24 },
});
