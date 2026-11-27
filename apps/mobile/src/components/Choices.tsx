// Choosing one option from a list. On iPhone it is the system's action sheet; Android has none, so the app shows
// its own sheet from below, which "Cancel", a tap outside or the back button close.
import { useEffect, useState } from "react";
import { ActionSheetIOS, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FONT, useTheme } from "../lib/theme";

/** The same options as ActionSheetIOS: the callback gets the index chosen, or cancelButtonIndex. */
export interface ChoicesOptions {
  title?: string;
  options: string[];
  cancelButtonIndex?: number;
  destructiveButtonIndex?: number;
}

type Request = ChoicesOptions & { onPick: (index: number) => void };

/** The sheet mounted at the root (ChoicesHost); there is only one. */
let present: ((request: Request) => void) | null = null;

export function showChoices(options: ChoicesOptions, onPick: (index: number) => void): void {
  if (Platform.OS === "ios") ActionSheetIOS.showActionSheetWithOptions(options, onPick);
  else present?.({ ...options, onPick });
}

/** Android's sheet. It goes once at the root of the app, inside the SafeAreaProvider. */
export function ChoicesHost() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [request, setRequest] = useState<Request | null>(null);
  useEffect(() => {
    if (Platform.OS === "ios") return;
    present = setRequest;
    return () => {
      present = null;
    };
  }, []);

  const pick = (index: number | undefined) => {
    const current = request;
    setRequest(null);
    if (current && index !== undefined) current.onPick(index);
  };
  const cancel = () => pick(request?.cancelButtonIndex);
  const cancelLabel = request?.cancelButtonIndex === undefined ? undefined : request.options[request.cancelButtonIndex];

  return (
    <Modal visible={request !== null} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={cancel}>
      <Pressable style={styles.backdrop} onPress={cancel} accessibilityRole="button" accessibilityLabel={cancelLabel} testID="choices-backdrop" />
      <View style={[styles.sheet, { backgroundColor: theme.surface, paddingBottom: insets.bottom + 8 }]} testID="choices">
        {request?.title ? <Text style={[styles.title, { color: theme.muted }]}>{request.title}</Text> : null}
        <ScrollView style={styles.list} bounces={false}>
          {request?.options.map((label, index) =>
            index === request.cancelButtonIndex ? null : (
              <Pressable
                key={`${index}-${label}`}
                accessibilityRole="button"
                onPress={() => pick(index)}
                style={({ pressed }) => [styles.option, { borderTopColor: theme.line }, pressed && { backgroundColor: theme.canvas }]}
                testID={`choice-${index}`}
              >
                <Text style={[styles.label, { color: index === request.destructiveButtonIndex ? theme.danger : theme.ink }]}>{label}</Text>
              </Pressable>
            ),
          )}
        </ScrollView>
        {cancelLabel ? (
          <Pressable
            accessibilityRole="button"
            onPress={cancel}
            style={({ pressed }) => [styles.option, styles.cancel, { borderTopColor: theme.line }, pressed && { backgroundColor: theme.canvas }]}
            testID="choices-cancel"
          >
            <Text style={[styles.label, styles.cancelLabel, { color: theme.ink }]}>{cancelLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { maxHeight: "70%", borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 8 },
  title: { fontFamily: FONT.medium, fontSize: 13, textAlign: "center", paddingHorizontal: 20, paddingVertical: 10 },
  list: { flexGrow: 0 },
  option: { minHeight: 52, justifyContent: "center", paddingHorizontal: 20, borderTopWidth: StyleSheet.hairlineWidth },
  label: { fontFamily: FONT.regular, fontSize: 17, textAlign: "center" },
  cancel: { marginTop: 6 },
  cancelLabel: { fontFamily: FONT.semibold },
});
