// History of a vehicle: period, totals, trips, stops, positions,
// export and comparison with another trip.
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_LABEL,
  type ExportFormat,
  HISTORY_MAX_POINTS,
  type HistoryPoint,
  type HistorySummary,
  type Stop,
  type Trip,
  type Vehicle,
  type VehicleHistory,
} from "@opengps/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, GitCompareArrows, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Spinner } from "../../components/ui";
import { downloadHistory, geocodePoint, getHistory } from "../../lib/api";
import { formatClock, formatClockSeconds, formatCoords, formatDay, formatDuration, formatKm } from "../../lib/format";
import { currentLanguage } from "../../lib/i18n";
import type { HistoryMark, HistoryView, MapHandle } from "../MapView";
import { errorText } from "../widgets";
import { Player } from "./Player";
import { type RouteDiff, awayFrom } from "./compare";
import { between } from "./geo";
import { PRESETS, type Preset, type Range, presetRange, rangeLabel, rangeProblem, reachesFuture, shiftRange, startOfDay, toInput } from "./range";

/** Colors of the two trips when comparing; a pair that is also distinguishable with color blindness. */
const COLOR_MAIN = "#2a78d6";
const COLOR_OTHER = "#eb6834";
const COLOR_ROUTE = "#101623";
const COLOR_START = "#12a065";

const historyKey = (vehicleId: string, range: { from: Date; to: Date }) => ["history", vehicleId, range.from.toISOString(), range.to.toISOString()];

/** What each trip has outside the other's path. */
interface Difference {
  main: RouteDiff;
  other: RouteDiff;
}

interface Props {
  vehicle: Vehicle;
  /** Vehicles it can be compared with. */
  vehicles: Vehicle[];
  geocoding: boolean;
  map: RefObject<MapHandle | null>;
  /** Gap over the map where the player goes on wide screens; without it, it goes in the panel. */
  playerSlot: HTMLElement | null;
  onView: (view: HistoryView) => void;
  onBack: () => void;
}

