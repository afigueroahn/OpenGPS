// What needs attention: each vehicle's scheduled services with what
// they are missing, and document expirations.
import { CURRENCIES, MAINT_EXPIRY_KINDS, type MaintDueStatus, type MaintExpiry, type MaintExpiryInput, type MaintExpiryKind, type MaintOverview, type MaintSchedule, type MaintSettings } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ClipboardList, Pencil, Plus, Settings2, Trash } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import i18n from "../../lib/i18n";
import { deleteMaintExpiry, getMaintSettings, getMaintenance, saveMaintExpiry, saveMaintSettings, setMaintBaseline } from "../../lib/maintenance";
import { amountOf, currencyName, dayLabel, today, whole } from "../fleet/format";
import { Card, Tile } from "../reports/kit";
import { errorText } from "../widgets";
import type { OrderDraft } from "./OrderDialog";

const select = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
const label = "mb-1.5 block text-[13px] font-medium text-ink-3";
const DUE_STYLE: Record<MaintDueStatus, string> = { due: "bg-danger/10 text-danger", soon: "bg-idle/15 text-[#8a5a00]", ok: "bg-moving/10 text-signal-ink" };

export function DueBadge({ status }: { status: MaintDueStatus }) {
  const { t } = useTranslation();
  return <span className={clsx("inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold", DUE_STYLE[status])}>{t(`shared.maintDue.${status}`)}</span>;
}

const expiryText = (e: MaintExpiry) => (e.daysLeft < 0 ? i18n.t("maintenance.pending.expiries.expired", { date: dayLabel(e.expiresOn) }) : e.daysLeft === 0 ? i18n.t("maintenance.pending.expiries.today") : i18n.t("maintenance.pending.expiries.expires", { date: dayLabel(e.expiresOn), count: e.daysLeft }));

