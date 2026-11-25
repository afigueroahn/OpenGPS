// An account's notifications: whom it tells, about what and through which
// channel. The channels themselves are connected by the platform owner; here
// the account only uses the ones there are.
import {
  ALERT_EVENTS,
  type AccountNotification,
  type AccountNotificationInput,
  type Delivery,
  type EventType,
  NOTIFY_CHANNELS,
  type NotificationOptions,
  type NotifyChannel,
  type Vehicle,
  type VehicleGroup,
  WRITTEN_CHANNELS,
  addressProblem,
} from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sayShared } from "../../lib/i18n";
import clsx from "clsx";
import { Pencil, Plus, Send, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { browserZone, getGroups, getVehicles } from "../../lib/api";
import { deleteNotification, getDeliveries, getNotifications, saveNotification, testNotification } from "../../lib/notifications";
import { Card, Segmented, VehiclePicker, inputClass, labelClass } from "../reports/kit";
import { ConfirmDialog, errorText } from "../widgets";
import { Switch } from "./SettingsTabs";
import { ChannelBadge, ChannelChoice, DeliveryLog, StatusChip } from "./notify";

type Target = "all" | "groups" | "vehicles";

/** A saved notification as it is sent back when only one thing of it changes. */
const inputOf = (n: AccountNotification): AccountNotificationInput => ({
  name: n.name,
  channel: n.channel,
  active: n.active,
  everyone: n.everyone,
  roles: n.roles,
  userIds: n.userIds,
  addresses: n.addresses,
  events: n.events,
  ruleIds: n.ruleIds,
  groupIds: n.groupIds,
  vehicleIds: n.vehicleIds,
  zone: n.zone,
});

export function NotificationsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ["notifications"], queryFn: getNotifications });
  const log = useQuery({ queryKey: ["notifications", "deliveries"], queryFn: getDeliveries, refetchInterval: 30_000 });
  const groups = useQuery({ queryKey: ["groups"], queryFn: getGroups });
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: getVehicles });
  const [editing, setEditing] = useState<AccountNotification | "new" | null>(null);
  const [removing, setRemoving] = useState<AccountNotification | null>(null);
  const [tested, setTested] = useState<{ id: string; deliveries: Delivery[] } | null>(null);

  const keep = (notifications: AccountNotification[]) => queryClient.setQueryData(["notifications"], (old: { notifications: AccountNotification[]; options: NotificationOptions } | undefined) => (old ? { ...old, notifications } : old));
  const refreshLog = () => void queryClient.invalidateQueries({ queryKey: ["notifications", "deliveries"] });
  const toggle = useMutation({ mutationFn: (n: AccountNotification) => saveNotification(n.id, { ...inputOf(n), active: !n.active }), onSuccess: keep });
  const test = useMutation({
    mutationFn: (n: AccountNotification) => testNotification(n.id),
    onSuccess: (deliveries, n) => {
      setTested({ id: n.id, deliveries: deliveries.filter((d) => d.source === "test").slice(0, 8) });
      refreshLog();
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const starter = useMutation({
    mutationFn: () => saveNotification(null, { name: t("admin.notifications.starter.name"), channel: "email", everyone: true, zone: browserZone() }),
    onSuccess: keep,
  });

  if (data.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }
  if (data.isError || !data.data) return <Notice tone="error">{errorText(data.error)}</Notice>;
  const { notifications, options } = data.data;

  const describe = (n: AccountNotification): string => {
    const who: string[] = [];
    if (n.everyone) who.push(t("admin.notifications.who.everyone"));
    for (const role of n.roles) who.push(options.roles.find((r) => r.id === role)?.name ?? role);
    if (n.userIds.length > 0) who.push(t("admin.notifications.who.people", { count: n.userIds.length }));
    if (n.addresses.length > 0) who.push(t("admin.notifications.who.addresses", { count: n.addresses.length }));
    const what = n.ruleIds ? t("admin.notifications.what.rules", { count: n.ruleIds.length }) : n.events ? t("admin.notifications.what.types", { count: n.events.length }) : t("admin.notifications.what.all");
    const where = n.vehicleIds ? t("admin.notifications.where.vehicles", { count: n.vehicleIds.length }) : n.groupIds ? t("admin.notifications.where.groups", { count: n.groupIds.length }) : t("admin.notifications.where.all");
    return [who.join(", "), what, where].join(" · ");
  };

  return (
    <div className="space-y-5">
      {options.usage.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.usage.map((u) => (
            <span key={u.channel} className="rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-ink-3">
              {t(`admin.notify.channel.${u.channel}`)}:{" "}
              <span className="num font-medium text-ink">{u.cap === null ? t("admin.notifications.usage.open", { sent: u.sent }) : t("admin.notifications.usage.capped", { sent: u.sent, cap: u.cap })}</span>
            </span>
          ))}
        </div>
      )}

      <Card
        title={t("admin.notifications.list.title")}
        note={t("admin.notifications.list.note")}
        action={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={15} aria-hidden="true" /> {t("admin.notifications.new")}
          </Button>
        }
      >
        {notifications.length === 0 ? (
          <div className="rounded-[12px] bg-canvas px-4 py-5">
            <p className="text-[14.5px] font-medium text-ink">{t("admin.notifications.empty.title")}</p>
            <p className="mt-1 max-w-[62ch] text-[13.5px] leading-relaxed text-muted">{t("admin.notifications.empty.lead")}</p>
            {options.channels.includes("email") && (
              <Button variant="secondary" size="sm" className="mt-3" loading={starter.isPending} onClick={() => starter.mutate()}>
                {t("admin.notifications.starter.action")}
              </Button>
            )}
            {starter.isError && <p className="mt-2 text-[13px] text-danger">{errorText(starter.error)}</p>}
          </div>
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
                      {t(`admin.notify.channel.${n.channel}`)} · {describe(n)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="secondary" size="sm" loading={test.isPending && test.variables?.id === n.id} disabled={!options.channels.includes(n.channel)} onClick={() => test.mutate(n)}>
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
                {!options.channels.includes(n.channel) && <p className="mt-2 text-[13px] text-danger">{t("admin.notifications.channelOff")}</p>}
                {test.isError && test.variables?.id === n.id && <p className="mt-2 text-[13px] text-danger">{errorText(test.error)}</p>}
                {tested?.id === n.id && (
                  <div className="mt-3 rounded-[12px] bg-canvas px-3.5 py-3">
                    <p className="mb-2 text-[13px] font-medium text-ink-3">{t("admin.notifications.tested")}</p>
                    <DeliveryLog deliveries={tested.deliveries} empty={t("admin.notify.log.empty")} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {toggle.isError && <p className="mt-3 text-[13px] text-danger">{errorText(toggle.error)}</p>}
      </Card>

      <Card title={t("admin.notify.log.title")} note={t("admin.notify.log.lead")}>
        {log.data ? <DeliveryLog deliveries={log.data} empty={t("admin.notify.log.empty")} /> : log.isError ? <Notice tone="error">{errorText(log.error)}</Notice> : <Spinner />}
      </Card>

      {editing && (
        <Editor
          key={editing === "new" ? "new" : editing.id}
          notification={editing === "new" ? null : editing}
          options={options}
          groups={groups.data ?? []}
          vehicles={vehicles.data ?? []}
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
          if (removing) await deleteNotification(removing.id);
          await queryClient.invalidateQueries({ queryKey: ["notifications"] });
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

/** A list of things to tick, in the panel's own colors. */
function Ticks({ items, chosen, onChange, columns }: { items: { id: string; label: string; note?: string }[]; chosen: string[]; onChange: (ids: string[]) => void; columns?: boolean }) {
  return (
    <div className={clsx("max-h-56 gap-x-4 gap-y-1.5 overflow-y-auto rounded-[10px] bg-canvas p-3 text-sm", columns ? "grid sm:grid-cols-2" : "grid")}>
      {items.map((item) => (
        <label key={item.id} className="flex items-start gap-2 text-ink">
          <input type="checkbox" className="mt-1" checked={chosen.includes(item.id)} onChange={(e) => onChange(e.target.checked ? [...chosen, item.id] : chosen.filter((id) => id !== item.id))} />
          <span className="min-w-0">
            {item.label}
            {item.note && <span className="ml-1.5 text-[12.5px] text-muted">{item.note}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

function Editor(props: { notification: AccountNotification | null; options: NotificationOptions; groups: VehicleGroup[]; vehicles: Vehicle[]; onClose: () => void; onSaved: (next: AccountNotification[]) => void }) {
  const { t } = useTranslation();
  const { notification: n, options, groups, vehicles } = props;
  const [name, setName] = useState(n?.name ?? "");
  const [channel, setChannel] = useState<NotifyChannel>(n?.channel ?? options.channels[0] ?? "email");
  const [active, setActive] = useState(n?.active ?? true);
  const [everyone, setEveryone] = useState(n?.everyone ?? false);
  const [roles, setRoles] = useState<string[]>(n?.roles ?? []);
  const [userIds, setUserIds] = useState<string[]>(n?.userIds ?? []);
  const [written, setWritten] = useState(n ? n.addresses.join("\n") : "");
  const [allEvents, setAllEvents] = useState(n ? n.events === null : true);
  const [events, setEvents] = useState<string[]>(n?.events ?? []);
  const [byRule, setByRule] = useState(Boolean(n?.ruleIds));
  const [ruleIds, setRuleIds] = useState<string[]>(n?.ruleIds ?? []);
  const [target, setTarget] = useState<Target>(n?.vehicleIds ? "vehicles" : n?.groupIds ? "groups" : "all");
  const [groupIds, setGroupIds] = useState<string[]>(n?.groupIds ?? []);
  const [vehicleIds, setVehicleIds] = useState<string[]>(n?.vehicleIds ?? []);
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({ mutationFn: (body: AccountNotificationInput) => saveNotification(n?.id ?? null, body), onSuccess: props.onSaved });
  // Nobody has the mobile app yet: push reaches no one until they install it.
  const lacks = (p: NotificationOptions["people"][number]) =>
    channel === "push" ? t("admin.notifications.editor.noApp") : channel === "sms" && !p.hasPhone ? t("admin.notifications.editor.noPhone") : undefined;
  // Push and the custom channel only reach people of the account: nothing is written by hand for them.
  const writes = options.canAddress && WRITTEN_CHANNELS.includes(channel);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const addresses = writes ? written.split(/[\s,;]+/).filter(Boolean) : [];
    if (!name.trim()) return setProblem(t("admin.notifications.editor.needName"));
    if (!(everyone || roles.length > 0 || userIds.length > 0) && addresses.length === 0) return setProblem(t("admin.notifications.editor.needWho"));
    const wrong = addresses.map((address) => addressProblem(channel, address)).find((p) => p !== null);
    if (wrong) return setProblem(sayShared(wrong));
    if (!allEvents && events.length === 0) return setProblem(t("admin.notifications.editor.needEvents"));
    if (byRule && ruleIds.length === 0) return setProblem(t("admin.notifications.editor.needRules"));
    if (target === "groups" && groupIds.length === 0) return setProblem(t("admin.notifications.editor.needGroups"));
    if (target === "vehicles" && vehicleIds.length === 0) return setProblem(t("admin.notifications.editor.needVehicles"));
    save.mutate({
      name: name.trim(),
      channel,
      active,
      everyone,
      roles,
      userIds,
      // Whoever cannot write addresses sends back the ones there were, untouched.
      addresses: !WRITTEN_CHANNELS.includes(channel) ? [] : options.canAddress ? addresses : (n?.addresses ?? []),
      events: allEvents ? null : (events as EventType[]),
      ruleIds: byRule ? ruleIds : null,
      groupIds: target === "groups" ? groupIds : null,
      vehicleIds: target === "vehicles" ? vehicleIds : null,
      zone: n?.zone ?? browserZone(),
    });
  };

  const hint = channel === "email" || channel === "sms" ? t(`admin.notifications.editor.addressHint.${channel}`) : "";
  const note =
    channel === "email"
      ? t("admin.notifications.editor.scopeNote")
      : channel === "webhook"
        ? t(options.customPerPerson ? "admin.notifications.editor.personNote.webhook" : "admin.notifications.editor.personNote.webhookOnce")
        : t(`admin.notifications.editor.personNote.${channel}`);
  return (
    <Modal open onClose={props.onClose} title={t(n ? "admin.notifications.editor.editTitle" : "admin.notifications.editor.newTitle")} wide>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field label={t("admin.notifications.editor.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("admin.notifications.editor.namePlaceholder")} autoFocus />

        <div>
          <ChannelChoice channels={NOTIFY_CHANNELS} usable={options.channels} value={channel} onChange={setChannel} />
          {n && !options.channels.includes(n.channel) && <p className="mt-2 text-[13px] text-danger">{t("admin.notifications.channelOff")}</p>}
        </div>

        <fieldset className="space-y-2.5">
          <legend className={labelClass}>{t("admin.notifications.editor.who")}</legend>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            {t("admin.notifications.editor.everyone")}
          </label>
          {!everyone && (
            <>
              <p className="text-[13px] font-medium text-ink-3">{t("admin.notifications.editor.roles")}</p>
              <Ticks columns items={options.roles.map((r) => ({ id: r.id, label: r.name }))} chosen={roles} onChange={setRoles} />
              <p className="text-[13px] font-medium text-ink-3">{t("admin.notifications.editor.people")}</p>
              <Ticks columns items={options.people.map((p) => ({ id: p.userId, label: p.name, note: lacks(p) ?? p.roleName }))} chosen={userIds} onChange={setUserIds} />
            </>
          )}
          <p className="text-[13px] leading-relaxed text-muted">{note}</p>
          {writes && (
            <div>
              <label htmlFor="notification-addresses" className="mb-1.5 block text-[13px] font-medium text-ink-3">
                {t("admin.notifications.editor.otherAddresses")}
              </label>
              <textarea
                id="notification-addresses"
                value={written}
                onChange={(e) => setWritten(e.target.value)}
                rows={2}
                spellCheck={false}
                placeholder={hint}
                className={clsx(inputClass, "h-auto w-full py-2 font-mono text-[13px]")}
              />
              <p className="mt-1 text-[13px] text-muted">{t("admin.notifications.editor.addressesNote")}</p>
            </div>
          )}
          {!options.canAddress && WRITTEN_CHANNELS.includes(channel) && <p className="text-[13px] text-muted">{t("admin.notifications.editor.noAddresses")}</p>}
        </fieldset>

        <fieldset className="space-y-2.5">
          <legend className={labelClass}>{t("admin.notifications.editor.what")}</legend>
          <Segmented
            label={t("admin.notifications.editor.what")}
            options={[
              { id: "all", label: t("admin.notifications.editor.allEvents") },
              { id: "some", label: t("admin.notifications.editor.someEvents") },
            ]}
            value={allEvents ? "all" : "some"}
            onChange={(id) => setAllEvents(id === "all")}
          />
          {!allEvents && <Ticks columns items={ALERT_EVENTS.map((type) => ({ id: type, label: t(`shared.event.${type}`) }))} chosen={events} onChange={setEvents} />}
          {options.rules.length > 0 && (
            <>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={byRule} onChange={(e) => setByRule(e.target.checked)} />
                {t("admin.notifications.editor.byRule")}
              </label>
              {byRule && <Ticks columns items={options.rules.map((r) => ({ id: r.id, label: r.name }))} chosen={ruleIds} onChange={setRuleIds} />}
            </>
          )}
        </fieldset>

        <fieldset className="space-y-2.5">
          <legend className={labelClass}>{t("admin.notifications.editor.where")}</legend>
          <Segmented
            label={t("admin.notifications.editor.where")}
            options={[
              { id: "all" as Target, label: t("admin.notifications.editor.allVehicles") },
              ...(groups.length > 0 ? [{ id: "groups" as Target, label: t("admin.notifications.editor.groups") }] : []),
              { id: "vehicles" as Target, label: t("admin.notifications.editor.vehicles") },
            ]}
            value={target}
            onChange={setTarget}
          />
          {target === "groups" && <Ticks columns items={groups.map((g) => ({ id: g.id, label: g.name, note: String(g.vehicleCount) }))} chosen={groupIds} onChange={setGroupIds} />}
          {target === "vehicles" && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted">{vehicleIds.length === 0 ? t("admin.users.scope.noVehicles") : t("admin.notifications.where.vehicles", { count: vehicleIds.length })}</span>
              <Button type="button" variant="secondary" size="sm" onClick={() => setPicking(true)}>
                {t(vehicleIds.length === 0 ? "admin.users.scope.pick" : "admin.users.scope.change")}
              </Button>
            </div>
          )}
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
      <VehiclePicker open={picking} vehicles={vehicles} chosen={vehicleIds} onClose={() => setPicking(false)} onDone={setVehicleIds} />
    </Modal>
  );
}
