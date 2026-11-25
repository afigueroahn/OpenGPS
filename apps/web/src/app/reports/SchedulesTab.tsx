// Scheduled reports: a report that arrives on its own by email, every day, every
// week or every month, to the account people who are chosen.
import {
  type ModuleKey,
  REPORT_FREQUENCIES,
  REPORT_PARAMS_DEFAULT,
  type ReportFormat,
  type ReportFrequency,
  type ReportSchedule,
  type ReportScheduleInput,
  type ReportType,
  SCHEDULES_MAX,
  SCHEDULE_RECIPIENTS_MAX,
  type Vehicle,
  type VehicleGroup,
  WEEKDAY_KEYS,
  minuteLabel,
} from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CalendarClock, Mail, Pause, Pencil, Play, Plus, Send, Trash } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { type SchedulesData, browserZone, deleteSchedule, getSchedules, saveSchedule, sendSchedule } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import i18n from "../../lib/i18n";
import { ConfirmDialog, errorText } from "../widgets";
import { REPORT_ICON, type ReportDraft, reportsFor } from "./ReportsTab";
import { type Scope, ScopeSelect, Segmented, inputClass, labelClass } from "./kit";

const FORMATS: { id: ReportFormat; label: string }[] = [
  { id: "pdf", label: "PDF" },
  { id: "xlsx", label: "Excel" },
];
const zoneName = (zone: string) => zone.replace(/_/g, " ");

/** "Cada lunes a las 07:00" */
export function whenText(s: Pick<ReportSchedule, "frequency" | "atMinute" | "weekday" | "monthDay">): string {
  const hour = minuteLabel(s.atMinute);
  if (s.frequency === "daily") return i18n.t("reports.schedules.when.daily", { hour });
  if (s.frequency === "weekly") {
    const day = WEEKDAY_KEYS[s.weekday];
    return i18n.t("reports.schedules.when.weekly", { day: day ? i18n.t(`reports.schedules.weekdayInSentence.${day}`) : "", hour });
  }
  return i18n.t("reports.schedules.when.monthly", { day: s.monthDay, hour });
}
/** The name a scheduled report gets when none is written: "Kilometraje · cada día". */
const defaultName = (type: ReportType, frequency: ReportFrequency) => `${i18n.t(`shared.report.${type}`)} · ${i18n.t(`shared.reportFrequency.${frequency}`).toLowerCase()}`;

const toInput = (s: ReportSchedule, patch: Partial<ReportScheduleInput> = {}): ReportScheduleInput => ({
  name: s.name,
  type: s.type,
  params: s.params,
  frequency: s.frequency,
  atMinute: s.atMinute,
  weekday: s.weekday,
  monthDay: s.monthDay,
  zone: s.zone,
  format: s.format,
  recipients: s.recipients.map((p) => p.userId),
  active: s.active,
  ...patch,
});