export function HistoryPanel({ vehicle, vehicles, geocoding, map, playerSlot, onView, onBack }: Props) {
  const { t } = useTranslation();
  const [range, setRangeState] = useState<Range>(() => presetRange("today"));
  const [tab, setTab] = useState<"trips" | "stops" | "positions">("trips");
  const [focus, setFocus] = useState<number | null>(null);
  const [seek, setSeek] = useState<{ t: number; n: number } | null>(null);
  const [compare, setCompare] = useState<{ vehicleId: string; range: Range } | null>(null);
  const setRange = (next: Range) => {
    setFocus(null);
    setRangeState(next);
  };

  const history = useQuery({
    queryKey: historyKey(vehicle.id, range),
    queryFn: () => getHistory(vehicle.id, range.from, range.to),
    staleTime: 30_000,
    // Today keeps growing while the vehicle is moving.
    refetchInterval: reachesFuture(range) ? 60_000 : false,
  });
  const data = history.data;
  const trip = focus === null ? null : (data?.trips[focus] ?? null);

  // A long period arrives lightened; when choosing a trip it is requested with all its detail.
  const tripRange = useMemo(() => (trip ? { from: new Date(trip.start), to: new Date(Date.parse(trip.end) + 1000) } : null), [trip]);
  const lightened = (data?.points.length ?? 0) >= HISTORY_MAX_POINTS;
  const tripDetail = useQuery({
    queryKey: tripRange ? historyKey(vehicle.id, tripRange) : ["history", "none"],
    queryFn: () => getHistory(vehicle.id, (tripRange as { from: Date }).from, (tripRange as { to: Date }).to),
    enabled: tripRange !== null && lightened,
    staleTime: 300_000,
  });

  const other = useQuery({
    queryKey: compare ? historyKey(compare.vehicleId, compare.range) : ["history", "none"],
    queryFn: () => getHistory((compare as { vehicleId: string }).vehicleId, (compare as { range: Range }).range.from, (compare as { range: Range }).range.to),
    enabled: compare !== null,
    staleTime: 30_000,
  });

  /** Points that are shown and played: the whole period or the selected trip. */
  const shown = useMemo<HistoryPoint[]>(() => {
    if (!data) return [];
    if (!trip) return data.points;
    return tripDetail.data?.points ?? between(data.points, Date.parse(trip.start) / 1000, Date.parse(trip.end) / 1000);
  }, [data, trip, tripDetail.data]);
  const otherPoints = compare ? other.data?.points : undefined;
  // The comparison goes both ways: what each trip has outside the other.
  const diff = useMemo<Difference | null>(() => {
    if (!otherPoints) return null;
    const other = awayFrom(shown, otherPoints);
    const main = awayFrom(otherPoints, shown);
    return other && main ? { main, other } : null;
  }, [shown, otherPoints]);

  // ─── What the map draws ─────────────────────────────────────────────────
  const fitKey = [vehicle.id, range.from.getTime(), range.to.getTime(), focus, data ? 1 : 0, compare?.vehicleId, compare?.range.from.getTime(), otherPoints ? 1 : 0].join("|");
  const view = useMemo<HistoryView>(() => {
    const marks: HistoryMark[] = [];
    const ends = (points: HistoryPoint[], start: string, end: string, order: number) => {
      const first = points[0];
      const last = points[points.length - 1];
      if (!first || !last) return;
      marks.push({ kind: "end", lat: last.lat, lon: last.lon, label: t("history.end"), color: end, order });
      marks.push({ kind: "start", lat: first.lat, lon: first.lon, label: t("history.start"), color: start, order });
    };
    const from = shown[0]?.t ?? 0;
    const to = shown[shown.length - 1]?.t ?? 0;
    (data?.stops ?? []).forEach((stop, i) => {
      const at = Date.parse(stop.start) / 1000;
      if (at >= from - 1 && at <= to + 1) marks.push({ kind: "stop", lat: stop.lat, lon: stop.lon, label: String(i + 1), color: compare ? COLOR_MAIN : COLOR_ROUTE });
    });
    if (compare && otherPoints) ends(otherPoints, COLOR_OTHER, COLOR_OTHER, 1);
    ends(shown, compare ? COLOR_MAIN : COLOR_START, compare ? COLOR_MAIN : COLOR_ROUTE, 0);
    return {
      routes: [
        ...(compare && otherPoints ? [{ points: otherPoints, color: COLOR_OTHER }] : []),
        { points: shown, color: compare ? COLOR_MAIN : COLOR_ROUTE },
      ],
      deviations: diff
        ? [...diff.other.deviations.map((points) => ({ points, color: COLOR_OTHER })), ...diff.main.deviations.map((points) => ({ points, color: COLOR_MAIN }))]
        : [],
      marks,
      fitKey,
    };
  }, [shown, data, compare, otherPoints, diff, fitKey, t]);
  useEffect(() => onView(view), [view, onView]);

  const goTo = (t: number, lat: number, lon: number) => {
    setSeek((s) => ({ t, n: (s?.n ?? 0) + 1 }));
    map.current?.flyTo(lat, lon);
  };

  const player = data && shown.length > 1 && (
    <Player
      points={shown}
      stops={data.stops}
      avgSpeedKmh={trip ? trip.avgSpeedKmh : data.summary.avgSpeedKmh}
      map={map}
      seek={seek}
      dark={!playerSlot}
    />
  );
  const exported = trip && tripRange ? tripRange : range;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white"
        >
          <ArrowLeft size={15} className="shrink-0" /> <span className="truncate">{vehicle.name}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <ToolButton
            active={compare !== null}
            onClick={() => {
              setFocus(null);
              setCompare(compare ? null : { vehicleId: vehicle.id, range: shiftRange(range, -1) });
            }}
            icon={<GitCompareArrows size={15} />}
          >
            {t("history.compare")}
          </ToolButton>
          <ExportMenu vehicleId={vehicle.id} range={exported} what={trip ? "trip" : "period"} disabled={!data || data.summary.positions === 0} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2">
        <h1 className="text-[22px] font-semibold tracking-tight">{t("history.title")}</h1>
        <RangePicker range={range} onChange={setRange} />

        {!playerSlot && player && <div className="mt-4 rounded-[14px] bg-ink-2 p-3">{player}</div>}

        {history.isLoading && (
          <div className="flex h-32 items-center justify-center text-white/50">
            <Spinner />
          </div>
        )}
        {history.isError && <p className="mt-5 rounded-[12px] bg-ink-2 px-4 py-3 text-sm text-white/75">{errorText(history.error)}</p>}

        {data && data.summary.positions === 0 && (
          <div className="mt-5 rounded-[14px] bg-ink-2 p-4">
            <p className="text-[15px] font-semibold">{t("history.noData.title")}</p>
            <p className="mt-1 text-sm leading-relaxed text-white/60">{t("history.noData.lead")}</p>
          </div>
        )}

        {data && data.summary.positions > 0 && (
          <>
            {compare ? (
              <ComparePanel
                vehicle={vehicle}
                vehicles={vehicles}
                range={range}
                compare={compare}
                onChange={setCompare}
                main={data.summary}
                other={other.data?.summary ?? null}
                loading={other.isLoading}
                error={other.isError ? errorText(other.error) : null}
                diff={diff}
              />
            ) : (
              <>
                <Summary summary={data.summary} trip={trip} onClear={() => setFocus(null)} />
                <div className="mt-5 flex gap-1 rounded-[10px] bg-ink-2 p-1" role="tablist" aria-label={t("history.tabs.label")}>
                  <Tab active={tab === "trips"} onClick={() => setTab("trips")} count={data.trips.length}>
                    {t("history.tabs.trips")}
                  </Tab>
                  <Tab active={tab === "stops"} onClick={() => setTab("stops")} count={data.stops.length}>
                    {t("history.tabs.stops")}
                  </Tab>
                  <Tab active={tab === "positions"} onClick={() => setTab("positions")}>
                    {t("history.tabs.positions")}
                  </Tab>
                </div>
                {tab === "trips" && <Trips trips={data.trips} focus={focus} onFocus={setFocus} geocoding={geocoding} />}
                {tab === "stops" && <Stops stops={data.stops} geocoding={geocoding} onPick={(s) => goTo(Date.parse(s.start) / 1000, s.lat, s.lon)} />}
                {tab === "positions" && (
                  <Positions points={shown} total={trip ? null : data.summary.positions} onPick={(p) => goTo(p.t, p.lat, p.lon)} />
                )}
              </>
            )}
          </>
        )}
      </div>

      {playerSlot && player && createPortal(<div className="pointer-events-auto mx-auto max-w-[820px]">{player}</div>, playerSlot)}
    </div>
  );
}

