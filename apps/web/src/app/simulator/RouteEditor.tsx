// Where a simulator route is built: from one address to another along
// streets, with points marked or dragged on the map, with straight lines, or
// with the path of a real trip.
import { type LonLat, SIM_LIMITS, type SimPlace, type SimRoute, type SimRouteInput, type SimulatorMeta, type Vehicle, isClosedLine, lineLengthM } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowLeft, ArrowUp, Repeat, Search, X } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Notice, Spinner } from "../../components/ui";
import { getVehicles } from "../../lib/api";
import { formatDuration, formatKm } from "../../lib/format";
import { getSimRoute, getSimTripLine, saveSimRoute, searchSimPlaces, traceSimRoute } from "../../lib/simulator";
import { today } from "../fleet/format";
import { Card, Segmented, inputClass, labelClass } from "../reports/kit";
import { errorText } from "../widgets";
import { SimRouteMap, letterOf } from "./SimRouteMap";

interface Point {
  /** Its own name in the list, which survives moving it up or down. */
  key: number;
  lon: number;
  lat: number;
  label: string;
}

/**
 * A path that did not come from joining the points with straight lines: traced
 * along streets by the routing service, or kept as it came (a real trip, or
 * the way the route was saved).
 */
interface Path {
  kind: "streets" | "kept";
  line: LonLat[];
  secs: number[] | null;
  lengthM: number;
}

type Mode = "streets" | "straight";
/** Something that can be stopped from doing what it would do by itself: a key press, a click. */
type Stoppable = { preventDefault(): void; stopPropagation(): void };

const mini = "h-9 rounded-[9px] border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-ink focus:outline-none";

export function RouteEditor({ routeId, meta, onClose }: { routeId: string | null; meta: SimulatorMeta; onClose: () => void }) {
  const { t } = useTranslation();
  const loaded = useQuery({ queryKey: ["admin", "simulator", "route", routeId], queryFn: () => getSimRoute(routeId as string), enabled: routeId !== null, gcTime: 0 });
  if (routeId !== null && !loaded.data) {
    return <Card>{loaded.error ? <Notice tone="error">{errorText(loaded.error)}</Notice> : <Spinner />}</Card>;
  }
  return <Editor route={loaded.data ?? null} meta={meta} onClose={onClose} title={routeId ? t("simulator.routes.editTitle") : t("simulator.routes.newTitle")} />;
}

