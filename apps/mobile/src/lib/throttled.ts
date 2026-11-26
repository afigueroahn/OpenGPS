// A value that changes at most once every `ms`: the last one always arrives,
// late if it has to. Same as the web app's (apps/web/src/app/widgets.tsx).
import { useEffect, useRef, useState } from "react";

export function useThrottled<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setCurrent(value);
      return;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setCurrent(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}
