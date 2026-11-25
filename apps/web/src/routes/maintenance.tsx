// Maintenance (module E): what needs attention, work orders,
// service plans and the catalogs of workshops and parts. It opens inside the
// panel, with its full width.
import type { Me, Permission } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, CalendarCheck, ClipboardList, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { ModulePanel, type PanelTab, PanelTabs } from "../app/admin/ModulePanel";
import { CatalogsTab } from "../app/maintenance/CatalogsTab";
import type { OrderDraft } from "../app/maintenance/OrderDialog";
import { OrdersTab } from "../app/maintenance/OrdersTab";
import { PendingTab } from "../app/maintenance/PendingTab";
import { PlansTab } from "../app/maintenance/PlansTab";
import { Notice } from "../components/ui";
import { getVehicles } from "../lib/api";

type TabId = "pending" | "orders" | "plans" | "catalogs";
/** `label` holds the key of its text. */
const TABS = [
  { id: "pending", label: "admin.modules.maintenance.tabs.pending", icon: TriangleAlert },
  { id: "orders", label: "admin.modules.maintenance.tabs.orders", icon: ClipboardList },
  { id: "plans", label: "admin.modules.maintenance.tabs.plans", icon: CalendarCheck },
  { id: "catalogs", label: "admin.modules.maintenance.tabs.catalogs", icon: BookOpen },
] as const satisfies readonly PanelTab<TabId>[];

export function MaintenancePage() {
  return <ModulePanel section="maintenance">{(me) => <Maintenance me={me} />}</ModulePanel>;
}

function Maintenance({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: getVehicles });
  /** Order that opens on arriving from a pending service. */
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const can = (permission: Permission) => me.account.permissions.includes(permission);
  const canManage = can("vehicles.manage");
  const wanted = search.get("tab") as TabId | null;
  const tab = TABS.some((each) => each.id === wanted) ? (wanted as TabId) : "pending";
  const list = (vehicles.data ?? []).map((v) => ({ id: v.id, name: v.name }));
  const go = (id: TabId) => setSearch(id === "pending" ? {} : { tab: id }, { replace: false });
  const tabs: PanelTab<TabId>[] = TABS.map((each) => ({ ...each, label: t(each.label) }));

  return (
    <>
      <PanelTabs tabs={tabs} value={tab} onChange={go} section={t("admin.nav.maintenance")} />
      {vehicles.isError && (
        <div className="mb-4">
          <Notice tone="error">{t("admin.modules.loadVehiclesFailed")}</Notice>
        </div>
      )}
      {tab === "pending" && (
        <PendingTab
          vehicles={list}
          canManage={canManage}
          onOrder={(next) => {
            setDraft(next);
            go("orders");
          }}
        />
      )}
      {tab === "orders" && <OrdersTab vehicles={list} canManage={canManage} draft={draft} onDraftUsed={() => setDraft(null)} />}
      {tab === "plans" && <PlansTab vehicles={list} canManage={canManage} />}
      {tab === "catalogs" && <CatalogsTab canManage={canManage} />}
    </>
  );
}