// ─── Period ─────────────────────────────────────────────────────────────────

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-colors",
        active ? "bg-white text-ink" : "bg-ink-2 text-white/75 hover:bg-ink-3 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

const dateInput =
  "num h-10 w-full rounded-[10px] border-0 bg-ink-2 px-3 text-[13px] text-white [color-scheme:dark] focus:outline-none focus-visible:ring-2 focus-visible:ring-signal";

function CustomRange({ from, to, onApply }: { from: Date; to: Date; onApply: (from: Date, to: Date) => void }) {
  const { t } = useTranslation();
  const [start, setStart] = useState(toInput(from));
  const [end, setEnd] = useState(toInput(to));
  useEffect(() => {
    setStart(toInput(from));
    setEnd(toInput(to));
  }, [from, to]);
  const problem = rangeProblem(new Date(start), new Date(end));
  const changed = start !== toInput(from) || end !== toInput(to);
  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-white/45">{t("common.from")}</span>
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={dateInput} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-white/45">{t("common.to")}</span>
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={dateInput} />
        </label>
      </div>
      {problem && changed && <p className="text-[13px] text-coral">{problem}</p>}
      {changed && !problem && (
        <button
          type="button"
          onClick={() => onApply(new Date(start), new Date(end))}
          className="h-9 w-full rounded-[10px] bg-signal text-[13px] font-semibold text-ink hover:bg-mint"
        >
          {t("history.range.apply")}
        </button>
      )}
    </div>
  );
}

function RangePicker({ range, onChange }: { range: Range; onChange: (range: Range) => void }) {
  const { t } = useTranslation();
  const next = shiftRange(range, 1);
  const canAdvance = next.from.getTime() <= Date.now();
  const arrow = "flex h-9 w-9 items-center justify-center rounded-[10px] text-white/70 hover:bg-ink-2 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent";
  // After moving with the arrows the period stops being "today" or "yesterday", unless it matches.
  const active: Preset = range.preset;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onChange(matchPreset(shiftRange(range, -1)))} aria-label={t("history.range.previous")} className={arrow}>
          <ChevronLeft size={18} />
        </button>
        <p className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold first-letter:uppercase">{rangeLabel(range)}</p>
        <button type="button" onClick={() => onChange(matchPreset(next))} disabled={!canAdvance} aria-label={t("history.range.next")} className={arrow}>
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("history.range.label")}>
        {PRESETS.map((p) => (
          <Chip key={p.id} active={active === p.id} onClick={() => onChange(p.id === "custom" ? { ...range, preset: "custom" } : presetRange(p.id))}>
            {p.label}
          </Chip>
        ))}
      </div>
      {active === "custom" && <CustomRange from={range.from} to={range.to} onApply={(from, to) => onChange({ preset: "custom", from, to })} />}
    </div>
  );
}

