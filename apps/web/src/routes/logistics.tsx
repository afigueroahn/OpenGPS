// Routes and logistics (module H): dispatch, planned routes and points of
// interest. It opens inside the panel, with its full width.
import type { Me, Permission } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Route, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { ModulePanel, type PanelTab, PanelTabs } from "../app/admin/ModulePanel";
import { DispatchTab } from "../app/routes/DispatchTab";
import { PlansTab } from "../app/routes/PlansTab";
import { PoisTab } from "../app/routes/PoisTab";
import { Notice } from "../components/ui";
import { getVehicles } from "../lib/api";

type TabId = "dispatch" | "routes" | "places";
/** `label` holds the key of its text. */
const TABS = [
  { id: "dispatch", label: "admin.modules.routes.tabs.dispatch", icon: Send },
  { id: "routes", label: "admin.modules.routes.tabs.routes", icon: Route },
  { id: "places", label: "admin.modules.routes.tabs.places", icon: MapPin },
] as const satisfies readonly PanelTab<TabId>[];

export function RoutesPage() {
  return <ModulePanel section="routes">{(me) => <Logistics me={me} />}</ModulePanel>;
}

function Logistics({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  // Each vehicle's position is refreshed: dispatch shows it on the map.
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: getVehicles, refetchInterval: 20_000 });
  const can = (permission: Permission) => me.account.permissions.includes(permission);
  const canManage = can("geofences.manage");
  const wanted = search.get("tab") as TabId | null;
  const tab = TABS.some((each) => each.id === wanted) ? (wanted as TabId) : "dispatch";
  const go = (id: TabId) => setSearch(id === "dispatch" ? {} : { tab: id }, { replace: false });
  const tabs: PanelTab<TabId>[] = TABS.map((each) => ({ ...each, label: t(each.label) }));

  return (
    <>
      <PanelTabs tabs={tabs} value={tab} onChange={go} section={t("admin.nav.routes")} />
      {vehicles.isError && (
        <div className="mb-4">
          <Notice tone="error">{t("admin.modules.loadVehiclesFailed")}</Notice>
        </div>
      )}
      {tab === "dispatch" && <DispatchTab vehicles={vehicles.data ?? []} canManage={canManage} />}
      {tab === "routes" && <PlansTab vehicles={vehicles.data ?? []} canManage={canManage} />}
      {tab === "places" && <PoisTab vehicles={vehicles.data ?? []} canManage={canManage} />}
    </>
  );
}
