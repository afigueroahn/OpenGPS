// Trip player: moves the point along the map and shows the speed
// over time. The chart is also the bar to move forward or back.
import { type HistoryPoint, type Stop, VEHICLE_STATUS_COLOR } from "@opengps/shared";
import clsx from "clsx";
import { Pause, Play } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { formatClock, formatClockSeconds, formatDay } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import type { MapHandle } from "../MapView";
import { GAP_S, indexAt, isWait, momentAt } from "./geo";

/** How many times faster than the clock playback advances. */
const RATES = [10, 30, 60, 120, 300, 600];
/** Roughly how long it should take to watch an entire trip. */
const TARGET_SECONDS = 40;

interface Props {
  points: HistoryPoint[];
  /**
   * What is being played. When it changes (another period or trip) playback starts over; the points of a
   * period that is still going on arrive again every minute with the same key, and playback keeps going.
   */
  playKey: string;
  stops: Stop[];
  /** Average while moving, which does not come from the points but from the analysis. */
  avgSpeedKmh: number;
  map: RefObject<MapHandle | null>;
  /** Jump requested from the lists: `n` changes with each request. */
  seek: { t: number; n: number } | null;
  /** Over the dark panel (phone) instead of over the map. */
  dark?: boolean;
}

const PLOT = { left: 30, right: 10, top: 16, bottom: 18 };

