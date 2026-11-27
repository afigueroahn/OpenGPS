// The person's passkeys in the app, as on the web (ADR-0024): the list, and renaming
// and deleting them with the app's own session. Creating one goes through the
// system's sign-in window, where the person signs in again (ADR-0023).
import { APP_PASSKEY_RETURN, type Passkey } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, type LucideIcon, Pencil, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { deletePasskey, errorText, listPasskeys, passkeyCreateUrl, renamePasskey } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { readPasskeyReturn } from "../lib/oauth";
import { useConfig } from "../lib/session";
import { FONT, useTheme } from "../lib/theme";
import { Card, LinkRow, Notice, SectionTitle } from "./ui";

const KEY = ["passkeys"];

/** Only where the platform has passkeys (ADR-0020). */
export function PasskeysSection() {
  const config = useConfig().data;
  if (!config?.passkeys) return null;
  // Creating one needs the platform's page for it (ADR-0023): one from before it would show its home instead.
  return <Passkeys fromApp={config.passkeysFromApp === true} />;
}

function Passkeys({ fromApp }: { fromApp: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: listPasskeys });
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const [opening, setOpening] = useState(false);
  const [said, setSaid] = useState<{ text: string; tone: "note" | "error" } | null>(null);
  const passkeys = list.data ?? [];

  const create = async () => {
    if (opening) return;
    setOpening(true);
    setSaid(null);
    try {
      const WebBrowser = await import("expo-web-browser");
      // Ephemeral: the window starts without a session, so the person signs in again and the session is fresh.
      const result = await WebBrowser.openAuthSessionAsync(passkeyCreateUrl(), APP_PASSKEY_RETURN, { preferEphemeralSession: true });
      if (result.type !== "success") return;
      const back = readPasskeyReturn(result.url);
      if (back && "created" in back) {
        setSaid({ text: t("passkey.created"), tone: "note" });
        await refresh();
      }
      // Whoever cancelled on the page knows it already.
      else if (back?.error !== "access_denied") setSaid({ text: t("passkey.failed"), tone: "error" });
    } catch {
      setSaid({ text: t("passkey.failed"), tone: "error" });
    } finally {
      setOpening(false);
    }
  };

  return (
    <>
      <SectionTitle text={t("passkeys.title")} />
      <Card testID="passkeys">
        {list.isPending ? (
          <View style={[styles.message, fromApp && line(theme.line)]}>
            <ActivityIndicator color={theme.muted} />
          </View>
        ) : null}
        {list.isError ? (
          <View style={[styles.message, fromApp && line(theme.line)]}>
            <Notice text={errorText(list.error)} testID="passkeys-error" />
          </View>
        ) : null}
        {list.isSuccess && passkeys.length === 0 ? (
          <View style={[styles.message, fromApp && line(theme.line)]}>
            <Notice text={t(fromApp ? "passkeys.none" : "passkeys.noneHere")} tone="note" testID="passkeys-none" />
          </View>
        ) : null}
        {passkeys.map((p, i) => (
          <PasskeyRow
            key={p.id}
            passkey={p}
            last={!fromApp && i === passkeys.length - 1}
            onChange={() => {
              // What was said about the last one created no longer applies.
              setSaid(null);
              return refresh();
            }}
          />
        ))}
        {fromApp ? <LinkRow label={t("passkey.create")} {...(opening ? { value: t("passkey.opening") } : {})} onPress={() => void create()} last testID="create-passkey" /> : null}
        {said ? (
          <View style={styles.said}>
            <Notice text={said.text} tone={said.tone} testID="create-passkey-result" />
          </View>
        ) : null}
      </Card>
    </>
  );
}

