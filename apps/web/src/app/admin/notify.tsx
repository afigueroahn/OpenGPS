// Pieces the notification screens share: each channel's icon, the cards to
// choose a channel, the custom headers, how a message ended and the log of
// what was sent.
import { CUSTOM_HEADERS_MAX, type CustomHeader, type Delivery, type DeliveryStatus, type NotifyChannel } from "@opengps/shared";
import clsx from "clsx";
import { Globe, type LucideIcon, Mail, MessageSquareText, Plus, Smartphone, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { inputClass, labelClass } from "../reports/kit";

export const CHANNEL_ICON: Record<NotifyChannel, LucideIcon> = { email: Mail, sms: MessageSquareText, webhook: Globe, push: Smartphone };

/** The channel's icon in its little square. */
export function ChannelBadge({ channel, muted, size = "md" }: { channel: NotifyChannel; muted?: boolean; size?: "md" | "lg" }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span className={clsx("flex shrink-0 items-center justify-center border border-line bg-canvas", size === "lg" ? "h-12 w-12 rounded-[12px]" : "h-9 w-9 rounded-[10px]", muted ? "text-faint" : "text-ink-3")}>
      <Icon size={size === "lg" ? 22 : 17} aria-hidden="true" />
    </span>
  );
}

/** The channels as cards to pick one, each with what it reaches. A channel the platform cannot use yet is shown, but not chosen. */
export function ChannelChoice<C extends NotifyChannel>({ channels, usable, value, onChange }: { channels: readonly C[]; usable: readonly NotifyChannel[]; value: C; onChange: (channel: C) => void }) {
  const { t } = useTranslation();
  return (
    <div>
      <span className={labelClass}>{t("admin.notifications.editor.channel")}</span>
      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
        {channels.map((c) => {
          const ready = usable.includes(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={value === c}
              disabled={!ready && value !== c}
              onClick={() => onChange(c)}
              className={clsx(
                "flex items-center gap-3 rounded-[12px] border px-3 py-2.5 text-left transition-colors",
                value === c ? "border-ink bg-canvas" : "border-line hover:border-faint",
                !ready && value !== c && "cursor-not-allowed opacity-60 hover:border-line",
              )}
            >
              <ChannelBadge channel={c} muted={!ready} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{t(`admin.notify.channel.${c}`)}</span>
                <span className={clsx("block text-[12.5px] leading-snug", ready ? "text-muted" : "text-danger")}>{ready ? t(`admin.notify.channelNote.${c}`) : t("admin.notify.unavailable")}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The custom headers of a message to another system. `value` null means "the
 * ones already saved": their values are not shown, only their names.
 */
export function HeadersEditor({ value, onChange, saved }: { value: CustomHeader[] | null; onChange: (headers: CustomHeader[] | null) => void; saved: string[] }) {
  const { t } = useTranslation();
  const small = clsx(inputClass, "num h-9 text-[13px]");
  return (
    <div>
      <span className={labelClass}>{t("admin.notify.headers.title")}</span>
      <p className="-mt-1 mb-2 text-[13px] leading-relaxed text-muted">{t("admin.notify.headers.note")}</p>
      {value === null ? (
        <div className="flex flex-wrap items-center gap-3 text-[13.5px] text-ink-3">
          <span>{saved.length > 0 ? t("admin.notify.headers.kept", { names: saved.join(", ") }) : t("admin.notify.headers.none")}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => onChange([])}>
            {t("admin.notify.headers.change")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {value.map((h, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- a header being written has no identity other than its place
            <div key={i} className="flex items-center gap-2">
              <input aria-label={t("admin.notify.headers.name", { n: i + 1 })} value={h.name} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Authorization" spellCheck={false} className={clsx(small, "w-[38%]")} />
              <input aria-label={t("admin.notify.headers.value", { n: i + 1 })} value={h.value} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="Bearer …" spellCheck={false} className={clsx(small, "min-w-0 flex-1")} />
              <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t("admin.notify.headers.remove", { n: i + 1 })} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-danger">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {value.length < CUSTOM_HEADERS_MAX && (
            <Button type="button" variant="secondary" size="sm" className="w-full" onClick={() => onChange([...value, { name: "", value: "" }])}>
              <Plus size={15} aria-hidden="true" /> {t("admin.notify.headers.add")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The headers as they are sent: empty rows left out. null keeps the saved ones. */
export const headersToSend = (headers: CustomHeader[] | null): CustomHeader[] | undefined =>
  headers === null ? undefined : headers.filter((h) => h.name.trim() || h.value.trim()).map((h) => ({ name: h.name.trim(), value: h.value.trim() }));

export function StatusChip({ status }: { status: DeliveryStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[12px] font-medium",
        status === "ok" && "bg-moving/15 text-signal-ink",
        status === "pending" && "bg-ink/[0.07] text-ink-3",
        status === "failed" && "bg-danger/10 text-danger",
      )}
    >
      {t(`admin.notify.status.${status}`)}
    </span>
  );
}

/** The latest messages: where each went, why and how it ended. */
export function DeliveryLog({ deliveries, empty }: { deliveries: Delivery[]; empty: string }) {
  const { t } = useTranslation();
  if (deliveries.length === 0) return <p className="py-2 text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {deliveries.map((d) => (
        <li key={d.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
          <ChannelBadge channel={d.channel} />
          <div className="min-w-0 flex-1 basis-56">
            <p className="truncate text-[14px] font-medium text-ink">{d.title}</p>
            <p className="truncate text-[13px] text-muted">
              {t(`admin.notify.channel.${d.channel}`)} · {d.to}
              {d.name ? ` · ${d.name}` : ""}
              {d.source !== "notification" && d.source !== "system" ? ` · ${t(`admin.notify.source.${d.source}`)}` : ""}
            </p>
            {d.error && <p className="mt-0.5 text-[13px] leading-snug text-danger">{d.error}</p>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <StatusChip status={d.status} />
            <span className="num text-[12px] text-muted">{formatDateTime(d.at)}</span>
            {d.nextAt && <span className="text-[12px] text-muted">{t("admin.notify.log.retryAt", { when: formatDateTime(d.nextAt) })}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
