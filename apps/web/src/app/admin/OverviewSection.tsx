// First screen of the administration panel: the account at a glance, a way
// into each section and the latest activity.
import { ALL_MODULES, type Me } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { getAccountSummary, getAdminStats } from "../../lib/api";
import { currentLanguage } from "../../lib/i18n";
import { Stats } from "./AccountsSection";
import { ActivitySection } from "./ActivitySection";
import { type Section, pathOf } from "./sections";

export function OverviewSection({ me, sections }: { me: Me; sections: Section[] }) {
  const { t } = useTranslation();
  const summary = useQuery({ queryKey: ["account", "summary"], queryFn: getAccountSummary, refetchInterval: 60_000 });
  const platform = useQuery({ queryKey: ["admin", "stats"], queryFn: getAdminStats, enabled: me.user.platformAdmin, refetchInterval: 60_000 });
  const number = new Intl.NumberFormat(currentLanguage());
  const s = summary.data;
  const tiles = [
    { label: t("admin.overview.stats.vehicles"), value: s ? number.format(s.vehicles) : " ", note: s ? t("admin.overview.stats.vehiclesNote", { count: s.reportingNow }) : "" },
    { label: t("admin.overview.stats.users"), value: s ? number.format(s.users) : " ", note: t("admin.overview.stats.usersNote") },
    { label: t("admin.overview.stats.events"), value: s ? number.format(s.events24h) : " ", note: t("admin.overview.stats.eventsNote") },
    { label: t("admin.overview.stats.modules"), value: number.format(me.account.modules.length), note: t("admin.overview.stats.modulesNote", { total: ALL_MODULES.length }) },
  ];
  const shortcuts = sections.filter((x) => x.id !== "overview");
  const seesActivity = sections.some((x) => x.id === "activity");

  return (
    <div className="space-y-6">
      <section aria-label={t("admin.overview.workspace")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-[14px] border border-line bg-surface px-4 py-4">
            <p className="text-[13px] font-medium text-muted">{tile.label}</p>
            <p className="num mt-3 text-[30px] font-semibold leading-none tracking-tight text-ink">{tile.value}</p>
            <p className="mt-2.5 text-[12.5px] text-muted">{tile.note}</p>
          </div>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="rounded-[14px] border border-line bg-surface p-5">
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{t("admin.overview.shortcuts.title")}</h2>
          <p className="mt-0.5 text-[13.5px] text-muted">{t("admin.overview.shortcuts.lead")}</p>
          <ul className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {shortcuts.map((x) => (
              <li key={x.id}>
                <Link to={pathOf(x)} className="group flex min-h-[60px] items-center gap-3 rounded-[12px] border border-line px-3.5 py-2 hover:border-faint hover:bg-canvas">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-canvas text-ink-3">
                    <x.icon size={17} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 text-[14.5px] font-medium leading-snug text-ink">{t(`admin.nav.${x.id}`)}</span>
                  <ArrowRight size={16} className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {seesActivity && (
          <section className="rounded-[14px] border border-line bg-surface p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[17px] font-semibold tracking-tight text-ink">{t("admin.overview.activity.title")}</h2>
                <p className="mt-0.5 text-[13.5px] text-muted">{t("admin.overview.activity.lead")}</p>
              </div>
              <Link to="/admin/activity" className="shrink-0 text-[13.5px] font-medium text-signal-ink hover:underline">
                {t("admin.overview.activity.all")}
              </Link>
            </div>
            <div className="mt-3">
              <ActivitySection latest={6} />
            </div>
          </section>
        )}
      </div>

      {me.user.platformAdmin && (
        <section>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{t("admin.overview.platform.title")}</h2>
          <p className="mb-3 mt-0.5 text-[13.5px] text-muted">{t("admin.overview.platform.lead")}</p>
          <Stats stats={platform.data} />
        </section>
      )}
    </div>
  );
}