/** One passkey: its name, which is renamed in place, when it was created, and deleting it. */
function PasskeyRow(props: { passkey: Passkey; last: boolean; onChange: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { passkey } = props;
  const name = passkey.name || t("passkeys.unnamed");
  // The name being written; null while it is not being renamed.
  const [draft, setDraft] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (next: string) => renamePasskey(passkey.id, next),
    onSuccess: async () => {
      await props.onChange();
      setDraft(null);
    },
  });
  const remove = useMutation({ mutationFn: () => deletePasskey(passkey.id), onSuccess: props.onChange });
  const edit = () => {
    rename.reset();
    remove.reset();
    setDraft(passkey.name ?? "");
  };
  const save = () => {
    const next = draft?.trim() ?? "";
    // An empty name keeps the one it has.
    if (!next || next === passkey.name) return setDraft(null);
    rename.mutate(next);
  };
  const confirmDelete = () => {
    rename.reset();
    Alert.alert(t("passkeys.deleteTitle"), t("passkeys.deleteBody", { name }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("passkeys.deleteConfirm"), style: "destructive", onPress: () => remove.mutate() },
    ]);
  };
  const problem = rename.error ?? remove.error;

  return (
    <View style={[styles.row, !props.last && line(theme.line)]} testID="passkey">
      <View style={styles.icon}>
        <KeyRound color={theme.muted} size={18} />
      </View>
      <View style={styles.what}>
        {draft === null ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t("passkeys.rename", { name })} onPress={edit}>
            <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
              {name}
            </Text>
          </Pressable>
        ) : (
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={save}
            autoFocus
            selectTextOnFocus
            // A device's name, as the person writes it: "iPhone" stays as it is.
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={60}
            returnKeyType="done"
            editable={!rename.isPending}
            placeholder={t("passkeys.namePlaceholder")}
            placeholderTextColor={theme.faint}
            accessibilityLabel={t("passkeys.name")}
            style={[styles.input, { color: theme.ink, borderColor: theme.line, backgroundColor: theme.canvas }]}
            testID="passkey-name"
          />
        )}
        <Text style={[styles.note, { color: theme.muted }]}>{t(passkey.backedUp ? "passkeys.createdSynced" : "passkeys.created", { date: formatDateTime(passkey.createdAt) })}</Text>
        {problem ? <Notice text={errorText(problem)} /> : null}
      </View>
      {draft === null ? (
        <>
          <IconButton icon={Pencil} label={t("passkeys.rename", { name })} onPress={edit} testID="rename-passkey" />
          <IconButton icon={Trash2} label={t("passkeys.delete", { name })} onPress={confirmDelete} busy={remove.isPending} danger testID="delete-passkey" />
        </>
      ) : (
        <>
          <TextButton label={t("common.cancel")} onPress={() => setDraft(null)} disabled={rename.isPending} />
          <TextButton label={t("common.save")} onPress={save} busy={rename.isPending} strong testID="save-passkey" />
        </>
      )}
    </View>
  );
}

function IconButton(props: { icon: LucideIcon; label: string; onPress: () => void; busy?: boolean; danger?: boolean; testID?: string }) {
  const theme = useTheme();
  const Icon = props.icon;
  const color = props.danger ? theme.danger : theme.muted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.busy}
      onPress={props.onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.5 : 1 }]}
      testID={props.testID}
    >
      {props.busy ? <ActivityIndicator color={color} size="small" /> : <Icon color={color} size={18} />}
    </Pressable>
  );
}

function TextButton(props: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean; strong?: boolean; testID?: string }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.busy || props.disabled}
      onPress={props.onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.textButton, { opacity: props.disabled ? 0.4 : pressed ? 0.5 : 1 }]}
      testID={props.testID}
    >
      {props.busy ? (
        <ActivityIndicator color={theme.signalInk} size="small" />
      ) : (
        <Text style={[styles.textButtonLabel, { color: props.strong ? theme.signalInk : theme.muted, fontFamily: props.strong ? FONT.semibold : FONT.medium }]}>{props.label}</Text>
      )}
    </Pressable>
  );
}

const line = (color: string) => ({ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color });

const styles = StyleSheet.create({
  message: { paddingVertical: 12 },
  said: { paddingBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12, gap: 10 },
  icon: { alignSelf: "flex-start", marginTop: 2 },
  what: { flex: 1, gap: 2 },
  name: { fontFamily: FONT.medium, fontSize: 15 },
  note: { fontFamily: FONT.regular, fontSize: 12.5 },
  input: { height: 36, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, fontFamily: FONT.regular, fontSize: 15 },
  iconButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  textButton: { minWidth: 44, height: 32, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  textButtonLabel: { fontSize: 15 },
});
