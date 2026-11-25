// Service plans: how often each thing is due (by kilometers, engine
// hours or time), how far in advance a notification is sent and which vehicles it
// applies to. With templates so you do not start from scratch.
import { MAINT_TEMPLATES, type MaintPlan, type MaintPlanInput, type MaintTriggers, isSharedKey } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Plus, Trash } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import i18n, { sayShared } from "../../lib/i18n";
import { deleteMaintPlan, getMaintPlans, saveMaintPlan } from "../../lib/maintenance";
import { whole } from "../fleet/format";
import { Card } from "../reports/kit";
import { errorText } from "../widgets";

/** "cada 5.000 km, 250 h de motor o 180 días" */
export function triggersText(p: MaintTriggers): string {
  const parts = [
    p.everyKm !== null ? `${whole(p.everyKm)} km` : null,
    p.everyHours !== null ? i18n.t("maintenance.plans.hours", { count: p.everyHours, n: whole(p.everyHours) }) : null,
    p.everyDays !== null ? i18n.t("maintenance.plans.days", { count: p.everyDays, n: whole(p.everyDays) }) : null,
  ].filter((x): x is string => x !== null);
  return i18n.t("maintenance.plans.every", { list: parts.length > 1 ? i18n.t("maintenance.plans.or", { rest: parts.slice(0, -1).join(", "), last: parts[parts.length - 1] }) : parts[0] });
}
const warnText = (p: MaintTriggers) => {
  const parts = [p.everyKm !== null && p.warnKm ? `${whole(p.warnKm)} km` : null, p.everyHours !== null && p.warnHours ? `${whole(p.warnHours)} h` : null, p.everyDays !== null && p.warnDays ? i18n.t("maintenance.plans.warnDays", { count: p.warnDays, n: whole(p.warnDays) }) : null].filter((x): x is string => x !== null);
  return parts.length ? i18n.t("maintenance.plans.warn", { list: parts.join(", ") }) : i18n.t("maintenance.plans.warnDue");
};
/** The name of a plan template in the language of the interface. */
const templateName = (id: string) => {
  const key = `maintTemplate.${id}`;
  return isSharedKey(key) ? sayShared({ key }) : id;
};

