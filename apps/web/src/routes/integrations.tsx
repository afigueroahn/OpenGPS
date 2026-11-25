// Integrations (module I): the API with its keys, notifications to other systems,
// automations, sensors that are not a GPS, and the exchange of data in files.
// It opens inside the panel, with its full width.
import type { Me, Permission } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, KeyRound, Thermometer, Webhook, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { ModulePanel, type PanelTab, PanelTabs } from "../app/admin/ModulePanel";
import { ApiTab } from "../app/integrations/ApiTab";
import { AutomationsTab } from "../app/integrations/AutomationsTab";
import { DataTab } from "../app/integrations/DataTab";
import { SensorsTab } from "../app/integrations/SensorsTab";
import { WebhooksTab } from "../app/integrations/WebhooksTab";
import { Notice } from "../components/ui";
import { getGroups, getVehicles } from "../lib/api";

type TabId = "api" | "webhooks" | "automations" | "sensors" | "data";
/** `label` and `short` hold the keys of their texts. `short` is the name that fits on a phone; `manage`, the ones only seen by whoever administers the integrations. */
const TABS = [
  { id: "api", label: "admin.modules.integrations.tabs.api", icon: KeyRound, manage: true },
  { id: "webhooks", label: "admin.modules.integrations.tabs.webhooks", short: "admin.modules.integrations.tabs.webhooksShort", icon: Webhook, manage: true },
  { id: "automations", label: "admin.modules.integrations.tabs.automations", short: "admin.modules.integrations.tabs.automationsShort", icon: Zap, manage: true },
  { id: "sensors", label: "admin.modules.integrations.tabs.sensors", icon: Thermometer, manage: false },
  { id: "data", label: "admin.modules.integrations.tabs.data", icon: FileSpreadsheet, manage: false },
] as const satisfies readonly (PanelTab<TabId> & { manage: boolean })[];

export function IntegrationsPage() {
  return <ModulePanel section="integrations">{(me) => <Integrations me={me} />}</ModulePanel>;
}

function Integrations({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: getVehicles });
  const groups = useQuery({ queryKey: ["groups"], queryFn: getGroups });
  const can = (permission: Permission) => me.account.permissions.includes(permission);
  const canManage = can("integrations.manage");
  const modules = me.account.modules;
  const tabs: PanelTab<TabId>[] = TABS.filter((each) => canManage || !each.manage).map((each) => ({ ...each, label: t(each.label), ...("short" in each ? { short: t(each.short) } : {}) }));
  const first = (tabs[0] as PanelTab<TabId>).id;
  const wanted = search.get("tab") as TabId | null;
  const tab = tabs.some((each) => each.id === wanted) ? (wanted as TabId) : first;
  const go = (id: TabId) => setSearch(id === first ? {} : { tab: id }, { replace: false });
  const named = (vehicles.data ?? []).map((v) => ({ id: v.id, name: v.name }));

  return (
    <>
      <PanelTabs tabs={tabs} value={tab} onChange={go} section={t("admin.nav.integrations")} />
      {(vehicles.isError || groups.isError) && (
        <div className="mb-4">
          <Notice tone="error">{t("admin.modules.loadVehiclesFailed")}</Notice>
        </div>
      )}
      {tab === "api" && <ApiTab />}
      {tab === "webhooks" && <WebhooksTab />}
      {tab === "automations" && <AutomationsTab vehicles={named} groups={groups.data ?? []} modules={modules} />}
      {tab === "sensors" && <SensorsTab vehicles={named} canManage={canManage} />}
      {tab === "data" && <DataTab modules={modules} canManage={canManage} />}
    </>
  );
}
