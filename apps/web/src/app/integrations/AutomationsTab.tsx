// Automations: when something happens (trigger) on certain vehicles and at
// certain times (condition), the platform does something on its own (action).
import {
  ADDRESS_CHANNELS,
  type AddressChannel,
  type Automation,
  type AutomationAction,
  type AutomationInput,
  type EventType,
  type ModuleKey,
  type VehicleGroup,
  WEEKDAY_KEYS,
  type WeekSchedule,
  addressProblem,
} from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18n, { sayShared } from "../../lib/i18n";
import clsx from "clsx";
import { Plus, Trash, Zap } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { browserZone } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { deleteAutomation, getAutomationRuns, getAutomations, getWebhooks, saveAutomation } from "../../lib/integrations";
import { Card, eventLabel } from "../reports/kit";
import { errorText } from "../widgets";
import { EventPicker, label, select } from "./kit";

type Scope = "all" | "group" | "vehicles";
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const timeOf = (minutes: number) => `${String(Math.floor(Math.min(minutes, 1439) / 60)).padStart(2, "0")}:${String(Math.min(minutes, 1439) % 60).padStart(2, "0")}`;

/** "Exceso de velocidad y 2 más" */
const triggersText = (a: Automation) => {
  const first = a.triggers[0] ? eventLabel(a.triggers[0]) : "";
  return a.triggers.length === 1 ? first : i18n.t("integrations.automations.triggersMore", { first, n: a.triggers.length - 1 });
};
const actionText = (action: AutomationAction) =>
  action.type === "notify"
    ? i18n.t("integrations.automations.action.notify", { channel: i18n.t(`shared.channel.${action.channel}`).toLowerCase(), count: action.to.length })
    : action.type === "webhook"
      ? i18n.t("integrations.automations.action.webhook")
      : i18n.t("integrations.automations.action.order");
/** An automation notifies addresses written by hand: push, which only reaches people of the account, is not one of them. */
const AUTOMATION_CHANNELS = ADDRESS_CHANNELS;
const ADDRESS_HINT = {
  email: { label: "integrations.automations.address.email.label", placeholder: "integrations.automations.address.email.placeholder" },
  sms: { label: "integrations.automations.address.sms.label", placeholder: "integrations.automations.address.sms.placeholder" },
  webhook: { label: "integrations.automations.address.webhook.label", placeholder: "integrations.automations.address.webhook.placeholder" },
} as const satisfies Record<AddressChannel, { label: string; placeholder: string }>;

