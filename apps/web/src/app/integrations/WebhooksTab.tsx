// Webhooks: where notifications are sent when something happens, with the log of what was sent.
import type { EventType, Webhook, WebhookDeliveryStatus, WebhookInput } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, RefreshCw, Send, Trash, Webhook as WebhookIcon, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { createWebhook, deleteWebhook, getWebhookDeliveries, getWebhooks, rotateWebhookSecret, testWebhook, updateWebhook } from "../../lib/integrations";
import { Card, eventLabel } from "../reports/kit";
import { errorText } from "../widgets";
import { Code, EventPicker, SecretBox, label, small } from "./kit";

const STATUS_STYLE: Record<WebhookDeliveryStatus, string> = { ok: "bg-moving/10 text-signal-ink", pending: "bg-idle/15 text-[#8a5a00]", failed: "bg-danger/10 text-danger" };
export function DeliveryBadge({ status }: { status: WebhookDeliveryStatus }) {
  const { t } = useTranslation();
  return <span className={clsx("inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold", STATUS_STYLE[status])}>{t(`shared.webhookStatus.${status}`)}</span>;
}

/** The verification example; the comment that heads it is added in the language of the interface. */
const VERIFY = `const crypto = require("node:crypto");
const [, t, v1] = req.headers["x-opengps-signature"].match(/^t=(\\d+),v1=(\\w+)$/);
const firma = crypto.createHmac("sha256", SECRETO).update(t + "." + cuerpo).digest("hex");
const esNuestro = crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(v1));`;

