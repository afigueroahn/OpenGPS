// The person's round mark: their photo, or their initials when they have none
// or it cannot be loaded. Same rules as the web app's (apps/web/src/components/Avatar.tsx):
// the photo goes alone, without a background.
// The photo is served only with the session, so it goes with the cookie the app keeps.
import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { useSaved } from "../lib/storage";
import { FONT, useTheme } from "../lib/theme";

/** Up to two initials: the first letter of the first two words. */
export const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0))
    .join("")
    .toUpperCase();

export function Avatar(props: { name: string; photoUrl: string | null; size?: number }) {
  const theme = useTheme();
  const server = useSaved((s) => s.server);
  const cookie = useSaved((s) => s.cookie);
  // The address that failed: a new photo gets its own chance.
  const [failed, setFailed] = useState<string | null>(null);
  const size = props.size ?? 56;
  const uri = props.photoUrl && server ? (/^https?:\/\//.test(props.photoUrl) ? props.photoUrl : `${server}${props.photoUrl}`) : null;
  const photo = uri && uri !== failed ? uri : null;
  return (
    <View
      style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }, !photo && { backgroundColor: theme.primary }]}
      testID="avatar"
    >
      {photo ? (
        <Image
          source={{ uri: photo, headers: cookie ? { Cookie: cookie } : {} }}
          style={StyleSheet.absoluteFill}
          onError={() => setFailed(photo)}
          accessibilityIgnoresInvertColors
          testID="avatar-photo"
        />
      ) : (
        <Text style={[styles.initials, { color: theme.onPrimary, fontSize: size * 0.36 }]}>{initialsOf(props.name) || "?"}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  initials: { fontFamily: FONT.bold },
});
