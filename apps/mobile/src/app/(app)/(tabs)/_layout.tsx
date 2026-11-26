// The tabs: map, vehicles, alerts, incidents (with module A) and account.
import { Tabs, useRouter } from "expo-router";
import { BellRing, CircleUser, List, Map, Plus, ShieldAlert } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet } from "react-native";
import { useIncidents } from "../../../lib/incidents";
import { useCan, useMe } from "../../../lib/session";
import { FONT, useTheme } from "../../../lib/theme";

export default function TabsLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const canAdd = useCan("vehicles.manage");
  const canReport = useCan("incidents.manage");
  const antitheft = useMe().data?.account.modules.includes("A") ?? false;
  const openIncidents = useIncidents(true, antitheft).data?.length ?? 0;
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.dark ? theme.signal : theme.signalInk,
        tabBarInactiveTintColor: theme.muted,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.line },
        tabBarLabelStyle: { fontFamily: FONT.medium, fontSize: 11 },
        headerStyle: { backgroundColor: theme.surface },
        headerTitleStyle: { fontFamily: FONT.semibold, fontSize: 17, color: theme.ink },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: theme.canvas },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t("tabs.map"), headerShown: false, tabBarButtonTestID: "tab-map", tabBarIcon: ({ color, size }) => <Map color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="vehicles"
        options={{
          title: t("tabs.vehicles"),
          tabBarButtonTestID: "tab-vehicles",
          tabBarIcon: ({ color, size }) => <List color={color} size={size} />,
          ...(canAdd
            ? {
                headerRight: () => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("wizard.add")}
                  hitSlop={10}
                  onPress={() => router.push("/add-gps")}
                  style={styles.headerButton}
                  testID="add-gps"
                >
                  <Plus color={theme.ink} size={24} />
                </Pressable>
                ),
              }
            : {}),
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{ title: t("tabs.alerts"), tabBarButtonTestID: "tab-alerts", tabBarIcon: ({ color, size }) => <BellRing color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="incidents"
        options={{
          title: t("tabs.incidents"),
          tabBarButtonTestID: "tab-incidents",
          tabBarIcon: ({ color, size }) => <ShieldAlert color={color} size={size} />,
          // Only with module A; the number is how many are open.
          ...(antitheft ? {} : { href: null }),
          ...(openIncidents > 0 ? { tabBarBadge: openIncidents } : {}),
          ...(antitheft && canReport
            ? {
                headerRight: () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("incidents.report")}
                    hitSlop={10}
                    onPress={() => router.push("/report-incident")}
                    style={styles.headerButton}
                    testID="report-incident"
                  >
                    <Plus color={theme.ink} size={24} />
                  </Pressable>
                ),
              }
            : {}),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{ title: t("tabs.account"), tabBarButtonTestID: "tab-account", tabBarIcon: ({ color, size }) => <CircleUser color={color} size={size} /> }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({ headerButton: { paddingHorizontal: 16 } });
