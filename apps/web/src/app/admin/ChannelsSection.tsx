// The channels the platform notifies through. Whoever runs it connects them
// once, here; every account then uses the ones that are on. One button per
// channel opens its settings: its switch, what it needs and a test message
// with what is saved. Email holds the mail server the platform sends with;
// the custom channel, the address of another system with its headers and its
// body, written with variables.
import {
  CUSTOM_METHODS,
  CUSTOM_VARIABLES,
  type ChannelSettings,
  type ChannelSettingsInput,
  type CustomHeader,
  type CustomMethod,
  NOTIFY_CHANNELS,
  type NotifyChannel,
  PERSON_VARIABLES,
  addressProblem,
} from "@opengps/shared";
import { useMutation } from "@tanstack/react-query";
import { sayShared } from "../../lib/i18n";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Button, Modal, Notice, Spinner } from "../../components/ui";
import { testChannel } from "../../lib/notifications";
import { inputClass } from "../reports/kit";
import { errorText } from "../widgets";
import { MailTemplatesCard } from "./MailTemplates";
import { MailForm, Row, Switch, useSaveSection, useSettings } from "./SettingsTabs";
import { ChannelBadge, HeadersEditor, headersToSend } from "./notify";

const field = clsx(inputClass, "w-full");

/** What is saved when nothing of a channel's keys is touched: everything as it is, without the keys. */
function inputOf(c: ChannelSettings): ChannelSettingsInput {
  const { hasToken: _smsKey, ...sms } = c.sms;
  const { headerNames: _headers, ...webhook } = c.webhook;
  return { email: c.email, sms, webhook, push: c.push };
}

/** On, off, or on but still missing what it needs to send. */
function statusOf(c: ChannelSettings, channel: NotifyChannel): "on" | "off" | "missing" {
  if (!c[channel].enabled) return "off";
  if (channel === "sms" && (!c.sms.hasToken || !c.sms.accountSid || !c.sms.from)) return "missing";
  if (channel === "webhook" && !c.webhook.url) return "missing";
  return "on";
}

