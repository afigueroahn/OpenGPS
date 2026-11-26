// Your details: the name everyone sees, and the phone where SMS notifications
// reach you. The same rules as the platform's (userSettingsSchema).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { ModalScreen } from "../../components/ModalScreen";
import { Button, Field, Notice } from "../../components/ui";
import { errorText, updateSettings } from "../../lib/api";
import { useMe } from "../../lib/session";
import { useTyped } from "../../lib/typed";

/** A phone with its country code: "+" and 8 to 15 digits, as the platform asks. */
const PHONE = /^\+[1-9]\d{7,14}$/;

export default function ProfileScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = useMe().data;
  const name = useTyped(me?.user.name ?? "");
  const phone = useTyped(me?.settings.phone ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (body: { name?: string; phone?: string | null }) => updateSettings(body),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  if (!me) return null;

  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setSaved(false);
    setProblem(null);
  };
  /** What would change, against what the platform has now. */
  const changes = (typedName: string, typedPhone: string) => {
    const cleanName = typedName.trim();
    const cleanPhone = typedPhone.replace(/[\s()-]/g, "");
    return {
      cleanName,
      cleanPhone,
      nameChanged: cleanName !== me.user.name,
      phoneChanged: (cleanPhone || null) !== me.settings.phone,
    };
  };
  const shown = changes(name.text, phone.text);

  const submit = () => {
    setSaved(false);
    const { cleanName, cleanPhone, nameChanged, phoneChanged } = changes(name.latest(), phone.latest());
    if (nameChanged && cleanName.length < 2) return setProblem(t("profile.badName"));
    if (phoneChanged && cleanPhone !== "" && !PHONE.test(cleanPhone)) return setProblem(t("profile.badPhone"));
    setProblem(null);
    if (!nameChanged && !phoneChanged) return;
    save.mutate({ ...(nameChanged ? { name: cleanName } : {}), ...(phoneChanged ? { phone: cleanPhone || null } : {}) });
  };

  return (
    <ModalScreen title={t("profile.title")} testID="profile">
      <Field label={t("profile.name")} value={name.text} onChangeText={edit(name.change)} maxLength={60} autoComplete="name" textContentType="name" testID="profile-name" />
      <View style={styles.block}>
        <Field
          label={t("profile.phone")}
          value={phone.text}
          onChangeText={edit(phone.change)}
          placeholder="+50499887766"
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          maxLength={20}
          testID="profile-phone"
        />
        <Notice tone="note" text={t("profile.phoneNote")} />
      </View>
      {problem ? <Notice text={problem} testID="profile-error" /> : null}
      {save.isError ? <Notice text={errorText(save.error)} /> : null}
      {saved && !save.isPending ? <Notice tone="note" text={t("profile.saved")} testID="profile-saved" /> : null}
      <Button label={t("profile.save")} busy={save.isPending} disabled={!shown.nameChanged && !shown.phoneChanged} onPress={submit} testID="profile-save" />
      {me.settings.phone !== null ? (
        <Button
          kind="danger"
          label={t("profile.remove")}
          disabled={save.isPending}
          onPress={() => {
            phone.change("");
            setSaved(false);
            save.mutate({ phone: null });
          }}
        />
      ) : null}
    </ModalScreen>
  );
}

const styles = StyleSheet.create({ block: { gap: 8 } });
