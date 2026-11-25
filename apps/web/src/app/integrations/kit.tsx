// Common pieces of the integrations section: the box for a newly
// created key, a code block to copy and the event list to choose from.
import { ALERT_EVENTS, EVENT_TYPES, type EventType } from "@opengps/shared";
import { Check, Copy, KeyRound } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentLanguage } from "../../lib/i18n";

export const select = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
export const label = "mb-1.5 block text-[13px] font-medium text-ink-3";
export const small = "h-10 min-w-0 rounded-[10px] border border-line bg-surface px-2.5 text-[14px] text-ink placeholder:text-faint focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* no clipboard permission: the text stays visible to copy by hand */
    }
  };
  return { copied, copy };
}

/** A technical text (a command, an address) with its copy button. */
export function Code({ children, wrap }: { children: string; wrap?: boolean }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy(children);
  return (
    <div className="on-dark relative rounded-[10px] bg-panel text-white">
      <pre className={`num overflow-x-auto px-3.5 py-3 pr-12 text-[12.5px] leading-relaxed ${wrap ? "whitespace-pre-wrap break-all" : ""}`}>{children}</pre>
      <button type="button" onClick={copy} aria-label={t("common.copy")} title={t("common.copy")} className="absolute right-1.5 top-1.5 rounded-lg bg-panel p-2 text-white/60 hover:bg-panel-2 hover:text-white">
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

/** A key that was just created: this is the only time it is seen in full. */
export function SecretBox({ title, secret, children }: { title: string; secret: string; children?: React.ReactNode }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy(secret);
  return (
    <div className="space-y-2.5 rounded-[12px] border border-idle/40 bg-idle/10 px-4 py-3.5" role="status">
      <p className="flex items-center gap-2 text-[14.5px] font-semibold text-ink">
        <KeyRound size={16} aria-hidden="true" /> {title}
      </p>
      <p className="text-[13.5px] leading-relaxed text-ink-3">{t("integrations.secret.note")}</p>
      <button type="button" onClick={copy} className="flex w-full items-center justify-between gap-3 rounded-[10px] bg-panel px-3.5 py-2.5 text-left text-white hover:bg-panel-2">
        <span className="num min-w-0 break-all text-[13.5px]">{secret}</span>
        <span className="shrink-0 text-[12.5px] text-white/70">{copied ? t("integrations.secret.copied") : t("common.copy")}</span>
      </button>
      {children}
    </div>
  );
}

/** List of events to check: first those that need attention, then the rest, in alphabetical order. */
export function EventPicker({ value, onChange, idPrefix }: { value: EventType[]; onChange: (next: EventType[]) => void; idPrefix: string }) {
  const { t } = useTranslation();
  const sorted = useMemo(() => {
    const byLabel = (a: EventType, b: EventType) => t(`shared.event.${a}`).localeCompare(t(`shared.event.${b}`), currentLanguage());
    return [...EVENT_TYPES.filter((e) => ALERT_EVENTS.includes(e)).sort(byLabel), ...EVENT_TYPES.filter((e) => !ALERT_EVENTS.includes(e)).sort(byLabel)];
  }, [t]);
  const picked = new Set(value);
  const toggle = (type: EventType) => onChange(picked.has(type) ? value.filter((e) => e !== type) : [...value, type]);
  return (
    <ul className="max-h-[30dvh] divide-y divide-line overflow-y-auto rounded-[10px] border border-line" aria-label={t("integrations.eventPicker.label")}>
      {sorted.map((type) => (
        <li key={type}>
          <label htmlFor={`${idPrefix}-${type}`} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-canvas">
            <input id={`${idPrefix}-${type}`} type="checkbox" checked={picked.has(type)} onChange={() => toggle(type)} className="h-4 w-4 accent-ink" />
            <span className="min-w-0 flex-1 truncate">{t(`shared.event.${type}`)}</span>
            {ALERT_EVENTS.includes(type) && <span className="shrink-0 text-[11.5px] text-muted">{t("integrations.eventPicker.alert")}</span>}
          </label>
        </li>
      ))}
    </ul>
  );
}
