// The platform's own notifications, for whoever runs it: each one is a
// destination plus the things it wants to hear about (a backup that failed,
// a disk filling up, a channel that stopped delivering).
import {
  ADDRESS_CHANNELS,
  type AddressChannel,
  type ChannelSettings,
  type Delivery,
  type Me,
  SYSTEM_EVENTS,
  type SystemEvent,
  type SystemNotification,
  type SystemNotificationInput,
  addressProblem,
} from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sayShared } from "../../lib/i18n";
import clsx from "clsx";
import { Pencil, Plus, Send, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { deleteSystemNotification, getSystemNotifications, saveSystemNotification, testSystemNotification } from "../../lib/notifications";
import { Card, labelClass } from "../reports/kit";
import { ConfirmDialog, errorText } from "../widgets";
import { Switch, useSettings } from "./SettingsTabs";
import { ChannelBadge, ChannelChoice, DeliveryLog, StatusChip } from "./notify";

type Listing = { notifications: SystemNotification[]; deliveries: Delivery[] };

/** A channel can be used once it is on and has what it needs. */
function ready(channels: ChannelSettings, channel: AddressChannel): boolean {
  const c = channels[channel];
  if (!c.enabled) return false;
  if (channel === "webhook") return channels.webhook.url !== "";
  return "hasToken" in c ? c.hasToken : true;
}

export function SystemNotificationsSection({ me }: { me: Me }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const data = useQuery({ queryKey: ["admin", "notifications"], queryFn: getSystemNotifications, refetchInterval: 30_000 });
  const [editing, setEditing] = useState<SystemNotification | "new" | null>(null);
  const [removing, setRemoving] = useState<SystemNotification | null>(null);
  const keep = (notifications: SystemNotification[]) => queryClient.setQueryData(["admin", "notifications"], (old: Listing | undefined) => (old ? { ...old, notifications } : old));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "notifications"] });
  const toggle = useMutation({
    mutationFn: (n: SystemNotification) => saveSystemNotification(n.id, { name: n.name, channel: n.channel, target: n.target, events: n.events, active: !n.active }),
    onSuccess: keep,
  });
  const test = useMutation({ mutationFn: (n: SystemNotification) => testSystemNotification(n.id), onSettled: () => void refresh() });

  if (data.isError) return <Notice tone="error">{errorText(data.error)}</Notice>;
  if (!data.data || !settings.data) {
    return (
      <div className="flex h-32 items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }
  const { notifications, deliveries } = data.data;
  const channels = ADDRESS_CHANNELS.filter((channel) => ready(settings.data.channels, channel));

  return (
    <div className="space-y-5">
      <Card
        title={t("admin.system.list.title")}
        note={t("admin.system.list.note")}
        action={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={15} aria-hidden="true" /> {t("admin.notifications.new")}
          </Button>
        }
      >
        {notifications.length === 0 ? (
          <p className="rounded-[12px] bg-canvas px-4 py-4 text-[13.5px] leading-relaxed text-muted">{t("admin.system.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {notifications.map((n) => (
              <li key={n.id} className="py-3.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <ChannelBadge channel={n.channel} muted={!n.active} />
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className={clsx("truncate text-[15px] font-medium", n.active ? "text-ink" : "text-muted")}>{n.name}</span>
                      {n.last && <StatusChip status={n.last.status} />}
                    </p>
                    <p className="truncate text-[13px] text-muted">
                      {t(`admin.notify.channel.${n.channel}`)} · {t("admin.system.things", { count: n.events.length })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="secondary" size="sm" loading={test.isPending && test.variables?.id === n.id} disabled={!channels.includes(n.channel)} onClick={() => test.mutate(n)}>
                      <Send size={14} aria-hidden="true" /> {t("admin.notifications.test")}
                    </Button>
                    <Switch label={t("admin.notifications.active", { name: n.name })} checked={n.active} disabled={toggle.isPending} onChange={() => toggle.mutate(n)} />
                    <IconButton label={t("admin.notifications.edit", { name: n.name })} onClick={() => setEditing(n)}>
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton label={t("admin.notifications.delete", { name: n.name })} onClick={() => setRemoving(n)}>
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                </div>
                {!channels.includes(n.channel) && <p className="mt-2 text-[13px] text-danger">{t("admin.notifications.channelOff")}</p>}
                {test.isError && test.variables?.id === n.id && <p className="mt-2 text-[13px] text-danger">{errorText(test.error)}</p>}
              </li>
            ))}
          </ul>
        )}
        {toggle.isError && <p className="mt-3 text-[13px] text-danger">{errorText(toggle.error)}</p>}
      </Card>

      <Card title={t("admin.notify.log.title")} note={t("admin.system.logLead")}>
        <DeliveryLog deliveries={deliveries} empty={t("admin.notify.log.empty")} />
      </Card>

      {editing && (
        <Editor
          key={editing === "new" ? "new" : editing.id}
          notification={editing === "new" ? null : editing}
          channels={channels}
          me={me}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            keep(next);
            setEditing(null);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={t("admin.notifications.remove.title")}
        confirm={t("admin.notifications.remove.confirm")}
        onClose={() => setRemoving(null)}
        action={async () => {
          if (removing) await deleteSystemNotification(removing.id);
          await refresh();
        }}
      >
        {t("admin.notifications.remove.body", { name: removing?.name ?? "" })}
      </ConfirmDialog>
    </div>
  );
}

function IconButton({ label, children, onClick }: { label: string; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="shrink-0 rounded-lg p-2 text-muted hover:bg-canvas hover:text-ink">
      {children}
    </button>
  );
}

function Editor(props: { notification: SystemNotification | null; channels: AddressChannel[]; me: Me; onClose: () => void; onSaved: (next: SystemNotification[]) => void }) {
  const { t } = useTranslation();
  const { notification: n, channels, me } = props;
  const [name, setName] = useState(n?.name ?? "");
  const [channel, setChannel] = useState<AddressChannel>(n?.channel ?? channels[0] ?? "email");
  const [target, setTarget] = useState(n?.target ?? me.user.email);
  const [events, setEvents] = useState<SystemEvent[]>(n?.events ?? ["backup_failed", "disk_high", "ingest_stalled", "channel_failing"]);
  const [active, setActive] = useState(n?.active ?? true);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (body: SystemNotificationInput) => saveSystemNotification(n?.id ?? null, body), onSuccess: props.onSaved });
  const pick = (next: AddressChannel) => {
    setChannel(next);
    setTarget(next === "email" ? me.user.email : next === "sms" ? (me.settings.phone ?? "") : "");
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!name.trim()) return setProblem(t("admin.notifications.editor.needName"));
    // In the custom channel the destination is optional: it only fills its variables.
    const wrong = channel === "webhook" && !target.trim() ? null : addressProblem(channel, target);
    if (wrong) return setProblem(sayShared(wrong));
    if (events.length === 0) return setProblem(t("admin.system.editor.needEvents"));
    save.mutate({ name: name.trim(), channel, target: target.trim(), events, active });
  };
  return (
    <Modal open onClose={props.onClose} title={t(n ? "admin.notifications.editor.editTitle" : "admin.notifications.editor.newTitle")} wide>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field label={t("admin.notifications.editor.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("admin.system.editor.namePlaceholder")} autoFocus />
        <ChannelChoice channels={ADDRESS_CHANNELS} usable={channels} value={channel} onChange={pick} />
        <Field
          label={t(channel === "webhook" ? "admin.system.editor.targetOptional" : "admin.system.editor.target")}
          hint={channel === "webhook" ? t("admin.system.editor.targetNote") : undefined}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder={t(`admin.channels.test.placeholder.${channel}`)}
          mono={channel === "sms"}
        />
        <fieldset>
          <legend className={labelClass}>{t("admin.system.editor.events")}</legend>
          <div className="grid gap-1.5 rounded-[10px] bg-canvas p-3 text-sm">
            {SYSTEM_EVENTS.map((event) => (
              <label key={event} className="flex items-start gap-2 text-ink">
                <input type="checkbox" className="mt-1" checked={events.includes(event)} onChange={(e) => setEvents(e.target.checked ? [...events, event] : events.filter((x) => x !== event))} />
                {t(`admin.system.event.${event}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t("admin.notifications.editor.active")}
        </label>
        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose}>
            {t("admin.notifications.editor.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t("admin.notifications.editor.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