export function ChannelsSection({ meEmail }: { meEmail: string }) {
  const { t } = useTranslation();
  const settings = useSettings();
  // The open channel lives in the address, so a link to the email settings opens them.
  const [search, setSearch] = useSearchParams();
  const open = NOTIFY_CHANNELS.find((c) => c === search.get("channel")) ?? null;
  const show = (channel: NotifyChannel | null) => setSearch(channel ? { channel } : {}, { replace: true });

  if (settings.isError) return <Notice tone="error">{errorText(settings.error)}</Notice>;
  if (!settings.data) {
    return (
      <div className="flex h-32 items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }
  const channels = settings.data.channels;
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {NOTIFY_CHANNELS.map((channel) => {
          const status = statusOf(channels, channel);
          return (
            <button
              key={channel}
              type="button"
              onClick={() => show(channel)}
              aria-label={t("admin.channels.configure", { channel: t(`admin.notify.channel.${channel}`) })}
              className="group flex min-h-[148px] flex-col items-start gap-3 rounded-[14px] border border-line bg-surface p-5 text-left transition-colors hover:border-faint"
            >
              <span className="flex w-full items-start justify-between gap-3">
                <ChannelBadge channel={channel} size="lg" muted={status === "off"} />
                <ChevronRight size={18} className="mt-1 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-[16px] font-semibold tracking-tight text-ink">{t(`admin.notify.channel.${channel}`)}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-muted">{t(`admin.channels.${channel}.lead`)}</span>
              </span>
              <span
                className={clsx(
                  "mt-auto inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium",
                  status === "on" && "bg-moving/15 text-signal-ink",
                  status === "off" && "bg-ink/[0.07] text-ink-3",
                  status === "missing" && "bg-danger/10 text-danger",
                )}
              >
                <span className={clsx("h-1.5 w-1.5 rounded-full", status === "on" ? "bg-moving" : status === "off" ? "bg-faint" : "bg-danger")} aria-hidden="true" />
                {t(`admin.channels.status.${status}`)}
              </span>
            </button>
          );
        })}
      </div>

      <Modal open={open !== null} onClose={() => show(null)} title={open ? t(`admin.notify.channel.${open}`) : ""} wide>
        {open === "email" && (
          <ChannelPanel channel="email" current={channels} testTo={meEmail} build={(enabled) => ({ email: { enabled } })} enabled={channels.email.enabled} test={false}>
            <div className="space-y-5">
              <MailForm current={settings.data.mail} meEmail={meEmail} />
              <MailTemplatesCard current={settings.data.mailTemplates} />
            </div>
          </ChannelPanel>
        )}
        {open === "sms" && <SmsPanel current={channels} />}
        {open === "webhook" && <CustomPanel current={channels} />}
        {open === "push" && (
          <ChannelPanel channel="push" current={channels} build={(enabled) => ({ push: { enabled } })} enabled={channels.push.enabled} test={false}>
            <p className="rounded-[12px] bg-canvas px-3.5 py-3 text-[13.5px] leading-relaxed text-ink-3">{t("admin.channels.push.note")}</p>
          </ChannelPanel>
        )}
      </Modal>
    </>
  );
}

/**
 * A channel's settings: its switch, its data and its test. `build` says what
 * of the settings this panel changes; the rest is saved as it was. A channel
 * with fields (`onToggle`) saves with its button; the others save on the switch.
 */
function ChannelPanel(props: {
  channel: NotifyChannel;
  current: ChannelSettings;
  enabled: boolean;
  /** There are changes in the fields that have not been saved. */
  dirty?: boolean;
  build: (enabled: boolean) => Partial<ChannelSettingsInput>;
  /** Where the test goes when nothing is written. */
  testTo?: string;
  /** Whether it offers a test message of its own. */
  test?: boolean;
  onToggle?: (enabled: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { channel, current, dirty = false } = props;
  const save = useSaveSection("channels");
  const [to, setTo] = useState(props.testTo ?? "");
  const [testProblem, setTestProblem] = useState<string | null>(null);
  const test = useMutation({ mutationFn: (address: string) => testChannel(channel, address) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ ...inputOf(current), ...props.build(props.enabled) });
  };
  const toggle = (enabled: boolean) => {
    if (props.onToggle) props.onToggle(enabled);
    else save.mutate({ ...inputOf(current), ...props.build(enabled) });
  };
  // In the custom channel what is written only fills its variables, and may be left empty.
  const optional = channel === "webhook";
  const runTest = () => {
    const problem = optional && !to.trim() ? null : addressProblem(channel, to);
    setTestProblem(problem && sayShared(problem));
    test.reset();
    if (!problem) test.mutate(to.trim());
  };
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <ChannelBadge channel={channel} size="lg" muted={!props.enabled} />
        <p className="min-w-0 flex-1 pt-0.5 text-[14px] leading-relaxed text-muted">{t(`admin.channels.${channel}.lead`)}</p>
      </div>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Row title={t("admin.channels.enableRow")} note={t("admin.channels.enableNote")}>
          <Switch label={t("admin.channels.enableRow")} checked={props.enabled} disabled={save.isPending} onChange={toggle} />
        </Row>
        {props.onToggle && props.children}
        {save.isError && <Notice tone="error">{errorText(save.error)}</Notice>}
        {props.onToggle && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={save.isPending} disabled={!dirty}>
              {t("admin.channels.save")}
            </Button>
            {save.isSuccess && !dirty && <span className="text-[13px] text-signal-ink">{t("admin.channels.saved")}</span>}
            {dirty && <span className="text-[13px] text-muted">{t("admin.channels.unsaved")}</span>}
          </div>
        )}
      </form>
      {/* What has a form of its own (the mail server) goes outside this one. */}
      {!props.onToggle && props.children}
      {props.test !== false && current[channel].enabled && (
        <div className="rounded-[12px] bg-canvas p-3.5">
          <label htmlFor={`test-${channel}`} className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("admin.channels.test.label")}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`test-${channel}`}
              className={clsx(inputClass, "min-w-0 flex-1 basis-56")}
              value={to}
              spellCheck={false}
              autoComplete="off"
              placeholder={t(`admin.channels.test.placeholder.${channel as "email" | "sms" | "webhook"}`)}
              onChange={(e) => {
                setTo(e.target.value);
                setTestProblem(null);
              }}
            />
            <Button type="button" variant="secondary" loading={test.isPending} disabled={dirty || (!optional && !to.trim())} title={dirty ? t("admin.channels.test.saveFirst") : undefined} onClick={runTest}>
              {t("admin.channels.test.send")}
            </Button>
          </div>
          {testProblem && <p className="mt-2 text-[13px] text-danger">{testProblem}</p>}
          {test.isSuccess && <p className="mt-2 text-[13px] text-signal-ink">{t("admin.channels.test.sent", { to: test.data.sentTo })}</p>}
          {test.isError && <p className="mt-2 text-[13px] text-danger">{t("admin.channels.test.failed", { reason: errorText(test.error) })}</p>}
        </div>
      )}
    </div>
  );
}

