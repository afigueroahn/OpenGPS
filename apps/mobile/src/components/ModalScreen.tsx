// Frame of the screens that open over the app (your details, deleting the
// account, adding a GPS): a title, a close button and room for the keyboard.
// On iPhone they open as a sheet below the status bar; on Android they take
// the whole screen, so the header leaves room for it.
import { useRouter } from "expo-router";
import { X } from "lucide-react-native";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FONT, useTheme } from "../lib/theme";

export function ModalScreen(props: { title: string; children: ReactNode; testID?: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const top = Platform.OS === "android" ? insets.top : 0;
  return (
    <View style={[styles.screen, { backgroundColor: theme.canvas }]} testID={props.testID}>
      <View style={[styles.header, { borderBottomColor: theme.line, backgroundColor: theme.surface, paddingTop: top + 18 }]}>
        <Text style={[styles.title, { color: theme.ink }]} numberOfLines={1}>
          {props.title}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          hitSlop={12}
          onPress={() => router.back()}
          style={[styles.close, { backgroundColor: theme.canvas }]}
          testID="modal-close"
        >
          <X color={theme.muted} size={18} />
        </Pressable>
      </View>
      <KeyboardAvoidingView behavior="padding" style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {props.children}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontFamily: FONT.bold, fontSize: 20 },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  content: { padding: 20, gap: 16, paddingBottom: 48 },
});
