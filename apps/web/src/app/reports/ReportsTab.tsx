// Reports: choose which one, for what period and for which vehicles; it is viewed on
// screen and downloaded as Excel or PDF.
import {
  type ModuleKey,
  REPORT_INFO,
  REPORT_PARAMS_DEFAULT,
  REPORT_TYPES,
  type ReportColumn,
  type ReportDocument,
  type ReportFormat,
  type ReportParams,
  type ReportTable,
  type ReportType,
  type ReportValue,
  type Vehicle,
  type VehicleGroup,
} from "@opengps/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Activity, ArrowDown, ArrowUp, ArrowUpDown, CalendarClock, FileSpreadsheet, FileText, Fuel, Gauge, Hexagon, IdCard, type LucideIcon, Milestone, ParkingCircle, Route, Siren, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice, Spinner } from "../../components/ui";
import { downloadReport, getReport } from "../../lib/api";
import { formatDuration, formatKm } from "../../lib/format";
import { currentLanguage } from "../../lib/i18n";
import { errorText } from "../widgets";
import { BarChart, IDLE, INK, MOVING, axisCount, axisKm, axisTime } from "./charts";
import { Card, PERIODS, type Period, type PeriodId, PlaceCell, type Scope, ScopeSelect, Segmented, Tile, customPeriod, formatCell, inputClass, isNumeric, isPlace, labelClass, periodLabel, periodOf, toDateInput } from "./kit";

export const REPORT_ICON: Record<ReportType, LucideIcon> = {
  trips: Route,
  stops: ParkingCircle,
  mileage: Milestone,
  speed: Gauge,
  geofences: Hexagon,
  alarms: Siren,
  utilization: Activity,
  drivers: IdCard,
  fuel: Fuel,
  maintenance: Wrench,
};

/** Reports the account can request, depending on its modules. */
export const reportsFor = (modules: ModuleKey[]) => REPORT_TYPES.filter((type) => !REPORT_INFO[type].requires || modules.includes(REPORT_INFO[type].requires as ModuleKey));

/** Rows drawn at once; the rest, on demand. */
const PAGE = 100;

export interface ReportDraft {
  type: ReportType;
  params: ReportParams;
}

