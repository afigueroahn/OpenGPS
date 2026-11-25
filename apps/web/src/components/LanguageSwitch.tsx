// The language chooser. The choice is kept in this browser and, for whoever
// is signed in, with their settings: it is also the language their emails and
// notifications are written in. The page loads again so that every screen,
// date and number is said in the new language.
import { LANGUAGES, LANGUAGE_NAME, type Language } from "@opengps/shared";
import clsx from "clsx";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { saveSettings } from "../lib/api";
import { currentLanguage, setLanguage } from "../lib/i18n";

export function LanguageSwitch({ className, signedIn = true, tone = "light" }: { className?: string; /** Whether there is a person to save the choice for. */ signedIn?: boolean; /** "dark" on the panels that are dark in both color modes. */ tone?: "light" | "dark" }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(currentLanguage);
  const choose = async (next: Language) => {
    if (next === current) return;
    setCurrent(next);
    setLanguage(next);
    if (signedIn) await saveSettings({ language: next }).catch(() => {});
    window.location.reload();
  };
  const dark = tone === "dark";
  return (
    <div className={clsx("flex gap-1 rounded-[10px] p-1", dark ? "bg-white/[0.08]" : "bg-canvas", className)} role="group" aria-label={t("language.label")}>
      {LANGUAGES.map((language) => (
        <button
          key={language}
          type="button"
          lang={language}
          aria-pressed={current === language}
          onClick={() => void choose(language)}
          className={clsx(
            "flex h-8 flex-1 items-center justify-center rounded-lg px-3 text-[12.5px] font-medium",
            current === language ? (dark ? "bg-white/[0.16] text-white" : "bg-surface text-ink shadow-sm") : dark ? "text-white/60 hover:text-white" : "text-muted hover:text-ink",
          )}
        >
          {LANGUAGE_NAME[language]}
        </button>
      ))}
    </div>
  );
}