/** If the period matches one of the shortcuts, marks it as such. */
function matchPreset(range: Range): Range {
  for (const id of ["today", "yesterday", "7d", "30d"] as const) {
    const preset = presetRange(id);
    if (preset.from.getTime() === range.from.getTime() && preset.to.getTime() === range.to.getTime()) return preset;
  }
  return range;
}

// ─── Totals ─────────────────────────────────────────────────────────────────

function Datum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-white/45">{label}</dt>
      <dd className="mt-0.5 text-[15px]">{value}</dd>
    </div>
  );
}

function Summary({ summary, trip, onClear }: { summary: HistorySummary; trip: Trip | null; onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mt-5">
      {trip && (
        <button
          type="button"
          onClick={onClear}
          className="mb-3 inline-flex h-7 items-center gap-1.5 rounded-full bg-signal/15 pl-3 pr-2 text-[12.5px] font-medium text-signal hover:bg-signal/25"
        >
          {t("history.summary.tripAt", { time: formatClock(Date.parse(trip.start)) })} <X size={14} aria-label={t("history.summary.wholePeriod")} />
        </button>
      )}
      <div className="flex items-baseline gap-2">
        <span className="text-[52px] font-semibold tabular-nums leading-none tracking-tight">{formatKm(trip ? trip.distanceM : summary.distanceM)}</span>
        <span className="text-[15px] text-white/50">km</span>
      </div>
      {trip ? (
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
          <Datum label={t("history.summary.duration")} value={formatDuration(trip.durationS)} />
          <Datum label={t("history.summary.idle")} value={formatDuration(trip.idleS)} />
          <Datum label={t("history.summary.maxSpeed")} value={`${trip.maxSpeedKmh} km/h`} />
          <Datum label={t("history.summary.avgSpeed")} value={`${trip.avgSpeedKmh} km/h`} />
        </dl>
      ) : (
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
          <Datum label={t("history.summary.moving")} value={formatDuration(summary.movingS)} />
          <Datum label={t("history.summary.stopped")} value={formatDuration(summary.stoppedS)} />
          <Datum label={t("history.summary.idle")} value={formatDuration(summary.idleS)} />
          <Datum label={t("history.summary.engineOn")} value={formatDuration(summary.movingS + summary.idleS)} />
          <Datum label={t("history.summary.maxSpeed")} value={`${summary.maxSpeedKmh} km/h`} />
          <Datum label={t("history.summary.avgSpeed")} value={`${summary.avgSpeedKmh} km/h`} />
        </dl>
      )}
    </div>
  );
}

function Tab({ active, onClick, count, children }: { active: boolean; onClick: () => void; count?: number; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        "h-8 flex-1 whitespace-nowrap rounded-lg text-[13px] font-medium transition-colors",
        active ? "bg-white text-ink" : "text-white/65 hover:text-white",
      )}
    >
      {children} {count !== undefined && <span className="num opacity-60">{count.toLocaleString(currentLanguage())}</span>}
    </button>
  );
}

// ─── Addresses ─────────────────────────────────────────────────────────────

function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);
  return { ref, seen };
}