export function ReportsTab(props: {
  vehicles: Vehicle[];
  groups: VehicleGroup[];
  modules: ModuleKey[];
  geocoding: boolean;
  /** Which report and period it opens with, if reached from a dashboard indicator. */
  start: { type: ReportType; period: Period; scope: Scope } | null;
  /** Opens the dialog to schedule this same report; without permission, there is no button. */
  onSchedule?: (draft: ReportDraft) => void;
}) {
  const { t } = useTranslation();
  const available = useMemo(() => reportsFor(props.modules), [props.modules]);
  const [type, setType] = useState<ReportType>(props.start?.type ?? "trips");
  const [period, setPeriod] = useState<Period>(() => props.start?.period ?? periodOf("7d"));
  const [scope, setScope] = useState<Scope>(props.start?.scope ?? { groupId: null, vehicleIds: null });
  const [limit, setLimit] = useState(REPORT_PARAMS_DEFAULT.speedLimitKmh);
  const [minStop, setMinStop] = useState(REPORT_PARAMS_DEFAULT.minStopMin);
  const [dates, setDates] = useState({ from: toDateInput(period.from), to: toDateInput(new Date(period.to.getTime() - 1)) });
  const [customError, setCustomError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // When arriving from a dashboard indicator that report opens, with its period.
  useEffect(() => {
    if (!props.start) return;
    setType(props.start.type);
    setPeriod(props.start.period);
    setScope(props.start.scope);
  }, [props.start]);

  const params: ReportParams = { ...scope, speedLimitKmh: limit, minStopMin: minStop };
  const report = useQuery({
    queryKey: ["report", type, period.from.getTime(), period.to.getTime(), scope.groupId, scope.vehicleIds?.join(","), type === "speed" ? limit : 0, type === "stops" ? minStop : 0],
    queryFn: () => getReport(type, period.from, period.to, params),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: 0,
  });

  const choose = (id: PeriodId) => {
    setCustomError(null);
    if (id !== "custom") return setPeriod(periodOf(id));
    setDates({ from: toDateInput(period.from), to: toDateInput(new Date(period.to.getTime() - 1)) });
    setPeriod({ ...period, id: "custom" });
  };
  const applyDates = (next: { from: string; to: string }) => {
    setDates(next);
    const result = customPeriod(next.from, next.to);
    if (typeof result === "string") return setCustomError(result);
    setCustomError(null);
    setPeriod(result);
  };
  const download = async (format: ReportFormat) => {
    setBusy(format);
    setFailed(null);
    try {
      await downloadReport(type, period.from, period.to, params, format);
    } catch (err) {
      setFailed(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const doc = report.data?.type === type ? report.data : undefined;
  return (
    <div className="gap-6 lg:flex">
      <nav aria-label={t("reports.view.nav")} className="lg:w-60 lg:shrink-0">
        <label className="lg:hidden">
          <span className={labelClass}>{t("reports.report")}</span>
          <select className={clsx(inputClass, "mb-4 w-full")} value={type} onChange={(e) => setType(e.target.value as ReportType)}>
            {available.map((r) => (
              <option key={r} value={r}>
                {t(`shared.report.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <ul className="hidden space-y-1 lg:block">
          {available.map((r) => {
            const Icon = REPORT_ICON[r];
            return (
              <li key={r}>
                <button
                  type="button"
                  aria-current={r === type ? "page" : undefined}
                  onClick={() => setType(r)}
                  className={clsx("flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left text-sm font-medium transition-colors", r === type ? "bg-primary text-on-primary" : "text-ink-3 hover:bg-ink/[0.06]")}
                >
                  <Icon size={16} className={r === type ? "text-signal" : "text-muted"} />
                  {t(`shared.report.${r}`)}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 flex-1 space-y-4">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[20px] font-semibold tracking-tight">{t(`shared.report.${type}`)}</h1>
              <p className="mt-0.5 text-sm text-muted">{t(`shared.reportNote.${type}`)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" loading={busy === "xlsx"} disabled={busy !== null || !doc} onClick={() => void download("xlsx")}>
                {busy !== "xlsx" && <FileSpreadsheet size={15} />} Excel
              </Button>
              <Button variant="secondary" size="sm" loading={busy === "pdf"} disabled={busy !== null || !doc} onClick={() => void download("pdf")}>
                {busy !== "pdf" && <FileText size={15} />} PDF
              </Button>
              {props.onSchedule && (
                <Button variant="secondary" size="sm" onClick={() => props.onSchedule?.({ type, params })}>
                  <CalendarClock size={15} /> {t("reports.view.schedule")}
                </Button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <Segmented label={t("reports.period.label")} options={PERIODS} value={period.id} onChange={choose} />
            <ScopeSelect scope={scope} onChange={setScope} groups={props.groups} vehicles={props.vehicles} />
            {type === "speed" && <NumberOption label={t("reports.view.speedLimit")} value={limit} min={20} max={200} onCommit={setLimit} />}
            {type === "stops" && <NumberOption label={t("reports.view.minStop")} value={minStop} min={3} max={1440} onCommit={setMinStop} />}
          </div>
          {period.id === "custom" && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label>
                <span className={labelClass}>{t("common.from")}</span>
                <input type="date" className={inputClass} value={dates.from} max={toDateInput(new Date())} onChange={(e) => applyDates({ ...dates, from: e.target.value })} />
              </label>
              <label>
                <span className={labelClass}>{t("common.to")}</span>
                <input type="date" className={inputClass} value={dates.to} max={toDateInput(new Date())} onChange={(e) => applyDates({ ...dates, to: e.target.value })} />
              </label>
              {customError && <p className="pb-2.5 text-[13px] text-danger">{customError}</p>}
            </div>
          )}
          {failed && (
            <div className="mt-3">
              <Notice tone="error">{failed}</Notice>
            </div>
          )}
        </Card>

        {report.isError && !report.isFetching && <Notice tone="error">{errorText(report.error)}</Notice>}
        {!doc && report.isFetching && (
          <div className="flex h-48 items-center justify-center text-muted">
            <Spinner size={22} />
          </div>
        )}
        {doc && !(report.isError && !report.isFetching) && (
          <div className={clsx("space-y-4 transition-opacity", report.isFetching && "opacity-60")} aria-busy={report.isFetching}>
            <ReportView doc={doc} geocoding={props.geocoding} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A number applied on leaving the field or pressing Enter, so the report is not requested on every keystroke. */
function NumberOption({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n)) return setText(String(value));
    const fixed = Math.min(max, Math.max(min, n));
    setText(String(fixed));
    if (fixed !== value) onCommit(fixed);
  };
  return (
    <label>
      <span className="flex h-10 items-center gap-2 rounded-[10px] border border-line bg-surface pl-3 text-sm text-muted focus-within:border-ink">
        {label}
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="num h-full w-[72px] rounded-r-[10px] border-l border-line bg-transparent px-2 text-ink focus:outline-none"
        />
      </span>
    </label>
  );
}

// ─── The report on screen ──────────────────────────────────────────────────

const chartFormat = (unit: ReportDocument["stats"][number]["type"]) => (value: number) =>
  unit === "distance" ? `${formatKm(value)} km` : unit === "duration" ? formatDuration(value) : formatCell(value, unit);

export function ReportView({ doc, geocoding }: { doc: ReportDocument; geocoding: boolean }) {
  const chart = doc.chart;
  return (
    <>
      <p className="px-1 text-[13px] text-muted">
        {periodLabel({ from: new Date(doc.from), to: new Date(doc.to) })} · {doc.scope}
        {doc.options.map((o) => ` · ${o}`).join("")}
      </p>
      {doc.stats.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {doc.stats.map((s) => (
            <Tile key={s.label} raised label={s.label} value={formatCell(s.value, s.type)} />
          ))}
        </div>
      )}
      {chart && (
        <Card title={chart.title}>
          <BarChart
            labels={chart.labels}
            dates={chart.labelType === "date"}
            unit={chart.unit === "distance" ? 1000 : chart.unit === "duration" ? 3600 : 1}
            format={chartFormat(chart.unit)}
            axis={chart.unit === "distance" ? axisKm : chart.unit === "duration" ? axisTime : axisCount}
            series={chart.series.map((s, i) => ({ name: s.name, values: s.values, color: chart.series.length > 1 ? (i === 0 ? MOVING : IDLE) : INK }))}
          />
        </Card>
      )}
      {doc.tables.map((table) => (
        <TableView key={`${doc.type}:${table.title}`} table={table} geocoding={geocoding} />
      ))}
      {doc.notes.length > 0 && (
        <ul className="space-y-1 px-1 text-[12.5px] text-muted">
          {doc.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Value a cell is sorted by: places, by their text; empty, last. */
const sortKey = (value: ReportValue): string | number | null => (isPlace(value) ? (value.address ?? `${value.lat},${value.lon}`) : value);

function TableView({ table, geocoding }: { table: ReportTable; geocoding: boolean }) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ column: number; down: boolean } | null>(null);
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const sign = sort.down ? -1 : 1;
    return [...table.rows].sort((a, b) => {
      const x = sortKey(a[sort.column] ?? null);
      const y = sortKey(b[sort.column] ?? null);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), currentLanguage(), { numeric: true })) * sign;
    });
  }, [table.rows, sort]);
  const align = (c: ReportColumn) => (isNumeric(c.type) ? "text-right" : "text-left");

  return (
    <section className="min-w-0 rounded-[14px] border border-line bg-surface">
      <header className="flex items-baseline justify-between gap-3 px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight">{table.title}</h2>
        <span className="text-[12.5px] text-muted">
          {t("reports.table.rows", { count: table.total, n: table.total.toLocaleString(currentLanguage()) })}
          {table.total > table.rows.length && ` · ${t("reports.table.shown", { n: table.rows.length.toLocaleString(currentLanguage()) })}`}
        </span>
      </header>
      {table.rows.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">{t("reports.noData")}</p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-muted">
                {table.columns.map((c, i) => {
                  const mine = sort?.column === i;
                  const Icon = mine ? (sort.down ? ArrowDown : ArrowUp) : ArrowUpDown;
                  return (
                    <th key={c.label} scope="col" aria-sort={mine ? (sort.down ? "descending" : "ascending") : undefined} className={clsx("whitespace-nowrap px-3 py-2 font-medium first:pl-4 last:pr-4", align(c))}>
                      <button
                        type="button"
                        onClick={() => setSort(mine ? (sort.down ? null : { column: i, down: true }) : { column: i, down: false })}
                        className={clsx("group inline-flex items-center gap-1 uppercase tracking-wider hover:text-ink", mine && "text-ink", isNumeric(c.type) && "flex-row-reverse")}
                        title={t("reports.table.sort")}
                      >
                        {c.label}
                        <Icon size={11} className={clsx(!mine && "opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60")} />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-line border-t border-line">
              {rows.slice(0, shown).map((row, r) => (
                // oxlint-disable-next-line react/no-array-index-key -- rows have no identifier of their own
                <tr key={r} className="hover:bg-canvas/70">
                  {table.columns.map((c, i) => {
                    const value = row[i] ?? null;
                    return (
                      <td key={c.label} className={clsx("px-3 py-2 first:pl-4 last:pr-4", align(c), isNumeric(c.type) ? "num whitespace-nowrap text-[13px]" : c.type === "place" ? "min-w-[230px] max-w-[340px]" : typeof value === "string" && value.length > 44 ? "min-w-[280px] max-w-[420px]" : "whitespace-nowrap")}>
                        {isPlace(value) ? <PlaceCell place={value} geocoding={geocoding} /> : formatCell(value, c.type)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {table.totals && (
              <tfoot>
                <tr className="border-t-2 border-line font-semibold">
                  {table.columns.map((c, i) => {
                    const value = table.totals?.[i] ?? null;
                    return (
                      <td key={c.label} className={clsx("px-3 py-2.5 first:pl-4 last:pr-4", align(c), isNumeric(c.type) && typeof value === "number" && "num whitespace-nowrap text-[13px]")}>
                        {value === null ? "" : formatCell(value, c.type)}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {rows.length > shown && (
        <div className="border-t border-line p-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE * 3)}>
            {t("reports.table.more", { n: (rows.length - shown).toLocaleString(currentLanguage()) })}
          </Button>
        </div>
      )}
    </section>
  );
}