const capText = (cap: number | null) => (cap === null ? "" : String(cap));
const capOf = (text: string) => (text.trim() === "" ? null : Math.max(1, Number(text.replace(/\D/g, "")) || 1));

function SmsPanel({ current }: { current: ChannelSettings }) {
  const { t } = useTranslation();
  const c = current.sms;
  const start = () => ({ enabled: c.enabled, accountSid: c.accountSid, token: "", from: c.from, cap: capText(c.monthlyCap) });
  const [form, setForm] = useState(start);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when the server returns what was saved
  useEffect(() => setForm(start()), [current]);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const build = (enabled: boolean): Partial<ChannelSettingsInput> => ({
    sms: { enabled, accountSid: form.accountSid.trim(), ...(form.token ? { token: form.token } : {}), from: form.from.trim(), monthlyCap: capOf(form.cap) },
  });
  return (
    <ChannelPanel channel="sms" current={current} enabled={form.enabled} dirty={JSON.stringify(form) !== JSON.stringify(start())} build={build} onToggle={(on) => set("enabled", on)}>
      <Row title={t("admin.channels.sms.account")} note={t("admin.channels.sms.accountNote")} wide>
        <input className={field} spellCheck={false} autoComplete="off" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" value={form.accountSid} onChange={(e) => set("accountSid", e.target.value)} />
      </Row>
      <Row title={t("admin.channels.key.title")} note={t("admin.channels.key.note")} wide>
        <input className={field} type="password" autoComplete="new-password" placeholder={t(c.hasToken ? "admin.channels.key.kept" : "admin.channels.key.empty")} value={form.token} onChange={(e) => set("token", e.target.value)} />
      </Row>
      <Row title={t("admin.channels.sms.from")} note={t("admin.channels.sms.fromNote")} wide>
        <input className={field} spellCheck={false} autoComplete="off" placeholder="+15005550006" value={form.from} onChange={(e) => set("from", e.target.value)} />
      </Row>
      <Row title={t("admin.channels.cap.title")} note={t("admin.channels.cap.note")}>
        <input className={clsx(inputClass, "num w-32")} inputMode="numeric" placeholder={t("admin.channels.cap.none")} aria-label={t("admin.channels.cap.title")} value={form.cap} onChange={(e) => set("cap", e.target.value.replace(/\D/g, ""))} />
      </Row>
    </ChannelPanel>
  );
}

