// Anti-theft (module A): cutting the engine remotely, in two steps, and the
// recovery mode with its link for the authorities. Same rules as the web
// app's (apps/web/src/app/security/SecurityCard.tsx): the platform checks
// speed and position first, and the person confirms by typing the word.
import { COMMAND_TTL_MIN, confirmWord, isConfirmWord, LOCK_MAX_SPEED_KMH, type LockCheck, type Vehicle, type VehicleSecurity } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen, ShieldAlert } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, Share, StyleSheet, Switch, Text, View } from "react-native";
import { shareLink } from "../../lib/address";
import { cancelLock, errorText, getSecurity, prepareLock, requestLock, setRecovery } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { currentLanguage } from "../../lib/i18n";
import { useCan } from "../../lib/session";
import { useSaved } from "../../lib/storage";
import { FONT, useTheme } from "../../lib/theme";
import { Button, Card, Field, Notice } from "../ui";

type Action = "lock" | "unlock";
const FAILED = ["expired", "failed", "unconfirmed"];
const minutesUntil = (iso: string, now = Date.now()) => Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));

export function SecurityCard(props: { vehicle: Vehicle; now: number }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const canCommand = useCan("commands.send");
  const { vehicle, now } = props;
  const key = ["security", vehicle.id];
  const security = useQuery({
    queryKey: key,
    queryFn: () => getSecurity(vehicle.id),
    // While a command waits or travels, its state is asked again often.
    refetchInterval: (q) => (q.state.data?.pending ? 5000 : false),
  });
  const keep = (s: VehicleSecurity) => queryClient.setQueryData(key, s);
  const [action, setAction] = useState<Action | null>(null);
  /** The link for the authorities, only right after turning recovery on. */
  const [link, setLink] = useState<string | null>(null);
  const server = useSaved((s) => s.server);

  const cancel = useMutation({ mutationFn: () => cancelLock(vehicle.id), onSuccess: keep });
  const recovery = useMutation({
    mutationFn: (on: boolean) => setRecovery(vehicle.id, on),
    onSuccess: ({ security: s, shareToken }) => {
      keep(s);
      setLink(shareToken && server ? shareLink(server, shareToken) : null);
    },
  });
  const s = security.data;
  if (!s) return null;

  const locked = s.lock?.state === "locked";
  const last = s.commands[0];
  const failed = !s.pending && last && FAILED.includes(last.status) ? last : null;
  const status = (st: string) => t(`shared.commandStatus.${st}`);
  const note = !s.lock
    ? t("security.note.never")
    : t(`security.note.${locked ? "lock" : "unlock"}${s.lock.confirmed ? "Confirmed" : "Sent"}`, { when: timeAgo(s.lock.changedAt, now) });

  const sendLink = (url: string) => void Share.share({ message: t("security.recovery.message", { name: vehicle.name, url }) }).catch(() => undefined);
  const toggleRecovery = (on: boolean) => {
    if (on) return recovery.mutate(true);
    Alert.alert(t("security.recovery.offTitle"), t("security.recovery.offBody"), [
      { text: t("security.recovery.cancel"), style: "cancel" },
      {
        text: t("security.recovery.off"),
        style: "destructive",
        onPress: () => {
          setLink(null);
          recovery.mutate(false);
        },
      },
    ]);
  };

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        {locked ? <Lock color={theme.danger} size={20} /> : <LockOpen color={theme.muted} size={20} />}
        <View style={styles.text}>
          <Text style={[styles.title, { color: theme.ink }]} testID="lock-state">
            {locked ? t("security.lock.locked") : t("security.lock.unlocked")}
          </Text>
          <Text style={[styles.note, { color: theme.muted }]}>{note}</Text>
        </View>
      </View>

      {s.pending ? (
        <View style={[styles.box, { backgroundColor: theme.canvas }]} testID="lock-pending">
          <Text style={[styles.boxTitle, { color: theme.ink }]}>{t(`security.pending.${s.pending.kind}`, { status: status(s.pending.status) })}</Text>
          <Text style={[styles.note, { color: theme.muted }]}>
            {s.pending.status === "waiting"
              ? t("security.pending.expires", { note: s.pending.note ?? status("waiting"), minutes: minutesUntil(s.pending.expiresAt, now) })
              : t("security.pending.sent")}
          </Text>
          {s.pending.status === "waiting" && canCommand ? (
            <Pressable accessibilityRole="button" disabled={cancel.isPending} onPress={() => cancel.mutate()} testID="lock-cancel">
              <Text style={[styles.link, { color: theme.danger }]}>{t("security.pending.cancel")}</Text>
            </Pressable>
          ) : null}
          {cancel.isError ? <Notice text={errorText(cancel.error)} /> : null}
        </View>
      ) : null}
      {failed ? (
        <Notice text={t(`security.lastFailed.${failed.kind}${failed.note ? "Note" : ""}`, { status: status(failed.status), note: failed.note ?? "" })} />
      ) : null}
      {s.lockSupported === false ? <Notice tone="note" text={t("security.lock.unsupported")} /> : null}
      {s.lockSupported === null ? <Notice tone="note" text={t("security.lock.supportUnknown")} /> : null}

      {action ? (
        <LockSteps vehicle={vehicle} action={action} now={now} onDone={(saved) => (saved && keep(saved), setAction(null))} />
      ) : canCommand && s.lockSupported && !s.pending ? (
        <Button
          kind={locked ? "secondary" : "danger"}
          label={locked ? t("security.lock.unlockStart") : t("security.lock.lockStart")}
          onPress={() => setAction(locked ? "unlock" : "lock")}
          testID="lock-start"
        />
      ) : null}

      <View style={[styles.recovery, { borderTopColor: theme.line }]}>
        <ShieldAlert color={s.recovery ? theme.danger : theme.muted} size={20} />
        <View style={styles.text}>
          <Text style={[styles.title, { color: theme.ink }]}>{t("security.recovery.title")}</Text>
          <Text style={[styles.note, { color: theme.muted }]}>
            {s.recovery ? t("security.recovery.active", { since: timeAgo(s.recovery.since, now) }) : t("security.recovery.inactive")}
          </Text>
        </View>
        <Switch
          testID="recovery-switch"
          accessibilityLabel={t("security.recovery.title")}
          value={recovery.isPending ? recovery.variables : s.recovery !== null}
          disabled={!canCommand || recovery.isPending}
          onValueChange={toggleRecovery}
          trackColor={{ true: theme.danger, false: theme.line }}
        />
      </View>
      {recovery.isError ? <Notice text={errorText(recovery.error)} /> : null}
      {link ? (
        <View style={styles.block} testID="recovery-link">
          <Text style={[styles.note, { color: theme.ink }]}>{t("security.recovery.linkBody", { name: vehicle.name })}</Text>
          <Text style={[styles.label, { color: theme.muted }]}>{t("security.recovery.linkLabel")}</Text>
          <Text selectable style={[styles.url, { color: theme.ink, backgroundColor: theme.canvas, borderColor: theme.line }]}>
            {link}
          </Text>
          <Button label={t("security.recovery.send")} onPress={() => sendLink(link)} testID="recovery-send" />
          <Text style={[styles.small, { color: theme.muted }]}>{t("security.recovery.copyNow")}</Text>
        </View>
      ) : null}
    </Card>
  );
}

