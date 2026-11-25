// Diagnostics of a vehicle: what the device reads from it (revolutions,
// temperature, battery), its fault codes, and the odometer and engine
// hours. The card summarizes; the dialog shows everything.
import { DIAG_COUNTERS, DIAG_PARAMS, type DiagFault, type DiagParam, type DiagSeries, type DiagStatus, type Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Activity, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { getDiagFaults, getDiagSeries, getDiagSettings, getDiagnostics, saveDiagLimits, saveDiagSettings, saveMeters } from "../../lib/api";
import { formatClock, formatDateTime, formatDay, timeAgo } from "../../lib/format";
import { currentLanguage } from "../../lib/i18n";
import { PRESETS, type Preset, type Range, presetRange } from "../history/range";
import { errorText } from "../widgets";

const SHORT_PRESETS = PRESETS.filter((p) => p.id !== "custom") as { id: Exclude<Preset, "custom">; label: string }[];
const lightSelect = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
/** A value with its decimals and thousands separator: "123.456" or "13,9". */
const number = (value: number, decimals: number) =>
  new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: "always" }).format(value);
const shown = (param: DiagParam, value: number) => `${number(value, DIAG_PARAMS[param].decimals)} ${DIAG_PARAMS[param].unit}`;
/** Where the odometer and the engine hours come from: catalog keys. */
const SOURCE_NOTE = { ecu: "diag.source.ecu", gps: "diag.source.gps", ignition: "diag.source.ignition" } as const;

export function DiagCard({ vehicle, canManage, now }: { vehicle: Vehicle; canManage: boolean; now: number }) {
  const { t } = useTranslation();
  const diag = useQuery({ queryKey: ["diag", vehicle.id], queryFn: () => getDiagnostics(vehicle.id), refetchInterval: 30_000 });
  const [open, setOpen] = useState(false);
  const status = diag.data;
  if (!status) return null;
  const value = (param: DiagParam) => status.readings.find((r) => r.param === param);
  const active = status.faults.filter((f) => f.clearedAt === null);
  const headline = (["rpm", "coolantTemp", "power"] as const).flatMap((p) => value(p) ?? []);
  const newest = status.readings.reduce<string | null>((latest, r) => (latest === null || r.at > latest ? r.at : latest), null);

  return (
    <div className="mt-3 rounded-[12px] bg-ink-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <Activity size={18} className={clsx("mt-0.5 shrink-0", active.length > 0 ? "text-coral" : "text-signal")} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{active.length > 0 ? t("diag.card.faults", { count: active.length }) : t("diag.card.title")}</p>
          {headline.length > 0 ? (
            <p className="num mt-0.5 text-[13px] text-white/70">{headline.map((r) => shown(r.param, r.value)).join(" · ")}</p>
          ) : (
            <p className="mt-0.5 text-[13px] leading-snug text-white/55">{t("diag.card.noData")}</p>
          )}
          <p className="num mt-1 text-[12.5px] text-white/45">
            {number(status.meters.odometerKm, 0)} km ·{" "}
            {newest
              ? t("diag.card.engineHoursRead", { hours: number(status.meters.engineHours, 1), when: timeAgo(newest, now) })
              : t("diag.card.engineHours", { hours: number(status.meters.engineHours, 1) })}
          </p>
        </div>
      </div>
      <button type="button" onClick={() => setOpen(true)} className="mt-3 flex h-9 w-full items-center justify-center rounded-[10px] bg-ink text-[13px] font-semibold hover:bg-ink-3">
        {t("diag.card.open")}
      </button>
      {open && <DiagDialog vehicle={vehicle} status={status} canManage={canManage} onClose={() => setOpen(false)} />}
    </div>
  );
}