export function PendingTab(props: { vehicles: { id: string; name: string }[]; canManage: boolean; onOrder: (draft: OrderDraft) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ["maintenance", "overview"], queryFn: getMaintenance, refetchInterval: 120_000 });
  const [baseline, setBaseline] = useState<MaintSchedule | null>(null);
  const [expiry, setExpiry] = useState<MaintExpiry | "new" | null>(null);
  const [settings, setSettings] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const put = (next: MaintOverview) => queryClient.setQueryData(["maintenance", "overview"], next);
  const removeExpiry = useMutation({ mutationFn: (id: string) => deleteMaintExpiry(id), onSuccess: put, onError: (err) => setFailed(errorText(err)) });

  if (overview.isLoading) {
    return (
      <div className="flex h-48 items-center justify-center text-muted">
        <Spinner size={22} />
      </div>
    );
  }
  if (overview.isError || !overview.data) return <Notice tone="error">{errorText(overview.error)}</Notice>;
  const { schedules, expiries, openOrders } = overview.data;
  const count = (status: MaintDueStatus) => schedules.filter((s) => s.status === status).length;
  const expiring = expiries.filter((e) => e.status !== "ok").length;
  const num = <span className="num" />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile raised label={t("maintenance.pending.tiles.due")} value={String(count("due"))} foot={t("maintenance.pending.tiles.dueFoot")} />
        <Tile raised label={t("maintenance.pending.tiles.soon")} value={String(count("soon"))} foot={t("maintenance.pending.tiles.soonFoot")} />
        <Tile raised label={t("maintenance.pending.tiles.open")} value={String(openOrders)} foot={t("maintenance.pending.tiles.openFoot")} />
        <Tile raised label={t("maintenance.pending.tiles.documents")} value={String(expiring)} foot={t("maintenance.pending.tiles.documentsFoot")} />
      </div>
      {failed && <Notice tone="error">{failed}</Notice>}

      <Card
        title={t("maintenance.pending.schedules.title")}
        note={t("maintenance.pending.schedules.note")}
        action={
          props.canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setSettings(true)}>
              <Settings2 size={14} aria-hidden="true" /> {t("maintenance.pending.schedules.settings")}
            </Button>
          ) : undefined
        }
      >
        {schedules.length === 0 ? (
          <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{t("maintenance.pending.schedules.empty")}</p>
        ) : (
          <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
            {schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <span className="min-w-0 flex-1 basis-60">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[14.5px] font-medium text-ink">{s.planName}</span>
                    <span className="truncate text-[13px] text-ink-3">{s.vehicleName}</span>
                  </span>
                  <span className={clsx("block text-[13px]", s.status === "due" ? "font-medium text-danger" : "text-ink-3")}>{s.reason.charAt(0).toUpperCase() + s.reason.slice(1)}</span>
                  <span className="block text-[12.5px] text-muted">
                    <Trans i18nKey="maintenance.pending.schedules.last" values={{ date: dayLabel(s.lastOn) }} components={{ num }} />
                    {s.lastKm !== null && s.dueKm !== null && (
                      <>
                        {" "}
                        <Trans i18nKey="maintenance.pending.schedules.dueKm" values={{ km: whole(s.dueKm) }} components={{ num }} />
                      </>
                    )}
                    {s.dueHours !== null && (
                      <>
                        {" "}
                        <Trans i18nKey="maintenance.pending.schedules.dueHours" values={{ hours: whole(s.dueHours) }} components={{ num }} />
                      </>
                    )}
                    {s.dueOn && (
                      <>
                        {" "}
                        <Trans i18nKey="maintenance.pending.schedules.dueOn" values={{ date: dayLabel(s.dueOn) }} components={{ num }} />
                      </>
                    )}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <DueBadge status={s.status} />
                  {props.canManage && (
                    <>
                      <button type="button" onClick={() => setBaseline(s)} aria-label={t("maintenance.pending.schedules.fixLast", { plan: s.planName, vehicle: s.vehicleName })} title={t("maintenance.pending.schedules.fixLastTitle")} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-ink">
                        <Pencil size={15} />
                      </button>
                      <Button variant={s.status === "ok" ? "secondary" : "primary"} size="sm" onClick={() => props.onOrder({ vehicleId: s.vehicleId, scheduleId: s.id, title: s.planName })} disabled={s.openOrderId !== null} title={s.openOrderId ? t("maintenance.pending.schedules.hasOrder") : undefined}>
                        <ClipboardList size={14} aria-hidden="true" /> {s.openOrderId ? t("maintenance.pending.schedules.withOrder") : t("maintenance.pending.schedules.order")}
                      </Button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={t("maintenance.pending.expiries.title")}
        note={t("maintenance.pending.expiries.note")}
        action={
          props.canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setExpiry("new")} disabled={props.vehicles.length === 0}>
              <Plus size={14} aria-hidden="true" /> {t("maintenance.pending.expiries.add")}
            </Button>
          ) : undefined
        }
      >
        {expiries.length === 0 ? (
          <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{t("maintenance.pending.expiries.empty")}</p>
        ) : (
          <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
            {expiries.map((e) => (
              <li key={`${e.source}-${e.id}`} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[14.5px] font-medium text-ink">
                      {t(`shared.maintExpiry.${e.kind}`)}
                      {e.name && <span className="font-normal text-ink-3"> · {e.name}</span>}
                    </span>
                    <span className="truncate text-[13px] text-ink-3">{e.vehicleName}</span>
                  </span>
                  <span className={clsx("block text-[12.5px]", e.status === "due" ? "font-medium text-danger" : "text-muted")}>
                    {expiryText(e).charAt(0).toUpperCase() + expiryText(e).slice(1)}
                    {e.source === "fleet" && <> · {t("maintenance.pending.expiries.fromFleet")}</>}
                    {e.note && <> · {e.note}</>}
                  </span>
                </span>
                <DueBadge status={e.status} />
                {props.canManage && (
                  <span className="flex w-[68px] shrink-0 justify-end">
                    {e.source === "own" && (
                      <>
                        <button type="button" onClick={() => setExpiry(e)} aria-label={t("maintenance.pending.expiries.edit", { vehicle: e.vehicleName })} title={t("common.edit")} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-ink">
                          <Pencil size={15} />
                        </button>
                        <button type="button" onClick={() => removeExpiry.mutate(e.id)} aria-label={t("maintenance.pending.expiries.remove", { vehicle: e.vehicleName })} title={t("common.remove")} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-danger">
                          <Trash size={15} />
                        </button>
                      </>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {baseline && <BaselineDialog schedule={baseline} onClose={() => setBaseline(null)} onSaved={put} />}
      {expiry && <ExpiryDialog expiry={expiry === "new" ? null : expiry} vehicles={props.vehicles} onClose={() => setExpiry(null)} onSaved={put} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </div>
  );
}

/** When the service was last done: what remains is counted from there. */
function BaselineDialog({ schedule, onClose, onSaved }: { schedule: MaintSchedule; onClose: () => void; onSaved: (next: MaintOverview) => void }) {
  const { t } = useTranslation();
  const [lastOn, setLastOn] = useState(schedule.lastOn);
  const [lastKm, setLastKm] = useState(schedule.lastKm === null ? "" : String(Math.round(schedule.lastKm)));
  const [lastHours, setLastHours] = useState(schedule.lastHours === null ? "" : String(Math.round(schedule.lastHours * 10) / 10));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { lastOn: string; lastKm: number | null; lastHours: number | null }) => setMaintBaseline(schedule.id, body),
    onSuccess: (next) => {
      onSaved(next);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const km = amountOf(lastKm);
    const hours = amountOf(lastHours);
    if (!lastOn) return setProblem(t("maintenance.pending.baseline.needDate"));
    if ([km, hours].some((n) => n !== null && !(n >= 0))) return setProblem(t("maintenance.pending.baseline.numbers"));
    setProblem(null);
    save.mutate({ lastOn, lastKm: km, lastHours: hours });
  };
  return (
    <Modal open onClose={onClose} title={`${schedule.planName} · ${schedule.vehicleName}`}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <p className="text-[13.5px] leading-relaxed text-ink-3">{t("maintenance.pending.baseline.lead")}</p>
        <Field label={t("maintenance.pending.baseline.date")} type="date" value={lastOn} max={today()} onChange={(e) => setLastOn(e.target.value)} mono />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("maintenance.pending.baseline.km")} value={lastKm} onChange={(e) => setLastKm(e.target.value)} inputMode="decimal" mono />
          <Field label={t("maintenance.pending.baseline.hours")} value={lastHours} onChange={(e) => setLastHours(e.target.value)} inputMode="decimal" mono />
        </div>
        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ExpiryDialog({ expiry, vehicles, onClose, onSaved }: { expiry: MaintExpiry | null; vehicles: { id: string; name: string }[]; onClose: () => void; onSaved: (next: MaintOverview) => void }) {
  const { t } = useTranslation();
  const [vehicleId, setVehicleId] = useState(expiry?.vehicleId ?? vehicles[0]?.id ?? "");
  const [kind, setKind] = useState<MaintExpiryKind>(expiry?.kind ?? "insurance");
  const [name, setName] = useState(expiry?.name ?? "");
  const [expiresOn, setExpiresOn] = useState(expiry?.expiresOn ?? "");
  const [warnDays, setWarnDays] = useState(String(expiry?.warnDays ?? 30));
  const [note, setNote] = useState(expiry?.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: MaintExpiryInput) => saveMaintExpiry(expiry?.id ?? null, body),
    onSuccess: (next) => {
      onSaved(next);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const days = Number(warnDays);
    if (!expiresOn) return setProblem(t("maintenance.pending.expiry.needDate"));
    if (!Number.isInteger(days) || days < 0 || days > 365) return setProblem(t("maintenance.pending.expiry.warnRange"));
    setProblem(null);
    save.mutate({ vehicleId, kind, name: name || null, expiresOn, warnDays: days, note: note || null });
  };
  return (
    <Modal open onClose={onClose} title={expiry ? t("maintenance.pending.expiry.editTitle") : t("maintenance.pending.expiry.newTitle")}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label htmlFor="vence-vehiculo" className={label}>
            {t("common.vehicle")}
          </label>
          <select id="vence-vehiculo" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={select}>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="vence-tipo" className={label}>
              {t("maintenance.pending.expiry.kind")}
            </label>
            <select id="vence-tipo" value={kind} onChange={(e) => setKind(e.target.value as MaintExpiryKind)} className={select}>
              {MAINT_EXPIRY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`shared.maintExpiry.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <Field label={t("maintenance.pending.expiry.expiresOn")} type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} mono />
        </div>
        <Field label={t("maintenance.pending.expiry.detail")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("maintenance.pending.expiry.detailPlaceholder")} />
        <Field label={t("maintenance.pending.expiry.warnDays")} value={warnDays} onChange={(e) => setWarnDays(e.target.value)} inputMode="numeric" mono />
        <Field label={t("maintenance.pending.expiry.note")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["maintenance", "settings"], queryFn: getMaintSettings });
  const [draft, setDraft] = useState<MaintSettings | null>(null);
  const current = draft ?? settings.data ?? null;
  const save = useMutation({
    mutationFn: (body: MaintSettings) => saveMaintSettings(body),
    onSuccess: (next) => {
      queryClient.setQueryData(["maintenance", "settings"], next);
      onClose();
    },
  });
  const listed = CURRENCIES.map((c) => c.code);
  const coins = current && !listed.includes(current.currency) ? [current.currency, ...listed] : listed;
  return (
    <Modal open onClose={onClose} title={t("maintenance.pending.settings.title")}>
      {!current ? (
        <div className="flex h-24 items-center justify-center text-muted">{settings.isError ? <Notice tone="error">{errorText(settings.error)}</Notice> : <Spinner />}</div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(current);
          }}
        >
          <p className="text-[13.5px] leading-relaxed text-ink-3">{t("maintenance.pending.settings.lead")}</p>
          <p className="text-[13px] leading-relaxed text-ink-3">{t("maintenance.pending.settings.who")}</p>
          <div>
            <label htmlFor="mant-moneda" className={label}>
              {t("maintenance.pending.settings.currency")}
            </label>
            <select id="mant-moneda" value={current.currency} onChange={(e) => setDraft({ ...current, currency: e.target.value })} className={select}>
              {coins.map((code) => (
                <option key={code} value={code}>
                  {code} · {currencyName(code)}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[12.5px] text-muted">{t("maintenance.pending.settings.currencyNote")}</p>
          </div>
          {save.isError && <Notice tone="error">{errorText(save.error)}</Notice>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
