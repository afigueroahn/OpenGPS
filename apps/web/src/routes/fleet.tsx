// Fleet (module D): the vehicle inventory with each profile, how much each one is used,
// what they cost and the group tree. It opens inside the panel, with its full width.
import type { Me, Permission } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { CarFront, FolderTree, Gauge, Receipt } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { ModulePanel, type PanelTab, PanelTabs } from "../app/admin/ModulePanel";
import { ExpensesTab } from "../app/fleet/ExpensesTab";
import { GroupsTab } from "../app/fleet/GroupsTab";
import { UsageTab } from "../app/fleet/UsageTab";
import { VehiclesTab } from "../app/fleet/VehiclesTab";
import { Notice } from "../components/ui";
import { getGroups } from "../lib/api";

type TabId = "vehicles" | "usage" | "expenses" | "groups";
/** `label` holds the key of its text. */
const TABS = [
  { id: "vehicles", label: "admin.modules.fleet.tabs.vehicles", icon: CarFront },
  { id: "usage", label: "admin.modules.fleet.tabs.usage", icon: Gauge },
  { id: "expenses", label: "admin.modules.fleet.tabs.expenses", icon: Receipt },
  { id: "groups", label: "admin.modules.fleet.tabs.groups", icon: FolderTree },
] as const satisfies readonly PanelTab<TabId>[];

export function FleetPage() {
  return <ModulePanel section="fleet">{(me) => <Fleet me={me} />}</ModulePanel>;
}

function Fleet({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const groups = useQuery({ queryKey: ["groups"], queryFn: getGroups });
  const can = (permission: Permission) => me.account.permissions.includes(permission);
  const canManage = can("vehicles.manage");
  // The group tree decides what each person sees: only whoever sees the whole account edits it.
  const seesEverything = me.account.groups === null;
  const tabs: PanelTab<TabId>[] = TABS.filter((each) => each.id !== "groups" || seesEverything).map((each) => ({ ...each, label: t(each.label) }));
  const wanted = search.get("tab") as TabId | null;
  const tab = tabs.some((each) => each.id === wanted) ? (wanted as TabId) : "vehicles";
  const go = (id: TabId) => setSearch(id === "vehicles" ? {} : { tab: id }, { replace: false });

  return (
    <>
      <PanelTabs tabs={tabs} value={tab} onChange={go} section={t("admin.nav.fleet")} />
      {groups.isError && (
        <div className="mb-4">
          <Notice tone="error">{t("admin.modules.loadGroupsFailed")}</Notice>
        </div>
      )}
      {tab === "vehicles" && <VehiclesTab groups={groups.data ?? []} canManage={canManage} />}
      {tab === "usage" && <UsageTab groups={groups.data ?? []} />}
      {tab === "expenses" && <ExpensesTab canManage={canManage} />}
      {tab === "groups" && <GroupsTab groups={groups.data ?? []} canManage={canManage} />}
    </>
  );
}
