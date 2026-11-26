// An incident: its vehicle, how it is going and its timeline. Whoever can
// manage incidents handles it, adds notes and photos as evidence, and closes
// it saying how it ended. Same as the web app's (IncidentsPanel.tsx, Detail).
import { INCIDENT_RESOLUTIONS, type IncidentDetail, type IncidentEntry, type IncidentResolution } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Paperclip } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, ActivityIndicator, Pressable, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { ModalScreen } from "../../components/ModalScreen";
import { Button, Card, Notice, SectionTitle } from "../../components/ui";
import { attendIncident, closeIncident, downloadFile, errorText, evidencePath, getIncident, noteIncident, uploadEvidence } from "../../lib/api";
import { formatDateTime, timeAgo } from "../../lib/format";
import { entryColor, proposedResolution, statusColor } from "../../lib/incidents";
import { PhotoError, pickEvidence } from "../../lib/photo";
import { isSheetOpen, select } from "../../lib/selection";
import { useCan, useNow } from "../../lib/session";
import { FONT, RADIUS, useTheme } from "../../lib/theme";
import { useTyped } from "../../lib/typed";

export default function IncidentScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const query = useQuery({ queryKey: ["incidents", "detail", id], queryFn: () => getIncident(id) });
  return (
    <ModalScreen title={query.data?.vehicleName ?? t("incidents.title")} testID="incident">
      {query.isPending ? <ActivityIndicator /> : query.isError ? <Notice text={errorText(query.error)} /> : <Detail incident={query.data} />}
    </ModalScreen>
  );
}

