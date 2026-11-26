// A horizontal slider drawn by the app: a track, the part already played and
// a knob the person drags. Plain JavaScript, so it needs no native module.
import { useRef, useState } from "react";
import { type LayoutChangeEvent, PanResponder, StyleSheet, View } from "react-native";
import { useTheme } from "../lib/theme";

const KNOB = 22;

/** Value from 0 to 1 for a touch at `x` on a track `width` wide. */
export const fractionAt = (x: number, width: number) => (width <= 0 ? 0 : Math.min(1, Math.max(0, x / width)));

export function Slider(props: {
  /** From 0 to 1. */
  value: number;
  /** While dragging, and once more when let go. */
  onChange: (value: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const handlers = useRef(props);
  handlers.current = props;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // The sheet or the list around must not take the gesture while dragging.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        handlers.current.onStart?.();
        handlers.current.onChange(fractionAt(e.nativeEvent.locationX, widthRef.current));
      },
      onPanResponderMove: (e) => handlers.current.onChange(fractionAt(e.nativeEvent.locationX, widthRef.current)),
      onPanResponderRelease: () => handlers.current.onEnd?.(),
      onPanResponderTerminate: () => handlers.current.onEnd?.(),
    }),
  ).current;

  const onLayout = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
    setWidth(e.nativeEvent.layout.width);
  };
  const x = Math.min(1, Math.max(0, props.value)) * width;

  return (
    <View
      testID={props.testID}
      accessibilityRole="adjustable"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(props.value * 100) }}
      onAccessibilityAction={(e) => {
        const step = e.nativeEvent.actionName === "increment" ? 0.05 : -0.05;
        props.onChange(Math.min(1, Math.max(0, props.value + step)));
      }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      style={styles.hit}
      onLayout={onLayout}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={[styles.track, { backgroundColor: theme.line }]}>
        <View style={[styles.done, { width: x, backgroundColor: theme.signalInk }]} />
      </View>
      <View pointerEvents="none" style={[styles.knob, { left: x - KNOB / 2, backgroundColor: theme.surface, borderColor: theme.signalInk }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { height: 36, justifyContent: "center" },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  done: { height: 4 },
  knob: { position: "absolute", width: KNOB, height: KNOB, borderRadius: KNOB / 2, borderWidth: 3, top: (36 - KNOB) / 2 },
});
