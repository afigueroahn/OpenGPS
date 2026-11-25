// How much each vehicle is used: distance traveled, time on trips and idling,
// and the days it did not go out.
import type { FleetUsage, VehicleGroup } from "@opengps/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ParseKeys } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Notice, Spinner } from "../../components/ui";
import { getFleetUtilization } from "../../lib/api";
import { formatDuration, formatKm } from "../../lib/format";
import { Card, PERIODS, type Period, type PeriodId, Segmented, Tile, customPeriod, inputClass, labelClass, periodLabel, periodOf, selectClass, toDateInput } from "../reports/kit";
import { errorText } from "../widgets";
import { whole } from "./format";
import { groupTree, indented, withChildren } from "./tree";

const OPTIONS = PERIODS.filter((p) => p.id !== "today" && p.id !== "yesterday");
type SortKey = "name" | "distanceM" | "trips" | "tripS" | "idleS" | "activeDays" | "unusedPercent";
const COLUMNS: { key: SortKey; label: ParseKeys; numeric: boolean }[] = [
  { key: "name", label: "fleet.usage.columns.name", numeric: false },
  { key: "distanceM", label: "fleet.usage.columns.distance", numeric: true },
  { key: "trips", label: "fleet.usage.columns.trips", numeric: true },
  { key: "tripS", label: "fleet.usage.columns.tripTime", numeric: true },
  { key: "idleS", label: "fleet.usage.columns.idle", numeric: true },
  { key: "activeDays", label: "fleet.usage.columns.activeDays", numeric: true },
  { key: "unusedPercent", label: "fleet.usage.columns.unused", numeric: true },
];

export function UsageTab({ groups }: { groups: VehicleGroup[] }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>(() => periodOf("30d"));
  const [dates, setDates] = useState({ from: toDateInput(period.from), to: toDateInput(new Date(period.to.getTime() - 1)) });
  const [customError, setCustomError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({ key: "tripS", down: true });
  const usage = useQuery({
    queryKey: ["fleet-usage", period.from.getTime(), period.to.getTime()],
    queryFn: () => getFleetUtilization(period.from, period.to),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: 0,
  });
  const tree = useMemo(() => groupTree(groups), [groups]);

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

  const data = usage.data;
  const rows = useMemo(() => {
    const inGroup = groupId === "all" ? null : withChildren(groups, groupId);
    const picked = (data?.vehicles ?? []).filter((r) => !inGroup || (r.groupId !== null && inGroup.has(r.groupId)));
    const way = sort.down ? -1 : 1;
    return picked.toSorted((a: FleetUsage, b: FleetUsage) => (sort.key === "name" ? a.name.localeCompare(b.name) * way : (a[sort.key] - b[sort.key]) * way || a.name.localeCompare(b.name)));
  }, [data, groupId, groups, sort]);
  const sum = (pick: (r: FleetUsage) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const unused = rows.length ? Math.round(sum((r) => r.unusedPercent) / rows.length) : 0;
  const without = rows.filter((r) => r.trips === 0).length;
  const days = data?.days ?? 0;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-tight">{t("fleet.usage.title")}</h1>
            <p className="mt-0.5 text-sm text-muted">{t("fleet.usage.lead", { period: periodLabel(period) })}</p>
          </div>
          {usage.isFetching && <Spinner className="text-muted" />}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Segmented label={t("fleet.usage.period")} options={OPTIONS} value={period.id} onChange={choose} />
          {tree.length > 0 && (
            <select aria-label={t("common.group")} value={groupId} onChange={(e) => setGroupId(e.target.value)} className={clsx(selectClass, "max-w-full")}>
              <option value="all">{t("fleet.usage.allVehicles")}</option>
              {tree.map((g) => (
                <option key={g.id} value={g.id}>
                  {indented(g)}
                </option>
              ))}
            </select>
          )}
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
      </Card>

      {usage.isError && !usage.isFetching && <Notice tone="error">{errorText(usage.error)}</Notice>}
      {!data && usage.isLoading && (
        <div className="flex h-40 items-center justify-center text-muted">
          <Spinner size={22} />
        </div>
      )}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Tile raised label={t("fleet.usage.distance")} value={`${formatKm(sum((r) => r.distanceM))} km`} foot={t("fleet.usage.trips", { count: sum((r) => r.trips), n: whole(sum((r) => r.trips)) })} />
            <Tile raised label={t("fleet.usage.tripTime")} value={formatDuration(sum((r) => r.tripS))} foot={t("fleet.usage.tripTimeFoot")} />
            <Tile raised label={t("fleet.usage.idle")} value={formatDuration(sum((r) => r.idleS))} foot={t("fleet.usage.idleFoot")} />
            <Tile raised label={t("fleet.usage.unusedDays")} value={`${unused} %`} foot={t("fleet.usage.ofDays", { count: days })} />
            <Tile raised label={t("fleet.usage.noTrips")} value={whole(without)} foot={t("fleet.usage.noTripsFoot", { count: without })} />
          </div>
          <Card>
            {rows.length === 0 ? (
              <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{t("fleet.usage.empty")}</p>
            ) : (
              <div className="-m-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-canvas/60 text-[12px] uppercase tracking-wider text-muted">
                      {COLUMNS.map((c) => {
                        const mine = sort.key === c.key;
                        return (
                          <th key={c.key} scope="col" aria-sort={mine ? (sort.down ? "descending" : "ascending") : undefined} className={clsx("whitespace-nowrap px-3 py-2 font-medium first:pl-4 last:pr-4", c.numeric ? "text-right" : "text-left")}>
                            <button type="button" onClick={() => setSort({ key: c.key, down: mine ? !sort.down : c.numeric })} className={clsx("inline-flex items-center gap-1 uppercase tracking-wider hover:text-ink", mine && "text-ink")}>
                              {t(c.label)}
                              {mine && (sort.down ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)}
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((r) => (
                      <tr key={r.vehicleId}>
                        <td className="max-w-[240px] truncate px-3 py-2.5 pl-4 font-medium text-ink">{r.name}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-[13px]">{formatKm(r.distanceM)} km</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-[13px]">{whole(r.trips)}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-[13px]">{formatDuration(r.tripS)}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-[13px]">{formatDuration(r.idleS)}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-[13px]">
                          {t("fleet.usage.daysOf", { n: r.activeDays, total: days })}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 pr-4">
                          <span className="flex items-center justify-end gap-2.5">
                            <span className="hidden h-2 w-24 overflow-hidden rounded-[4px] bg-canvas sm:block" aria-hidden="true">
                              <span className={clsx("block h-full rounded-r-[4px]", r.unusedPercent >= 80 ? "bg-danger" : "bg-ink-3")} style={{ width: `${r.unusedPercent}%` }} />
                            </span>
                            <span className={clsx("num w-11 text-right text-[13px]", r.unusedPercent >= 80 && "font-semibold text-danger")}>{r.unusedPercent} %</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="text-[12.5px] text-muted">{t("fleet.usage.footer")}</p>
        </>
      )}
    </div>
  );
}
