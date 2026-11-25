// Reports and dashboards (module G): the indicator board, reports and
// scheduled reports. It opens inside the panel, with its full width.
import type { Me, Permission, ReportType } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ChartColumn, LayoutDashboard } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { ModulePanel, type PanelTab, PanelTabs } from "../app/admin/ModulePanel";
import { DashboardTab } from "../app/reports/DashboardTab";
import { type ReportDraft, ReportsTab } from "../app/reports/ReportsTab";
import { SchedulesTab } from "../app/reports/SchedulesTab";
import type { Period, Scope } from "../app/reports/kit";
import { Notice, Spinner } from "../components/ui";
import { getGroups, getVehicles } from "../lib/api";
import { useConfig } from "../lib/session";

type TabId = "dashboard" | "reports" | "scheduled";
/** `label` holds the key of its text. */
const TABS = [
  { id: "dashboard", label: "admin.modules.reports.tabs.dashboard", icon: LayoutDashboard },
  { id: "reports", label: "admin.modules.reports.tabs.reports", icon: ChartColumn },
  { id: "scheduled", label: "admin.modules.reports.tabs.scheduled", icon: CalendarClock },
] as const satisfies readonly PanelTab<TabId>[];

export function ReportsPage() {
  return <ModulePanel section="reports">{(me) => <Reports me={me} />}</ModulePanel>;
}

function Reports({ me }: { me: Me }) {
  const { t } = useTranslation();
  const config = useConfig();
  const [search, setSearch] = useSearchParams();
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: getVehicles, refetchInterval: 60_000 });
  const groups = useQuery({ queryKey: ["groups"], queryFn: getGroups });
  /** Report reached from an indicator, and report to be scheduled. */
  const [start, setStart] = useState<{ type: ReportType; period: Period; scope: Scope } | null>(null);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const clearDraft = useCallback(() => setDraft(null), []);

  if (config.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }

  const can = (permission: Permission) => me.account.permissions.includes(permission);
  const tabs: PanelTab<TabId>[] = TABS.filter((each) => each.id !== "scheduled" || can("reports.schedule")).map((each) => ({ ...each, label: t(each.label) }));
  const wanted = search.get("tab") as TabId | null;
  const tab = tabs.some((each) => each.id === wanted) ? (wanted as TabId) : "dashboard";
  const go = (id: TabId) => setSearch(id === "dashboard" ? {} : { tab: id }, { replace: false });
  const modules = me.account.modules;

  return (
    <>
      <PanelTabs tabs={tabs} value={tab} onChange={go} section={t("admin.nav.reports")} />
      {(vehicles.isError || groups.isError) && (
        <div className="mb-4">
          <Notice tone="error">{t("admin.modules.loadVehiclesFailed")}</Notice>
        </div>
      )}
      {tab === "dashboard" && (
        <DashboardTab
          vehicles={vehicles.data ?? []}
          groups={groups.data ?? []}
          modules={modules}
          onReport={(type, period, scope) => {
            setStart({ type, period, scope });
            go("reports");
          }}
        />
      )}
      {tab === "reports" && (
        <ReportsTab
          vehicles={vehicles.data ?? []}
          groups={groups.data ?? []}
          modules={modules}
          geocoding={config.data?.geocoding ?? false}
          start={start}
          {...(can("reports.schedule")
            ? {
                onSchedule: (next: ReportDraft) => {
                  setDraft(next);
                  go("scheduled");
                },
              }
            : {})}
        />
      )}
      {tab === "scheduled" && <SchedulesTab vehicles={vehicles.data ?? []} groups={groups.data ?? []} modules={modules} meId={me.user.id} draft={draft} onDraftUsed={clearDraft} />}
    </>
  );
}
