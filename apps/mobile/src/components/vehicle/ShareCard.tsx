// Share a vehicle's location with someone outside: a temporary link, sent with
// the phone's share menu, and the links still alive, to revoke them. Same
// rules as the web app's (ShareDialog): the link is shown only when created.
import { SHARE_DURATIONS, type ShareLink, type Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Share2 } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Share, StyleSheet, Text, View } from "react-native";
import { shareLink } from "../../lib/address";
import { createShare, errorText, getShares, revokeShare } from "../../lib/api";
import { formatDateTime, formatDuration } from "../../lib/format";
import i18n from "../../lib/i18n";
import { useCan } from "../../lib/session";
import { useSaved } from "../../lib/storage";
import { FONT, useTheme } from "../../lib/theme";
import { Button, Card, Notice, Segmented } from "../ui";

/** "8 horas", "3 días": whole days are said in days. */
const durationLabel = (hours: number) => (hours % 24 === 0 ? i18n.t("share.days", { count: hours / 24 }) : i18n.t("share.hours", { count: hours }));

export function ShareCard(props: { vehicle: Vehicle }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const canShare = useCan("links.share");
  const server = useSaved((s) => s.server);
  const { vehicle } = props;
  const [hours, setHours] = useState<number>(8);
  /** The newly created link: it can only be sent now. */
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);

  const links = useQuery({ queryKey: ["shares", vehicle.id], queryFn: () => getShares(vehicle.id), enabled: canShare });
  const send = (url: string) => void Share.share({ message: t("share.message", { name: vehicle.name, url }) }).catch(() => undefined);
  const create = useMutation({
    mutationFn: () => createShare(vehicle.id, { hours, note: "" }),
    onSuccess: async ({ link, token }) => {
      const url = shareLink(server ?? "", token);
      setFresh({ id: link.id, url });
      await queryClient.invalidateQueries({ queryKey: ["shares", vehicle.id] });
      send(url);
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeShare(id),
    onSuccess: (_, id) => {
      // A revoked link no longer works: it stops being offered.
      setFresh((f) => (f?.id === id ? null : f));
      return queryClient.invalidateQueries({ queryKey: ["shares", vehicle.id] });
    },
  });
  if (!canShare) return null;

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Share2 color={theme.signalInk} size={20} />
        <Text style={[styles.title, { color: theme.ink }]}>{t("share.title")}</Text>
      </View>
      <Text style={[styles.note, { color: theme.muted }]}>{t("share.intro", { name: vehicle.name })}</Text>

      {fresh ? (
        <View style={styles.block}>
          <Notice tone="note" text={t("share.created")} />
          <Text selectable style={[styles.link, { color: theme.ink, backgroundColor: theme.canvas, borderColor: theme.line }]} testID="share-link">
            {fresh.url}
          </Text>
          <View style={styles.actions}>
            <View style={styles.action}>
              <Button kind="primary" label={t("share.send")} onPress={() => send(fresh.url)} />
            </View>
            <View style={styles.action}>
              <Button kind="secondary" label={t("share.another")} onPress={() => setFresh(null)} />
            </View>
          </View>
          <Text style={[styles.small, { color: theme.muted }]}>{t("share.warning")}</Text>
        </View>
      ) : (
        <View style={styles.block}>
          <Text style={[styles.label, { color: theme.muted }]}>{t("share.duration")}</Text>
          <Segmented
            testID="share-hours"
            value={String(hours)}
            onChange={(v) => setHours(Number(v))}
            options={SHARE_DURATIONS.map((h) => ({ value: String(h), label: durationLabel(h) }))}
          />
          {create.isError ? <Notice text={errorText(create.error)} /> : null}
          <Button kind="primary" label={t("share.create")} busy={create.isPending} onPress={() => create.mutate()} testID="share-create" />
        </View>
      )}

      <Text style={[styles.label, { color: theme.muted }]}>{t("share.alive")}</Text>
      {links.isSuccess && links.data.length === 0 ? <Text style={[styles.small, { color: theme.muted }]}>{t("share.none")}</Text> : null}
      {links.data?.map((link) => (
        <View key={link.id} style={[styles.row, { borderTopColor: theme.line }]}>
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, { color: theme.ink }]} numberOfLines={1}>
              {link.note || t("share.noNote")}
            </Text>
            <Text style={[styles.small, { color: theme.muted }]}>{detailOf(link)}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={revoke.isPending}
            onPress={() => revoke.mutate(link.id)}
            hitSlop={8}
            testID={`share-revoke-${link.id}`}
          >
            <Text style={[styles.revoke, { color: theme.danger, opacity: revoke.isPending && revoke.variables === link.id ? 0.5 : 1 }]}>{t("share.revoke")}</Text>
          </Pressable>
        </View>
      ))}
      {revoke.isError ? <Notice text={errorText(revoke.error)} /> : null}
    </Card>
  );
}

/** "Vence en 7 h 55 min · abierto 3 veces" */
function detailOf(link: ShareLink): string {
  const left = (Date.parse(link.expiresAt) - Date.now()) / 1000;
  const expires = left > 48 * 3600 ? i18n.t("share.expiresOn", { date: formatDateTime(link.expiresAt) }) : i18n.t("share.expiresIn", { duration: formatDuration(left) });
  const opened = link.views === 0 ? i18n.t("share.notOpened") : i18n.t("share.opened", { count: link.views });
  return `${expires} · ${opened}${link.createdBy ? ` · ${link.createdBy}` : ""}`;
}

const styles = StyleSheet.create({
  card: { paddingVertical: 14, gap: 10 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontFamily: FONT.semibold, fontSize: 16 },
  note: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
  block: { gap: 10 },
  label: { fontFamily: FONT.medium, fontSize: 13, marginTop: 4 },
  link: { fontFamily: FONT.mono, fontSize: 12, padding: 10, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  actions: { flexDirection: "row", gap: 8 },
  action: { flex: 1 },
  small: { fontFamily: FONT.regular, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontFamily: FONT.medium, fontSize: 14 },
  revoke: { fontFamily: FONT.semibold, fontSize: 14 },
});
