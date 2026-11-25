// The emails the platform writes, to rewrite them. Each one opens its editor:
// its words in each language, the variables it may use and how it will look.
// What is left as it came is not saved, so a later change in the platform's
// own words still reaches it.
import { LANGUAGES, LANGUAGE_NAME, type Language, type MailTemplateInfo, type MailTemplateText, type MailTemplates, mailTemplateProblem } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { type FormEvent, Fragment, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal, Notice, Spinner } from "../../components/ui";
import { getMailTemplates } from "../../lib/api";
import { sayShared } from "../../lib/i18n";
import { useConfig } from "../../lib/session";
import { Card, inputClass } from "../reports/kit";
import { errorText } from "../widgets";
import { useSaveSection } from "./SettingsTabs";

type Field = keyof MailTemplateText;
const field = clsx(inputClass, "w-full");
const same = (a: MailTemplateText, b: MailTemplateText) => a.subject === b.subject && a.heading === b.heading && a.body === b.body && a.action === b.action;

/** The list of emails. `current` is what the console already rewrote. */
export function MailTemplatesCard({ current }: { current: MailTemplates }) {
  const { t } = useTranslation();
  const templates = useQuery({ queryKey: ["admin", "mail-templates"], queryFn: getMailTemplates, staleTime: Infinity });
  const [open, setOpen] = useState<MailTemplateInfo | null>(null);
  return (
    <Card title={t("admin.settings.mailTemplates.title")} note={t("admin.settings.mailTemplates.note")}>
      {templates.isError ? (
        <Notice tone="error">{errorText(templates.error)}</Notice>
      ) : !templates.data ? (
        <div className="flex h-24 items-center justify-center text-muted">
          <Spinner />
        </div>
      ) : (
        <ul className="-my-1 divide-y divide-line">
          {templates.data.map((template) => {
            const name = t(`admin.settings.mailTemplates.items.${template.id}.name`);
            const custom = LANGUAGES.some((l) => current[template.id]?.[l]);
            return (
              <li key={template.id}>
                <button
                  type="button"
                  onClick={() => setOpen(template)}
                  aria-label={t("admin.settings.mailTemplates.edit", { name })}
                  className="group flex w-full items-center gap-3 py-3 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{name}</span>
                      {custom && <span className="rounded-full bg-moving/15 px-2 py-0.5 text-[11.5px] font-medium text-signal-ink">{t("admin.settings.mailTemplates.custom")}</span>}
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-muted">{t(`admin.settings.mailTemplates.items.${template.id}.note`)}</span>
                  </span>
                  <ChevronRight size={18} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={open !== null} onClose={() => setOpen(null)} title={open ? t(`admin.settings.mailTemplates.items.${open.id}.name`) : ""} wide>
        {open && <TemplateEditor template={open} current={current} onDone={() => setOpen(null)} />}
      </Modal>
    </Card>
  );
}

function TemplateEditor({ template, current, onDone }: { template: MailTemplateInfo; current: MailTemplates; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const appName = useConfig().data?.appName ?? "";
  const save = useSaveSection("mailTemplates");
  const start = () => Object.fromEntries(LANGUAGES.map((l) => [l, current[template.id]?.[l] ?? template.defaults[l]])) as Record<Language, MailTemplateText>;
  const [drafts, setDrafts] = useState(start);
  // It opens in the language of the screen, which is the one most likely to be checked.
  const [language, setLanguage] = useState<Language>(LANGUAGES.find((l) => l === i18n.resolvedLanguage) ?? LANGUAGES[0]);
  const [problem, setProblem] = useState<string | null>(null);
  // The field that last had the cursor, so a variable goes where it was.
  const focused = useRef<{ field: Field; element: HTMLInputElement | HTMLTextAreaElement } | null>(null);

  const draft = drafts[language];
  const dirty = LANGUAGES.some((l) => !same(drafts[l], start()[l]));
  const set = (key: Field, value: string) => {
    save.reset();
    setProblem(null);
    setDrafts((d) => ({ ...d, [language]: { ...d[language], [key]: value } }));
  };
  const insert = (variable: string) => {
    const token = `{{${variable}}}`;
    const at = focused.current;
    const key: Field = at?.field ?? "body";
    const text = draft[key];
    const from = at?.element.selectionStart ?? text.length;
    const to = at?.element.selectionEnd ?? text.length;
    set(key, text.slice(0, from) + token + text.slice(to));
    // The cursor stays after what was put in.
    requestAnimationFrame(() => {
      if (!at) return;
      at.element.focus();
      at.element.setSelectionRange(from + token.length, from + token.length);
    });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    for (const l of LANGUAGES) {
      const found = mailTemplateProblem(template.id, drafts[l]);
      if (found) {
        setLanguage(l);
        setProblem(t("admin.settings.mailTemplates.problemIn", { language: LANGUAGE_NAME[l], problem: sayShared(found) }));
        return;
      }
    }
    // What is as it came is not kept: it follows the platform's words.
    const mine = Object.fromEntries(LANGUAGES.filter((l) => !same(drafts[l], template.defaults[l])).map((l) => [l, drafts[l]]));
    const { [template.id]: _before, ...others } = current;
    save.mutate({ ...others, ...(Object.keys(mine).length > 0 ? { [template.id]: mine } : {}) }, { onSuccess: onDone });
  };
  const track = (key: Field) => ({
    onFocus: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      focused.current = { field: key, element: e.currentTarget };
    },
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <p className="text-[14px] leading-relaxed text-muted">{t(`admin.settings.mailTemplates.items.${template.id}.note`)}</p>

      <div role="group" aria-label={t("admin.settings.mailTemplates.language")} className="inline-flex rounded-[10px] bg-canvas p-1">
        {LANGUAGES.map((l) => {
          const custom = !same(drafts[l], template.defaults[l]);
          return (
            <button
              key={l}
              type="button"
              aria-pressed={language === l}
              aria-label={custom ? t("admin.settings.mailTemplates.customLanguage", { language: LANGUAGE_NAME[l] }) : LANGUAGE_NAME[l]}
              onClick={() => {
                focused.current = null;
                setLanguage(l);
              }}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[13.5px] font-medium transition-colors",
                language === l ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink",
              )}
            >
              {LANGUAGE_NAME[l]}
              {custom && <span className="h-1.5 w-1.5 rounded-full bg-moving" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      <div className="space-y-4">
        <Label text={t("admin.settings.mailTemplates.subject")}>
          <input className={field} value={draft.subject} maxLength={200} spellCheck onChange={(e) => set("subject", e.target.value)} {...track("subject")} />
        </Label>
        <Label text={t("admin.settings.mailTemplates.heading")}>
          <input className={field} value={draft.heading} maxLength={200} spellCheck onChange={(e) => set("heading", e.target.value)} {...track("heading")} />
        </Label>
        <Label text={t("admin.settings.mailTemplates.body")} note={t("admin.settings.mailTemplates.bodyNote")}>
          <textarea className={clsx(field, "min-h-[132px] resize-y py-2.5 leading-relaxed")} value={draft.body} maxLength={4000} spellCheck onChange={(e) => set("body", e.target.value)} {...track("body")} />
        </Label>
        {template.action && (
          <Label text={t("admin.settings.mailTemplates.action")} note={t("admin.settings.mailTemplates.actionNote")}>
            <input className={field} value={draft.action} maxLength={80} spellCheck onChange={(e) => set("action", e.target.value)} {...track("action")} />
          </Label>
        )}
      </div>

      <div>
        <p className="text-[13px] font-medium text-ink-3">{t("admin.settings.mailTemplates.variables")}</p>
        <p className="mt-0.5 text-[12.5px] text-muted">{t("admin.settings.mailTemplates.variablesNote")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {template.variables.map((v) => (
            <button
              key={v}
              type="button"
              // The field keeps the cursor: the variable goes where it was.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(v)}
              title={t(`admin.settings.mailTemplates.variable.${v}`)}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-line bg-surface px-2.5 py-1 text-left text-[12.5px] hover:border-faint"
            >
              <code className="font-mono text-ink">{`{{${v}}}`}</code>
              <span className="text-muted">{t(`admin.settings.mailTemplates.variable.${v}`)}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-[13px] font-medium text-ink-3">{t("admin.settings.mailTemplates.preview")}</p>
        <Preview text={draft} appName={appName} action={template.action} />
      </div>

      {problem && <Notice tone="error">{problem}</Notice>}
      {save.isError && <Notice tone="error">{errorText(save.error)}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={save.isPending} disabled={!dirty}>
          {t("common.save")}
        </Button>
        {!same(draft, template.defaults[language]) && (
          <Button
            type="button"
            variant="ghost"
            title={t("admin.settings.mailTemplates.restoreNote", { language: LANGUAGE_NAME[language] })}
            onClick={() => {
              save.reset();
              setProblem(null);
              setDrafts((d) => ({ ...d, [language]: template.defaults[language] }));
            }}
          >
            {t("admin.settings.mailTemplates.restore")}
          </Button>
        )}
        {dirty && <span className="text-[13px] text-muted">{t("admin.settings.unsaved")}</span>}
      </div>
    </form>
  );
}

function Label({ text, note, children }: { text: string; note?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink-3">{text}</span>
      {children}
      {note && <span className="mt-1 block text-[12.5px] text-muted">{note}</span>}
    </label>
  );
}

/** The words with their variables marked; the platform's name already in place, as it will go out. */
function Words({ text, appName }: { text: string; appName: string }) {
  return (
    <>
      {text.split(/(\{\{[^{}]*\}\})/g).map((part, i) => {
        const name = part.match(/^\{\{\s*(\w+)\s*\}\}$/)?.[1];
        if (name === "app" && appName) return <Fragment key={i}>{appName}</Fragment>;
        if (part.startsWith("{{") && part.endsWith("}}")) {
          return (
            <mark key={i} className="rounded bg-idle/20 px-1 font-mono text-[0.92em] text-inherit">
              {part}
            </mark>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

/** How the email will look: the same frame every email goes in. */
function Preview({ text, appName, action }: { text: MailTemplateText; appName: string; action: boolean }) {
  return (
    <div className="rounded-[12px] bg-[#f4f5f7] p-4 text-[#1c2430]">
      <p className="mb-3 truncate border-b border-black/10 pb-2 text-[13px] font-semibold">
        <Words text={text.subject} appName={appName} />
      </p>
      <div className="rounded-[10px] bg-white p-5">
        <p className="pb-3 text-[13px] font-semibold text-[#0f5fd7]">{appName}</p>
        <p className="pb-2 text-[18px] font-semibold leading-snug">
          <Words text={text.heading} appName={appName} />
        </p>
        <p className="whitespace-pre-line text-[14px] leading-relaxed">
          <Words text={text.body} appName={appName} />
        </p>
        {action && text.action && (
          <span className="mt-4 inline-block rounded-[8px] bg-[#0f5fd7] px-4 py-2.5 text-[14px] font-semibold text-white">
            <Words text={text.action} appName={appName} />
          </span>
        )}
      </div>
    </div>
  );
}
