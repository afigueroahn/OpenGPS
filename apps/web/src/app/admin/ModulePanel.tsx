// A module's page inside the panel: the same menu on the left and bar on top
// as the administration, the module's name and what it is for, and its tabs.
// Whoever has no session goes to sign in and comes back; an account without
// the module does not see it.
import type { Me } from "@opengps/shared";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { Spinner } from "../../components/ui";
import { useMe } from "../../lib/session";
import { AdminShell } from "./AdminShell";
import { SECTIONS, type SectionId, pathOf, viewerOf } from "./sections";

export function ModulePanel({ section, children }: { section: SectionId; children: (me: Me) => ReactNode }) {
  const me = useMe();
  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner size={24} />
      </div>
    );
  }
  const own = SECTIONS.find((s) => s.id === section);
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(own ? pathOf(own) : "/")}`} replace />;
  const viewer = viewerOf(me.data);
  const sections = SECTIONS.filter((s) => s.show(viewer));
  const current = sections.find((s) => s.id === section);
  // Without the module, the section does not exist for this account.
  if (!current) return <Navigate to="/" replace />;
  return (
    <AdminShell me={me.data} sections={sections} current={current}>
      {children(me.data)}
    </AdminShell>
  );
}

export interface PanelTab<T extends string> {
  id: T;
  label: string;
  /** A shorter name for a phone, when the full one does not fit. */
  short?: string;
  icon: LucideIcon;
}

/** The tabs of a module, under its heading. On a phone they scroll sideways. */
export function PanelTabs<T extends string>({ tabs, value, onChange, section }: { tabs: PanelTab<T>[]; value: T; onChange: (id: T) => void; section: string }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("admin.menu.tabs", { section })} className="-mx-4 mb-5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
      <div className="flex w-max gap-1 rounded-[12px] border border-line bg-surface p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={value === tab.id ? "page" : undefined}
            onClick={() => onChange(tab.id)}
            className={clsx(
              "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 text-[13.5px] font-medium transition-colors sm:px-3.5 sm:text-sm",
              value === tab.id ? "bg-ink/[0.07] text-ink" : "text-ink-3 hover:bg-ink/[0.04] hover:text-ink",
            )}
          >
            <tab.icon size={15} className={clsx("shrink-0", value === tab.id ? "text-signal-ink" : "text-muted")} aria-hidden="true" />
            {tab.short ? (
              <>
                <span className="sm:hidden">{tab.short}</span>
                <span className="hidden sm:inline">{tab.label}</span>
              </>
            ) : (
              tab.label
            )}
          </button>
        ))}
      </div>
    </nav>
  );
}
