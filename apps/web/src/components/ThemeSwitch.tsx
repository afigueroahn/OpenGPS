// The color mode chooser: the device's, light or dark. The choice is saved
// with the person's settings when they are signed in.
import type { ThemeMode } from "@opengps/shared";
import clsx from "clsx";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { saveSettings } from "../lib/api";
import { setMode, useTheme } from "../lib/theme";

const OPTIONS: { id: ThemeMode; icon: typeof Sun }[] = [
  { id: "system", icon: Monitor },
  { id: "light", icon: Sun },
  { id: "dark", icon: Moon },
];

export function ThemeSwitch({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { mode } = useTheme();
  const choose = (next: ThemeMode) => {
    setMode(next);
    void saveSettings({ theme: next }).catch(() => {});
  };
  return (
    <div className={clsx("flex gap-1 rounded-[10px] bg-canvas p-1", className)} role="group" aria-label={t("theme.label")}>
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={mode === o.id}
          onClick={() => choose(o.id)}
          className={clsx("flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium", mode === o.id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}
        >
          <o.icon size={14} aria-hidden="true" /> {t(`theme.${o.id}`)}
        </button>
      ))}
    </div>
  );
}
