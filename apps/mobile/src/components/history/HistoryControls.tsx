// What the history is asked for and how it plays: the period (today,
// yesterday, the last days or chosen days) and the player of the trip.
import { HISTORY_MAX_DAYS, type HistoryPoint } from "@opengps/shared";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatClock, formatClockSeconds, formatDay } from "../../lib/format";
import { addDays, advance, daysRange, matchPreset, type Moment, PRESETS, type Range, presetRange, rangeProblem, RATES, shiftRange, startOfDay, wholeDays } from "../../lib/history";
import { FONT, RADIUS, useTheme } from "../../lib/theme";
import { Slider } from "../Slider";
import { Button, Card, Notice } from "../ui";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Sáb, 21 nov" or "15 nov – 21 nov". */
export function rangeLabel(range: Range): string {
  const days = wholeDays(range);
  if (days === 1) return capital(formatDay(range.from.getTime()));
  if (days !== null) return `${formatDay(range.from.getTime())} – ${formatDay(range.to.getTime() - 1)}`;
  return `${formatDay(range.from.getTime())} ${formatClock(range.from.getTime())} – ${formatClock(range.to.getTime())}`;
}

export function RangePicker(props: { range: Range; onChange: (range: Range) => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { range } = props;
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(range.from);
  const [last, setLast] = useState(addDays(range.to, -1));
  const next = shiftRange(range, 1);
  const canNext = next.from.getTime() <= Date.now();
  const draft = daysRange(first, last);
  const problem = rangeProblem(draft);

  const choose = (preset: (typeof PRESETS)[number]) => {
    if (preset === "custom") {
      setFirst(startOfDay(range.from));
      setLast(startOfDay(addDays(range.to, -1)));
      setEditing(true);
      return;
    }
    setEditing(false);
    props.onChange(presetRange(preset));
  };

  return (
    <View style={styles.block}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {PRESETS.map((p) => {
          const on = p === "custom" ? editing || range.preset === "custom" : !editing && range.preset === p;
          return (
            <Pressable
              key={p}
              testID={`preset-${p}`}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => choose(p)}
              style={[styles.chip, { backgroundColor: on ? theme.primary : theme.surface, borderColor: on ? theme.primary : theme.line }]}
            >
              <Text style={[styles.chipText, { color: on ? theme.onPrimary : theme.ink }]}>{t(`history.presets.${p}`)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {editing ? (
        <Card style={styles.custom}>
          <DayStepper label={t("history.range.from")} day={first} onChange={setFirst} />
          <DayStepper label={t("history.range.to")} day={last} onChange={setLast} />
          {problem ? <Notice text={problem === "tooLong" ? t("history.range.tooLong", { days: HISTORY_MAX_DAYS }) : t("history.range.endBeforeStart")} /> : null}
          <Button
            label={t("history.range.apply")}
            disabled={problem !== null}
            onPress={() => {
              setEditing(false);
              props.onChange(matchPreset(draft));
            }}
            testID="range-apply"
          />
        </Card>
      ) : (
        <View style={[styles.stepper, { backgroundColor: theme.surface, borderColor: theme.line }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("history.range.previous")} hitSlop={8} onPress={() => props.onChange(matchPreset(shiftRange(range, -1)))} testID="range-previous">
            <ChevronLeft color={theme.ink} size={22} />
          </Pressable>
          <Text style={[styles.label, { color: theme.ink }]} numberOfLines={1} testID="range-label">
            {rangeLabel(range)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("history.range.next")}
            accessibilityState={{ disabled: !canNext }}
            hitSlop={8}
            disabled={!canNext}
            onPress={() => props.onChange(matchPreset(next))}
            testID="range-next"
          >
            <ChevronRight color={canNext ? theme.ink : theme.line} size={22} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** A day that goes back and forward one at a time; never past today. */
function DayStepper(props: { label: string; day: Date; onChange: (day: Date) => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const canLater = addDays(props.day, 1).getTime() <= startOfDay(new Date()).getTime();
  return (
    <View style={styles.dayRow}>
      <Text style={[styles.dayLabel, { color: theme.muted }]}>{props.label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("history.range.earlier")} hitSlop={8} onPress={() => props.onChange(addDays(props.day, -1))}>
        <ChevronLeft color={theme.ink} size={20} />
      </Pressable>
      <Text style={[styles.day, { color: theme.ink }]}>{capital(formatDay(props.day.getTime()))}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("history.range.later")} hitSlop={8} disabled={!canLater} onPress={() => props.onChange(addDays(props.day, 1))}>
        <ChevronRight color={canLater ? theme.ink : theme.line} size={20} />
      </Pressable>
    </View>
  );
}

/** Frames per second the player repaints: enough to see it move, light for the phone. */
const FRAME_MS = 66;

export function Player(props: {
  points: HistoryPoint[];
  moment: Moment | null;
  time: number;
  onTime: (time: number) => void;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  rate: number;
  onRate: (rate: number) => void;
  /** The period spans several days: the day goes with the time. */
  severalDays: boolean;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { points, time, playing, rate } = props;
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? 0;
  const timeRef = useRef(time);
  timeRef.current = time;
  const handlers = useRef(props);
  handlers.current = props;

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let before = Date.now();
    let painted = 0;
    let current = timeRef.current;
    const tick = () => {
      const now = Date.now();
      const elapsed = Math.min(now - before, 100) / 1000;
      before = now;
      current = advance(points, current, elapsed, rate);
      if (current >= t1) {
        handlers.current.onTime(t1);
        handlers.current.onPlaying(false);
        return;
      }
      if (now - painted >= FRAME_MS) {
        painted = now;
        handlers.current.onTime(current);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, rate, points, t1]);

  const toggle = () => {
    if (!playing && time >= t1) props.onTime(t0);
    props.onPlaying(!playing);
  };
  const nextRate = () => props.onRate(RATES[(RATES.indexOf(rate as (typeof RATES)[number]) + 1) % RATES.length] ?? RATES[0]);
  const m = props.moment;

  return (
    <Card style={styles.player}>
      <View style={styles.playerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playing ? t("history.player.pause") : t("history.player.play")}
          onPress={toggle}
          style={[styles.play, { backgroundColor: theme.primary }]}
          testID="player-toggle"
        >
          {playing ? <Pause color={theme.onPrimary} size={20} fill={theme.onPrimary} /> : <Play color={theme.onPrimary} size={20} fill={theme.onPrimary} />}
        </Pressable>
        <View style={styles.when}>
          <Text style={[styles.clock, { color: theme.ink }]} testID="player-time">
            {formatClockSeconds(time * 1000)}
          </Text>
          {props.severalDays ? <Text style={[styles.small, { color: theme.muted }]}>{formatDay(time * 1000)}</Text> : null}
        </View>
        <View style={styles.speed}>
          <Text style={[styles.clock, { color: theme.ink }]}>{m ? `${Math.round(m.speed)} km/h` : "—"}</Text>
          <Text style={[styles.small, { color: theme.muted }]}>
            {m?.ignition === true ? t("history.player.engineOn") : m?.ignition === false ? t("history.player.engineOff") : " "}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("history.player.rate")}
          onPress={nextRate}
          style={[styles.rate, { borderColor: theme.line }]}
          testID="player-rate"
        >
          <Text style={[styles.rateText, { color: theme.ink }]}>×{rate}</Text>
        </Pressable>
      </View>
      <Slider
        testID="player-slider"
        accessibilityLabel={t("history.player.moment")}
        value={t1 > t0 ? (time - t0) / (t1 - t0) : 0}
        onStart={() => props.onPlaying(false)}
        onChange={(f) => props.onTime(t0 + f * (t1 - t0))}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  block: { gap: 10 },
  chips: { gap: 8 },
  chip: { height: 34, paddingHorizontal: 14, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth, justifyContent: "center" },
  chipText: { fontFamily: FONT.medium, fontSize: 14 },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 44, paddingHorizontal: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  label: { flex: 1, textAlign: "center", fontFamily: FONT.semibold, fontSize: 15 },
  custom: { paddingVertical: 12, gap: 12 },
  dayRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  dayLabel: { width: 56, fontFamily: FONT.medium, fontSize: 13 },
  day: { flex: 1, textAlign: "center", fontFamily: FONT.semibold, fontSize: 15 },
  player: { paddingVertical: 12, gap: 6, borderRadius: RADIUS },
  playerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  play: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  when: { flex: 1 },
  speed: { alignItems: "flex-end" },
  clock: { fontFamily: FONT.mono, fontSize: 17 },
  small: { fontFamily: FONT.regular, fontSize: 12 },
  rate: { minWidth: 52, height: 34, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  rateText: { fontFamily: FONT.mono, fontSize: 14 },
});
