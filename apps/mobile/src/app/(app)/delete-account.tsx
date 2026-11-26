// Deleting your account from the phone, as the App Store asks of apps where
// one can be created. Same rules as the web app's (PrivacyDialogs.tsx): the
// password confirms it; whoever has none types the word and needs a recent session.
import { confirmWord, isConfirmWord } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { ModalScreen } from "../../components/ModalScreen";
import { Button, Card, Field, Notice } from "../../components/ui";
import { auth, authMessage } from "../../lib/api";
import { currentLanguage } from "../../lib/i18n";
import { clearAlerts } from "../../lib/alerts";
import { select } from "../../lib/selection";
import { useMe } from "../../lib/session";
import { save } from "../../lib/storage";
import { FONT, useTheme } from "../../lib/theme";
import { useTyped } from "../../lib/typed";

export default function DeleteAccountScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const me = useMe().data;
  const password = useTyped();
  const word = useTyped();

  const remove = useMutation({
    mutationFn: () => auth.deleteAccount(me?.user.hasPassword ? password.latest() : null),
    onSuccess: () => {
      // The person no longer exists on the platform: the app forgets the session and goes back to signing in.
      select(null);
      clearAlerts();
      save({ cookie: "" });
      queryClient.clear();
    },
  });
  if (!me) return null;

  const expected = confirmWord("deleteAccount", currentLanguage());
  const ready = me.user.hasPassword ? password.text !== "" : isConfirmWord("deleteAccount", word.text);
  const points = [t("deleteAccount.vehicles"), t("deleteAccount.people"), t("deleteAccount.final")];

  return (
    <ModalScreen title={t("deleteAccount.title")} testID="delete-account-screen">
      <Text style={[styles.body, { color: theme.ink }]}>{t("deleteAccount.intro", { email: me.user.email })}</Text>
      <Card style={styles.card}>
        {points.map((p) => (
          <View key={p} style={styles.point}>
            <Text style={[styles.bullet, { color: theme.danger }]}>•</Text>
            <Text style={[styles.pointText, { color: theme.muted }]}>{p}</Text>
          </View>
        ))}
      </Card>
      {me.user.hasPassword ? (
        <Field
          label={t("deleteAccount.password")}
          value={password.text}
          onChangeText={password.change}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          testID="delete-password"
        />
      ) : (
        <View style={styles.block}>
          <Notice tone="note" text={t("deleteAccount.noPassword")} />
          <Field label={t("deleteAccount.typeWord", { word: expected })} value={word.text} onChangeText={word.change} autoCapitalize="characters" autoCorrect={false} testID="delete-word" />
        </View>
      )}
      {remove.isError ? <Notice text={authMessage(remove.error)} testID="delete-error" /> : null}
      <Button kind="danger" label={t("deleteAccount.confirm")} busy={remove.isPending} disabled={!ready} onPress={() => remove.mutate()} testID="delete-confirm" />
    </ModalScreen>
  );
}

const styles = StyleSheet.create({
  body: { fontFamily: FONT.regular, fontSize: 16, lineHeight: 22 },
  card: { paddingVertical: 12, gap: 8 },
  point: { flexDirection: "row", gap: 8 },
  bullet: { fontFamily: FONT.bold, fontSize: 15 },
  pointText: { flex: 1, fontFamily: FONT.regular, fontSize: 14, lineHeight: 20 },
  block: { gap: 10 },
});
