// The person's photo in their account, which they change from the phone: a
// tap offers their photos, the camera or removing it, and the platform keeps
// the new one at once (the web shows it too).
import type { Me } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { deletePhoto, errorText, uploadPhoto } from "../lib/api";
import { PhotoError, pickPhoto } from "../lib/photo";
import { useTheme } from "../lib/theme";
import { Avatar } from "./Avatar";

type Choice = "library" | "camera" | "remove";

export function ProfilePhoto(props: { user: Me["user"]; size?: number }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const size = props.size ?? 56;
  const hasPhoto = props.user.photoUrl !== null;

  const change = useMutation({
    mutationFn: async (choice: Choice) => {
      if (choice === "remove") return deletePhoto();
      const photo = await pickPhoto(choice);
      if (photo) await uploadPhoto(photo);
      return null;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
    onError: (err) => {
      const message =
        err instanceof PhotoError ? (err.reason === "permission" ? t("photo.noPermission") : t("photo.noCamera")) : errorText(err);
      Alert.alert(t("photo.change"), message);
    },
  });

  const choose = () => {
    const choices: { choice: Choice; label: string }[] = [
      { choice: "library", label: t("photo.library") },
      { choice: "camera", label: t("photo.camera") },
      ...(hasPhoto ? [{ choice: "remove" as const, label: t("photo.remove") }] : []),
    ];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: t("photo.change"),
          options: [...choices.map((c) => c.label), t("photo.cancel")],
          cancelButtonIndex: choices.length,
          ...(hasPhoto ? { destructiveButtonIndex: choices.length - 1 } : {}),
        },
        (index) => {
          const picked = choices[index];
          if (picked) change.mutate(picked.choice);
        },
      );
    } else {
      Alert.alert(t("photo.change"), undefined, [
        ...choices.filter((c) => c.choice !== "camera").map((c) => ({ text: c.label, onPress: () => change.mutate(c.choice) })),
        { text: t("photo.cancel"), style: "cancel" as const },
      ]);
    }
  };

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t("photo.change")} onPress={choose} disabled={change.isPending} testID="profile-photo">
      <Avatar name={props.user.name} photoUrl={props.user.photoUrl} size={size} />
      {change.isPending ? (
        <View style={[styles.busy, { width: size, height: size, borderRadius: size / 2 }]}>
          <ActivityIndicator color="#ffffff" />
        </View>
      ) : null}
      <View style={[styles.badge, { backgroundColor: theme.surface, borderColor: theme.line }]}>
        <Camera color={theme.ink} size={13} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  busy: { position: "absolute", top: 0, left: 0, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(16,22,35,0.45)" },
  badge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
});
