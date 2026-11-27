// Your password, from the phone, as on the web's profile (ADR-0028): changed with
// the current one, closing the other sessions if you want; the app keeps the new
// session the platform gives it then. Whoever has none gets the link to create
// one sent to their email.
import { PASSWORD_POLICY_DEFAULT, passwordHint, passwordProblem } from "@opengps/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Switch, Text, View } from "react-native";
import { ModalScreen } from "../../components/ModalScreen";
import { Button, Card, Field, Notice } from "../../components/ui";
import { ApiRequestError, auth, authMessage } from "../../lib/api";
import { useConfig, useMe } from "../../lib/session";
import { FONT, useTheme } from "../../lib/theme";
import { useTyped } from "../../lib/typed";

export default function PasswordScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const me = useMe().data;
  const policy = useConfig().data?.passwordPolicy ?? PASSWORD_POLICY_DEFAULT;
  const current = useTyped();
  const next = useTyped();
  const [others, setOthers] = useState(true);
  const [weak, setWeak] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (body: { current: string; next: string; closeOthers: boolean }) => auth.changePassword(body.current, body.next, body.closeOthers),
    onSuccess: () => {
      current.change("");
      next.change("");
    },
  });
  const link = useMutation({ mutationFn: (email: string) => auth.requestPasswordReset(email) });
  if (!me) return null;

  if (!me.user.hasPassword) {
    return (
      <ModalScreen title={t("password.title")} testID="password-screen">
        <Text style={[styles.body, { color: theme.ink }]}>{t("password.noneLead")}</Text>
        {link.isSuccess ? (
          <Notice tone="note" text={t("password.sent", { email: me.user.email })} testID="password-sent" />
        ) : (
          <Button label={t("password.send")} busy={link.isPending} onPress={() => link.mutate(me.user.email)} testID="password-send" />
        )}
        {link.isError ? <Notice text={authMessage(link.error)} /> : null}
      </ModalScreen>
    );
  }

  const typing = (set: (text: string) => void) => (text: string) => {
    set(text);
    setWeak(null);
    change.reset();
  };
  const submit = () => {
    const problem = passwordProblem(next.latest(), policy);
    if (problem) return setWeak(t(`shared.${problem.key}`, problem.params ?? {}));
    change.mutate({ current: current.latest(), next: next.latest(), closeOthers: others });
  };
  const hint = passwordHint(policy);
  const failed = change.error instanceof ApiRequestError && change.error.code === "INVALID_PASSWORD" ? t("password.wrongCurrent") : change.isError ? authMessage(change.error) : null;

  return (
    <ModalScreen title={t("password.title")} testID="password-screen">
      <Field
        label={t("password.current")}
        value={current.text}
        onChangeText={typing(current.change)}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        testID="password-current"
      />
      <View style={styles.block}>
        <Field
          label={t("password.new")}
          value={next.text}
          onChangeText={typing(next.change)}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          passwordRules={`minlength: ${policy.minLength};`}
          testID="password-new"
        />
        <Notice tone={weak ? "error" : "note"} text={weak ?? t(`shared.${hint.key}`, hint.params ?? {})} testID={weak ? "password-weak" : "password-hint"} />
      </View>
      <Card>
        <View style={styles.switchRow}>
          <Text style={[styles.switchLabel, { color: theme.ink }]}>{t("password.others")}</Text>
          <Switch accessibilityLabel={t("password.others")} value={others} onValueChange={setOthers} trackColor={{ true: theme.signal, false: theme.line }} testID="password-others" />
        </View>
      </Card>
      {failed ? <Notice text={failed} testID="password-error" /> : null}
      {change.isSuccess ? <Notice tone="note" text={t(change.variables.closeOthers ? "password.changedOthers" : "password.changed")} testID="password-changed" /> : null}
      <Button label={t("password.save")} busy={change.isPending} disabled={current.text === "" || next.text === ""} onPress={submit} testID="password-save" />
    </ModalScreen>
  );
}

const styles = StyleSheet.create({
  body: { fontFamily: FONT.regular, fontSize: 16, lineHeight: 22 },
  block: { gap: 8 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  switchLabel: { flex: 1, fontFamily: FONT.medium, fontSize: 15 },
});