export function SchedulesTab(props: {
  vehicles: Vehicle[];
  groups: VehicleGroup[];
  modules: ModuleKey[];
  meId: string;
  /** Report to schedule, if reached from a report's "Programar" button. */
  draft: ReportDraft | null;
  onDraftUsed: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["report-schedules"], queryFn: getSchedules });
  const [editing, setEditing] = useState<ReportSchedule | "new" | null>(null);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [removing, setRemoving] = useState<ReportSchedule | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!props.draft) return;
    setDraft(props.draft);
    setEditing("new");
    props.onDraftUsed();
  }, [props.draft, props.onDraftUsed]);

  const update = (schedule: ReportSchedule) =>
    queryClient.setQueryData<SchedulesData>(["report-schedules"], (old) => (old ? { ...old, schedules: old.schedules.map((s) => (s.id === schedule.id ? schedule : s)) } : old));
  const toggle = useMutation({
    mutationFn: (s: ReportSchedule) => saveSchedule(toInput(s, { active: !s.active }), s.id),
    onSuccess: update,
    onError: (err) => setNotice({ tone: "error", text: errorText(err) }),
  });
  const send = useMutation({
    mutationFn: (s: ReportSchedule) => sendSchedule(s.id),
    onMutate: () => setNotice(null),
    onSuccess: (result) => {
      update(result.schedule);
      setNotice({ tone: "success", text: t("reports.schedules.sent", { name: result.schedule.name, count: result.sentTo }) });
    },
    onError: (err) => {
      setNotice({ tone: "error", text: errorText(err) });
      void queryClient.invalidateQueries({ queryKey: ["report-schedules"] });
    },
  });

  const schedules = query.data?.schedules ?? [];
  const full = schedules.length >= SCHEDULES_MAX;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight">{t("reports.schedules.title")}</h1>
          <p className="mt-0.5 max-w-[62ch] text-sm text-muted">{t("reports.schedules.lead")}</p>
        </div>
        <Button
          size="sm"
          disabled={full || !query.data}
          title={full ? t("reports.schedules.full", { max: SCHEDULES_MAX }) : undefined}
          onClick={() => {
            setDraft(null);
            setEditing("new");
          }}
        >
          <Plus size={15} strokeWidth={2.5} /> {t("reports.schedules.new")}
        </Button>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {query.isLoading && (
        <div className="flex h-40 items-center justify-center text-muted">
          <Spinner size={22} />
        </div>
      )}
      {query.isError && <Notice tone="error">{errorText(query.error)}</Notice>}
      {query.data && schedules.length === 0 && (
        <div className="rounded-[14px] border border-dashed border-line bg-surface px-5 py-10 text-center">
          <CalendarClock size={26} className="mx-auto text-faint" />
          <p className="mt-3 text-[15px] font-medium">{t("reports.schedules.empty.title")}</p>
          <p className="mx-auto mt-1 max-w-[46ch] text-sm text-muted">{t("reports.schedules.empty.lead")}</p>
        </div>
      )}
      <ul className="space-y-3">
        {schedules.map((s) => {
          const Icon = REPORT_ICON[s.type];
          const sending = send.isPending && send.variables?.id === s.id;
          return (
            <li key={s.id} className={clsx("rounded-[14px] border border-line bg-surface p-4", !s.active && "opacity-75")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-canvas text-ink-3">
                    <Icon size={17} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-semibold">{s.name}</p>
                    <p className="text-[13px] text-muted">
                      {t("reports.schedules.summary", { report: t(`shared.report.${s.type}`), format: s.format === "pdf" ? "PDF" : "Excel" })} · {whenText(s)}
                      {s.zone !== browserZone() && ` ${t("reports.schedules.zone", { zone: zoneName(s.zone) })}`}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button variant="secondary" size="sm" loading={sending} disabled={send.isPending} onClick={() => send.mutate(s)}>
                    {!sending && <Send size={14} />} {t("reports.schedules.sendNow")}
                  </Button>
                  <IconButton label={s.active ? t("reports.schedules.pause") : t("reports.schedules.resume")} onClick={() => toggle.mutate(s)} disabled={toggle.isPending}>
                    {s.active ? <Pause size={15} /> : <Play size={15} />}
                  </IconButton>
                  <IconButton label={t("common.edit")} onClick={() => setEditing(s)}>
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton label={t("reports.schedules.delete")} onClick={() => setRemoving(s)}>
                    <Trash size={15} />
                  </IconButton>
                </div>
              </div>
              <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-3">
                <div className="min-w-0">
                  <dt className="text-muted">{t("reports.schedules.recipients")}</dt>
                  <dd className="truncate" title={s.recipients.map((p) => p.email).join(", ")}>
                    {s.recipients.length === 0 ? t("reports.schedules.noRecipients") : s.recipients.map((p) => p.name).join(", ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">{t("reports.schedules.next")}</dt>
                  <dd>{s.active ? formatDateTime(s.nextRunAt) : t("reports.schedules.paused")}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted">{t("reports.schedules.last")}</dt>
                  <dd className={clsx(s.lastRun && !s.lastRun.ok && "text-danger")}>
                    {s.lastRun ? (s.lastRun.ok ? formatDateTime(s.lastRun.at) : t("reports.schedules.lastFailed", { when: formatDateTime(s.lastRun.at), error: s.lastRun.error ?? t("reports.schedules.noDetail") })) : t("reports.schedules.never")}
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>

      {query.data && editing && (
        <ScheduleDialog
          key={editing === "new" ? `new:${draft?.type ?? ""}` : editing.id}
          schedule={editing === "new" ? null : editing}
          draft={editing === "new" ? draft : null}
          people={query.data.people}
          vehicles={props.vehicles}
          groups={props.groups}
          modules={props.modules}
          meId={props.meId}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={t("reports.schedules.remove.title")}
        confirm={t("reports.schedules.remove.confirm")}
        onClose={() => setRemoving(null)}
        action={() => deleteSchedule((removing as ReportSchedule).id)}
        onDone={() => void queryClient.invalidateQueries({ queryKey: ["report-schedules"] })}
      >
        {t("reports.schedules.remove.body", { name: removing?.name ?? "" })}
      </ConfirmDialog>
    </div>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="flex h-8 w-8 items-center justify-center rounded-[10px] text-muted hover:bg-canvas hover:text-ink disabled:opacity-50">
      {children}
    </button>
  );
}

function ScheduleDialog(props: {
  schedule: ReportSchedule | null;
  draft: ReportDraft | null;
  people: SchedulesData["people"];
  vehicles: Vehicle[];
  groups: VehicleGroup[];
  modules: ModuleKey[];
  meId: string;
  onClose: () => void;
}) {
  const { schedule } = props;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const start = schedule?.params ?? props.draft?.params ?? REPORT_PARAMS_DEFAULT;
  const [type, setType] = useState<ReportType>(schedule?.type ?? props.draft?.type ?? "mileage");
  const [name, setName] = useState(schedule?.name ?? "");
  const [scope, setScope] = useState<Scope>({ groupId: start.groupId, vehicleIds: start.vehicleIds });
  const [limit, setLimit] = useState(String(start.speedLimitKmh));
  const [minStop, setMinStop] = useState(String(start.minStopMin));
  const [frequency, setFrequency] = useState<ReportFrequency>(schedule?.frequency ?? "daily");
  const [weekday, setWeekday] = useState(schedule?.weekday ?? 1);
  const [monthDay, setMonthDay] = useState(schedule?.monthDay ?? 1);
  const [time, setTime] = useState(minuteLabel(schedule?.atMinute ?? 7 * 60));
  const [format, setFormat] = useState<ReportFormat>(schedule?.format ?? "pdf");
  const [recipients, setRecipients] = useState<Set<string>>(() => new Set(schedule ? schedule.recipients.map((p) => p.userId) : [props.meId]));
  // An existing report keeps the zone it was scheduled with.
  const zone = schedule?.zone ?? browserZone();

  const save = useMutation({
    mutationFn: () => {
      const [hours, minutes] = time.split(":").map(Number);
      return saveSchedule(
        {
          name: name.trim() || defaultName(type, frequency),
          type,
          params: { ...scope, speedLimitKmh: Number(limit) || REPORT_PARAMS_DEFAULT.speedLimitKmh, minStopMin: Number(minStop) || REPORT_PARAMS_DEFAULT.minStopMin },
          frequency,
          atMinute: (hours ?? 7) * 60 + (minutes ?? 0),
          weekday,
          monthDay,
          zone,
          format,
          recipients: [...recipients],
          active: schedule?.active ?? true,
        },
        schedule?.id,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["report-schedules"] });
      props.onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const toggle = (id: string) =>
    setRecipients((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Modal open onClose={props.onClose} title={schedule ? t("reports.schedules.dialog.editTitle") : t("reports.schedules.dialog.newTitle")} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            <span className={labelClass}>{t("reports.report")}</span>
            <select className={clsx(inputClass, "w-full")} value={type} onChange={(e) => setType(e.target.value as ReportType)}>
              {reportsFor(props.modules).map((r) => (
                <option key={r} value={r}>
                  {t(`shared.report.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <div>
            <label htmlFor="informe-vehiculos" className={labelClass}>
              {t("common.vehicles")}
            </label>
            <div className="flex">
              <ScopeSelect id="informe-vehiculos" scope={scope} onChange={setScope} groups={props.groups} vehicles={props.vehicles} />
            </div>
          </div>
        </div>
        <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={defaultName(type, frequency)} hint={t("reports.schedules.dialog.nameHint")} />
        {type === "speed" && <Field label={t("reports.schedules.dialog.speedLimit")} type="number" min={20} max={200} value={limit} onChange={(e) => setLimit(e.target.value)} mono />}
        {type === "stops" && <Field label={t("reports.schedules.dialog.minStop")} type="number" min={3} max={1440} value={minStop} onChange={(e) => setMinStop(e.target.value)} mono />}

        <div>
          <span className={labelClass}>{t("reports.schedules.dialog.frequency")}</span>
          <Segmented label={t("reports.schedules.dialog.frequency")} options={REPORT_FREQUENCIES.map((id) => ({ id, label: t(`shared.reportFrequency.${id}`) }))} value={frequency} onChange={setFrequency} />
          <p className="mt-1.5 text-[13px] text-muted">{t("reports.schedules.dialog.covers", { period: t(`shared.reportFrequencyPeriod.${frequency}`) })}</p>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          {frequency === "weekly" && (
            <label>
              <span className={labelClass}>{t("reports.schedules.dialog.weekday")}</span>
              <select className={inputClass} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <option key={d} value={d}>
                    {t(`shared.weekday.${WEEKDAY_KEYS[d] ?? "sunday"}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {frequency === "monthly" && (
            <label>
              <span className={labelClass}>{t("reports.schedules.dialog.monthDay")}</span>
              <select className={inputClass} value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className={labelClass}>{t("reports.schedules.dialog.time")}</span>
            <input type="time" required className={clsx(inputClass, "num")} value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <div>
            <span className={labelClass}>{t("reports.schedules.dialog.file")}</span>
            <Segmented label={t("reports.schedules.dialog.file")} options={FORMATS} value={format} onChange={setFormat} />
          </div>
        </div>
        <p className="-mt-1 text-[13px] text-muted">{t("reports.schedules.dialog.zone", { zone: zoneName(zone) })}</p>

        <fieldset>
          <legend className={labelClass}>
            <Mail size={13} className="mr-1 inline align-[-2px]" />
            {t("reports.schedules.dialog.recipients")}
          </legend>
          <ul className="max-h-44 divide-y divide-line overflow-y-auto rounded-[10px] border border-line">
            {props.people.map((p) => (
              <li key={p.userId}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-canvas">
                  <input type="checkbox" className="h-4 w-4 accent-ink" checked={recipients.has(p.userId)} onChange={() => toggle(p.userId)} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="min-w-0 max-w-[55%] truncate text-[12.5px] text-muted">{p.email}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[13px] text-muted">{t("reports.schedules.dialog.recipientsNote", { max: SCHEDULE_RECIPIENTS_MAX })}</p>
        </fieldset>

        {save.isError && <Notice tone="error">{errorText(save.error)}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={recipients.size === 0 || recipients.size > SCHEDULE_RECIPIENTS_MAX}>
            {schedule ? t("common.save") : t("reports.view.schedule")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