function Editor({ route, meta, onClose, title }: { route: SimRoute | null; meta: SimulatorMeta; onClose: () => void; title: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const nextKey = useRef(0);
  const pointOf = (lon: number, lat: number, label = ""): Point => ({ key: nextKey.current++, lon, lat, label });

  const [name, setName] = useState(route?.name ?? "");
  const [points, setPoints] = useState<Point[]>(() => {
    if (!route) return [];
    if (route.waypoints.length >= 2) return route.waypoints.map((w) => pointOf(w.lon, w.lat, w.label));
    // A route that came without its points (an example circuit) shows where it starts and ends.
    const first = route.line[0] as LonLat;
    const last = route.line[route.line.length - 1] as LonLat;
    return [pointOf(first[0], first[1]), pointOf(last[0], last[1])];
  });
  // What is not straight lines between its points is a path of its own.
  const straightSaved = route ? !route.snapped && route.line.length === route.waypoints.length : false;
  const [path, setPath] = useState<Path | null>(() => (route && !straightSaved ? { kind: route.snapped ? "streets" : "kept", line: route.line, secs: route.secs, lengthM: route.lengthM } : null));
  const [mode, setMode] = useState<Mode>(route ? (route.snapped ? "streets" : "straight") : meta.routing ? "streets" : "straight");
  const [stale, setStale] = useState(false);
  const [fit, setFit] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  // What the route would be if saved right now.
  const straight: LonLat[] = points.map((p) => [p.lon, p.lat]);
  const kept = path?.kind === "kept" ? path : null;
  const traced = path?.kind === "streets" && mode === "streets" && !stale ? path : null;
  const needsTrace = !kept && mode === "streets" && !traced;
  const line = kept?.line ?? traced?.line ?? straight;
  const lengthM = kept?.lengthM ?? traced?.lengthM ?? (straight.length >= 2 ? lineLengthM(straight) : 0);
  const seconds = traced?.secs ? (traced.secs[traced.secs.length - 1] ?? null) : null;
  const closed = isClosedLine(line);

  /** The points changed: a path traced through the old ones no longer says where the route goes. */
  const change = (next: Point[]) => {
    setPoints(next);
    setProblem(null);
    if (path?.kind === "kept") setPath(null);
    else if (path) setStale(true);
  };
  const add = (lon: number, lat: number, label = "") => {
    if (points.length >= SIM_LIMITS.waypoints) return setProblem(t("simulator.routes.tooManyPoints", { max: SIM_LIMITS.waypoints }));
    change([...points, pointOf(lon, lat, label)]);
  };
  const swap = (i: number, j: number) => {
    const next = [...points];
    [next[i], next[j]] = [next[j] as Point, next[i] as Point];
    change(next);
  };

  const trace = useMutation({
    mutationFn: () => traceSimRoute(points.map(({ lon, lat }) => ({ lon, lat }))),
    onSuccess: (found) => {
      setPath({ kind: "streets", line: found.line, secs: found.secs, lengthM: found.lengthM });
      setStale(false);
      setFit((n) => n + 1);
    },
  });

  // Searching an address: only when the person sends it, never while they type.
  const [query, setQuery] = useState("");
  const search = useMutation({ mutationFn: (q: string) => searchSimPlaces(q) });
  const find = (e: Stoppable) => {
    e.preventDefault();
    e.stopPropagation();
    if (query.trim().length >= 3) search.mutate(query.trim());
  };
  const choose = (place: SimPlace) => {
    add(place.lon, place.lat, place.label);
    search.reset();
    setQuery("");
    setFit((n) => n + 1);
  };

  // The path of a real trip.
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: getVehicles });
  const [fromTrip, setFromTrip] = useState(false);
  const [source, setSource] = useState({ vehicleId: "", date: today(), from: "06:00", to: "18:00" });
  const vehicleId = source.vehicleId || (vehicles.data?.[0] as Vehicle | undefined)?.id || "";
  const take = useMutation({
    mutationFn: () => getSimTripLine(vehicleId, new Date(`${source.date}T${source.from}:00`), new Date(`${source.date}T${source.to}:00`)),
    onSuccess: (found) => {
      const first = found.line[0] as LonLat;
      const last = found.line[found.line.length - 1] as LonLat;
      setPoints([pointOf(first[0], first[1]), pointOf(last[0], last[1])]);
      setPath({ kind: "kept", line: found.line, secs: null, lengthM: found.lengthM });
      setStale(false);
      setFromTrip(false);
      setProblem(null);
      setFit((n) => n + 1);
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      // Along streets, what is saved is the path through the points as they are now.
      const fresh = needsTrace ? await traceSimRoute(points.map(({ lon, lat }) => ({ lon, lat }))) : null;
      const body: SimRouteInput = {
        name: name.trim(),
        waypoints: points.map(({ lon, lat, label }) => ({ lon, lat, label })),
        snapped: !kept && mode === "streets",
        line: fresh?.line ?? line,
        secs: fresh?.secs ?? traced?.secs ?? null,
      };
      return saveSimRoute(route?.id ?? null, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "simulator"] });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setProblem(t("simulator.routes.nameNeeded"));
    if (points.length < 2) return setProblem(t("simulator.routes.pointsNeeded"));
    setProblem(null);
    save.mutate();
  };

  const failed = save.error ?? trace.error ?? take.error ?? search.error;
  return (
    <Card
      title={title}
      note={t("simulator.routes.editorNote")}
      action={
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden="true" />
          {t("simulator.routes.back")}
        </Button>
      }
    >
      <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-5 lg:grid-cols-[1.45fr_1fr]">
        <div className="min-w-0">
          <SimRouteMap line={needsTrace ? (path?.line ?? []) : line} stale={needsTrace} points={points} onAdd={(lon, lat) => add(lon, lat)} onMove={(i, lon, lat) => change(points.map((p, at) => (at === i ? { ...p, lon, lat, label: "" } : p)))} fitKey={fit} className="h-[26rem] lg:h-[34rem]" label={t("simulator.routes.map")} />
          <p className="mt-2 text-[13px] text-muted">{t("simulator.routes.mapHint")}</p>
        </div>

        <div className="min-w-0 space-y-5">
          <Field label={t("simulator.routes.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("simulator.routes.namePlaceholder")} autoFocus={!route} />

          <div>
            <p className={labelClass}>{t("simulator.routes.path")}</p>
            <Segmented<Mode | "kept">
              label={t("simulator.routes.path")}
              // A path kept as it came is neither: nothing is marked until the person chooses.
              value={kept ? "kept" : mode}
              onChange={(next) => {
                if (next === "kept") return;
                setMode(next);
                // Choosing how to trace it lets go of a path that came from somewhere else.
                if (kept) {
                  setPath(null);
                  setStale(false);
                }
              }}
              options={[
                { id: "streets", label: t("simulator.routes.mode.streets") },
                { id: "straight", label: t("simulator.routes.mode.straight") },
              ]}
            />
            <p className="mt-2 text-[13px] text-muted">
              {kept ? t("simulator.routes.modeNote.kept") : mode === "streets" ? (meta.routing ? t("simulator.routes.modeNote.streets") : t("simulator.routes.modeNote.streetsOff")) : t("simulator.routes.modeNote.straight")}
            </p>
          </div>

          <div>
            <p className={labelClass}>{t("simulator.routes.points")}</p>
            {points.length === 0 ? (
              <p className="text-sm text-muted">{t("simulator.routes.noPoints")}</p>
            ) : (
              <ol className="divide-y divide-line rounded-[10px] border border-line">
                {points.map((p, i) => (
                  <li key={p.key} className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className={clsx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold text-white", i === 0 ? "bg-[#12a065]" : i === points.length - 1 ? "bg-[#101623]" : "bg-[#7c6cf0]")}>{letterOf(i)}</span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px]" title={p.label || undefined}>
                      {p.label || <span className="num text-muted">{t("simulator.routes.pointAt", { lat: p.lat.toFixed(5), lon: p.lon.toFixed(5) })}</span>}
                    </span>
                    <button type="button" disabled={i === 0} onClick={() => swap(i, i - 1)} aria-label={t("simulator.routes.moveUp", { letter: letterOf(i) })} className="rounded-md p-1 text-muted hover:bg-canvas hover:text-ink disabled:opacity-30">
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                    <button type="button" disabled={i === points.length - 1} onClick={() => swap(i, i + 1)} aria-label={t("simulator.routes.moveDown", { letter: letterOf(i) })} className="rounded-md p-1 text-muted hover:bg-canvas hover:text-ink disabled:opacity-30">
                      <ArrowDown size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => change(points.filter((_, at) => at !== i))} aria-label={t("simulator.routes.removePoint", { letter: letterOf(i) })} className="rounded-md p-1 text-muted hover:bg-canvas hover:text-danger">
                      <X size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ol>
            )}

            {/* Its own form: sending it searches, and does not save the route. */}
            <div className="mt-2.5 flex gap-2">
              <input
                className={clsx(inputClass, "h-9 flex-1 text-[13px]")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") find(e);
                }}
                maxLength={200}
                disabled={!meta.placeSearch}
                placeholder={meta.placeSearch ? t("simulator.routes.searchPlaceholder") : t("simulator.routes.searchOff")}
                aria-label={t("simulator.routes.search")}
              />
              <Button type="button" variant="secondary" size="sm" className="h-9" loading={search.isPending} disabled={!meta.placeSearch || query.trim().length < 3} onClick={find}>
                <Search size={14} aria-hidden="true" />
                {t("simulator.routes.search")}
              </Button>
            </div>
            {search.data && (
              <ul className="mt-2 divide-y divide-line rounded-[10px] border border-line">
                {search.data.length === 0 && <li className="px-3 py-2 text-[13px] text-muted">{t("simulator.routes.searchEmpty")}</li>}
                {search.data.map((place) => (
                  <li key={`${place.lat}:${place.lon}:${place.label}`}>
                    <button type="button" onClick={() => choose(place)} className="block w-full px-3 py-2 text-left text-[13.5px] hover:bg-canvas">
                      {place.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-2.5 flex flex-wrap gap-2">
              <button type="button" disabled={points.length < 2 || closed} onClick={() => add((points[0] as Point).lon, (points[0] as Point).lat, (points[0] as Point).label)} className={clsx(mini, "inline-flex items-center gap-1.5 disabled:opacity-45")}>
                <Repeat size={13} aria-hidden="true" />
                {t("simulator.routes.close")}
              </button>
              {(vehicles.data?.length ?? 0) > 0 && (
                <button type="button" aria-expanded={fromTrip} onClick={() => setFromTrip((v) => !v)} className={clsx(mini, fromTrip && "border-ink")}>
                  {t("simulator.routes.fromTrip")}
                </button>
              )}
            </div>
            {fromTrip && (
              <div className="mt-2 flex flex-wrap items-end gap-2 rounded-[12px] border border-line px-3 py-2.5">
                <label className="min-w-0 flex-1 basis-40 text-[12.5px] text-ink-3">
                  {t("common.vehicle")}
                  <select value={vehicleId} onChange={(e) => setSource({ ...source, vehicleId: e.target.value })} className={clsx(mini, "mt-1 block w-full")}>
                    {(vehicles.data ?? []).map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-[12.5px] text-ink-3">
                  {t("simulator.routes.day")}
                  <input type="date" value={source.date} max={today()} onChange={(e) => setSource({ ...source, date: e.target.value })} className={clsx(mini, "num mt-1 block")} />
                </label>
                <label className="text-[12.5px] text-ink-3">
                  {t("common.from")}
                  <input type="time" value={source.from} onChange={(e) => setSource({ ...source, from: e.target.value })} className={clsx(mini, "num mt-1 block")} />
                </label>
                <label className="text-[12.5px] text-ink-3">
                  {t("common.to")}
                  <input type="time" value={source.to} onChange={(e) => setSource({ ...source, to: e.target.value })} className={clsx(mini, "num mt-1 block")} />
                </label>
                <Button type="button" size="sm" loading={take.isPending} disabled={!vehicleId || !source.date || source.to <= source.from} onClick={() => take.mutate()}>
                  {t("simulator.routes.take")}
                </Button>
              </div>
            )}
          </div>

          <div className="rounded-[10px] bg-canvas px-3.5 py-2.5 text-sm">
            {points.length < 2 ? (
              <span className="text-muted">{t("simulator.routes.summaryEmpty")}</span>
            ) : needsTrace ? (
              <span className="text-ink-3">{path ? t("simulator.routes.summaryStale") : t("simulator.routes.summaryUntraced")}</span>
            ) : (
              <span>
                <span className="font-semibold">{t("simulator.routes.km", { km: formatKm(lengthM) })}</span>
                {seconds !== null && <span className="text-ink-3"> · {t("simulator.routes.drive", { time: formatDuration(seconds) })}</span>}
                <span className="text-ink-3"> · {closed ? t("simulator.routes.circuit") : t("simulator.routes.open")}</span>
              </span>
            )}
          </div>

          {route && route.inUse > 0 && <Notice>{t("simulator.routes.inUseNote", { count: route.inUse })}</Notice>}
          {(problem || failed) && <Notice tone="error">{problem ?? errorText(failed)}</Notice>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            {!kept && mode === "streets" && (
              <Button type="button" variant="secondary" loading={trace.isPending} disabled={points.length < 2 || !meta.routing} onClick={() => trace.mutate()}>
                {t("simulator.routes.trace")}
              </Button>
            )}
            <Button type="submit" loading={save.isPending} disabled={needsTrace && !meta.routing}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}