export function WebhooksTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const hooks = useQuery({ queryKey: ["integrations", "webhooks"], queryFn: getWebhooks, refetchInterval: 30_000 });
  const [editing, setEditing] = useState<Webhook | "new" | null>(null);
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);
  const put = (next: Webhook[]) => queryClient.setQueryData(["integrations", "webhooks"], next);
  return (
    <div className="space-y-4">
      <Card
        title={t("integrations.webhooks.title")}
        note={t("integrations.webhooks.note")}
        action={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={15} aria-hidden="true" /> {t("integrations.webhooks.new")}
          </Button>
        }
      >
        {fresh && (
          <div className="mb-4">
            <SecretBox title={t("integrations.webhooks.secretTitle", { name: fresh.name })} secret={fresh.secret}>
              <p className="text-[13px] leading-relaxed text-ink-3">{t("integrations.webhooks.secretNote")}</p>
            </SecretBox>
          </div>
        )}
        {hooks.isLoading && <Spinner className="text-muted" />}
        {hooks.isError && <Notice tone="error">{errorText(hooks.error)}</Notice>}
        {hooks.data &&
          (hooks.data.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm leading-relaxed text-ink-3">{t("integrations.webhooks.empty")}</p>
          ) : (
            <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
              {hooks.data.map((w) => (
                <li key={w.id}>
                  <button type="button" onClick={() => setEditing(w)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas/70">
                    <WebhookIcon size={18} className="shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-ink">
                        {w.name}
                        {!w.active && <span className="ml-2 text-[12.5px] font-normal text-muted">{t("integrations.webhooks.off")}</span>}
                      </span>
                      <span className="num block truncate text-[12.5px] text-muted">{w.url}</span>
                      <span className="block truncate text-[12.5px] text-muted">{w.events === null ? t("integrations.webhooks.allEvents") : w.events.length === 1 ? t(`shared.event.${w.events[0] as EventType}`) : t("integrations.webhooks.events", { count: w.events.length })}</span>
                    </span>
                    {w.last ? (
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <DeliveryBadge status={w.last.status} />
                        <span className="num text-[12px] text-muted">{formatDateTime(w.last.at)}</span>
                      </span>
                    ) : (
                      <span className="shrink-0 text-[12.5px] text-muted">{t("integrations.webhooks.noDeliveries")}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Card>

      <Card title={t("integrations.webhooks.payload.title")} note={t("integrations.webhooks.payload.note")}>
        <div className="space-y-3">
          <Code>
            {JSON.stringify(
              {
                id: 1284,
                type: "speeding",
                label: t("integrations.webhooks.payload.sample.label"),
                createdAt: "2026-11-23T14:02:11.000Z",
                event: {
                  vehicleId: "…",
                  vehicleName: t("integrations.webhooks.payload.sample.vehicle"),
                  lat: 14.0818,
                  lon: -87.2068,
                  speedKmh: 112,
                  summary: t("integrations.webhooks.payload.sample.summary"),
                },
              },
              null,
              2,
            )}
          </Code>
          <p className="text-[13.5px] leading-relaxed text-ink-3">
            <Trans i18nKey="integrations.webhooks.payload.delivery" components={{ h: <span className="num" /> }} />
          </p>
          <Code>{`// ${t("integrations.webhooks.payload.verify")}\n${VERIFY}`}</Code>
        </div>
      </Card>

      {editing && (
        <WebhookDialog
          hook={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(next, secret, name) => {
            put(next);
            if (secret) setFresh({ name, secret });
          }}
          onSecret={(name, secret) => setFresh({ name, secret })}
        />
      )}
    </div>
  );
}

function WebhookDialog({ hook, onClose, onSaved, onSecret }: { hook: Webhook | null; onClose: () => void; onSaved: (next: Webhook[], secret: string | null, name: string) => void; onSecret: (name: string, secret: string) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(hook?.name ?? "");
  const [url, setUrl] = useState(hook?.url ?? "https://");
  const [active, setActive] = useState(hook?.active ?? true);
  const [all, setAll] = useState(hook ? hook.events === null : true);
  const [events, setEvents] = useState<EventType[]>(hook?.events ?? []);
  /** Custom headers. When editing their values are not shown: `null` keeps the existing ones. */
  const [headers, setHeaders] = useState<{ name: string; value: string }[] | null>(hook ? null : []);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const log = useQuery({ queryKey: ["integrations", "deliveries", hook?.id], queryFn: () => getWebhookDeliveries(hook?.id ?? ""), enabled: hook !== null });
  const save = useMutation({
    mutationFn: async (body: WebhookInput) => (hook ? { webhooks: await updateWebhook(hook.id, body), secret: null } : createWebhook(body)),
    onSuccess: (r) => {
      onSaved(r.webhooks, r.secret, name.trim());
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteWebhook(hook?.id ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integrations", "webhooks"] });
      onClose();
    },
  });
  const test = useMutation({
    mutationFn: () => testWebhook(hook?.id ?? ""),
    onSuccess: (next) => {
      queryClient.setQueryData(["integrations", "deliveries", hook?.id], next);
      void queryClient.invalidateQueries({ queryKey: ["integrations", "webhooks"] });
    },
  });
  const rotate = useMutation({
    mutationFn: () => rotateWebhookSecret(hook?.id ?? ""),
    onSuccess: (secret) => {
      onSecret(hook?.name ?? "", secret);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setProblem(t("integrations.giveName"));
    if (!/^https?:\/\/.+/i.test(url.trim())) return setProblem(t("integrations.webhooks.dialog.urlStart"));
    if (!all && events.length === 0) return setProblem(t("integrations.webhooks.dialog.needEvents"));
    const list = headers?.filter((h) => h.name.trim() || h.value.trim());
    if (list?.some((h) => !/^[A-Za-z0-9-]{1,60}$/.test(h.name.trim()) || !h.value.trim())) return setProblem(t("integrations.webhooks.dialog.badHeader"));
    setProblem(null);
    save.mutate({ name: name.trim(), url: url.trim(), active, events: all ? null : events, ...(list ? { headers: list.map((h) => ({ name: h.name.trim(), value: h.value.trim() })) } : {}) });
  };
  return (
    <Modal open onClose={onClose} title={hook ? hook.name : t("integrations.webhooks.new")} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("integrations.webhooks.dialog.namePlaceholder")} autoFocus={!hook} />
        <Field label={t("integrations.webhooks.dialog.url")} value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} mono hint={t("integrations.webhooks.dialog.urlHint")} />
        <div>
          <span className={label}>{t("integrations.webhooks.dialog.events")}</span>
          <div className="mb-2 flex gap-1 rounded-[10px] bg-canvas p-1" role="group">
            {[
              { on: true, text: t("common.all") },
              { on: false, text: t("integrations.webhooks.dialog.someEvents") },
            ].map((o) => (
              <button key={o.text} type="button" aria-pressed={all === o.on} onClick={() => setAll(o.on)} className={clsx("h-8 flex-1 rounded-lg text-[13px] font-medium", all === o.on ? "bg-primary text-on-primary" : "text-ink-3 hover:text-ink")}>
                {o.text}
              </button>
            ))}
          </div>
          {!all && <EventPicker value={events} onChange={setEvents} idPrefix="webhook-evento" />}
        </div>
        <div>
          <span className={label}>
            <Trans i18nKey="integrations.webhooks.dialog.headers" components={{ note: <span className="font-normal text-muted" /> }} />
          </span>
          {headers === null ? (
            <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-3">
              <span>{hook && hook.headerNames.length > 0 ? t("integrations.webhooks.dialog.headersKept", { names: hook.headerNames.join(", ") }) : t("integrations.webhooks.dialog.headersNone")}</span>
              <Button type="button" variant="secondary" size="sm" onClick={() => setHeaders([])}>
                {t("integrations.webhooks.dialog.headersChange")}
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {headers.map((h, i) => (
                // oxlint-disable-next-line react/no-array-index-key -- rows have no identity other than their place
                <div key={i} className="flex gap-1.5">
                  <input aria-label={t("integrations.webhooks.dialog.headerName", { n: i + 1 })} value={h.name} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Authorization" className={clsx(small, "num w-[38%]")} />
                  <input aria-label={t("integrations.webhooks.dialog.headerValue", { n: i + 1 })} value={h.value} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="Bearer …" className={clsx(small, "num flex-1")} />
                  <button type="button" onClick={() => setHeaders(headers.filter((_, j) => j !== i))} aria-label={t("integrations.webhooks.dialog.headerRemove", { n: i + 1 })} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-danger">
                    <X size={15} />
                  </button>
                </div>
              ))}
              {headers.length < 8 && (
                <Button type="button" variant="secondary" size="sm" onClick={() => setHeaders([...headers, { name: "", value: "" }])}>
                  <Plus size={14} aria-hidden="true" /> {t("integrations.webhooks.dialog.addHeader")}
                </Button>
              )}
              {hook && <p className="text-[12.5px] text-muted">{t("integrations.webhooks.dialog.headersReplace")}</p>}
            </div>
          )}
        </div>
        <label className="flex cursor-pointer items-center gap-3 text-[14.5px] text-ink">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-ink" />
          {t("integrations.webhooks.dialog.active")}
        </label>

        {hook && (
          <section className="space-y-2 rounded-[12px] bg-canvas px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[14px] font-semibold text-ink">{t("integrations.webhooks.dialog.log")}</h3>
              <span className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" loading={test.isPending} onClick={() => test.mutate()}>
                  <Send size={14} aria-hidden="true" /> {t("integrations.webhooks.dialog.test")}
                </Button>
                <Button type="button" variant="secondary" size="sm" loading={rotate.isPending} onClick={() => rotate.mutate()} title={t("integrations.webhooks.dialog.rotateTitle")}>
                  <RefreshCw size={14} aria-hidden="true" /> {t("integrations.webhooks.dialog.rotate")}
                </Button>
              </span>
            </div>
            {log.isLoading && <Spinner className="text-muted" />}
            {log.data &&
              (log.data.length === 0 ? (
                <p className="text-[13px] text-muted">{t("integrations.webhooks.dialog.logEmpty")}</p>
              ) : (
                <ul className="max-h-52 divide-y divide-line overflow-y-auto rounded-[10px] border border-line bg-surface text-[13px]">
                  {log.data.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{d.topic === "test" ? t("integrations.webhooks.dialog.testTopic") : eventLabel(d.topic)}</span>
                        <span className="block truncate text-[12px] text-muted">
                          <span className="num">{formatDateTime(d.createdAt)}</span>
                          {d.attempts > 1 && ` · ${t("integrations.webhooks.dialog.attempts", { n: d.attempts })}`}
                          {d.error && ` · ${d.error}`}
                          {d.nextAt && ` · ${t("integrations.webhooks.dialog.retry", { when: formatDateTime(d.nextAt) })}`}
                        </span>
                      </span>
                      <DeliveryBadge status={d.status} />
                    </li>
                  ))}
                </ul>
              ))}
          </section>
        )}

        {(problem || save.isError || remove.isError || test.isError || rotate.isError) && <Notice tone="error">{problem ?? errorText(save.error ?? remove.error ?? test.error ?? rotate.error)}</Notice>}
        {confirming ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-danger/25 bg-danger/5 px-3.5 py-2.5">
            <span className="text-sm text-danger">{t("integrations.webhooks.dialog.confirmDelete")}</span>
            <span className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="button" variant="danger" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
                {t("common.delete")}
              </Button>
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            {hook ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                <Trash size={14} aria-hidden="true" /> {t("common.delete")}
              </Button>
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={save.isPending}>
                {t("common.save")}
              </Button>
            </span>
          </div>
        )}
      </form>
    </Modal>
  );
}