export function Player({ points, playKey, stops, avgSpeedKmh, map, seek, dark = false }: Props) {
  const { t } = useTranslation();
  const night = useTheme().dark;
  const first = points[0];
  const last = points[points.length - 1];
  const t0 = first?.t ?? 0;
  const t1 = last?.t ?? 0;
  const span = Math.max(1, t1 - t0);

  const [time, setTime] = useState(t0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(60);
  const timeRef = useRef(time);
  timeRef.current = time;

  // With another trip, it goes back to the start and picks a pace that covers it in little time.
  useEffect(() => {
    let moving = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i] as HistoryPoint;
      const b = points[i + 1] as HistoryPoint;
      if (!isWait(a, b)) moving += b.t - a.t;
    }
    const ideal = moving / TARGET_SECONDS;
    setRate(RATES.reduce((best, r) => (Math.abs(r - ideal) < Math.abs(best - ideal) ? r : best), RATES[0] as number));
    setPlaying(false);
    setTime(points[0]?.t ?? 0);
    // Deliberate dependencies: only with another trip, not each time its points arrive again.
  }, [playKey]);

  useEffect(() => {
    if (seek) setTime(Math.min(t1, Math.max(t0, seek.t)));
    // Deliberate dependencies: only when a jump is requested.
  }, [seek]);

  // ─── Progress ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let before = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.min(now - before, 100) / 1000;
      before = now;
      let next = timeRef.current + elapsed * rate;
      // Stops and stretches without data are skipped: nobody wants to watch a still point.
      for (let guard = 0; guard < 200 && next < t1; guard++) {
        const i = indexAt(points, next);
        const a = points[i] as HistoryPoint;
        const b = points[i + 1];
        if (!b || !isWait(a, b)) break;
        next = b.t;
      }
      if (next >= t1) {
        setTime(t1);
        setPlaying(false);
        return;
      }
      setTime(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, rate, points, t1]);

  // ─── Point on the map ──────────────────────────────────────────────────────
  const moment = useMemo(() => momentAt(points, time), [points, time]);
  useEffect(() => {
    if (!moment) {
      map.current?.setCursor(null);
      return;
    }
    const status = moment.speed >= 3 ? "moving" : moment.ignition ? "idle" : "stopped";
    map.current?.setCursor({
      lat: moment.lat,
      lon: moment.lon,
      course: moment.speed >= 3 ? moment.course : null,
      color: VEHICLE_STATUS_COLOR[status],
      follow: playing,
    });
  }, [moment, playing, map]);
  useEffect(() => () => map.current?.setCursor(null), [map]);

  // ─── Chart ───────────────────────────────────────────────────────────────
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const height = dark ? 84 : 104;
  const plotW = Math.max(0, width - PLOT.left - PLOT.right);
  const plotH = height - PLOT.top - PLOT.bottom;

  const chart = useMemo(() => {
    let max: HistoryPoint | null = null;
    for (const p of points) if (!max || p.s > max.s) max = p;
    const top = Math.max(40, Math.ceil((max?.s ?? 0) / 20) * 20);
    const x = (t: number) => ((t - t0) / span) * plotW;
    const y = (speed: number) => plotH - (Math.min(speed, top) / top) * plotH;
    // At most one point per pixel, keeping the highest speed of each.
    const pieces: [number, number][][] = [];
    let piece: [number, number][] = [];
    let column = -1;
    let previous: HistoryPoint | null = null;
    for (const p of points) {
      if (previous && p.t - previous.t > GAP_S) {
        if (piece.length > 0) pieces.push(piece);
        piece = [];
        column = -1;
      }
      const px = x(p.t);
      const py = y(p.s);
      const lastInPiece = piece[piece.length - 1];
      if (Math.floor(px) === column && lastInPiece) lastInPiece[1] = Math.min(lastInPiece[1], py);
      else piece.push([px, py]);
      column = Math.floor(px);
      previous = p;
    }
    if (piece.length > 0) pieces.push(piece);
    const text = (piece: [number, number][]) => piece.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join("L");
    return {
      top,
      max,
      x,
      y,
      line: pieces.map((piece) => `M${text(piece)}`).join(""),
      area: pieces
        .map((piece) => `M${(piece[0] as [number, number])[0].toFixed(1)} ${plotH}L${text(piece)}L${(piece[piece.length - 1] as [number, number])[0].toFixed(1)} ${plotH}Z`)
        .join(""),
      bands: stops
        .map((s) => ({ from: Math.max(t0, Date.parse(s.start) / 1000), to: Math.min(t1, Date.parse(s.end) / 1000) }))
        .filter((b) => b.to > b.from)
        .map((b) => ({ x: x(b.from), w: Math.max(1, x(b.to) - x(b.from)) })),
    };
  }, [points, stops, t0, t1, span, plotW, plotH]);

  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const timeAtPointer = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return t0 + Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width))) * span;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? span / 10 : span / 100;
    const moves: Record<string, number> = { ArrowLeft: time - step, ArrowRight: time + step, Home: t0, End: t1 };
    if (e.key === " ") {
      e.preventDefault();
      toggle();
    } else if (e.key in moves) {
      e.preventDefault();
      setTime(Math.min(t1, Math.max(t0, moves[e.key] as number)));
    }
  };
  const toggle = () => {
    if (!playing && time >= t1) setTime(t0);
    setPlaying((p) => !p);
  };

  if (points.length < 2) return null;

  const hovered = hover === null ? null : momentAt(points, hover);
  const inStop = (t: number) => stops.some((s) => t * 1000 >= Date.parse(s.start) && t * 1000 <= Date.parse(s.end));
  const cursorX = chart.x(time);
  // The chart follows the mode, over the panel and over the map alike.
  const colors = night
    ? { "--serie": "#3ddc97", "--relleno": "rgb(61 220 151 / 0.14)", "--guia": "rgb(255 255 255 / 0.12)", "--banda": "rgb(255 255 255 / 0.09)", "--cursor": "#ffffff", "--fondo": "#101623" }
    : { "--serie": "#101623", "--relleno": "rgb(16 22 35 / 0.09)", "--guia": "#e2e6ee", "--banda": "rgb(16 22 35 / 0.07)", "--cursor": "#0c7a4d", "--fondo": "#ffffff" };
  const muted = dark ? "text-white/50" : "text-muted";
  // If the trip spans several days, the axis ends also carry the date.
  const severalDays = new Date(t0 * 1000).toDateString() !== new Date(t1 * 1000).toDateString();
  const edge = (t: number) => (severalDays ? `${formatDay(t * 1000)} ${formatClock(t * 1000)}` : formatClock(t * 1000));
  const maxLabelX = chart.max ? Math.min(plotW - 34, Math.max(4, chart.x(chart.max.t) + 7)) : 0;

  return (
    <div
      className={clsx(dark ? "text-white" : "rounded-[16px] bg-surface p-4 text-ink shadow-[0_2px_6px_rgb(16_22_35/0.1),0_12px_34px_rgb(16_22_35/0.16)]")}
      style={colors as CSSProperties}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? t("history.player.pause") : t("history.player.play")}
          className={clsx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",
            dark ? "bg-signal text-ink hover:bg-mint" : "bg-primary text-on-primary hover:bg-primary/85",
          )}
        >
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" className="translate-x-px" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="num text-[19px] font-semibold leading-tight">{formatClockSeconds(time * 1000)}</p>
          <p className={clsx("truncate text-[12px]", muted)}>{formatDay(time * 1000)}</p>
        </div>
        <div className="text-right">
          <p className="leading-tight">
            <span className="num text-[19px] font-semibold">{Math.round(moment?.speed ?? 0)}</span>
            <span className={clsx("ml-1 text-[12px]", muted)}>km/h</span>
          </p>
          <p className={clsx("text-[12px]", muted)}>
            {moment?.ignition === null || moment?.ignition === undefined ? " " : moment.ignition ? t("history.player.engineOn") : t("history.player.engineOff")}
          </p>
        </div>
        <label className="shrink-0">
          <span className="sr-only">{t("history.player.rate")}</span>
          <select
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className={clsx(
              "num h-9 rounded-[10px] border-0 px-2 text-[13px] font-medium focus:outline-none focus-visible:ring-2",
              dark ? "bg-ink-2 text-white focus-visible:ring-signal" : "bg-canvas text-ink focus-visible:ring-ink/30",
            )}
          >
            {RATES.map((r) => (
              <option key={r} value={r}>
                ×{r}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label={t("history.player.moment")}
        aria-valuemin={t0}
        aria-valuemax={t1}
        aria-valuenow={Math.round(time)}
        aria-valuetext={t("history.player.momentValue", { time: formatClockSeconds(time * 1000), speed: Math.round(moment?.speed ?? 0) })}
        onKeyDown={onKey}
        className="relative mt-3 select-none rounded-lg"
      >
        {width > 0 && (
          <svg width={width} height={height} className="block" role="img" aria-label={t("history.player.chart")}>
            <g transform={`translate(${PLOT.left} ${PLOT.top})`}>
              {chart.bands.map((b) => (
                <rect key={b.x} x={b.x} y={0} width={b.w} height={plotH} fill="var(--banda)" />
              ))}
              {[chart.top, chart.top / 2].map((v) => (
                <g key={v}>
                  <line x1={0} x2={plotW} y1={chart.y(v)} y2={chart.y(v)} stroke="var(--guia)" strokeWidth={1} />
                  <text x={-7} y={chart.y(v) + 3.5} textAnchor="end" className={clsx("num fill-current text-[10px]", muted)}>
                    {v}
                  </text>
                </g>
              ))}
              <line x1={0} x2={plotW} y1={plotH} y2={plotH} stroke="var(--guia)" strokeWidth={1} />
              <path d={chart.area} fill="var(--relleno)" />
              <path d={chart.line} fill="none" stroke="var(--serie)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {chart.max && chart.max.s > 0 && (
                <g>
                  <circle cx={chart.x(chart.max.t)} cy={chart.y(chart.max.s)} r={4} fill="var(--serie)" stroke="var(--fondo)" strokeWidth={2} />
                  <text x={maxLabelX} y={chart.y(chart.max.s) - 6} className="num fill-current text-[10.5px] font-semibold">
                    {chart.max.s}
                  </text>
                </g>
              )}
              {hovered && hover !== null && <line x1={chart.x(hover)} x2={chart.x(hover)} y1={0} y2={plotH} stroke="var(--serie)" strokeOpacity={0.35} strokeWidth={1} />}
              <line x1={cursorX} x2={cursorX} y1={-4} y2={plotH} stroke="var(--cursor)" strokeWidth={2} strokeLinecap="round" />
              <circle cx={cursorX} cy={chart.y(moment?.speed ?? 0)} r={5} fill="var(--cursor)" stroke="var(--fondo)" strokeWidth={2} />
              <text x={0} y={plotH + 14} className={clsx("num fill-current text-[10px]", muted)}>
                {edge(t0)}
              </text>
              <text x={plotW} y={plotH + 14} textAnchor="end" className={clsx("num fill-current text-[10px]", muted)}>
                {edge(t1)}
              </text>
              {/* Layer that receives the pointer: larger than any marker. */}
              <rect
                x={0}
                y={-PLOT.top}
                width={plotW}
                height={height}
                fill="transparent"
                className="cursor-ew-resize touch-none"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  dragging.current = true;
                  setPlaying(false);
                  setTime(timeAtPointer(e));
                }}
                onPointerMove={(e) => {
                  const t = timeAtPointer(e);
                  if (dragging.current) setTime(t);
                  if (e.pointerType === "mouse") setHover(t);
                }}
                onPointerUp={() => {
                  dragging.current = false;
                }}
                onPointerLeave={() => setHover(null)}
              />
            </g>
          </svg>
        )}
        {hovered && hover !== null && (
          <div
            className={clsx(
              "pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] shadow-lg",
              dark ? "bg-white text-ink" : "bg-primary text-on-primary",
            )}
            style={{ left: Math.min(Math.max(PLOT.left + chart.x(hover), 60), width - 60), transform: "translate(-50%, -100%)" }}
          >
            <span className="num font-semibold">{Math.round(hovered.speed)} km/h</span>
            <span className="num ml-2 opacity-70">
              {severalDays && `${formatDay(hover * 1000)} `}
              {formatClockSeconds(hover * 1000)}
            </span>
            {inStop(hover) && <span className="ml-2 opacity-70">{t("history.player.inStop")}</span>}
          </div>
        )}
      </div>

      <p className={clsx("mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]", muted)}>
        <span>
          <Trans
            i18nKey="history.player.legend"
            values={{ max: chart.max?.s ?? 0, avg: avgSpeedKmh }}
            components={{ b: <strong className={clsx("num font-semibold", dark ? "text-white" : "text-ink")} /> }}
          />
        </span>
        {chart.bands.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: "var(--banda)", outline: "1px solid var(--guia)" }} />
            {t("history.player.stops")}
          </span>
        )}
      </p>
    </div>
  );
}
