// Building blocks of the screens, with the brand's colors and type.
import { ChevronRight } from "lucide-react-native";
import type { ReactNode, Ref } from "react";
import { ActivityIndicator, Pressable, type StyleProp, StyleSheet, Text, TextInput, type TextInputProps, View, type ViewStyle } from "react-native";
import { FONT, type Palette, RADIUS, useTheme } from "../lib/theme";

export function Button(props: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "signal" | "secondary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  /** Over the dark screens before the session, in both modes. */
  dark?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const kind = props.kind ?? "primary";
  const colors = {
    primary: { bg: theme.primary, fg: theme.onPrimary, border: theme.primary },
    signal: { bg: theme.signal, fg: "#101623", border: theme.signal },
    secondary: props.dark ? { bg: "#1a2233", fg: "#ffffff", border: "#283248" } : { bg: "transparent", fg: theme.ink, border: theme.line },
    danger: { bg: "transparent", fg: theme.danger, border: theme.line },
  }[kind];
  const off = props.disabled || props.busy;
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={off}
      onPress={props.onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: colors.bg, borderColor: colors.border, opacity: off ? 0.55 : pressed ? 0.8 : 1 }]}
    >
      {props.busy ? <ActivityIndicator color={colors.fg} /> : <Text style={[styles.buttonText, { color: colors.fg }]}>{props.label}</Text>}
    </Pressable>
  );
}

/** A labelled text field. `dark` draws it for the dark sign-in screens. */
export function Field(props: TextInputProps & { label: string; dark?: boolean; ref?: Ref<TextInput> }) {
  const theme = useTheme();
  const { label, dark, style, ref, ...input } = props;
  const fg = dark ? "#ffffff" : theme.ink;
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: dark ? "#98a2b3" : theme.muted }]}>{label}</Text>
      <TextInput
        ref={ref}
        placeholderTextColor={dark ? "#667186" : theme.faint}
        accessibilityLabel={label}
        style={[
          styles.input,
          { color: fg, backgroundColor: dark ? "#1a2233" : theme.surface, borderColor: dark ? "#283248" : theme.line },
          style,
        ]}
        {...input}
      />
    </View>
  );
}

/** A message on the screen: an error or a note. */
export function Notice(props: { text: string; tone?: "error" | "note"; dark?: boolean; testID?: string }) {
  const theme = useTheme();
  const error = (props.tone ?? "error") === "error";
  const color = error ? (props.dark ? "#ff8f88" : theme.danger) : props.dark ? "#98a2b3" : theme.muted;
  return (
    <Text testID={props.testID} accessibilityRole={error ? "alert" : "text"} style={[styles.notice, { color }]}>
      {props.text}
    </Text>
  );
}

export function StatusDot(props: { color: string; size?: number }) {
  const size = props.size ?? 10;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: props.color }} />;
}

/** A card of the screens: a group of rows on the surface color. */
export function Card(props: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  const theme = useTheme();
  return (
    <View testID={props.testID} style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.line }, props.style]}>
      {props.children}
    </View>
  );
}

/** Label on the left, value on the right; `mono` for numbers. */
export function Row(props: { label: string; value: string; note?: string | null; mono?: boolean; last?: boolean }) {
  const theme = useTheme();
  return (
    <View style={[styles.row, !props.last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line }]}>
      <Text style={[styles.rowLabel, { color: theme.muted }]}>{props.label}</Text>
      <View style={styles.rowValue}>
        <Text style={[props.mono ? styles.mono : styles.rowText, { color: theme.ink }]}>{props.value}</Text>
        {props.note ? <Text style={[styles.rowNote, { color: theme.faint }]}>{props.note}</Text> : null}
      </View>
    </View>
  );
}

/** A row that opens something: its name on the left and an arrow on the right. */
export function LinkRow(props: { label: string; onPress: () => void; value?: string; last?: boolean; testID?: string }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="link"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, styles.linkRow, !props.last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line }, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={[styles.rowText, styles.linkLabel, { color: theme.ink }]}>{props.label}</Text>
      {props.value ? <Text style={[styles.rowNote, styles.linkValue, { color: theme.muted }]}>{props.value}</Text> : null}
      <ChevronRight color={theme.faint} size={18} />
    </Pressable>
  );
}

export function SectionTitle(props: { text: string }) {
  const theme = useTheme();
  return <Text style={[styles.sectionTitle, { color: theme.muted }]}>{props.text.toUpperCase()}</Text>;
}

/** A choice among a few options, like a segmented control. */
export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; testID?: string }) {
  const theme = useTheme();
  return (
    <View testID={props.testID} style={[styles.segmented, { backgroundColor: theme.canvas, borderColor: theme.line }]}>
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => props.onChange(o.value)}
            style={[styles.segment, on && { backgroundColor: theme.surface, shadowOpacity: 0.12, elevation: 1 }]}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={[styles.segmentText, { color: on ? theme.ink : theme.muted }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Centered(props: { children: ReactNode }) {
  return <View style={styles.centered}>{props.children}</View>;
}

export const text = (theme: Palette) =>
  StyleSheet.create({
    title: { fontFamily: FONT.bold, fontSize: 22, color: theme.ink },
    body: { fontFamily: FONT.regular, fontSize: 15, lineHeight: 21, color: theme.muted },
  });

const styles = StyleSheet.create({
  button: { height: 48, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  buttonText: { fontFamily: FONT.semibold, fontSize: 16 },
  field: { gap: 6 },
  fieldLabel: { fontFamily: FONT.medium, fontSize: 13 },
  input: { height: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontFamily: FONT.regular, fontSize: 16 },
  notice: { fontFamily: FONT.regular, fontSize: 14, lineHeight: 20 },
  card: { borderRadius: RADIUS, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 12, gap: 12 },
  rowLabel: { fontFamily: FONT.regular, fontSize: 15, flexShrink: 0 },
  rowValue: { flex: 1, alignItems: "flex-end" },
  rowText: { fontFamily: FONT.medium, fontSize: 15, textAlign: "right" },
  rowNote: { fontFamily: FONT.regular, fontSize: 12, marginTop: 2, textAlign: "right" },
  mono: { fontFamily: FONT.mono, fontSize: 14, textAlign: "right" },
  linkRow: { alignItems: "center" },
  linkLabel: { flex: 1, textAlign: "left", fontFamily: FONT.regular },
  linkValue: { marginTop: 0, fontSize: 14 },
  sectionTitle: { fontFamily: FONT.semibold, fontSize: 12, letterSpacing: 0.6, marginTop: 22, marginBottom: 8, marginLeft: 4 },
  segmented: { flexDirection: "row", borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 3 },
  segment: { flex: 1, height: 34, borderRadius: 8, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, shadowOpacity: 0 },
  segmentText: { fontFamily: FONT.medium, fontSize: 14 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
});