function Detail({ incident }: { incident: IncidentDetail }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const now = useNow();
  const canManage = useCan("incidents.manage");
  const note = useTyped();
  const closingNote = useTyped();
  const [closing, setClosing] = useState(false);
  const [resolution, setResolution] = useState<IncidentResolution>(proposedResolution(incident.kind));
  const [photoProblem, setPhotoProblem] = useState<string | null>(null);

  const done = (saved: IncidentDetail) => {
    queryClient.setQueryData(["incidents", "detail", saved.id], saved);
    void queryClient.invalidateQueries({ queryKey: ["incidents", "list"] });
  };
  const attend = useMutation({ mutationFn: () => attendIncident(incident.id), onSuccess: done });
  const addNote = useMutation({
    mutationFn: (text: string) => noteIncident(incident.id, text),
    onSuccess: (saved) => {
      note.change("");
      done(saved);
    },
  });
  // The photo's name says when it was attached: "foto-2026-11-26-1202.jpg".
  const photoName = () => `${t("incidents.photoName")}-${new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "")}.jpg`;
  const upload = useMutation({ mutationFn: (photo: Blob) => uploadEvidence(incident.id, photo, photoName()), onSuccess: done });
  const close = useMutation({
    mutationFn: () => closeIncident(incident.id, { resolution, note: closingNote.latest().trim() }),
    onSuccess: (saved) => {
      setClosing(false);
      done(saved);
    },
  });

  const showOnMap = () => {
    select(incident.vehicleId);
    router.navigate("/");
    if (!isSheetOpen()) router.push("/vehicle");
  };
  const saveNote = () => {
    const text = note.latest().trim();
    if (text) addNote.mutate(text);
  };
  const attach = () => {
    const options = [t("photo.library"), t("photo.camera"), t("common.cancel")];
    ActionSheetIOS.showActionSheetWithOptions({ title: t("incidents.attach"), options, cancelButtonIndex: 2 }, (i) => {
      if (i > 1) return;
      setPhotoProblem(null);
      pickEvidence(i === 0 ? "library" : "camera")
        .then((photo) => {
          if (photo) upload.mutate(photo);
        })
        .catch((err: unknown) => setPhotoProblem(err instanceof PhotoError && err.reason === "camera" ? t("photo.noCamera") : t("photo.noPermission")));
    });
  };
  const open = incident.status !== "closed";
  const urgent = open && incident.priority === 1;
  const status = t(`shared.incidentStatus.${incident.status}`);

  return (
    <>
      <View style={styles.head}>
        <Text style={[styles.kind, { color: theme.ink }]}>{t(`shared.incidentKind.${incident.kind}`)}</Text>
        <Text style={[styles.status, { color: statusColor(incident.status, theme) }]} testID="incident-status">
          {urgent ? t("incidents.statusPriority", { status }) : status}
        </Text>
        <Text style={[styles.small, { color: theme.muted }]}>
          {incident.attendedBy
            ? t("incidents.openedAttended", { when: timeAgo(incident.openedAt, now), name: incident.attendedBy })
            : t("incidents.opened", { when: timeAgo(incident.openedAt, now) })}
          {!open && incident.resolution ? ` · ${t(`shared.incidentResolution.${incident.resolution}`).toLowerCase()}` : ""}
        </Text>
      </View>

      <View style={styles.actions}>
        {canManage && incident.status === "open" ? (
          <View style={styles.action}>
            <Button kind="signal" label={t("incidents.attend")} busy={attend.isPending} onPress={() => attend.mutate()} testID="incident-attend" />
          </View>
        ) : null}
        <View style={styles.action}>
          <Button kind="secondary" label={t("incidents.showOnMap")} onPress={showOnMap} testID="incident-map" />
        </View>
      </View>
      {attend.isError ? <Notice text={errorText(attend.error)} /> : null}

      <SectionTitle text={t("incidents.timeline")} />
      <Card style={styles.timeline}>
        {incident.entries.map((entry, i) => (
          <Entry key={entry.id} entry={entry} incidentId={incident.id} last={i === incident.entries.length - 1} />
        ))}
      </Card>

      {canManage && open ? (
        <>
          <SectionTitle text={t("incidents.addNote")} />
          <TextInput
            value={note.text}
            onChangeText={note.change}
            multiline
            maxLength={2000}
            placeholder={t("incidents.notePlaceholder")}
            placeholderTextColor={theme.faint}
            style={[styles.area, { color: theme.ink, backgroundColor: theme.surface, borderColor: theme.line }]}
            testID="incident-note"
          />
          <View style={styles.actions}>
            <View style={styles.action}>
              <Button label={t("incidents.saveNote")} busy={addNote.isPending} disabled={!note.text.trim()} onPress={saveNote} testID="incident-save-note" />
            </View>
            <View style={styles.action}>
              <Button kind="secondary" label={t("incidents.attachPhoto")} busy={upload.isPending} onPress={attach} testID="incident-attach" />
            </View>
          </View>
          {addNote.isError || upload.isError ? <Notice text={errorText(addNote.error ?? upload.error)} /> : null}
          {photoProblem ? <Notice text={photoProblem} /> : null}

          {closing ? (
            <Card style={styles.closeCard}>
              <Text style={[styles.closeTitle, { color: theme.ink }]}>{t("incidents.closeHow")}</Text>
              <View style={styles.chips}>
                {INCIDENT_RESOLUTIONS.map((r) => {
                  const on = r === resolution;
                  return (
                    <Pressable
                      key={r}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => setResolution(r)}
                      style={[styles.chip, { backgroundColor: on ? theme.primary : theme.canvas, borderColor: on ? theme.primary : theme.line }]}
                      testID={`resolution-${r}`}
                    >
                      <Text style={[styles.chipText, { color: on ? theme.onPrimary : theme.ink }]}>{t(`shared.incidentResolution.${r}`)}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                value={closingNote.text}
                onChangeText={closingNote.change}
                multiline
                maxLength={2000}
                placeholder={t("incidents.closeNote")}
                placeholderTextColor={theme.faint}
                style={[styles.area, { color: theme.ink, backgroundColor: theme.canvas, borderColor: theme.line }]}
                testID="incident-close-note"
              />
              <Notice tone="note" text={t("incidents.closeLead")} />
              {close.isError ? <Notice text={errorText(close.error)} /> : null}
              <View style={styles.actions}>
                <View style={styles.action}>
                  <Button kind="secondary" label={t("common.cancel")} onPress={() => setClosing(false)} />
                </View>
                <View style={styles.action}>
                  <Button label={t("incidents.close")} busy={close.isPending} onPress={() => close.mutate()} testID="incident-close-confirm" />
                </View>
              </View>
            </Card>
          ) : (
            <Button kind="danger" label={t("incidents.close")} onPress={() => setClosing(true)} testID="incident-close" />
          )}
        </>
      ) : null}
    </>
  );
}

function Entry(props: { entry: IncidentEntry; incidentId: string; last: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { entry } = props;
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  // The evidence comes with the session to the phone, and opens in the share menu to look at it or keep it.
  const openFile = async (fileId: string) => {
    setOpening(true);
    setFailed(false);
    try {
      const file = await downloadFile(evidencePath(props.incidentId, fileId));
      await Share.share({ url: file.uri });
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  };
  return (
    <View style={styles.entry}>
      <View style={styles.rail}>
        <View style={[styles.dot, { backgroundColor: entryColor(entry.kind, theme) }]} />
        {!props.last ? <View style={[styles.line, { backgroundColor: theme.line }]} /> : null}
      </View>
      <View style={styles.entryMain}>
        <Text style={[styles.entryText, { color: theme.ink }]}>{entry.text}</Text>
        {entry.file ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void openFile((entry.file as { id: string }).id)}
            style={({ pressed }) => [styles.file, { backgroundColor: theme.canvas, opacity: pressed || opening ? 0.6 : 1 }]}
          >
            {opening ? <ActivityIndicator size="small" /> : <Paperclip color={theme.signalInk} size={14} />}
            <Text style={[styles.fileName, { color: theme.ink }]} numberOfLines={1}>
              {entry.file.name}
            </Text>
          </Pressable>
        ) : null}
        {failed ? <Notice text={t("errors.network")} /> : null}
        <Text style={[styles.entryAt, { color: theme.faint }]}>
          {formatDateTime(entry.at)} · {entry.userName ?? t("incidents.platform")}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: 4 },
  kind: { fontFamily: FONT.semibold, fontSize: 17 },
  status: { fontFamily: FONT.semibold, fontSize: 14 },
  small: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: "row", gap: 10 },
  action: { flex: 1 },
  timeline: { paddingVertical: 14 },
  entry: { flexDirection: "row", gap: 12 },
  rail: { alignItems: "center", width: 12 },
  dot: { width: 11, height: 11, borderRadius: 6, marginTop: 4 },
  line: { flex: 1, width: StyleSheet.hairlineWidth * 2, marginVertical: 2 },
  entryMain: { flex: 1, gap: 4, paddingBottom: 16 },
  entryText: { fontFamily: FONT.regular, fontSize: 15, lineHeight: 20 },
  entryAt: { fontFamily: FONT.regular, fontSize: 12 },
  file: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", maxWidth: "100%", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  fileName: { fontFamily: FONT.medium, fontSize: 13, flexShrink: 1 },
  area: { minHeight: 88, borderRadius: 12, borderWidth: 1, padding: 12, fontFamily: FONT.regular, fontSize: 16, textAlignVertical: "top" },
  closeCard: { paddingVertical: 14, gap: 12, borderRadius: RADIUS },
  closeTitle: { fontFamily: FONT.semibold, fontSize: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, height: 34, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth, justifyContent: "center" },
  chipText: { fontFamily: FONT.medium, fontSize: 14 },
});