/** The two steps: the platform checks the vehicle, then the person types the word and confirms. */
function LockSteps(props: { vehicle: Vehicle; action: Action; now: number; onDone: (saved: VehicleSecurity | null) => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { vehicle, action } = props;
  const [word, setWord] = useState("");
  const check = useQuery<LockCheck>({
    queryKey: ["lock-check", vehicle.id, action],
    queryFn: () => prepareLock(vehicle.id, action),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const send = useMutation({
    mutationFn: () => requestLock(vehicle.id, { action, confirmToken: check.data?.confirmToken ?? "", word: word.trim() }),
    onSuccess: (saved) => props.onDone(saved),
  });
  const expected = confirmWord(action, currentLanguage());
  const ready = check.isSuccess && isConfirmWord(action, word);
  const c = check.data;

  return (
    <View style={[styles.box, { backgroundColor: theme.canvas }]} testID="lock-steps">
      <Text style={[styles.note, { color: theme.ink }]}>
        {action === "lock" ? t("security.dialog.lockBody", { name: vehicle.name, speed: LOCK_MAX_SPEED_KMH }) : t("security.dialog.unlockBody", { name: vehicle.name })}
      </Text>
      {check.isError ? <Notice text={errorText(check.error)} /> : null}
      {c ? (
        <>
          <View style={styles.facts}>
            <Fact label={t("security.dialog.speedNow")} value={c.speedKmh === null ? "—" : `${c.speedKmh} km/h`} />
            <Fact label={t("security.dialog.lastFix")} value={c.fixAgeS === null ? t("security.dialog.noFix") : timeAgo(new Date(Date.now() - c.fixAgeS * 1000).toISOString())} />
          </View>
          {action === "lock" ? (
            <Notice tone={c.safeNow ? "note" : "error"} text={c.safeNow ? t("security.dialog.safeNow") : t("security.dialog.notSafe", { speed: LOCK_MAX_SPEED_KMH, minutes: COMMAND_TTL_MIN })} testID="lock-safety" />
          ) : null}
          <Field label={t("security.dialog.typeWord", { word: expected })} value={word} onChangeText={setWord} autoCapitalize="characters" autoCorrect={false} testID="lock-word" />
        </>
      ) : null}
      {send.isError ? (
        <>
          <Notice text={errorText(send.error)} />
          <Pressable accessibilityRole="button" onPress={() => (send.reset(), void check.refetch())}>
            <Text style={[styles.link, { color: theme.signalInk }]}>{t("security.dialog.recheck")}</Text>
          </Pressable>
        </>
      ) : null}
      <View style={styles.actions}>
        <View style={styles.action}>
          <Button kind="secondary" label={t("security.dialog.cancel")} onPress={() => props.onDone(null)} />
        </View>
        <View style={styles.action}>
          <Button
            kind={action === "lock" ? "danger" : "primary"}
            label={action === "lock" ? t("security.dialog.lock") : t("security.dialog.unlock")}
            busy={send.isPending || check.isFetching}
            disabled={!ready}
            onPress={() => send.mutate()}
            testID="lock-confirm"
          />
        </View>
      </View>
    </View>
  );
}

function Fact(props: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.fact}>
      <Text style={[styles.small, { color: theme.muted }]}>{props.label}</Text>
      <Text style={[styles.factValue, { color: theme.ink }]}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 14, gap: 10 },
  head: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  text: { flex: 1, gap: 2 },
  title: { fontFamily: FONT.semibold, fontSize: 16 },
  note: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
  box: { padding: 12, borderRadius: 12, gap: 10 },
  boxTitle: { fontFamily: FONT.semibold, fontSize: 14 },
  link: { fontFamily: FONT.semibold, fontSize: 14 },
  facts: { flexDirection: "row", gap: 12 },
  fact: { flex: 1, gap: 2 },
  factValue: { fontFamily: FONT.mono, fontSize: 15 },
  actions: { flexDirection: "row", gap: 8 },
  action: { flex: 1 },
  recovery: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  block: { gap: 8 },
  label: { fontFamily: FONT.medium, fontSize: 13 },
  url: { fontFamily: FONT.mono, fontSize: 12, padding: 10, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  small: { fontFamily: FONT.regular, fontSize: 12, lineHeight: 17 },
});