type Tab = "now" | "chart" | "faults" | "meters" | "limits";
/** The tabs of the dialog; each label is a catalog key. */
const TABS = [
  { id: "now", label: "diag.tabs.now" },
  { id: "chart", label: "diag.tabs.chart" },
  { id: "faults", label: "diag.tabs.faults" },
  { id: "meters", label: "diag.tabs.meters" },
  { id: "limits", label: "diag.tabs.limits" },
] as const satisfies readonly { id: Tab; label: string }[];

function DiagDialog({ vehicle, status, canManage, onClose }: { vehicle: Vehicle; status: DiagStatus; canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(status.faults.some((f) => f.clearedAt === null) ? "faults" : "now");
  return (
    <Modal open onClose={onClose} title={t("diag.dialog.title", { name: vehicle.name })} wide>
      <div className="space-y-5">
        <div className="flex gap-1 overflow-x-auto rounded-[10px] bg-canvas p-1" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={clsx("h-8 flex-1 whitespace-nowrap rounded-lg px-1.5 text-[12.5px] font-medium transition-colors sm:px-2.5 sm:text-[13px]", tab === item.id ? "bg-primary text-on-primary" : "text-ink-3 hover:text-ink")}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        {tab === "now" && <NowTab status={status} />}
        {tab === "chart" && <ChartTab vehicle={vehicle} status={status} />}
        {tab === "faults" && <FaultsTab vehicle={vehicle} />}
        {tab === "meters" && <MetersTab vehicle={vehicle} status={status} canManage={canManage} />}
        {tab === "limits" && <LimitsTab vehicle={vehicle} status={status} canManage={canManage} />}
      </div>
    </Modal>
  );
}

// ─── Now ───────────────────────────────────────────────────────────────────

function NowTab({ status }: { status: DiagStatus }) {
  const { t } = useTranslation();
  if (status.readings.length === 0) {
    return <p className="rounded-[12px] bg-canvas px-4 py-3 text-[14px] leading-relaxed text-ink-3">{t("diag.now.empty")}</p>;
  }
  const over = (param: DiagParam, value: number) =>
    (param === "rpm" && status.limits.rpmMax !== null && value > status.limits.rpmMax) || (param === "coolantTemp" && status.limits.tempMaxC !== null && value > status.limits.tempMaxC);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {status.readings.map((r) => (
          <div key={r.param} className="rounded-[12px] bg-canvas px-3.5 py-3">
            <p className="text-[11px] font-medium uppercase leading-snug tracking-wider text-muted">{t(`shared.diagParam.${r.param}`)}</p>
            <p className={clsx("num mt-1 text-[19px] font-semibold leading-tight tracking-tight", over(r.param, r.value) ? "text-danger" : "text-ink")}>{shown(r.param, r.value)}</p>
            <p className="num mt-0.5 text-[12px] text-muted">{formatDateTime(r.at)}</p>
          </div>
        ))}
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted">{t("diag.now.note")}</p>
      {status.others.length > 0 && (
        <details className="rounded-[12px] border border-line px-4 py-3">
          <summary className="cursor-pointer text-[14px] font-semibold text-ink">{t("diag.now.others", { n: status.others.length })}</summary>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{t("diag.now.othersNote")}</p>
          <ul className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] text-ink-3 sm:grid-cols-3">
            {status.others.map((o) => (
              <li key={o.name} className="flex justify-between gap-2">
                <span>{o.name}</span>
                <span className="font-medium text-ink">{number(o.value, Number.isInteger(o.value) ? 0 : 2)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ─── Charts ────────────────────────────────────────────────────────────────

function ChartTab({ vehicle, status }: { vehicle: Vehicle; status: DiagStatus }) {
  const { t } = useTranslation();
  const available = status.readings.map((r) => r.param);
  const [param, setParam] = useState<DiagParam>(available.includes("rpm") ? "rpm" : (available[0] ?? "power"));
  const [range, setRange] = useState<Range>(() => presetRange("today"));
  const series = useQuery({
    queryKey: ["diag", vehicle.id, "series", param, range.from.getTime(), range.to.getTime()],
    queryFn: () => getDiagSeries(vehicle.id, param, range.from, range.to),
    placeholderData: (previous) => previous,
  });
  const s = series.data;
  const info = DIAG_PARAMS[param];
  return (
    <div className="space-y-4">
      <select aria-label={t("diag.chart.param")} value={param} onChange={(e) => setParam(e.target.value as DiagParam)} className={lightSelect}>
        {(available.length > 0 ? available : (["power"] as DiagParam[])).map((p) => (
          <option key={p} value={p}>
            {t(`shared.diagParam.${p}`)}
          </option>
        ))}
      </select>
      <div className="flex gap-1 rounded-[10px] bg-canvas p-1">
        {SHORT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={range.preset === p.id}
            onClick={() => setRange(presetRange(p.id))}
            className={clsx("h-8 flex-1 rounded-lg text-[13px] font-medium transition-colors", range.preset === p.id ? "bg-primary text-on-primary" : "text-ink-3 hover:text-ink")}
          >
            {p.label}
          </button>
        ))}
      </div>
      {series.isLoading && (
        <div className="flex h-40 items-center justify-center text-muted">
          <Spinner />
        </div>
      )}
      {series.isError && <Notice tone="error">{errorText(series.error)}</Notice>}
      {s && s.param === param && (
        <div className={clsx("space-y-4", series.isFetching && "opacity-60")}>
          {s.points.length >= 2 ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                {DIAG_COUNTERS.includes(param) ? (
                  <>
                    <Stat label={t("diag.chart.delta")} value={s.delta === null ? "—" : shown(param, s.delta)} />
                    <Stat label={t("diag.chart.start")} value={s.min === null ? "—" : shown(param, s.min)} />
                    <Stat label={t("diag.chart.end")} value={s.max === null ? "—" : shown(param, s.max)} />
                  </>
                ) : (
                  <>
                    <Stat label={t("diag.chart.min")} value={s.min === null ? "—" : shown(param, s.min)} alert={param === "power" && s.limit !== null && s.min !== null && s.min < s.limit} />
                    <Stat label={t("diag.chart.avg")} value={s.avg === null ? "—" : shown(param, s.avg)} />
                    <Stat label={t("diag.chart.max")} value={s.max === null ? "—" : shown(param, s.max)} alert={param !== "power" && s.limit !== null && s.max !== null && s.max > s.limit} />
                  </>
                )}
              </div>
              <ValueChart series={s} unit={info.unit} decimals={info.decimals} label={t(`shared.diagParam.${param}`)} />
            </>
          ) : (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-[13.5px] leading-relaxed text-ink-3">{t("diag.chart.empty")}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="rounded-[12px] bg-canvas px-3.5 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</p>
      <p className={clsx("num mt-1 text-[17px] font-semibold leading-tight tracking-tight", alert ? "text-danger" : "text-ink")}>{value}</p>
    </div>
  );
}

const LINE = "#2a78d6";
const LIMIT = "#d0453a";
const PLOT = { left: 44, right: 10, top: 10, bottom: 20 };
const HEIGHT = 200;
/** Seconds without readings after which the line is cut. */
const GAP_S = 900;

/** A data point over time: a single series, with its notification limit if it has one and the exact value when the pointer passes. */
function ValueChart({ series, unit, decimals, label }: { series: DiagSeries; unit: string; decimals: number; label: string }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const points = series.points;
  const first = points[0] as { t: number; v: number };
  const last = points[points.length - 1] as { t: number; v: number };
  const values = points.map((p) => p.v);
  const withLimit = series.limit === null ? values : [...values, series.limit];
  // The axis leaves room above and below; if everything is the same value, it widens a little so the line does not stick to the edge.
  let low = Math.min(...withLimit);
  let high = Math.max(...withLimit);
  const pad = (high - low) * 0.08 || Math.max(1, Math.abs(high) * 0.05);
  low = low >= 0 && low - pad < 0 ? 0 : low - pad;
  high += pad;
  const plotW = Math.max(0, width - PLOT.left - PLOT.right);
  const plotH = HEIGHT - PLOT.top - PLOT.bottom;
  const x = (t: number) => (last.t === first.t ? 0 : ((t - first.t) / (last.t - first.t)) * plotW);
  const y = (v: number) => plotH - ((v - low) / (high - low)) * plotH;
  // With the engine off there are no readings: the line is cut instead of joining one trip with the next.
  const line = points.map((p, i) => `${i === 0 || p.t - (points[i - 1] as { t: number }).t > GAP_S ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const severalDays = new Date(first.t * 1000).toDateString() !== new Date(last.t * 1000).toDateString();
  const when = (t: number) => (severalDays ? `${formatDay(t * 1000)} ${formatClock(t * 1000)}` : formatClock(t * 1000));
  const point = hover === null ? null : (points[hover] ?? null);
  const nearest = (clientX: number, rect: DOMRect) => {
    const t = first.t + ((clientX - rect.left) / Math.max(1, rect.width)) * (last.t - first.t);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs((points[i] as { t: number }).t - t) < Math.abs((points[best] as { t: number }).t - t)) best = i;
    return best;
  };
  const ticks = [high - pad, (high - pad + low + (low === 0 ? 0 : pad)) / 2, low === 0 ? 0 : low + pad];
  return (
    <div ref={box} className="relative select-none">
      {width > 0 && (
        <svg width={width} height={HEIGHT} className="block" role="img" aria-label={t("diag.chart.aria", { label, from: number(first.v, decimals), to: number(last.v, decimals), unit })}>
          <g transform={`translate(${PLOT.left} ${PLOT.top})`}>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke="rgb(16 22 35 / 0.08)" strokeWidth={1} />
                <text x={-7} y={y(v) + 3.5} textAnchor="end" className="num fill-current text-[10px] text-muted">
                  {number(v, Math.abs(v) >= 100 ? 0 : decimals)}
                </text>
              </g>
            ))}
            {series.limit !== null && (
              <>
                <line x1={0} x2={plotW} y1={y(series.limit)} y2={y(series.limit)} stroke={LIMIT} strokeWidth={1.5} strokeDasharray="5 4" />
                <text x={plotW - 4} y={y(series.limit) - 5} textAnchor="end" className="fill-current text-[10px] font-medium" style={{ color: LIMIT }}>
                  {t("diag.chart.limit")}
                </text>
              </>
            )}
            <path d={line} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(last.t)} cy={y(last.v)} r={4} fill={LINE} stroke="#fff" strokeWidth={2} />
            {point && (
              <>
                <line x1={x(point.t)} x2={x(point.t)} y1={0} y2={plotH} stroke={LINE} strokeOpacity={0.35} strokeWidth={1} />
                <circle cx={x(point.t)} cy={y(point.v)} r={5} fill={LINE} stroke="#fff" strokeWidth={2} />
              </>
            )}
            <text x={0} y={plotH + 14} className="num fill-current text-[10px] text-muted">
              {when(first.t)}
            </text>
            <text x={plotW} y={plotH + 14} textAnchor="end" className="num fill-current text-[10px] text-muted">
              {when(last.t)}
            </text>
            <rect
              x={0}
              y={-PLOT.top}
              width={plotW}
              height={HEIGHT}
              fill="transparent"
              className="touch-none"
              onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
              onPointerDown={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
              onPointerLeave={() => setHover(null)}
            />
          </g>
        </svg>
      )}
      {point && (
        <div
          className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-lg bg-panel px-2.5 py-1.5 text-[12px] text-white shadow-lg"
          style={{ left: Math.min(Math.max(PLOT.left + x(point.t), 80), width - 80), transform: "translate(-50%, -20%)" }}
        >
          <span className="num font-semibold">
            {number(point.v, decimals)} {unit}
          </span>
          <span className="num text-white/60"> · {when(point.t)}</span>
        </div>
      )}
    </div>
  );
}

// ─── Faults ──────────────────────────────────────────────────────────────────

function FaultsTab({ vehicle }: { vehicle: Vehicle }) {
  const { t } = useTranslation();
  const faults = useQuery({ queryKey: ["diag", vehicle.id, "faults"], queryFn: () => getDiagFaults(vehicle.id) });
  if (faults.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }
  if (faults.isError) return <Notice tone="error">{errorText(faults.error)}</Notice>;
  const list = faults.data ?? [];
  const active = list.filter((f) => f.clearedAt === null);
  const solved = list.filter((f) => f.clearedAt !== null);
  if (list.length === 0) {
    return <p className="rounded-[12px] bg-canvas px-4 py-3 text-[14px] leading-relaxed text-ink-3">{t("diag.faults.empty")}</p>;
  }
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-[14px] font-semibold text-ink">{t("diag.faults.active")}</h3>
        {active.length === 0 ? <p className="text-[14px] text-ink-3">{t("diag.faults.none")}</p> : <ul className="space-y-2">{active.map((f) => <Fault key={`${f.code}-${f.firstSeenAt}`} fault={f} />)}</ul>}
      </section>
      {solved.length > 0 && (
        <section>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">{t("diag.faults.solved")}</h3>
          <ul className="space-y-2">
            {solved.map((f) => (
              <Fault key={`${f.code}-${f.firstSeenAt}`} fault={f} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Fault({ fault }: { fault: DiagFault }) {
  const activeNow = fault.clearedAt === null;
  return (
    <li className={clsx("rounded-[12px] px-3.5 py-3", activeNow ? "bg-danger/5" : "bg-canvas")}>
      <p className="flex items-start gap-2 text-[14.5px] font-semibold text-ink">
        {activeNow && <TriangleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />}
        <span>
          <span className="num">{fault.code}</span> · {fault.description}
        </span>
      </p>
      <p className="mt-1 text-[12.5px] text-muted">
        {fault.clearedAt ? (
          <Trans
            i18nKey="diag.faults.cleared"
            values={{ system: fault.system, from: formatDateTime(fault.firstSeenAt), to: formatDateTime(fault.clearedAt) }}
            components={{ num: <span className="num" /> }}
          />
        ) : (
          <Trans
            i18nKey="diag.faults.seen"
            values={{ system: fault.system, from: formatDateTime(fault.firstSeenAt), last: formatDateTime(fault.lastSeenAt) }}
            components={{ num: <span className="num" /> }}
          />
        )}
      </p>
    </li>
  );
}

// ─── Odometer and hours ────────────────────────────────────────────────────────

const numberOf = (text: string) => (text.trim() === "" ? null : Number(text.replace(/\s/g, "").replace(",", ".")));

function MetersTab({ vehicle, status, canManage }: { vehicle: Vehicle; status: DiagStatus; canManage: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const m = status.meters;
  const [odometer, setOdometer] = useState("");
  const [hours, setHours] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { odometerKm?: number; engineHours?: number }) => saveMeters(vehicle.id, body),
    onSuccess: () => {
      setOdometer("");
      setHours("");
      void queryClient.invalidateQueries({ queryKey: ["diag", vehicle.id] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const km = numberOf(odometer);
    const h = numberOf(hours);
    if (km === null && h === null) return setProblem(t("diag.meters.needValue"));
    if ((km !== null && !(km >= 0)) || (h !== null && !(h >= 0))) return setProblem(t("diag.meters.notNumber"));
    setProblem(null);
    save.mutate({ ...(km !== null ? { odometerKm: km } : {}), ...(h !== null ? { engineHours: h } : {}) });
  };
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[12px] bg-canvas px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{t("diag.meters.odometer")}</p>
          <p className="num mt-1 text-[21px] font-semibold leading-tight tracking-tight text-ink">{number(m.odometerKm, 0)} km</p>
          <p className="mt-0.5 text-[12px] leading-snug text-muted">{t(SOURCE_NOTE[m.odometerSource])}</p>
        </div>
        <div className="rounded-[12px] bg-canvas px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{t("diag.meters.hours")}</p>
          <p className="num mt-1 text-[21px] font-semibold leading-tight tracking-tight text-ink">{number(m.engineHours, 1)} h</p>
          <p className="mt-0.5 text-[12px] leading-snug text-muted">{t(SOURCE_NOTE[m.hoursSource])}</p>
        </div>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-3">
        <Trans i18nKey="diag.meters.lead" values={{ since: formatDateTime(m.since) }} components={{ num: <span className="num" /> }} />
      </p>
      {canManage && (
        <form onSubmit={submit} className="space-y-3 rounded-[12px] border border-line px-4 py-3.5" noValidate>
          <h3 className="text-[14px] font-semibold text-ink">{t("diag.meters.adjustTitle")}</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("diag.meters.odometerKm")} value={odometer} onChange={(e) => setOdometer(e.target.value)} inputMode="decimal" mono placeholder={String(Math.round(m.odometerKm))} />
            <Field label={t("diag.meters.hours")} value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" mono placeholder={String(m.engineHours)} />
          </div>
          {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
          {save.isSuccess && <Notice tone="success">{t("diag.meters.saved")}</Notice>}
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              {t("diag.meters.adjust")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── Notifications ──────────────────────────────────────────────────────────────────

type LimitKey = "rpmMax" | "tempMaxC" | "voltageMinV";
/** Each limit's name and note are in the catalog under "diag.limits.<key>". */
const LIMITS: { key: LimitKey; unit: string }[] = [
  { key: "rpmMax", unit: "rpm" },
  { key: "tempMaxC", unit: "°C" },
  { key: "voltageMinV", unit: "V" },
];

function LimitsTab({ vehicle, status, canManage }: { vehicle: Vehicle; status: DiagStatus; canManage: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: ["diag", "settings"], queryFn: getDiagSettings });
  // For each limit: "account" (the account's), "own" (its own) or "off" (no notification).
  const modeOf = (key: LimitKey) => (key in status.own ? (status.own[key] === null ? "off" : "own") : "account");
  const [mode, setMode] = useState<Record<LimitKey, "account" | "own" | "off">>(() => ({ rpmMax: modeOf("rpmMax"), tempMaxC: modeOf("tempMaxC"), voltageMinV: modeOf("voltageMinV") }));
  const [text, setText] = useState<Record<LimitKey, string>>(() => ({
    rpmMax: status.own.rpmMax != null ? String(status.own.rpmMax) : "",
    tempMaxC: status.own.tempMaxC != null ? String(status.own.tempMaxC) : "",
    voltageMinV: status.own.voltageMinV != null ? String(status.own.voltageMinV) : "",
  }));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Partial<Record<LimitKey, number | null>>) => saveDiagLimits(vehicle.id, body),
    onSuccess: (saved) => queryClient.setQueryData(["diag", vehicle.id], saved),
  });
  const saveAccount = useMutation({
    mutationFn: saveDiagSettings,
    onSuccess: (saved) => {
      queryClient.setQueryData(["diag", "settings"], saved);
      void queryClient.invalidateQueries({ queryKey: ["diag", vehicle.id] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Partial<Record<LimitKey, number | null>> = {};
    for (const { key } of LIMITS) {
      if (mode[key] === "off") body[key] = null;
      if (mode[key] === "own") {
        const value = numberOf(text[key]);
        if (value === null || !(value > 0)) return setProblem(t("diag.limits.needOwn", { label: t(`diag.limits.${key}.label`).toLowerCase() }));
        body[key] = value;
      }
    }
    setProblem(null);
    save.mutate(body);
  };
  const a = account.data;
  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {LIMITS.map(({ key, unit }) => (
          <div key={key}>
            <p className="text-[14px] font-semibold text-ink">{t(`diag.limits.${key}.label`)}</p>
            <p className="mb-2 mt-0.5 text-[13px] leading-relaxed text-ink-3">{t(`diag.limits.${key}.note`)}</p>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                aria-label={t("diag.limits.modeAria", { label: t(`diag.limits.${key}.label`).toLowerCase() })}
                disabled={!canManage}
                value={mode[key]}
                onChange={(e) => setMode((m) => ({ ...m, [key]: e.target.value as "account" | "own" | "off" }))}
                className={lightSelect}
              >
                <option value="account">
                  {a
                    ? a[key] === null
                      ? t("diag.limits.accountOff")
                      : t("diag.limits.accountValue", { value: number(a[key] as number, key === "voltageMinV" ? 1 : 0), unit })
                    : t("diag.limits.account")}
                </option>
                <option value="own">{t("diag.limits.own")}</option>
                <option value="off">{t("diag.limits.off")}</option>
              </select>
              {mode[key] === "own" && (
                <input
                  aria-label={t("diag.limits.ownAria", { label: t(`diag.limits.${key}.label`).toLowerCase(), unit })}
                  className="num h-11 w-28 rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
                  inputMode="decimal"
                  disabled={!canManage}
                  placeholder={unit}
                  value={text[key]}
                  onChange={(e) => setText((current) => ({ ...current, [key]: e.target.value }))}
                />
              )}
            </div>
          </div>
        ))}
        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        {save.isSuccess && <Notice tone="success">{t("diag.limits.saved")}</Notice>}
        {canManage && (
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </form>

      {canManage && a && (
        <details className="rounded-[12px] border border-line px-4 py-3">
          <summary className="cursor-pointer text-[14px] font-semibold text-ink">{t("diag.limits.accountTitle")}</summary>
          <AccountLimits key={JSON.stringify(a)} current={a} saving={saveAccount.isPending} error={saveAccount.error} onSave={(body) => saveAccount.mutate(body)} />
        </details>
      )}
      <p className="text-[12.5px] leading-relaxed text-muted">{t("diag.limits.note")}</p>
    </div>
  );
}

function AccountLimits({ current, saving, error, onSave }: { current: { rpmMax: number | null; tempMaxC: number | null; voltageMinV: number | null }; saving: boolean; error: unknown; onSave: (body: { rpmMax: number | null; tempMaxC: number | null; voltageMinV: number | null }) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState<Record<LimitKey, string>>({ rpmMax: current.rpmMax?.toString() ?? "", tempMaxC: current.tempMaxC?.toString() ?? "", voltageMinV: current.voltageMinV?.toString() ?? "" });
  return (
    <form
      className="mt-3 space-y-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ rpmMax: numberOf(text.rpmMax), tempMaxC: numberOf(text.tempMaxC), voltageMinV: numberOf(text.voltageMinV) });
      }}
    >
      <p className="text-[13px] leading-relaxed text-ink-3">{t("diag.limits.accountLead")}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {LIMITS.map(({ key, unit }) => (
          <Field
            key={key}
            label={`${t(`diag.limits.${key}.label`)} (${unit})`}
            value={text[key]}
            onChange={(e) => setText((current) => ({ ...current, [key]: e.target.value }))}
            inputMode="decimal"
            mono
          />
        ))}
      </div>
      <p className="text-[13px] leading-relaxed text-ink-3">{t("diag.limits.whoNote")}</p>
      {error ? <Notice tone="error">{errorText(error)}</Notice> : null}
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" loading={saving}>
          {t("diag.limits.saveAccount")}
        </Button>
      </div>
    </form>
  );
}
