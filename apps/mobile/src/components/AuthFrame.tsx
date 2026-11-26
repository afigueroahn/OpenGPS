// Frame of the screens before the session: dark in both modes, like the web
// app's sign-in page, with the brand on top and room for the keyboard.
import type { ReactNode } from "react";
import { Image, KeyboardAvoidingView, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { FONT } from "../lib/theme";

export function AuthFrame(props: { name?: string; headline?: string; title: string; body?: string | null; children: ReactNode }) {
  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.fill}>
        <KeyboardAvoidingView behavior="padding" style={styles.fill}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.brand}>
              <Image source={require("../../assets/icon.png")} style={styles.logo} accessibilityIgnoresInvertColors />
              {props.name ? (
                <Text style={styles.wordmark} testID="app-name">
                  {props.name}
                </Text>
              ) : (
                <Text style={styles.wordmark}>
                  Open<Text style={styles.wordmarkDim}>GPS</Text>
                </Text>
              )}
            </View>
            {props.headline ? <Text style={styles.headline}>{props.headline}</Text> : null}
            <View style={styles.form}>
              <Text style={styles.title}>{props.title}</Text>
              {props.body ? <Text style={styles.body}>{props.body}</Text> : null}
              {props.children}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

export const authStyles = StyleSheet.create({
  link: { fontFamily: FONT.medium, fontSize: 15, color: "#3ddc97", textAlign: "center", paddingVertical: 8 },
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101623" },
  fill: { flex: 1 },
  content: { flexGrow: 1, padding: 24, paddingTop: 48, gap: 28 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { width: 40, height: 40, borderRadius: 10 },
  wordmark: { fontFamily: FONT.bold, fontSize: 24, color: "#ffffff" },
  wordmarkDim: { color: "#98a2b3" },
  headline: { fontFamily: FONT.bold, fontSize: 34, lineHeight: 40, color: "#ffffff" },
  form: { gap: 16 },
  title: { fontFamily: FONT.semibold, fontSize: 20, color: "#ffffff" },
  body: { fontFamily: FONT.regular, fontSize: 15, lineHeight: 21, color: "#98a2b3", marginTop: -8 },
});
