// Vehicle list: search, status filter and the state of each one. A tap shows
// it on the map with its sheet.
import { type Vehicle, type VehicleGroup, vehicleStatus } from "@opengps/shared";
import { useRouter } from "expo-router";
import { ChevronDown, FolderTree } from "lucide-react-native";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { showChoices } from "../../../components/Choices";
import { Button, Centered, StatusDot, text } from "../../../components/ui";
import { formatSpeed, timeAgo } from "../../../lib/format";
import { applyFilters, countByStatus, FILTER_STATUSES, type Filters, NO_FILTERS } from "../../../lib/filters";
import { groupTree, indented } from "../../../lib/groups";
import { select } from "../../../lib/selection";
import { useNow } from "../../../lib/session";
import { FONT, RADIUS, useTheme } from "../../../lib/theme";
import { useGroups, useVehicles } from "../../../lib/vehicles";

export default function VehiclesScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const now = useNow();
  const vehicles = useVehicles();
  const groups = useGroups().data ?? [];
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const all = vehicles.data ?? [];
  const shown = useMemo(() => applyFilters(all, filters, now, groups), [all, filters, now, groups]);
  // The counts by status respect the chosen group, so they match the list.
  const inGroup = useMemo(() => applyFilters(all, { ...NO_FILTERS, group: filters.group }, now, groups), [all, filters.group, now, groups]);
  const counts = useMemo(() => countByStatus(inGroup, now), [inGroup, now]);
  const filtering = filters.status !== "all" || filters.group !== "all" || filters.search.trim() !== "";
  const groupName = (id: string | null) => (id ? groups.find((g) => g.id === id)?.name : undefined);
  // The spinner is for the person pulling the list; the refreshes on their own go unseen.
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    setPulling(true);
    await vehicles.refetch();
    setPulling(false);
  };

  const open = (v: Vehicle) => {
    select(v.id);
    router.navigate("/");
    router.push("/vehicle");
  };

  if (vehicles.isPending) return <Centered><Text style={text(theme).body}>…</Text></Centered>;
  if (vehicles.isError && all.length === 0) {
    return (
      <Centered>
        <Text style={text(theme).body}>{t("list.failed")}</Text>
        <Button kind="secondary" label={t("errors.retry")} onPress={() => void vehicles.refetch()} />
      </Centered>
    );
  }
  if (all.length === 0) {
    return (
      <Centered>
        <Text style={text(theme).title}>{t("list.empty.title")}</Text>
        <Text style={[text(theme).body, styles.center]}>{t("list.empty.body")}</Text>
      </Centered>
    );
  }

  return (
    <FlatList
      testID="vehicle-list"
      data={shown}
      keyExtractor={(v) => v.id}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void pull()} tintColor={theme.muted} />}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View style={styles.header}>
          <TextInput
            testID="vehicle-search"
            value={filters.search}
            onChangeText={(search) => setFilters({ ...filters, search })}
            placeholder={t("list.searchPlaceholder")}
            placeholderTextColor={theme.faint}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={[styles.search, { backgroundColor: theme.surface, borderColor: theme.line, color: theme.ink }]}
          />
          {groups.length > 0 ? <GroupPicker groups={groups} value={filters.group} onChange={(group) => setFilters({ ...filters, group })} /> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Chip label={t("list.all")} count={inGroup.length} on={filters.status === "all"} onPress={() => setFilters({ ...filters, status: "all" })} />
            {FILTER_STATUSES.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => (
              <Chip
                key={s}
                testID={`chip-${s}`}
                label={t(`list.status.${s}`)}
                count={counts.get(s) ?? 0}
                color={theme.status[s]}
                on={filters.status === s}
                onPress={() => setFilters({ ...filters, status: filters.status === s ? "all" : s })}
              />
            ))}
          </ScrollView>
          <Text style={[styles.count, { color: theme.muted }]}>
            {filtering ? t("list.filtered", { shown: shown.length, total: all.length }) : t("list.count", { count: all.length })}
          </Text>
        </View>
      }
      ListEmptyComponent={
        <View style={styles.noMatch}>
          <Text style={text(theme).body}>{t("list.noMatch")}</Text>
          <Button kind="secondary" label={t("list.clearFilters")} onPress={() => setFilters(NO_FILTERS)} />
        </View>
      }
      renderItem={({ item }) => <VehicleRow vehicle={item} group={groupName(item.groupId)} now={now} onPress={() => open(item)} />}
    />
  );
}

