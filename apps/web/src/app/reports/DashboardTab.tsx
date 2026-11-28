// Indicator dashboards: each person chooses which indicators they see, in what
// order, for what period and for which group, and can have several.
import {
  ALL_DASHBOARD_WIDGETS,
  DASHBOARDS_MAX,
  DASHBOARD_DEFAULT_WIDGETS,
  DASHBOARD_PERIODS,
  DASHBOARD_WIDGETS,
  type Dashboard,
  type DashboardData,
  type DashboardInput,
  type DashboardPeriod,
  type DashboardTotals,
  type DashboardWidget,
  type ModuleKey,
  type ReportType,
  type Vehicle,
  type VehicleGroup,
  type VehicleStatus,
  vehicleStatus,
} from "@opengps/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDown, ChevronUp, Plus, Settings2, Trash } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner, StatusDot } from "../../components/ui";
import { deleteDashboard, getDashboardData, getDashboards, saveDashboard } from "../../lib/api";
import { formatDuration, formatKm } from "../../lib/format";
import i18n, { currentLanguage } from "../../lib/i18n";
import { useNow } from "../../lib/session";
import { ConfirmBar, errorText } from "../widgets";
import { BarChart, HBars, IDLE, INK, MOVING, axisCount, axisKm, axisTime } from "./charts";
import { Card, type Period, type Scope, ScopeSelect, Segmented, Tile, eventLabel, labelClass, periodLabel, periodOf } from "./kit";

/** The dashboard shown while the person has not saved any; its name is given where it is shown. */
const STARTER: Dashboard = { id: "", name: "", period: "7d", groupId: null, vehicleIds: null, widgets: DASHBOARD_DEFAULT_WIDGETS };
/** Report that details each indicator. */
const WIDGET_REPORT: Partial<Record<DashboardWidget, ReportType>> = {
  distance_by_day: "mileage",
  top_distance: "mileage",
  usage_by_day: "utilization",
  least_used: "utilization",
  alerts_by_type: "alarms",
  alerts_by_day: "alarms",
  driver_scores: "drivers",
};
const WIDE: DashboardWidget[] = ["totals"];
const FLEET_STATUSES: VehicleStatus[] = ["moving", "idle", "stopped", "offline", "pending", "no_device"];
const km = (meters: number) => `${formatKm(meters)} km`;
const whole = new Intl.NumberFormat(currentLanguage());

const toInput = (board: Dashboard, patch: Partial<DashboardInput> = {}): DashboardInput => ({ name: board.name, period: board.period, groupId: board.groupId, vehicleIds: board.vehicleIds, widgets: board.widgets, ...patch });
const widgetsFor = (modules: ModuleKey[]) => ALL_DASHBOARD_WIDGETS.filter((w) => !DASHBOARD_WIDGETS[w].requires || modules.includes(DASHBOARD_WIDGETS[w].requires as ModuleKey));