export function AutomationsTab(props: { vehicles: { id: string; name: string }[]; groups: VehicleGroup[]; modules: ModuleKey[] }) {
  const { t } = useTranslation();
  const autos = useQuery({ queryKey: ["integrations", "automations"], queryFn: getAutomations });
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  return (
    <div className="space-y-4">
      <Card
        title={t("integrations.automations.title")}
        note={t("integrations.automations.note")}
        action={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={15} aria-hidden="true" /> {t("integrations.automations.new")}
          </Button>
        }
      >
        {autos.isLoading && <Spinner className="text-muted" />}
        {autos.isError && <Notice tone="error">{errorText(autos.error)}</Notice>}
        {autos.data &&
          (autos.data.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm leading-relaxed text-ink-3">{t("integrations.automations.empty")}</p>
          ) : (
            <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
              {autos.data.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setEditing(a)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas/70">
                    <Zap size={18} className={clsx("shrink-0", a.active ? "text-signal-ink" : "text-faint")} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-ink">
                        {a.name}
                        {!a.active && <span className="ml-2 text-[12.5px] font-normal text-muted">{t("integrations.automations.off")}</span>}
                      </span>
                      <span className="block truncate text-[12.5px] text-muted">
                        {triggersText(a)} → {actionText(a.action)}
                      </span>
                    </span>
                    <span className="num shrink-0 text-right text-[12.5px] text-ink-3">
                      {t("integrations.automations.runs", { count: a.runs })}
                      {a.lastRunAt && <span className="block text-muted">{formatDateTime(a.lastRunAt)}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Card>
      {editing && <AutomationDialog auto={editing === "new" ? null : editing} {...props} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AutomationDialog({ auto, vehicles, groups, modules, onClose }: { auto: Automation | null; vehicles: { id: string; name: string }[]; groups: VehicleGroup[]; modules: ModuleKey[]; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const hooks = useQuery({ queryKey: ["integrations", "webhooks"], queryFn: getWebhooks });
  const runs = useQuery({ queryKey: ["integrations", "runs", auto?.id], queryFn: () => getAutomationRuns(auto?.id ?? ""), enabled: auto !== null });
  const [name, setName] = useState(auto?.name ?? "");
  const [active, setActive] = useState(auto?.active ?? true);
  const [triggers, setTriggers] = useState<EventType[]>(auto?.triggers ?? []);
  const [scope, setScope] = useState<Scope>(auto?.groupId ? "group" : auto?.vehicleIds ? "vehicles" : "all");
  const [groupId, setGroupId] = useState(auto?.groupId ?? groups[0]?.id ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set(auto?.vehicleIds ?? []));
  // Schedule: the same time ranges on all the marked days.
  const window = auto?.schedule?.days.find((d) => d !== null) ?? null;
  const [timed, setTimed] = useState(Boolean(auto?.schedule));
  const [days, setDays] = useState<boolean[]>(auto?.schedule ? auto.schedule.days.map((d) => d !== null) : [true, true, true, true, true, true, true]);
  const [from, setFrom] = useState(window ? timeOf(window[0]) : "18:00");
  const [to, setTo] = useState(window ? timeOf(window[1]) : "06:00");
  const [cooldown, setCooldown] = useState(String(auto?.cooldownMin ?? 0));
  const [kind, setKind] = useState<AutomationAction["type"]>(auto?.action.type ?? "notify");
  const [channel, setChannel] = useState<AddressChannel>(auto?.action.type === "notify" ? auto.action.channel : "email");
  const [addresses, setAddresses] = useState(auto?.action.type === "notify" ? auto.action.to.join(", ") : "");
  const [webhookId, setWebhookId] = useState(auto?.action.type === "webhook" ? auto.action.webhookId : "");
  const [title, setTitle] = useState(auto?.action.type === "order" ? (auto.action.title ?? "") : "");
  const [problem, setProblem] = useState<string | null>(null);
  const done = (next?: Automation[]) => {
    if (next) queryClient.setQueryData(["integrations", "automations"], next);
    else void queryClient.invalidateQueries({ queryKey: ["integrations", "automations"] });
    onClose();
  };
  const save = useMutation({ mutationFn: (body: AutomationInput) => saveAutomation(auto?.id ?? null, body), onSuccess: done });
  const remove = useMutation({ mutationFn: () => deleteAutomation(auto?.id ?? ""), onSuccess: () => done() });
  const hookId = webhookId || hooks.data?.[0]?.id || "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const wait = Number(cooldown);
    if (!name.trim()) return setProblem(t("integrations.giveName"));
    if (triggers.length === 0) return setProblem(t("integrations.automations.dialog.needTrigger"));
    if (scope === "group" && !groupId) return setProblem(t("integrations.automations.dialog.needGroup"));
    if (scope === "vehicles" && picked.size === 0) return setProblem(t("integrations.automations.dialog.needVehicle"));
    if (timed && !days.some(Boolean)) return setProblem(t("integrations.automations.dialog.needDay"));
    if (!Number.isInteger(wait) || wait < 0 || wait > 1440) return setProblem(t("integrations.automations.dialog.cooldownRange"));
    let action: AutomationAction;
    if (kind === "notify") {
      const list = addresses.split(/[\s,;]+/).filter(Boolean);
      // In the custom channel the destinations are optional: they only fill its variables.
      if ((list.length === 0 && channel !== "webhook") || list.length > 5) return setProblem(t("integrations.automations.dialog.needAddresses"));
      const wrong = list.map((address) => addressProblem(channel, address)).find((p) => p !== null);
      if (wrong) return setProblem(`${sayShared(wrong)}.`);
      action = { type: "notify", channel, to: list };
    } else if (kind === "webhook") {
      if (!hookId) return setProblem(t("integrations.automations.dialog.needWebhook"));
      action = { type: "webhook", webhookId: hookId };
    } else action = { type: "order", title: title.trim() || null };
    const fromMin = minutesOf(from);
    const toMin = minutesOf(to);
    const schedule: WeekSchedule | null = timed ? { zone: auto?.schedule?.zone ?? browserZone(), days: days.map((on) => (on ? [fromMin, toMin === fromMin ? 1440 : toMin] : null)) } : null;
    setProblem(null);
    save.mutate({ name: name.trim(), active, triggers, groupId: scope === "group" ? groupId : null, vehicleIds: scope === "vehicles" ? [...picked] : null, schedule, cooldownMin: wait, action });
  };
  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <Modal open onClose={onClose} title={auto ? auto.name : t("integrations.automations.dialog.new")} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("integrations.automations.dialog.namePlaceholder")} autoFocus={!auto} />

        <div>
          <span className={label}>{t("integrations.automations.dialog.when")}</span>
          <EventPicker value={triggers} onChange={setTriggers} idPrefix="auto-evento" />
        </div>

        <div>
          <span className={label}>{t("integrations.automations.dialog.where")}</span>
          <select aria-label={t("integrations.automations.dialog.whereLabel")} value={scope} onChange={(e) => setScope(e.target.value as Scope)} className={select}>
            <option value="all">{t("integrations.automations.dialog.allVehicles")}</option>
            {groups.length > 0 && <option value="group">{t("integrations.automations.dialog.groupOption")}</option>}
            <option value="vehicles">{t("integrations.automations.dialog.vehiclesOption")}</option>
          </select>
          {scope === "group" && (
            <select aria-label={t("common.group")} value={groupId} onChange={(e) => setGroupId(e.target.value)} className={clsx(select, "mt-2")}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {scope === "vehicles" && (
            <ul className="mt-2 max-h-[24dvh] divide-y divide-line overflow-y-auto rounded-[10px] border border-line">
              {vehicles.map((v) => (
                <li key={v.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-canvas">
                    <input type="checkbox" checked={picked.has(v.id)} onChange={() => toggle(v.id)} className="h-4 w-4 accent-ink" />
                    <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <label className="mt-3 flex cursor-pointer items-center gap-3 text-[14.5px] text-ink">
            <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} className="h-4 w-4 accent-ink" />
            {t("integrations.automations.dialog.timed")}
          </label>
          {timed && (
            <div className="mt-2 space-y-2 rounded-[12px] border border-line px-3 py-2.5">
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_KEYS.map((day, i) => (
                  <button key={day} type="button" aria-pressed={days[i]} onClick={() => setDays(days.map((on, j) => (j === i ? !on : on)))} className={clsx("h-8 rounded-full border px-3 text-[12.5px] font-medium", days[i] ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink-3")}>
                    {t(`shared.weekday.${day}`).slice(0, 3)}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-[12.5px] text-ink-3">
                  {t("common.from")}
                  <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="num mt-1 block h-9 rounded-[9px] border border-line bg-surface px-2.5 text-[13.5px] text-ink" />
                </label>
                <label className="text-[12.5px] text-ink-3">
                  {t("common.to")}
                  <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className="num mt-1 block h-9 rounded-[9px] border border-line bg-surface px-2.5 text-[13.5px] text-ink" />
                </label>
                <p className="pb-2 text-[12.5px] text-muted">{minutesOf(to) <= minutesOf(from) ? t("integrations.automations.dialog.overnight") : t("integrations.automations.dialog.localTime")}</p>
              </div>
            </div>
          )}
        </div>

        <div>
          <span className={label}>{t("integrations.automations.dialog.do")}</span>
          <select aria-label={t("integrations.automations.dialog.doLabel")} value={kind} onChange={(e) => setKind(e.target.value as AutomationAction["type"])} className={select}>
            <option value="notify">{t("shared.automationAction.notify")}</option>
            <option value="webhook">{t("shared.automationAction.webhook")}</option>
            {(modules.includes("E") || kind === "order") && <option value="order">{t("shared.automationAction.order")}</option>}
          </select>
          <div className="mt-2">
            {kind === "notify" && (
              <div className="space-y-2">
                <select aria-label={t("integrations.automations.dialog.channel")} value={channel} onChange={(e) => setChannel(e.target.value as AddressChannel)} className={select}>
                  {AUTOMATION_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {t(`shared.channel.${c}`)}
                    </option>
                  ))}
                </select>
                <Field label={t(ADDRESS_HINT[channel].label)} value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder={t(ADDRESS_HINT[channel].placeholder)} hint={t(channel === "webhook" ? "integrations.automations.dialog.customHint" : "integrations.automations.dialog.addressesHint")} />
              </div>
            )}
            {kind === "webhook" &&
              ((hooks.data ?? []).length === 0 ? (
                <p className="rounded-[10px] bg-canvas px-3 py-2.5 text-[13px] text-ink-3">{t("integrations.automations.dialog.noWebhooks")}</p>
              ) : (
                <select aria-label={t("integrations.automations.dialog.webhook")} value={hookId} onChange={(e) => setWebhookId(e.target.value)} className={select}>
                  {(hooks.data ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              ))}
            {kind === "order" && <Field label={t("integrations.automations.dialog.orderTitle")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={t("integrations.automations.dialog.orderPlaceholder")} hint={t("integrations.automations.dialog.orderHint")} />}
          </div>
        </div>

        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
          <Field label={t("integrations.automations.dialog.cooldown")} value={cooldown} onChange={(e) => setCooldown(e.target.value)} inputMode="numeric" mono hint={t("integrations.automations.dialog.cooldownHint")} />
          <label className="flex cursor-pointer items-center gap-3 pb-7 text-[14.5px] text-ink">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-ink" />
            {t("integrations.automations.dialog.active")}
          </label>
        </div>

        {auto && (
          <section className="space-y-2 rounded-[12px] bg-canvas px-4 py-3">
            <h3 className="text-[14px] font-semibold text-ink">{t("integrations.automations.dialog.runs")}</h3>
            {runs.isLoading && <Spinner className="text-muted" />}
            {runs.data &&
              (runs.data.length === 0 ? (
                <p className="text-[13px] text-muted">{t("integrations.automations.dialog.runsEmpty")}</p>
              ) : (
                <ul className="max-h-44 divide-y divide-line overflow-y-auto rounded-[10px] border border-line bg-surface text-[13px]">
                  {runs.data.map((r) => (
                    <li key={r.id} className="flex items-baseline justify-between gap-3 px-3 py-2">
                      <span className="min-w-0">
                        <span className="font-medium text-ink">{r.vehicleName ?? t("common.vehicle")}</span>
                        <span className="text-ink-3"> · {eventLabel(r.eventType)}</span>
                        <span className={clsx("block truncate text-[12.5px]", r.ok ? "text-muted" : "text-danger")}>{r.detail}</span>
                      </span>
                      <span className="num shrink-0 text-[12px] text-muted">{formatDateTime(r.at)}</span>
                    </li>
                  ))}
                </ul>
              ))}
          </section>
        )}

        {(problem || save.isError || remove.isError) && <Notice tone="error">{problem ?? errorText(save.error ?? remove.error)}</Notice>}
        <div className="flex items-center justify-between gap-2">
          {auto ? (
            <Button type="button" variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
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
      </form>
    </Modal>
  );
}