/** The group the list shows, chosen in the system's menu: each group takes in those that hang from it. */
function GroupPicker(props: { groups: VehicleGroup[]; value: string; onChange: (group: string) => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const tree = groupTree(props.groups);
  const label =
    props.value === "all" ? t("list.allGroups") : props.value === "none" ? t("list.noGroup") : (tree.find((g) => g.id === props.value)?.name ?? t("list.allGroups"));
  const choose = () => {
    const values = ["all", ...tree.map((g) => g.id), "none"];
    const options = [t("list.allGroups"), ...tree.map((g) => `${indented(g)} (${g.total})`), t("list.noGroup"), t("common.cancel")];
    showChoices({ title: t("list.groupFilter"), options, cancelButtonIndex: options.length - 1 }, (i) => {
      const value = values[i];
      if (value !== undefined) props.onChange(value);
    });
  };
  const on = props.value !== "all";
  return (
    <Pressable
      testID="group-filter"
      accessibilityRole="button"
      accessibilityLabel={`${t("list.groupFilter")}: ${label}`}
      onPress={choose}
      style={({ pressed }) => [styles.groupButton, { backgroundColor: on ? theme.primary : theme.surface, borderColor: on ? theme.primary : theme.line, opacity: pressed ? 0.7 : 1 }]}
    >
      <FolderTree color={on ? theme.onPrimary : theme.muted} size={16} />
      <Text style={[styles.groupText, { color: on ? theme.onPrimary : theme.ink }]} numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown color={on ? theme.onPrimary : theme.muted} size={16} />
    </Pressable>
  );
}

function Chip(props: { label: string; count: number; on: boolean; color?: string; onPress: () => void; testID?: string }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      style={[styles.chip, { backgroundColor: props.on ? theme.primary : theme.surface, borderColor: props.on ? theme.primary : theme.line }]}
    >
      {props.color ? <StatusDot color={props.color} size={8} /> : null}
      <Text style={[styles.chipText, { color: props.on ? theme.onPrimary : theme.ink }]}>{props.label}</Text>
      <Text style={[styles.chipCount, { color: props.on ? theme.onPrimary : theme.muted }]}>{props.count}</Text>
    </Pressable>
  );
}

function VehicleRow(props: { vehicle: Vehicle; group: string | undefined; now: number; onPress: () => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { vehicle: v, now } = props;
  const status = vehicleStatus(v, now);
  return (
    <Pressable
      testID={`vehicle-${v.id}`}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.7 : 1 }]}
    >
      <StatusDot color={theme.status[status]} size={12} />
      <View style={styles.rowMain}>
        <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
          {v.name}
        </Text>
        <Text style={[styles.sub, { color: theme.muted }]} numberOfLines={1}>
          {[t(`shared.vehicleStatus.${status}`), v.plate, props.group].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <View style={styles.rowSide}>
        {status === "moving" ? <Text style={[styles.speed, { color: theme.ink }]}>{formatSpeed(v.state?.speedKmh)}</Text> : null}
        {v.state ? <Text style={[styles.ago, { color: theme.faint }]}>{timeAgo(v.state.lastSeenAt, now)}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, paddingTop: 8, gap: 8 },
  center: { textAlign: "center" },
  header: { gap: 12, marginBottom: 4 },
  search: { height: 44, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontFamily: FONT.regular, fontSize: 16 },
  chips: { gap: 8 },
  groupButton: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", height: 36, paddingHorizontal: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  groupText: { fontFamily: FONT.medium, fontSize: 14, flexShrink: 1 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth },
  chipText: { fontFamily: FONT.medium, fontSize: 14 },
  chipCount: { fontFamily: FONT.mono, fontSize: 12 },
  count: { fontFamily: FONT.regular, fontSize: 13, marginLeft: 4 },
  noMatch: { alignItems: "center", gap: 12, paddingTop: 32 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: RADIUS, borderWidth: StyleSheet.hairlineWidth },
  rowMain: { flex: 1, gap: 2 },
  name: { fontFamily: FONT.semibold, fontSize: 16 },
  sub: { fontFamily: FONT.regular, fontSize: 13 },
  rowSide: { alignItems: "flex-end", gap: 2 },
  speed: { fontFamily: FONT.mono, fontSize: 13 },
  ago: { fontFamily: FONT.regular, fontSize: 12 },
});