export function DashboardTab(props: {
  vehicles: Vehicle[];
  groups: VehicleGroup[];
  modules: ModuleKey[];
  /** Opens the report that details an indicator, with the same period and group. */
  onReport: (type: ReportType, period: Period, scope: Scope) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const now = useNow(60_000);
  const boards = useQuery({ queryKey: ["dashboards"], queryFn: getDashboards });
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Dashboard | "new" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const list = boards.data ?? [];
  const board = list.find((b) => b.id === currentId) ?? list[0] ?? { ...STARTER, name: t("reports.dashboard.defaultName") };
  const available = useMemo(() => widgetsFor(props.modules), [props.modules]);
  const widgets = board.widgets.filter((w) => available.includes(w));
  // The saved group or vehicles may have been deleted: then the dashboard covers what is left, or all vehicles.
  const groupId = board.groupId && props.groups.some((g) => g.id === board.groupId) ? board.groupId : null;
  const known = board.vehicleIds?.filter((id) => props.vehicles.some((v) => v.id === id)) ?? [];
  const vehicleIds = known.length > 0 ? known : null;
  const scope: Scope = vehicleIds ? { groupId: null, vehicleIds } : { groupId, vehicleIds: null };
  // The period is recalculated when the day changes, not on every clock tick.
  const today = new Date(now).toDateString();
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const period = useMemo(() => periodOf(board.period), [board.period, today]);

  const data = useQuery({
    queryKey: ["dashboard-data", period.from.getTime(), period.to.getTime(), scope.groupId, scope.vehicleIds?.join(",") ?? null],
    queryFn: () => getDashboardData(period.from, period.to, scope),
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
    enabled: boards.isSuccess,
  });

  // Changing the period or the vehicles saves automatically; the first change creates the dashboard.
  const persist = useMutation({
    mutationFn: (patch: Partial<DashboardInput>) => saveDashboard(toInput(board, patch), board.id || undefined),
    onMutate: (patch) => {
      setFailed(null);
      if (board.id) queryClient.setQueryData<Dashboard[]>(["dashboards"], (old) => old?.map((b) => (b.id === board.id ? { ...b, ...patch, groupId: patch.groupId === undefined ? b.groupId : patch.groupId, vehicleIds: patch.vehicleIds === undefined ? b.vehicleIds : patch.vehicleIds } : b)));
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<Dashboard[]>(["dashboards"], (old) => (old?.some((b) => b.id === saved.id) ? old.map((b) => (b.id === saved.id ? saved : b)) : [...(old ?? []), saved]));
      setCurrentId(saved.id);
    },
    onError: (err) => {
      setFailed(errorText(err));
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    },
  });

  if (boards.isLoading) {
    return (
      <div className="flex h-48 items-center justify-center text-muted">
        <Spinner size={22} />
      </div>
    );
  }
  if (boards.isError) return <Notice tone="error">{errorText(boards.error)}</Notice>;

  const inGroup = props.vehicles.filter((v) => (vehicleIds ? vehicleIds.includes(v.id) : !groupId || v.groupId === groupId));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {list.length > 1 ? (
            <Segmented label={t("reports.dashboard.boards")} options={list.map((b) => ({ id: b.id, label: b.name }))} value={board.id} onChange={setCurrentId} />
          ) : (
            <h1 className="text-[20px] font-semibold tracking-tight">{board.name}</h1>
          )}
          <Button variant="ghost" size="sm" disabled={list.length >= DASHBOARDS_MAX} onClick={() => setEditing("new")}>
            <Plus size={15} /> {t("reports.dashboard.new")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label={t("reports.period.label")} options={DASHBOARD_PERIODS.map((id) => ({ id, label: t(`shared.dashboardPeriod.${id}`) }))} value={board.period} onChange={(id: DashboardPeriod) => persist.mutate({ period: id })} />
          <ScopeSelect scope={scope} onChange={(next) => persist.mutate(next)} groups={props.groups} vehicles={props.vehicles} />
          <Button variant="secondary" size="sm" onClick={() => setEditing(board)}>
            <Settings2 size={15} /> {t("reports.dashboard.customize")}
          </Button>
        </div>
      </div>
      <p className="-mt-1 text-[13px] text-muted">
        {periodLabel(period)} · {t("reports.dashboard.vehicles", { count: inGroup.length })}
      </p>
      {failed && <Notice tone="error">{failed}</Notice>}
      {data.isError && <Notice tone="error">{errorText(data.error)}</Notice>}
      {!data.data && data.isFetching && (
        <div className="flex h-48 items-center justify-center text-muted">
          <Spinner size={22} />
        </div>
      )}
      {data.data && (
        <div className={clsx("grid gap-4 transition-opacity lg:grid-cols-2", data.isPlaceholderData && "opacity-60")} aria-busy={data.isPlaceholderData}>
          {widgets.map((w) => {
            const report = WIDGET_REPORT[w];
            return (
              <Card
                key={w}
                title={t(`shared.dashboardWidget.${w}`)}
                className={clsx(WIDE.includes(w) && "lg:col-span-2")}
                action={
                  report && (
                    <button type="button" onClick={() => props.onReport(report, period, scope)} className="shrink-0 rounded-lg px-2 py-1 text-[12.5px] font-medium text-signal-ink hover:bg-canvas">
                      {t("reports.dashboard.seeReport")}
                    </button>
                  )
                }
              >
                <Widget kind={w} data={data.data as DashboardData} vehicles={inGroup} now={now} />
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <BoardDialog
          key={editing === "new" ? "new" : editing.id || "starter"}
          board={editing === "new" ? { ...STARTER, name: "" } : editing}
          isNew={editing === "new"}
          available={available}
          onClose={() => setEditing(null)}
          onSaved={(saved) => setCurrentId(saved?.id ?? null)}
        />
      )}
    </div>
  );
}

// ─── Indicators ─────────────────────────────────────────────────────────────

/** "34 % más que antes": the previous period of the same duration. */
function change(current: number, previous: number): string {
  if (previous <= 0) return current > 0 ? i18n.t("reports.dashboard.change.nothingBefore") : i18n.t("reports.dashboard.change.same");
  const percent = Math.round(((current - previous) / previous) * 100);
  if (percent === 0) return i18n.t("reports.dashboard.change.same");
  return i18n.t(percent > 0 ? "reports.dashboard.change.more" : "reports.dashboard.change.less", { percent: whole.format(Math.abs(percent)) });
}

function Widget({ kind, data, vehicles, now }: { kind: DashboardWidget; data: DashboardData; vehicles: Vehicle[]; now: number }): ReactNode {
  const { t } = useTranslation();
  const days = data.days.map((d) => d.date);
  switch (kind) {
    case "totals": {
      const c = data.totals;
      const p = data.previous;
      const tile = (label: string, pick: (x: DashboardTotals) => number, format: (n: number) => string) => <Tile label={label} value={format(pick(c))} foot={change(pick(c), pick(p))} />;
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {tile(t("reports.dashboard.tile.distance"), (x) => x.distanceM, km)}
          {tile(t("reports.dashboard.tile.trips"), (x) => x.trips, (n) => whole.format(n))}
          {tile(t("reports.dashboard.tile.drivingTime"), (x) => x.drivingS, formatDuration)}
          {tile(t("reports.dashboard.tile.idle"), (x) => x.idleS, formatDuration)}
          {tile(t("reports.dashboard.tile.alerts"), (x) => x.alerts, (n) => whole.format(n))}
          <Tile label={t("reports.dashboard.tile.vehiclesUsed")} value={t("reports.dashboard.tile.usedOf", { used: c.activeVehicles, total: data.vehicles })} foot={t("reports.dashboard.tile.before", { n: p.activeVehicles })} />
        </div>
      );
    }
    case "fleet": {
      const counts = new Map<VehicleStatus, number>();
      for (const v of vehicles) counts.set(vehicleStatus(v, now), (counts.get(vehicleStatus(v, now)) ?? 0) + 1);
      const shown = FLEET_STATUSES.filter((s) => (counts.get(s) ?? 0) > 0 || s === "moving" || s === "stopped");
      return (
        <ul className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {shown.map((s) => (
            <li key={s} className="flex items-center justify-between gap-3 border-b border-line pb-2.5">
              <span className="inline-flex min-w-0 items-center gap-2 text-[13.5px] text-ink-3">
                <StatusDot status={s} />
                <span className="truncate">{t(`shared.vehicleStatus.${s}`)}</span>
              </span>
              <span className="num text-[17px] font-semibold">{counts.get(s) ?? 0}</span>
            </li>
          ))}
        </ul>
      );
    }
    case "distance_by_day":
      return <BarChart labels={days} dates unit={1000} format={km} axis={axisKm} series={[{ name: t("reports.dashboard.series.distance"), color: INK, values: data.days.map((d) => d.distanceM) }]} />;
    case "usage_by_day":
      return (
        <BarChart
          labels={days}
          dates
          unit={3600}
          format={formatDuration}
          axis={axisTime}
          series={[
            { name: t("reports.dashboard.series.moving"), color: MOVING, values: data.days.map((d) => d.movingS) },
            { name: t("reports.dashboard.series.idle"), color: IDLE, values: data.days.map((d) => d.idleS) },
          ]}
        />
      );
    case "alerts_by_day":
      return <BarChart labels={days} dates format={(n) => whole.format(Math.round(n))} axis={axisCount} series={[{ name: t("reports.dashboard.series.alerts"), color: INK, values: data.days.map((d) => d.alerts) }]} />;
    case "top_distance":
      return (
        <HBars
          format={km}
          empty={t("reports.dashboard.empty.topDistance")}
          rows={data.byVehicle
            .filter((v) => v.distanceM > 0)
            .sort((a, b) => b.distanceM - a.distanceM)
            .slice(0, 10)
            .map((v) => ({ key: v.id, label: v.name, value: v.distanceM }))}
        />
      );
    case "least_used":
      return (
        <HBars
          format={formatDuration}
          empty={t("reports.dashboard.empty.leastUsed")}
          rows={[...data.byVehicle]
            .sort((a, b) => a.drivingS - b.drivingS || a.name.localeCompare(b.name, currentLanguage(), { numeric: true }))
            .slice(0, 10)
            .map((v) => ({ key: v.id, label: v.name, value: v.drivingS }))}
        />
      );
    case "alerts_by_type":
      return <HBars format={(n) => whole.format(n)} empty={t("reports.dashboard.empty.alerts")} rows={data.alertTypes.slice(0, 10).map((a) => ({ key: a.type, label: eventLabel(a.type), value: a.count }))} />;
    case "driver_scores": {
      const people = (data.drivers ?? []).filter((d) => d.driverId !== null).slice(0, 8);
      if (people.length === 0) return <p className="py-6 text-center text-sm text-muted">{t("reports.dashboard.empty.drivers")}</p>;
      return (
        <ul className="divide-y divide-line">
          {people.map((d) => (
            <li key={d.driverId} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
              <span className="min-w-0 truncate text-ink-3">{d.name}</span>
              <span className="flex shrink-0 items-baseline gap-3">
                <span className="num text-[12.5px] text-muted">{km(d.distanceM)}</span>
                <span className="num w-9 text-right text-[16px] font-semibold">{d.score ?? "—"}</span>
              </span>
            </li>
          ))}
        </ul>
      );
    }
  }
}

// ─── Customize ────────────────────────────────────────────────────────────

function BoardDialog(props: { board: Dashboard; isNew: boolean; available: DashboardWidget[]; onClose: () => void; onSaved: (saved: Dashboard | null) => void }) {
  const { board } = props;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(board.name);
  // First those the dashboard already shows, in its order; then the rest.
  const [order, setOrder] = useState<DashboardWidget[]>(() => [...board.widgets.filter((w) => props.available.includes(w)), ...props.available.filter((w) => !board.widgets.includes(w))]);
  const [on, setOn] = useState<Set<DashboardWidget>>(() => new Set(board.widgets));
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setName(board.name), [board.name]);

  const save = useMutation({
    mutationFn: () => saveDashboard({ name: name.trim() || t("reports.dashboard.defaultName"), period: board.period, groupId: board.groupId, vehicleIds: board.vehicleIds, widgets: order.filter((w) => on.has(w)) }, props.isNew ? undefined : board.id || undefined),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      props.onSaved(saved);
      props.onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDashboard(board.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      props.onSaved(null);
      props.onClose();
    },
  });
  const move = (index: number, by: -1 | 1) =>
    setOrder((old) => {
      const next = [...old];
      const target = index + by;
      if (target < 0 || target >= next.length) return old;
      [next[index], next[target]] = [next[target] as DashboardWidget, next[index] as DashboardWidget];
      return next;
    });
  const toggle = (w: DashboardWidget) =>
    setOn((old) => {
      const next = new Set(old);
      if (!next.delete(w)) next.add(w);
      return next;
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const error = save.error ?? remove.error;

  return (
    <Modal open onClose={props.onClose} title={props.isNew ? t("reports.dashboard.dialog.newTitle") : t("reports.dashboard.dialog.editTitle")} wide>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={t("reports.dashboard.defaultName")} />
        <fieldset>
          <legend className={labelClass}>{t("reports.dashboard.dialog.widgets")}</legend>
          <ul className="divide-y divide-line rounded-[10px] border border-line">
            {order.map((w, i) => (
              <li key={w} className="flex items-center gap-3 px-3 py-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-ink" checked={on.has(w)} onChange={() => toggle(w)} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t(`shared.dashboardWidget.${w}`)}</span>
                    <span className="block text-[12.5px] text-muted">{t(`shared.dashboardWidgetNote.${w}`)}</span>
                  </span>
                </label>
                <span className="flex shrink-0">
                  <button type="button" aria-label={t("reports.dashboard.dialog.moveUp", { name: t(`shared.dashboardWidget.${w}`) })} disabled={i === 0} onClick={() => move(i, -1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-canvas hover:text-ink disabled:opacity-30">
                    <ChevronUp size={16} />
                  </button>
                  <button type="button" aria-label={t("reports.dashboard.dialog.moveDown", { name: t(`shared.dashboardWidget.${w}`) })} disabled={i === order.length - 1} onClick={() => move(i, 1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-canvas hover:text-ink disabled:opacity-30">
                    <ChevronDown size={16} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </fieldset>
        {error && <Notice tone="error">{errorText(error)}</Notice>}
        {confirming ? (
          <ConfirmBar pending={remove.isPending} onCancel={() => setConfirming(false)} onConfirm={() => remove.mutate()}>
            {t("reports.dashboard.dialog.confirmDelete", { name: board.name })}
          </ConfirmBar>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {!props.isNew && board.id ? (
              <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
                <Trash size={15} /> {t("reports.dashboard.dialog.delete")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={props.onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={save.isPending} disabled={on.size === 0}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}