/** The custom channel: how it calls the other system, written with variables that each message fills. */
function CustomPanel({ current }: { current: ChannelSettings }) {
  const { t } = useTranslation();
  const c = current.webhook;
  // The headers saved are kept (null) until they are changed: their values do not come back.
  const start = () => ({ enabled: c.enabled, method: c.method, url: c.url, body: c.body, headers: null as CustomHeader[] | null });
  const [form, setForm] = useState(start);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when the server returns what was saved
  useEffect(() => setForm(start()), [current]);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const url = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  // A variable goes where the cursor was last: the address or the body.
  const last = useRef<"url" | "body">("url");
  const insert = (name: string) => {
    const where = form.method === "GET" ? "url" : last.current;
    const field = where === "url" ? url.current : body.current;
    const text = `{{${name}}}`;
    const value = form[where];
    const at = field?.selectionStart ?? value.length;
    const until = field?.selectionEnd ?? at;
    set(where, value.slice(0, at) + text + value.slice(until));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(at + text.length, at + text.length);
    });
  };
  const build = (enabled: boolean): Partial<ChannelSettingsInput> => ({
    webhook: { enabled, method: form.method, url: form.url.trim(), body: form.body, ...(form.headers !== null ? { headers: headersToSend(form.headers) } : {}) },
  });
  const { headers: _headers, ...rest } = form;
  const dirty = form.headers !== null || JSON.stringify(rest) !== JSON.stringify((({ headers: _h, ...r }) => r)(start()));
  return (
    <ChannelPanel channel="webhook" current={current} enabled={form.enabled} dirty={dirty} build={build} onToggle={(on) => set("enabled", on)}>
      <div>
        <label htmlFor="custom-url" className="mb-1.5 block text-[13px] font-medium text-ink-3">
          {t("admin.channels.webhook.address")}
        </label>
        <div className="flex gap-2">
          <select aria-label={t("admin.channels.webhook.method")} value={form.method} onChange={(e) => set("method", e.target.value as CustomMethod)} className={clsx(inputClass, "w-[92px] shrink-0 font-mono text-[13px]")}>
            {CUSTOM_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            id="custom-url"
            ref={url}
            className={clsx(inputClass, "min-w-0 flex-1 font-mono text-[13px]")}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://api.empresa.com/avisos?tipo={{type}}&para={{phone}}"
            value={form.url}
            onFocus={() => (last.current = "url")}
            onChange={(e) => set("url", e.target.value)}
          />
        </div>
        <p className="mt-1 text-[13px] text-muted">{t("admin.channels.webhook.addressNote")}</p>
      </div>
      <HeadersEditor value={form.headers} onChange={(headers) => set("headers", headers)} saved={c.headerNames} />
      {form.method !== "GET" && (
        <div>
          <label htmlFor="custom-body" className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("admin.channels.webhook.body")}
          </label>
          <textarea
            id="custom-body"
            ref={body}
            rows={5}
            spellCheck={false}
            value={form.body}
            placeholder={'{"to": "{{phone}}", "text": "{{message}}"}'}
            onFocus={() => (last.current = "body")}
            onChange={(e) => set("body", e.target.value)}
            className={clsx(inputClass, "h-auto w-full py-2 font-mono text-[13px]")}
          />
          <p className="mt-1 text-[13px] text-muted">{t("admin.channels.webhook.bodyNote")}</p>
        </div>
      )}
      <div className="rounded-[12px] bg-canvas p-3.5">
        <p className="text-[13px] font-medium text-ink-3">{t("admin.channels.webhook.variables")}</p>
        <p className="mb-2.5 mt-0.5 text-[13px] leading-relaxed text-muted">{t("admin.channels.webhook.variablesNote")}</p>
        <ul className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {CUSTOM_VARIABLES.map((name) => (
            <li key={name} className="flex min-w-0 items-baseline gap-2">
              <button
                type="button"
                onClick={() => insert(name)}
                title={t("admin.channels.webhook.insert", { name: `{{${name}}}` })}
                className={clsx(
                  "shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[12.5px] transition-colors hover:border-ink",
                  PERSON_VARIABLES.includes(name) ? "border-signal/40 text-signal-ink" : "border-line text-ink",
                )}
              >
                {`{{${name}}}`}
              </button>
              <span className="min-w-0 text-[12.5px] leading-snug text-muted">{t(`admin.channels.webhook.variable.${name}`)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-3">{t("admin.channels.webhook.perPerson")}</p>
      </div>
    </ChannelPanel>
  );
}