export function PlansTab(props: { vehicles: { id: string; name: string }[]; canManage: boolean }) {
  const { t } = useTranslation();
  const plans = useQuery({ queryKey: ["maintenance", "plans"], queryFn: getMaintPlans });
  const [editing, setEditing] = useState<MaintPlan | "new" | null>(null);
  return (
    <div className="space-y-4">
      <Card
        title={t("maintenance.plans.title")}
        note={t("maintenance.plans.note")}
        action={
          props.canManage ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus size={15} aria-hidden="true" /> {t("maintenance.plans.new")}
            </Button>
          ) : undefined
        }
      >
        {plans.isLoading && (
          <div className="flex h-24 items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
        {plans.isError && <Notice tone="error">{errorText(plans.error)}</Notice>}
        {plans.data &&
          (plans.data.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm leading-relaxed text-ink-3">
              {props.canManage ? t("maintenance.plans.emptyManage") : t("maintenance.plans.empty")}
            </p>
          ) : (
            <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
              {plans.data.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => setEditing(p)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas/70">
                    <CalendarCheck size={18} className="shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] font-medium text-ink">{p.name}</span>
                      <span className="block text-[12.5px] text-muted">
                        {triggersText(p)} · {warnText(p)}
                      </span>
                    </span>
                    <span className="num shrink-0 text-[13px] text-ink-3">{t("maintenance.plans.vehicles", { count: p.vehicleIds.length })}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Card>
      {editing && <PlanDialog plan={editing === "new" ? null : editing} vehicles={props.vehicles} canManage={props.canManage} onClose={() => setEditing(null)} />}
    </div>
  );
}

const num = (n: number | null) => (n === null ? "" : String(n));
/** An integer typed by hand; empty is null. */
const whole0 = (text: string) => (text.trim() === "" ? null : Number(text.trim().replace(/[.\s]/g, "")));

function PlanDialog({ plan, vehicles, canManage, onClose }: { plan: MaintPlan | null; vehicles: { id: string; name: string }[]; canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(plan?.name ?? "");
  const [form, setForm] = useState({ everyKm: num(plan?.everyKm ?? null), everyHours: num(plan?.everyHours ?? null), everyDays: num(plan?.everyDays ?? null), warnKm: num(plan?.warnKm ?? null), warnHours: num(plan?.warnHours ?? null), warnDays: num(plan?.warnDays ?? null) });
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set(plan?.vehicleIds ?? []));
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const done = (next?: MaintPlan[]) => {
    if (next) queryClient.setQueryData(["maintenance", "plans"], next);
    void queryClient.invalidateQueries({ queryKey: ["maintenance"] });
    onClose();
  };
  const save = useMutation({ mutationFn: (body: MaintPlanInput) => saveMaintPlan(plan?.id ?? null, body), onSuccess: done });
  const remove = useMutation({ mutationFn: () => deleteMaintPlan(plan?.id ?? ""), onSuccess: () => done() });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const applyTemplate = (id: string) => {
    const template = MAINT_TEMPLATES.find((x) => x.id === id);
    if (!template) return;
    setName(templateName(template.id));
    setForm({ everyKm: num(template.everyKm), everyHours: num(template.everyHours), everyDays: num(template.everyDays), warnKm: num(template.warnKm), warnHours: num(template.warnHours), warnDays: num(template.warnDays) });
  };
  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const values = { everyKm: whole0(form.everyKm), everyHours: whole0(form.everyHours), everyDays: whole0(form.everyDays), warnKm: whole0(form.warnKm), warnHours: whole0(form.warnHours), warnDays: whole0(form.warnDays) };
    if (!name.trim()) return setProblem(t("maintenance.plans.needName"));
    if (Object.values(values).some((n) => n !== null && (!Number.isInteger(n) || n < 0))) return setProblem(t("maintenance.plans.wholeNumbers"));
    if (values.everyKm === null && values.everyHours === null && values.everyDays === null) return setProblem(t("maintenance.plans.needInterval"));
    if ([values.everyKm, values.everyHours, values.everyDays].some((n) => n === 0)) return setProblem(t("maintenance.plans.intervalZero"));
    setProblem(null);
    save.mutate({ name: name.trim(), ...values, notes: notes || null, vehicleIds: [...picked] });
  };
  return (
    <Modal open onClose={onClose} title={plan ? t("maintenance.plans.editTitle") : t("maintenance.plans.newTitle")} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <fieldset disabled={!canManage} className="space-y-4">
          {!plan && (
            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-ink-3">{t("maintenance.plans.template")}</span>
              <div className="flex flex-wrap gap-1.5">
                {MAINT_TEMPLATES.map((template) => (
                  <button key={template.id} type="button" onClick={() => applyTemplate(template.id)} className="h-8 rounded-full border border-line bg-surface px-3 text-[13px] font-medium text-ink-3 hover:border-ink hover:text-ink">
                    {templateName(template.id)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("maintenance.plans.namePlaceholder")} />
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-ink-3">{t("maintenance.plans.interval")}</span>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <Field label={t("maintenance.plans.km")} value={form.everyKm} onChange={set("everyKm")} inputMode="numeric" mono />
              <Field label={t("maintenance.plans.hoursField")} value={form.everyHours} onChange={set("everyHours")} inputMode="numeric" mono />
              <Field label={t("maintenance.plans.daysField")} value={form.everyDays} onChange={set("everyDays")} inputMode="numeric" mono />
            </div>
          </div>
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-ink-3">{t("maintenance.plans.warnAhead")}</span>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <Field label={t("maintenance.plans.kmBefore")} value={form.warnKm} onChange={set("warnKm")} inputMode="numeric" mono />
              <Field label={t("maintenance.plans.hoursBefore")} value={form.warnHours} onChange={set("warnHours")} inputMode="numeric" mono />
              <Field label={t("maintenance.plans.daysBefore")} value={form.warnDays} onChange={set("warnDays")} inputMode="numeric" mono />
            </div>
          </div>
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-ink-3">
              <Trans i18nKey="maintenance.plans.appliesTo" values={{ n: picked.size, total: vehicles.length }} components={{ muted: <span className="font-normal text-muted" /> }} />
            </span>
            {vehicles.length === 0 ? (
              <p className="text-[13px] text-muted">{t("maintenance.plans.noVehicles")}</p>
            ) : (
              <ul className="max-h-[32dvh] divide-y divide-line overflow-y-auto rounded-[10px] border border-line">
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
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{t("maintenance.plans.joinNote")}</p>
          </div>
          <Field label={t("maintenance.plans.notes")} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </fieldset>
        {(problem || save.isError || remove.isError) && <Notice tone="error">{problem ?? errorText(save.error ?? remove.error)}</Notice>}
        {canManage &&
          (confirming ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-danger/25 bg-danger/5 px-3.5 py-2.5">
              <span className="text-sm text-danger">{t("maintenance.plans.confirmDelete")}</span>
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
              {plan ? (
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
          ))}
      </form>
    </Modal>
  );
}
