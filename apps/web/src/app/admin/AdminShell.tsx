// Frame of the administration panel: the menu on the left, a bar on top with
// where you are, the color mode and your user, and the section in the middle.
// On a phone the menu is a drawer.
import type { Me } from "@opengps/shared";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, LogOut, Menu, Moon, PanelLeft, Sun, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Avatar } from "../../components/Avatar";
import { Logo } from "../../components/ui";
import { auth, saveSettings } from "../../lib/api";
import { adoptLanguage } from "../../lib/i18n";
import { useConfig } from "../../lib/session";
import { adoptMode, setMode, useTheme } from "../../lib/theme";
import { GROUPS, type Section, pathOf } from "./sections";

const COLLAPSED_KEY = "admin-menu-collapsed";

export function AdminShell({ me, sections, current, children }: { me: Me; sections: Section[]; current: Section; children: ReactNode }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { dark } = useTheme();
  // On a phone the menu opens over the page; on a large screen it can be folded to its icons.
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [userMenu, setUserMenu] = useState(false);
  const userRoot = useRef<HTMLDivElement>(null);

  useEffect(() => setDrawer(false), [current.id]);
  // The color mode and the language saved with the person follow them to this browser.
  useEffect(() => adoptMode(me.settings.theme), [me.settings.theme]);
  useEffect(() => void adoptLanguage(me.settings.language), [me.settings.language]);
  useEffect(() => {
    if (!userMenu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !userRoot.current?.contains(e.target as Node)) setUserMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [userMenu]);

  const fold = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Without storage the menu simply opens unfolded next time.
    }
  };
  const flipTheme = () => {
    const next = dark ? "light" : "dark";
    setMode(next);
    void saveSettings({ theme: next }).catch(() => {});
  };
  const signOut = async () => {
    await auth.signOut().catch(() => {});
    queryClient.clear();
    window.location.assign("/login");
  };
  const nav = (compact: boolean) => (
    <nav aria-label={t("admin.menu.sections")} className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {GROUPS.map((group) => {
        const items = sections.filter((s) => s.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group}>
            {!compact && <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{t(`admin.groups.${group}`)}</p>}
            <ul className="space-y-0.5">
              {items.map((s) => (
                <li key={s.id}>
                  <Link
                    to={pathOf(s)}
                    aria-current={s.id === current.id ? "page" : undefined}
                    title={compact ? t(`admin.nav.${s.id}`) : undefined}
                    className={clsx(
                      "flex h-10 items-center gap-3 rounded-[10px] text-[14.5px] font-medium transition-colors",
                      compact ? "justify-center px-0" : "px-3",
                      s.id === current.id ? "bg-ink/[0.07] text-ink" : "text-ink-3 hover:bg-ink/[0.04] hover:text-ink",
                    )}
                  >
                    <s.icon size={18} className={clsx("shrink-0", s.id === current.id ? "text-signal-ink" : "text-muted")} aria-hidden="true" />
                    {!compact && <span className="truncate">{t(`admin.nav.${s.id}`)}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  const brand = (compact: boolean) => (
    <div className={clsx("flex h-[60px] shrink-0 items-center border-b border-line", compact ? "justify-center px-0" : "px-5")}>
      <Logo iconOnly={compact} />
    </div>
  );

  const appVersion = useConfig().data?.version;
  const version = appVersion ? t("common.version", { version: appVersion }) : "";
  // Only the version goes at the foot; with the menu folded, just its number.
  const versionFoot = (compact: boolean) =>
    appVersion && (
      <p className="num shrink-0 border-t border-line px-2 py-3 text-center text-[12px] text-faint" title={compact ? version : undefined}>
        {compact ? appVersion : version}
      </p>
    );

  const iconButton = "flex h-9 w-9 items-center justify-center rounded-[10px] text-ink-3 hover:bg-ink/[0.06] hover:text-ink";

  return (
    <div className="flex h-full bg-canvas">
      {/* Large screens: the menu is part of the page. */}
      <aside className={clsx("hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] lg:flex", collapsed ? "w-[68px]" : "w-[264px]")}>
        {brand(collapsed)}
        {nav(collapsed)}
        {versionFoot(collapsed)}
      </aside>

      {/* Phones: the menu slides over the page. */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label={t("admin.menu.close")} className="absolute inset-0 bg-[rgb(16_22_35/0.55)]" onClick={() => setDrawer(false)} />
          <aside className="relative flex h-full w-[280px] max-w-[85vw] flex-col bg-surface shadow-2xl">
            <button type="button" aria-label={t("admin.menu.close")} onClick={() => setDrawer(false)} className={clsx(iconButton, "absolute right-2 top-3")}>
              <X size={18} />
            </button>
            {brand(false)}
            {nav(false)}
            {versionFoot(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[60px] shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:px-5">
          <button type="button" aria-label={t("admin.menu.open")} onClick={() => setDrawer(true)} className={clsx(iconButton, "lg:hidden")}>
            <Menu size={18} />
          </button>
          <button type="button" aria-label={t(collapsed ? "admin.menu.expand" : "admin.menu.collapse")} aria-pressed={collapsed} onClick={fold} className={clsx(iconButton, "hidden lg:flex")}>
            <PanelLeft size={18} />
          </button>
          <p className="min-w-0 flex-1 truncate pl-1 text-[14.5px] text-muted" aria-label={`${t(`admin.groups.${current.group}`)}: ${t(`admin.nav.${current.id}`)}`}>
            {/* On a phone the section name is already the page heading right below. */}
            <span className="font-medium text-ink sm:hidden">{t(`admin.groups.${current.group}`)}</span>
            <span className="hidden sm:inline">
              {t(`admin.groups.${current.group}`)} <span className="px-1.5 text-faint">/</span>
              <span className="font-medium text-ink">{t(`admin.nav.${current.id}`)}</span>
            </span>
          </p>
          <Link to="/" className="hidden h-9 items-center gap-1.5 rounded-[10px] px-3 text-sm font-medium text-ink-3 hover:bg-ink/[0.06] hover:text-ink sm:inline-flex">
            <ArrowLeft size={15} aria-hidden="true" /> {t("admin.back")}
          </Link>
          <button type="button" onClick={flipTheme} aria-label={t(dark ? "admin.themeToggle.toLight" : "admin.themeToggle.toDark")} title={t(dark ? "admin.themeToggle.toLight" : "admin.themeToggle.toDark")} className={iconButton}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <div ref={userRoot} className="relative">
            <button
              type="button"
              onClick={() => setUserMenu((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={userMenu}
              aria-label={t("admin.user.menu")}
              className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-ink/[0.08] text-[12.5px] text-ink hover:bg-ink/[0.14]"
            >
              <Avatar name={me.user.name} photoUrl={me.user.photoUrl} className="h-full w-full" />
            </button>
            {userMenu && (
              <div role="menu" className="absolute right-0 top-11 z-30 w-64 rounded-[14px] border border-line bg-surface p-1.5 shadow-2xl">
                <div className="px-3 py-2.5">
                  <p className="truncate text-sm font-semibold text-ink">{me.user.name}</p>
                  <p className="truncate text-[13px] text-muted">{me.user.email}</p>
                </div>
                <Link to="/" role="menuitem" className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-sm font-medium text-ink hover:bg-canvas sm:hidden">
                  <ArrowLeft size={16} aria-hidden="true" /> {t("admin.back")}
                </Link>
                <button type="button" role="menuitem" onClick={() => void signOut()} className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-canvas">
                  <LogOut size={16} aria-hidden="true" /> {t("admin.user.signOut")}
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
            <header className="mb-6">
              <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">{t(`admin.nav.${current.id}`)}</h1>
              <p className="mt-1.5 max-w-[70ch] text-[15px] leading-relaxed text-muted">{t(`admin.lead.${current.id}`)}</p>
            </header>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
