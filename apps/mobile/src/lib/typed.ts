// What a person types in a field. A button pressed right after typing can run
// before React renders the last keystrokes, and then the screen's state still
// holds the text without them. Whatever sends the text reads it with `latest()`,
// which every keystroke updates at once; `text` is for drawing the screen.
import { useCallback, useRef, useState } from "react";

export function useTyped(initial = "") {
  const [text, setText] = useState(initial);
  const ref = useRef(initial);
  const change = useCallback((next: string) => {
    ref.current = next;
    setText(next);
  }, []);
  const latest = useCallback(() => ref.current, []);
  return { text, change, latest };
}