/** Approximate address of a point; while unknown, its coordinates. */
function Place({ lat, lon, known, geocoding }: { lat: number; lon: number; known: string | null; geocoding: boolean }) {
  const { ref, seen } = useSeen<HTMLSpanElement>();
  const lookup = useQuery({
    queryKey: ["place", lat.toFixed(4), lon.toFixed(4)],
    queryFn: () => geocodePoint(lat, lon),
    enabled: geocoding && known === null && seen,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const address = known ?? lookup.data ?? null;
  return (
    <span ref={ref} className={clsx(!address && "num text-[12.5px]")}>
      {address ?? formatCoords(lat, lon)}
    </span>
  );
}

// ─── Trips ──────────────────────────────────────────────────────────────────

function Trips({ trips, focus, onFocus, geocoding }: { trips: Trip[]; focus: number | null; onFocus: (index: number | null) => void; geocoding: boolean }) {
  const { t } = useTranslation();
  if (trips.length === 0) return <Empty>{t("history.trips.empty")}</Empty>;
  // With several days, each one has its header with the day's kilometers.
  const days = new Map<number, { index: number; trip: Trip }[]>();
  trips.forEach((trip, index) => {
    const day = startOfDay(new Date(trip.start)).getTime();
    const list = days.get(day);
    if (list) list.push({ index, trip });
    else days.set(day, [{ index, trip }]);
  });
  return (
    <div className="mt-3 space-y-4">
      {[...days.entries()].map(([day, list]) => (
        <section key={day}>
          {days.size > 1 && (
            <h2 className="mb-1.5 flex items-baseline justify-between px-1 text-[12px] font-medium uppercase tracking-wider text-white/45">
              <span>{formatDay(day)}</span>
              <span className="num normal-case tracking-normal">{formatKm(list.reduce((n, t) => n + t.trip.distanceM, 0))} km</span>
            </h2>
          )}
          <ul className="space-y-1.5">
            {list.map(({ index, trip }) => (
              <li key={trip.start}>
                <button
                  type="button"
                  onClick={() => onFocus(focus === index ? null : index)}
                  aria-pressed={focus === index}
                  className={clsx(
                    "w-full rounded-[12px] px-3 py-3 text-left transition-colors",
                    focus === index ? "bg-ink-3 ring-1 ring-signal/60" : "bg-ink-2 hover:bg-ink-3",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="num text-[15px] font-semibold">
                      {formatClock(Date.parse(trip.start))} – {formatClock(Date.parse(trip.end))}
                    </span>
                    <span className="num text-[15px] font-semibold">{formatKm(trip.distanceM)} km</span>
                  </span>
                  <span className="mt-0.5 block text-[13px] text-white/55">
                    {formatDuration(trip.durationS)} · {t("history.trips.max", { speed: trip.maxSpeedKmh })}
                    {trip.idleS >= 60 && ` · ${t("history.trips.idle", { time: formatDuration(trip.idleS) })}`}
                  </span>
                  <span className="mt-2 block space-y-1 text-[13px] leading-snug text-white/80">
                    <span className="flex items-start gap-2">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: COLOR_START }} />
                      <Place lat={trip.startLat} lon={trip.startLon} known={trip.startAddress} geocoding={geocoding} />
                    </span>
                    <span className="flex items-start gap-2">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-[2px] bg-white" />
                      <Place lat={trip.endLat} lon={trip.endLon} known={trip.endAddress} geocoding={geocoding} />
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ─── Stops ─────────────────────────────────────────────────────────────────

function Stops({ stops, geocoding, onPick }: { stops: Stop[]; geocoding: boolean; onPick: (stop: Stop) => void }) {
  const { t } = useTranslation();
  if (stops.length === 0) return <Empty>{t("history.stops.empty")}</Empty>;
  const multiDay = new Set(stops.map((s) => startOfDay(new Date(s.start)).getTime())).size > 1;
  return (
    <ul className="mt-3 space-y-1.5">
      {stops.map((stop, i) => (
        <li key={stop.start}>
          <button type="button" onClick={() => onPick(stop)} className="flex w-full gap-3 rounded-[12px] bg-ink-2 px-3 py-3 text-left transition-colors hover:bg-ink-3">
            <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[11.5px] font-bold text-ink">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="num text-[15px] font-semibold">
                  {formatClock(Date.parse(stop.start))} – {formatClock(Date.parse(stop.end))}
                </span>
                <span className="text-[15px] font-semibold">{formatDuration(stop.durationS)}</span>
              </span>
              {(multiDay || stop.idleS >= 60) && (
                <span className="mt-0.5 block text-[13px] text-white/55">
                  {multiDay && formatDay(Date.parse(stop.start))}
                  {multiDay && stop.idleS >= 60 && " · "}
                  {stop.idleS >= 60 && t("history.stops.engineOn", { time: formatDuration(stop.idleS) })}
                </span>
              )}
              <span className="mt-1.5 block text-[13px] leading-snug text-white/80">
                <Place lat={stop.lat} lon={stop.lon} known={stop.address} geocoding={geocoding} />
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ─── Positions ──────────────────────────────────────────────────────────────

const ROW = 34;

function Positions({ points, total, onPick }: { points: HistoryPoint[]; total: number | null; onPick: (point: HistoryPoint) => void }) {
  const { t } = useTranslation();
  const [top, setTop] = useState(0);
  const height = 340;
  const start = Math.max(0, Math.floor(top / ROW) - 6);
  const end = Math.min(points.length, Math.ceil((top + height) / ROW) + 6);
  const multiDay = points.length > 1 && startOfDay(new Date((points[0] as HistoryPoint).t * 1000)).getTime() !== startOfDay(new Date((points[points.length - 1] as HistoryPoint).t * 1000)).getTime();
  return (
    <div className="mt-3">
      <div className="grid grid-cols-[1fr_auto_5.5rem] gap-3 px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-white/45">
        <span>{t("history.positions.time")}</span>
        <span className="text-right">km/h</span>
        <span>{t("history.positions.engine")}</span>
      </div>
      {/* Only the visible rows are drawn: there can be thousands. */}
      <div className="overflow-y-auto rounded-[12px] bg-ink-2" style={{ maxHeight: height }} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
        <div className="relative" style={{ height: points.length * ROW }}>
          {points.slice(start, end).map((p, i) => (
            <button
              key={start + i}
              type="button"
              onClick={() => onPick(p)}
              className="absolute inset-x-0 grid grid-cols-[1fr_auto_5.5rem] items-center gap-3 px-3 text-left text-[13px] hover:bg-ink-3"
              style={{ top: (start + i) * ROW, height: ROW }}
            >
              <span className="num truncate">
                {multiDay && <span className="text-white/45">{formatDay(p.t * 1000)} </span>}
                {formatClockSeconds(p.t * 1000)}
              </span>
              <span className="num text-right font-semibold">{p.s}</span>
              <span className="text-white/60">{p.i === null ? "—" : p.i ? t("history.positions.on") : t("history.positions.off")}</span>
            </button>
          ))}
        </div>
      </div>
      {total !== null && total > points.length && (
        <p className="mt-2 px-1 text-[12px] leading-relaxed text-white/45">
          {t("history.positions.partial", { shown: points.length.toLocaleString(currentLanguage()), total: total.toLocaleString(currentLanguage()) })}
        </p>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="mt-3 rounded-[12px] bg-ink-2 px-4 py-3 text-sm leading-relaxed text-white/60">{children}</p>;
}

// ─── Export ────────────────────────────────────────────────────────────────

function ToolButton({ active, onClick, icon, children, disabled }: { active?: boolean; onClick: () => void; icon: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={clsx(
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors disabled:opacity-40",
        active ? "bg-white text-ink" : "text-white/70 hover:bg-ink-2 hover:text-white",
      )}
    >
      {icon} {children}
    </button>
  );
}

/** `what` is exported: the selected trip or the whole period. */
function ExportMenu({ vehicleId, range, what, disabled }: { vehicleId: string; range: { from: Date; to: Date }; what: "trip" | "period"; disabled: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const download = useMutation({ mutationFn: (format: ExportFormat) => downloadHistory(vehicleId, range.from, range.to, format), onSuccess: () => setOpen(false) });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <ToolButton
        active={open}
        disabled={disabled}
        onClick={() => {
          download.reset();
          setOpen((o) => !o);
        }}
        icon={<Download size={15} />}
      >
        {t("history.export.button")}
      </ToolButton>
      {open && (
        <div className="themed absolute right-0 top-10 z-20 w-[272px] rounded-[14px] bg-surface p-1.5 text-ink shadow-2xl" role="menu" aria-label={t(`history.export.${what}`)}>
          <p className="px-3 pb-1 pt-2 text-[12px] font-medium uppercase tracking-wider text-muted">{t(`history.export.${what}`)}</p>
          {EXPORT_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              disabled={download.isPending}
              onClick={() => download.mutate(format)}
              className="flex w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-left hover:bg-canvas disabled:opacity-60"
            >
              <span>
                <span className="block text-sm font-semibold">{EXPORT_FORMAT_LABEL[format]}</span>
                <span className="block text-[12.5px] text-muted">{t(`history.export.note.${format}`)}</span>
              </span>
              {download.isPending && download.variables === format && <Spinner size={16} />}
            </button>
          ))}
          {download.isError && <p className="px-3 pb-2 pt-1 text-[13px] text-danger">{errorText(download.error)}</p>}
        </div>
      )}
    </div>
  );
}

// ─── Compare ────────────────────────────────────────────────────────────────

function ComparePanel(props: {
  vehicle: Vehicle;
  vehicles: Vehicle[];
  range: Range;
  compare: { vehicleId: string; range: Range };
  onChange: (compare: { vehicleId: string; range: Range }) => void;
  main: HistorySummary;
  other: VehicleHistory["summary"] | null;
  loading: boolean;
  error: string | null;
  diff: Difference | null;
}) {
  const { t } = useTranslation();
  const { vehicle, range, compare, main, other, diff } = props;
  const sameVehicle = compare.vehicleId === vehicle.id;
  const options: { id: string; label: string; range: Range }[] = [
    { id: "previous", label: t("history.comparison.previous"), range: shiftRange(range, -1) },
    ...(sameRange(weekBefore(range), shiftRange(range, -1)) ? [] : [{ id: "week", label: t("history.comparison.weekBefore"), range: weekBefore(range) }]),
    ...(sameVehicle ? [] : [{ id: "same", label: t("history.comparison.samePeriod"), range: { ...range, preset: "custom" as const } }]),
  ];
  const same = sameRange;
  const chosen = options.find((o) => same(o.range, compare.range))?.id ?? "custom";
  const [custom, setCustom] = useState(false);
  const withDevice = props.vehicles.filter((v) => v.device);
  // With two vehicles, each column has its name; with just one, its period.
  const otherName = props.vehicles.find((v) => v.id === compare.vehicleId)?.name ?? t("history.comparison.otherName");

  const rows: [string, (s: HistorySummary) => number, (n: number) => string, (delta: number) => string][] = [
    [t("history.comparison.rows.distance"), (s) => s.distanceM, (n) => `${formatKm(n)} km`, (d) => `${formatKm(Math.abs(d))} km`],
    [t("history.comparison.rows.moving"), (s) => s.movingS, formatDuration, (d) => formatDuration(Math.abs(d))],
    [t("history.comparison.rows.idle"), (s) => s.idleS, formatDuration, (d) => formatDuration(Math.abs(d))],
    [t("history.comparison.rows.stopped"), (s) => s.stoppedS, formatDuration, (d) => formatDuration(Math.abs(d))],
    [t("history.comparison.rows.maxSpeed"), (s) => s.maxSpeedKmh, (n) => `${n} km/h`, (d) => `${Math.abs(d)} km/h`],
    [t("history.comparison.rows.avgSpeed"), (s) => s.avgSpeedKmh, (n) => `${n} km/h`, (d) => `${Math.abs(d)} km/h`],
    [t("history.comparison.rows.trips"), (s) => s.trips, String, (d) => String(Math.abs(d))],
    [t("history.comparison.rows.stops"), (s) => s.stops, String, (d) => String(Math.abs(d))],
  ];

  return (
    <div className="mt-5">
      <h2 className="text-[11px] font-medium uppercase tracking-wider text-white/45">{t("history.comparison.title")}</h2>
      {withDevice.length > 1 && (
        <select
          value={compare.vehicleId}
          onChange={(e) => {
            // With another vehicle the natural choice is the same period; with the same one, the previous.
            const toSame = e.target.value !== vehicle.id && same(compare.range, shiftRange(range, -1));
            const toPrevious = e.target.value === vehicle.id && same(compare.range, range);
            props.onChange({
              vehicleId: e.target.value,
              range: toSame ? { ...range, preset: "custom" } : toPrevious ? shiftRange(range, -1) : compare.range,
            });
          }}
          aria-label={t("history.comparison.vehicle")}
          className="mt-2 h-9 w-full rounded-[10px] border-0 bg-ink-2 px-3 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          {withDevice.map((v) => (
            <option key={v.id} value={v.id}>
              {v.id === vehicle.id ? t("history.comparison.thisVehicle", { name: v.name }) : v.name}
            </option>
          ))}
        </select>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("history.comparison.period")}>
        {options.map((o) => (
          <Chip
            key={o.id}
            active={!custom && chosen === o.id}
            onClick={() => {
              setCustom(false);
              props.onChange({ ...compare, range: o.range });
            }}
          >
            {o.label}
          </Chip>
        ))}
        <Chip active={custom || chosen === "custom"} onClick={() => setCustom(true)}>
          {t("history.comparison.custom")}
        </Chip>
      </div>
      {(custom || chosen === "custom") && (
        <CustomRange from={compare.range.from} to={compare.range.to} onApply={(from, to) => props.onChange({ ...compare, range: { preset: "custom", from, to } })} />
      )}

      {props.loading && (
        <div className="flex h-24 items-center justify-center text-white/50">
          <Spinner />
        </div>
      )}
      {props.error && <Empty>{props.error}</Empty>}

      {other && (
        <>
          <table className="mt-5 w-full text-[13px]">
            <thead>
              <tr className="text-left align-bottom text-[11px] font-medium uppercase tracking-wider text-white/45">
                <th className="pb-2 font-medium" />
                <th className="max-w-[84px] pb-2 pl-2 text-right font-medium">
                  <Key color={COLOR_MAIN} />
                  <span className="block truncate normal-case tracking-normal first-letter:uppercase" title={`${vehicle.name} · ${rangeLabel(range)}`}>
                    {sameVehicle ? rangeLabel(range) : vehicle.name}
                  </span>
                </th>
                <th className="max-w-[84px] pb-2 pl-2 text-right font-medium">
                  <Key color={COLOR_OTHER} />
                  <span className="block truncate normal-case tracking-normal first-letter:uppercase" title={`${otherName} · ${rangeLabel(compare.range)}`}>
                    {sameVehicle ? rangeLabel(compare.range) : otherName}
                  </span>
                </th>
                <th className="pb-2 pl-2 text-right font-medium">{t("history.comparison.difference")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, pick, show, showDelta]) => {
                const delta = pick(other) - pick(main);
                return (
                  <tr key={label} className="border-t border-white/8">
                    <th className="py-2 text-left font-normal text-white/60">{label}</th>
                    <td className="whitespace-nowrap py-2 pl-2 text-right tabular-nums">{show(pick(main))}</td>
                    <td className="whitespace-nowrap py-2 pl-2 text-right tabular-nums">{show(pick(other))}</td>
                    <td className="whitespace-nowrap py-2 pl-2 text-right tabular-nums text-white/60">
                      {delta === 0 ? t("history.comparison.equal") : `${delta > 0 ? "+" : "−"}${showDelta(delta)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {other.positions === 0 ? (
            <Empty>{t("history.comparison.noPositions")}</Empty>
          ) : (
            diff && <Verdict diff={diff} />
          )}
        </>
      )}
    </div>
  );
}

function Verdict({ diff }: { diff: Difference }) {
  const { t } = useTranslation();
  const { main, other } = diff;
  const far = (meters: number) => (meters >= 1000 ? `${formatKm(meters)} km` : `${Math.max(10, Math.round(meters / 10) * 10)} m`);
  const same = main.deviations.length === 0 && other.deviations.length === 0;
  const shared = Math.round(((main.sharedM + other.sharedM) / Math.max(1, main.totalM + other.totalM)) * 100);
  return (
    <div className="mt-4 rounded-[14px] bg-ink-2 p-4">
      <p className="text-[15px] font-semibold">{same ? t("history.verdict.same") : t("history.verdict.shared", { percent: shared })}</p>
      {same ? (
        <p className="mt-1 text-sm leading-relaxed text-white/60">{t("history.verdict.noneApart")}</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-white/70">
          {other.deviations.length > 0 && (
            <li className="flex gap-2">
              <span className="mt-2 h-[3px] w-4 shrink-0 rounded-full" style={{ background: COLOR_OTHER }} />
              <span>{t("history.verdict.otherLeaves", { count: other.deviations.length, far: far(other.maxSeparationM) })}</span>
            </li>
          )}
          {main.deviations.length > 0 && (
            <li className="flex gap-2">
              <span className="mt-2 h-[3px] w-4 shrink-0 rounded-full" style={{ background: COLOR_MAIN }} />
              <span>{t("history.verdict.mainLeaves", { count: main.deviations.length, far: far(main.maxSeparationM) })}</span>
            </li>
          )}
          <li className="text-white/50">{t("history.verdict.highlighted")}</li>
        </ul>
      )}
    </div>
  );
}

const sameRange = (a: Range, b: Range) => a.from.getTime() === b.from.getTime() && a.to.getTime() === b.to.getTime();

/** Short stroke in the trip color, as on the map. */
function Key({ color }: { color: string }) {
  return <span className="mb-1 ml-auto block h-[3px] w-6 rounded-full" style={{ background: color }} />;
}

function weekBefore(range: Range): Range {
  const shift = (d: Date) => {
    const copy = new Date(d);
    copy.setDate(copy.getDate() - 7);
    return copy;
  };
  return { preset: "custom", from: shift(range.from), to: shift(range.to) };
}
