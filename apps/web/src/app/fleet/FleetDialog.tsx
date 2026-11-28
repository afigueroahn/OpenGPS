// Fleet profile of a vehicle: its data, its availability and whether it is
// active, who it is assigned to, its documents and its useful life.
import { CURRENCIES, FLEET_DOCUMENT_KINDS, FLEET_STATES, FLEET_STATUSES, type FleetDetail, type FleetDocumentKind, type FleetProfileInput, type FleetState, type FleetStatus, isSharedKey } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { FileText, FileUp, Trash, TriangleAlert } from "lucide-react";
import type { ParseKeys } from "i18next";
import { type FormEvent, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { addFleetAssignment, deleteFleetDocument, fleetDocumentUrl, getFleetAssignments, getFleetVehicle, removeFleetAssignment, saveFleetProfile, setFleetState, setFleetStatus, uploadFleetDocument } from "../../lib/api";
import { decimalMark, formatDateTime } from "../../lib/format";
import { sayShared } from "../../lib/i18n";
import { ConfirmBar, errorText } from "../widgets";
import { FLEET_KIND_VALUES, amountOf, currencyName, dayLabel, daysUntil, kindLabel, money, today, whole } from "./format";

const lightSelect = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
const label = "mb-1.5 block text-[13px] font-medium text-ink-3";
/** A short number typed by hand, such as the year or the years of useful life. */
const numberOf = (text: string) => (text.trim() === "" ? null : Number(text.trim().replace(",", ".")));

type Tab = "profile" | "status" | "assigned" | "documents" | "life";
const TABS: { id: Tab; label: ParseKeys; short?: ParseKeys }[] = [
  { id: "profile", label: "fleet.dialog.tabs.profile" },
  { id: "status", label: "fleet.dialog.tabs.status" },
  { id: "assigned", label: "fleet.dialog.tabs.assigned", short: "fleet.dialog.tabs.assignedShort" },
  { id: "documents", label: "fleet.dialog.tabs.documents", short: "fleet.dialog.tabs.documentsShort" },
  { id: "life", label: "fleet.dialog.tabs.life" },
];
/** What a value of the change log says: an availability or a state, or the value itself when it is not known. */
const logValue = (field: string, value: string) => {
  const key = `${field === "status" ? "fleetAvailability" : "fleetState"}.${value}`;
  return isSharedKey(key) ? sayShared({ key }) : value;
};

export function FleetDialog({ vehicleId, canManage, onClose }: { vehicleId: string; canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["fleet", vehicleId], queryFn: () => getFleetVehicle(vehicleId) });
  const [tab, setTab] = useState<Tab>("profile");
  /** What each change returns is the whole profile: it is left in place and the list is requested again. */
  const put = (next: FleetDetail) => {
    queryClient.setQueryData(["fleet", vehicleId], next);
    void queryClient.invalidateQueries({ queryKey: ["fleet"], exact: true });
  };
  const v = detail.data;
  return (
    <Modal open onClose={onClose} title={v ? `${v.name}${v.plate ? ` · ${v.plate}` : ""}` : t("fleet.dialog.title")} wide>
      {detail.isLoading && (
        <div className="flex h-40 items-center justify-center text-muted">
          <Spinner />
        </div>
      )}
      {detail.isError && <Notice tone="error">{errorText(detail.error)}</Notice>}
      {v && (
        // With a minimum height, the tabs do not jump around when switching from one to another.
        <div className="min-h-[min(440px,62dvh)] space-y-5">
          <div className="flex gap-0.5 rounded-[10px] bg-canvas p-1 sm:gap-1" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                aria-label={t(item.label)}
                onClick={() => setTab(item.id)}
                className={clsx("h-8 flex-auto whitespace-nowrap rounded-lg px-1 text-[12px] font-medium tracking-tight transition-colors sm:px-2.5 sm:text-[13px] sm:tracking-normal", tab === item.id ? "bg-primary text-on-primary" : "text-ink-3 hover:text-ink")}
              >
                {/* On the phone all five fit with the short name. */}
                {item.short ? (
                  <>
                    <span className="sm:hidden">{t(item.short)}</span>
                    <span className="hidden sm:inline">{t(item.label)}</span>
                  </>
                ) : (
                  t(item.label)
                )}
                {item.id === "documents" && v.expiring > 0 && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[#ff6f66] align-middle" role="img" aria-label={t("fleet.dialog.expiringDot")} />}
              </button>
            ))}
          </div>
          {tab === "profile" && <ProfileTab v={v} canManage={canManage} onSaved={put} />}
          {tab === "status" && <StateTab v={v} canManage={canManage} onSaved={put} />}
          {tab === "assigned" && <AssignedTab v={v} canManage={canManage} />}
          {tab === "documents" && <DocumentsTab v={v} canManage={canManage} onSaved={put} />}
          {tab === "life" && <LifeTab v={v} canManage={canManage} onSaved={put} />}
        </div>
      )}
    </Modal>
  );
}

/** What is saved of the profile: all together, so each tab also sends what has not changed. */
const profileOf = (v: FleetDetail): FleetProfileInput => ({
  vin: v.vin,
  brand: v.brand,
  model: v.model,
  year: v.year,
  color: v.color,
  kind: v.kind,
  notes: v.notes,
  purchaseDate: v.purchaseDate,
  purchasePrice: v.purchasePrice,
  currency: v.currency,
  salvageValue: v.salvageValue,
  lifeYears: v.lifeYears,
  purchaseOdometerKm: v.purchaseOdometerKm,
});

// ─── Profile ───────────────────────────────────────────────────────────────────

function ProfileTab({ v, canManage, onSaved }: { v: FleetDetail; canManage: boolean; onSaved: (v: FleetDetail) => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ vin: v.vin ?? "", brand: v.brand ?? "", model: v.model ?? "", year: v.year ? String(v.year) : "", color: v.color ?? "", kind: v.kind ?? "", notes: v.notes ?? "" });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (body: FleetProfileInput) => saveFleetProfile(v.vehicleId, body), onSuccess: onSaved });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const year = numberOf(form.year);
    if (year !== null && !(year >= 1950 && year <= 2100)) return setProblem(t("fleet.profile.badYear"));
    setProblem(null);
    save.mutate({ ...profileOf(v), vin: form.vin || null, brand: form.brand || null, model: form.model || null, year, color: form.color || null, kind: form.kind || null, notes: form.notes || null });
  };
  const kinds = form.kind && !FLEET_KIND_VALUES.includes(form.kind) ? [form.kind, ...FLEET_KIND_VALUES] : FLEET_KIND_VALUES;
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="flex items-start gap-4">
        {v.photoId ? (
          <img src={fleetDocumentUrl(v.photoId)} alt={t("fleet.profile.photoOf", { name: v.name })} className="h-24 w-32 shrink-0 rounded-[12px] border border-line object-cover" />
        ) : (
          <div className="flex h-24 w-32 shrink-0 items-center justify-center rounded-[12px] bg-canvas px-2 text-center text-[12px] leading-snug text-muted">{t("fleet.profile.noPhoto")}</div>
        )}
        <dl className="min-w-0 flex-1 space-y-1 text-[13.5px]">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{t("fleet.profile.availability")}</dt>
            <dd className="font-medium text-ink">{t(`shared.fleetAvailability.${v.availability}`)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{t("fleet.profile.assignedTo")}</dt>
            <dd className="truncate font-medium text-ink">{v.assignedTo ?? t("fleet.profile.nobody")}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{t("fleet.profile.odometer")}</dt>
            <dd className="num font-medium text-ink">{v.odometerKm === null ? "—" : `${whole(v.odometerKm)} km`}</dd>
          </div>
        </dl>
      </div>
      <fieldset disabled={!canManage} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("fleet.profile.brand")} value={form.brand} onChange={set("brand")} maxLength={40} />
        <Field label={t("fleet.profile.model")} value={form.model} onChange={set("model")} maxLength={60} />
        <Field label={t("fleet.profile.year")} value={form.year} onChange={set("year")} inputMode="numeric" mono maxLength={4} />
        <Field label={t("fleet.profile.color")} value={form.color} onChange={set("color")} maxLength={30} />
        <div>
          <label htmlFor="tipo-de-vehiculo" className={label}>
            {t("fleet.profile.kind")}
          </label>
          <select id="tipo-de-vehiculo" value={form.kind} onChange={set("kind")} className={lightSelect}>
            <option value="">{t("fleet.profile.noKind")}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </div>
        <Field label={t("fleet.profile.vin")} value={form.vin} onChange={set("vin")} mono maxLength={40} />
        <div className="sm:col-span-2">
          <label htmlFor="notas-del-vehiculo" className={label}>
            {t("common.notes")}
          </label>
          <textarea id="notas-del-vehiculo" value={form.notes} onChange={set("notes")} rows={2} maxLength={1000} className="w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10" />
        </div>
      </fieldset>
      <p className="text-[12.5px] text-muted">{t("fleet.profile.nameNote")}</p>
      {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
      {save.isSuccess && <Notice tone="success">{t("fleet.profile.saved")}</Notice>}
      {canManage && (
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            {t("common.save")}
          </Button>
        </div>
      )}
    </form>
  );
}

// ─── Status ──────────────────────────────────────────────────────────────────

function StateTab({ v, canManage, onSaved }: { v: FleetDetail; canManage: boolean; onSaved: (v: FleetDetail) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<FleetStatus>(v.status);
  const [statusNote, setStatusNote] = useState(v.statusNote ?? "");
  const [state, setState] = useState<FleetState>(v.state);
  const [stateNote, setStateNote] = useState(v.stateNote ?? "");
  const saveStatus = useMutation({ mutationFn: () => setFleetStatus(v.vehicleId, status, statusNote || null), onSuccess: onSaved });
  const saveState = useMutation({ mutationFn: () => setFleetState(v.vehicleId, state, stateNote || null), onSuccess: onSaved });
  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">{t("fleet.state.availability")}</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">
            <Trans i18nKey="fleet.state.availabilityNow" values={{ value: t(`shared.fleetAvailability.${v.availability}`), since: formatDateTime(v.statusSince) }} components={{ b: <strong className="font-semibold text-ink" />, num: <span className="num" /> }} />
          </p>
        </div>
        <fieldset disabled={!canManage} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
          <select aria-label={t("fleet.state.availability")} value={status} onChange={(e) => setStatus(e.target.value as FleetStatus)} className={lightSelect}>
            {FLEET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`shared.fleetAvailability.${s}`)}
              </option>
            ))}
          </select>
          <input aria-label={t("fleet.state.availabilityReason")} placeholder={t("fleet.state.reasonPlaceholder")} maxLength={200} value={statusNote} onChange={(e) => setStatusNote(e.target.value)} className={lightSelect} />
          {canManage && (
            <Button type="button" variant="secondary" loading={saveStatus.isPending} onClick={() => saveStatus.mutate()}>
              {t("fleet.state.change")}
            </Button>
          )}
        </fieldset>
        {saveStatus.isError && <Notice tone="error">{errorText(saveStatus.error)}</Notice>}
      </section>
      <section className="space-y-3">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">{t("fleet.state.state")}</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">
            <Trans i18nKey="fleet.state.stateNow" values={{ value: t(`shared.fleetState.${v.state}`), since: formatDateTime(v.stateSince) }} components={{ b: <strong className="font-semibold text-ink" />, num: <span className="num" /> }} />
          </p>
        </div>
        <fieldset disabled={!canManage} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
          <select aria-label={t("fleet.state.stateLabel")} value={state} onChange={(e) => setState(e.target.value as FleetState)} className={lightSelect}>
            {FLEET_STATES.map((s) => (
              <option key={s} value={s}>
                {t(`shared.fleetState.${s}`)}
              </option>
            ))}
          </select>
          <input aria-label={t("fleet.state.stateReason")} placeholder={t("fleet.state.reasonPlaceholder")} maxLength={200} value={stateNote} onChange={(e) => setStateNote(e.target.value)} className={lightSelect} />
          {canManage && (
            <Button type="button" variant="secondary" loading={saveState.isPending} onClick={() => saveState.mutate()}>
              {t("fleet.state.change")}
            </Button>
          )}
        </fieldset>
        {saveState.isError && <Notice tone="error">{errorText(saveState.error)}</Notice>}
      </section>
      {v.log.length > 0 && (
        <section>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">{t("fleet.state.log")}</h3>
          <ul className="divide-y divide-line text-[13.5px]">
            {v.log.map((entry) => (
              <li key={`${entry.at}-${entry.field}`} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{logValue(entry.field, entry.value)}</span>
                  {entry.note && <span className="text-ink-3"> · {entry.note}</span>}
                  {entry.userName && <span className="text-muted"> · {entry.userName}</span>}
                </span>
                <span className="num shrink-0 text-[12.5px] text-muted">{formatDateTime(entry.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ─── Assigned to ──────────────────────────────────────────────────────────────

function AssignedTab({ v, canManage }: { v: FleetDetail; canManage: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = ["fleet", v.vehicleId, "assignments"];
  const list = useQuery({ queryKey: key, queryFn: () => getFleetAssignments(v.vehicleId) });
  const [person, setPerson] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const done = (next: Awaited<ReturnType<typeof getFleetAssignments>>) => {
    queryClient.setQueryData(key, next);
    setPerson("");
    setTo("");
    void queryClient.invalidateQueries({ queryKey: ["fleet"], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["fleet", v.vehicleId], exact: true });
  };
  const add = useMutation({ mutationFn: () => addFleetAssignment(v.vehicleId, { person, from, to: to || null, note: null }), onSuccess: done });
  const remove = useMutation({ mutationFn: (id: string) => removeFleetAssignment(id), onSuccess: done });
  if (list.isLoading) {
    return (
      <div className="flex h-24 items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }
  if (list.isError || !list.data) return <Notice tone="error">{errorText(list.error)}</Notice>;
  const withDrivers = list.data.source === "drivers";
  const when = (value: string) => (withDrivers ? formatDateTime(value) : dayLabel(value));
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink-3">
        {withDrivers ? t("fleet.assigned.drivers") : t("fleet.assigned.manual")}
      </p>
      {!withDrivers && canManage && (
        <form
          className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto]"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (person.trim()) add.mutate();
          }}
        >
          <Field label={t("fleet.assigned.person")} value={person} onChange={(e) => setPerson(e.target.value)} maxLength={80} />
          <Field label={t("common.from")} type="date" value={from} onChange={(e) => setFrom(e.target.value)} mono />
          <Field label={t("fleet.assigned.until")} type="date" value={to} onChange={(e) => setTo(e.target.value)} mono />
          <Button type="submit" loading={add.isPending} disabled={!person.trim()}>
            {t("fleet.assigned.assign")}
          </Button>
        </form>
      )}
      {(add.isError || remove.isError) && <Notice tone="error">{errorText(add.error ?? remove.error)}</Notice>}
      {list.data.items.length === 0 ? (
        <p className="rounded-[12px] bg-canvas px-4 py-3 text-[13.5px] text-ink-3">{t("fleet.assigned.empty")}</p>
      ) : (
        <ul className="divide-y divide-line text-[14px]">
          {list.data.items.map((a) =>
            asking === a.id ? (
              <li key={a.id} className="py-2.5">
                <ConfirmBar confirm={t("common.remove")} pending={remove.isPending} onCancel={() => setAsking(null)} onConfirm={() => remove.mutate(a.id)}>
                  {t("fleet.assigned.confirmRemove", { name: a.person })}
                </ConfirmBar>
              </li>
            ) : (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{a.person}</span>
                  <span className="num block text-[12.5px] text-muted">
                    {when(a.from)} – {a.to ? when(a.to) : t("fleet.assigned.today")}
                    {a.note && <> · {a.note}</>}
                  </span>
                </span>
                {!withDrivers && canManage && (
                  <button type="button" onClick={() => setAsking(a.id)} aria-label={t("fleet.assigned.remove", { name: a.person })} title={t("common.remove")} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-danger">
                    <Trash size={15} />
                  </button>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

// ─── Documents ──────────────────────────────────────────────────────────────

function DocumentsTab({ v, canManage, onSaved }: { v: FleetDetail; canManage: boolean; onSaved: (v: FleetDetail) => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<FleetDocumentKind>("insurance");
  const [expiresOn, setExpiresOn] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadFleetDocument(v.vehicleId, file, { kind, ...(kind !== "photo" && expiresOn ? { expiresOn } : {}) }),
    onSuccess: (next) => {
      setExpiresOn("");
      onSaved(next);
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteFleetDocument(id), onSuccess: onSaved });
  return (
    <div className="space-y-4">
      {canManage && (
        <div className="grid grid-cols-1 items-end gap-2 rounded-[12px] border border-line px-4 py-3.5 sm:grid-cols-[1.3fr_1fr_auto]">
          <div>
            <label htmlFor="tipo-de-documento" className={label}>
              {t("fleet.documents.kind")}
            </label>
            <select id="tipo-de-documento" value={kind} onChange={(e) => setKind(e.target.value as FleetDocumentKind)} className={lightSelect}>
              {FLEET_DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`shared.fleetDocument.${k}`)}
                </option>
              ))}
            </select>
          </div>
          {kind === "photo" ? <span className="hidden sm:block" /> : <Field label={t("fleet.documents.expiresOn")} type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} mono />}
          <div>
            <input
              ref={input}
              type="file"
              accept={kind === "photo" ? "image/jpeg,image/png,image/webp" : "image/jpeg,image/png,image/webp,application/pdf"}
              className="sr-only"
              aria-label={t("fleet.documents.file")}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = "";
              }}
            />
            <Button type="button" loading={upload.isPending} onClick={() => input.current?.click()}>
              <FileUp size={16} aria-hidden="true" />
              {t("fleet.documents.upload")}
            </Button>
          </div>
          <p className="text-[12.5px] text-muted sm:col-span-3">{t("fleet.documents.note")}</p>
        </div>
      )}
      {(upload.isError || remove.isError) && <Notice tone="error">{errorText(upload.error ?? remove.error)}</Notice>}
      {v.docs.length === 0 ? (
        <p className="rounded-[12px] bg-canvas px-4 py-3 text-[13.5px] text-ink-3">{t("fleet.documents.empty")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {v.docs.map((d) => {
            const left = d.expiresOn ? daysUntil(d.expiresOn) : null;
            if (asking === d.id) {
              return (
                <li key={d.id} className="py-2.5">
                  <ConfirmBar pending={remove.isPending} onCancel={() => setAsking(null)} onConfirm={() => remove.mutate(d.id)}>
                    {t("fleet.documents.confirmRemove", { name: d.name })}
                  </ConfirmBar>
                </li>
              );
            }
            return (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                <a href={fleetDocumentUrl(d.id)} target="_blank" rel="noreferrer" className="flex min-w-0 items-start gap-2.5 text-[14px] hover:underline">
                  <FileText size={17} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">{d.name}</span>
                    <span className="block text-[12.5px] text-muted">
                      {t(`shared.fleetDocument.${d.kind}`)}
                      {d.note && <> · {d.note}</>}
                      {d.expiresOn && left !== null && (
                        <span className={clsx(left <= 30 && "font-medium text-danger")}>
                          {" "}
                          · {left < 0 ? t("fleet.documents.expired", { date: dayLabel(d.expiresOn) }) : left === 0 ? t("fleet.documents.today") : t("fleet.documents.expires", { date: dayLabel(d.expiresOn) })}
                          {left <= 30 && <TriangleAlert size={13} className="ml-1 inline-block align-[-2px]" aria-hidden="true" />}
                        </span>
                      )}
                    </span>
                  </span>
                </a>
                {canManage && (
                  <button type="button" onClick={() => setAsking(d.id)} aria-label={t("fleet.documents.remove", { name: d.name })} title={t("common.delete")} className="shrink-0 rounded-lg p-2 text-muted hover:bg-canvas hover:text-danger">
                    <Trash size={15} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Useful life ───────────────────────────────────────────────────────────────

function LifeTab({ v, canManage, onSaved }: { v: FleetDetail; canManage: boolean; onSaved: (v: FleetDetail) => void }) {
  const { t } = useTranslation();
  // With at most two decimals, so that saving it again reads the same.
  const text = (n: number | null) => (n === null ? "" : String(Math.round(n * 100) / 100));
  const [form, setForm] = useState({ purchaseDate: v.purchaseDate ?? "", purchasePrice: text(v.purchasePrice), currency: v.currency ?? "HNL", salvageValue: text(v.salvageValue), lifeYears: text(v.lifeYears), purchaseOdometerKm: text(v.purchaseOdometerKm) });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (body: FleetProfileInput) => saveFleetProfile(v.vehicleId, body), onSuccess: onSaved });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const price = amountOf(form.purchasePrice);
    const salvage = amountOf(form.salvageValue);
    const years = numberOf(form.lifeYears);
    const odometer = amountOf(form.purchaseOdometerKm);
    if ([price, salvage, years, odometer].some((n) => n !== null && !(n >= 0))) return setProblem(t("fleet.life.numbers"));
    if (price !== null && salvage !== null && salvage > price) return setProblem(t("fleet.life.salvage"));
    setProblem(null);
    save.mutate({ ...profileOf(v), purchaseDate: form.purchaseDate || null, purchasePrice: price, currency: price === null ? v.currency : form.currency, salvageValue: salvage, lifeYears: years, purchaseOdometerKm: odometer });
  };
  const listed = CURRENCIES.map((c) => c.code);
  const coins = listed.includes(form.currency) ? listed : [form.currency, ...listed];
  const life = v.life;
  return (
    <div className="space-y-5">
      {life ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Figure label={t("fleet.life.bookValue")} value={money(life.bookValue, life.currency)} note={t("fleet.life.perYear", { amount: money(life.perYear, life.currency) })} />
            <Figure label={t("fleet.life.depreciated")} value={money(life.depreciated, life.currency)} note={t("fleet.life.age", { count: life.ageYears, n: decimalMark(life.ageYears) })} />
            <Figure label={t("fleet.life.used")} value={`${life.usedPercent} %`} note={t("fleet.life.endsOn", { date: dayLabel(life.endsOn) })} alert={life.usedPercent >= 100} />
            <Figure label={t("fleet.life.spent")} value={money(life.expenses, life.currency)} note={t("fleet.life.spentNote")} />
            <Figure label={t("fleet.life.totalCost")} value={money(life.totalCost, life.currency)} note={t("fleet.life.totalCostNote")} />
            <Figure label={t("fleet.life.costPerKm")} value={life.costPerKm === null ? "—" : money(life.costPerKm, life.currency)} note={life.km === null ? t("fleet.life.noOdometer") : t("fleet.life.kmSince", { n: whole(life.km) })} />
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-canvas" role="img" aria-label={t("fleet.life.usedBar", { n: life.usedPercent })}>
            <div className={clsx("h-full rounded-full", life.usedPercent >= 100 ? "bg-danger" : "bg-primary")} style={{ width: `${Math.max(2, life.usedPercent)}%` }} />
          </div>
        </>
      ) : (
        <p className="rounded-[12px] bg-canvas px-4 py-3 text-[13.5px] leading-relaxed text-ink-3">
          {t("fleet.life.empty")}
        </p>
      )}
      <form onSubmit={submit} className="space-y-3" noValidate>
        <fieldset disabled={!canManage} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("fleet.life.purchaseDate")} type="date" value={form.purchaseDate} onChange={set("purchaseDate")} mono />
          <Field label={t("fleet.life.years")} value={form.lifeYears} onChange={set("lifeYears")} inputMode="decimal" mono />
          <Field label={t("fleet.life.price")} value={form.purchasePrice} onChange={set("purchasePrice")} inputMode="decimal" mono />
          <div>
            <label htmlFor="moneda-de-compra" className={label}>
              {t("fleet.life.currency")}
            </label>
            <select id="moneda-de-compra" value={form.currency} onChange={set("currency")} className={lightSelect}>
              {coins.map((code) => (
                <option key={code} value={code}>
                  {code} · {currencyName(code)}
                </option>
              ))}
            </select>
          </div>
          <Field label={t("fleet.life.salvageValue")} value={form.salvageValue} onChange={set("salvageValue")} inputMode="decimal" mono hint={t("fleet.life.salvageHint")} />
          <Field label={t("fleet.life.purchaseOdometer")} value={form.purchaseOdometerKm} onChange={set("purchaseOdometerKm")} inputMode="decimal" mono />
        </fieldset>
        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        {save.isSuccess && <Notice tone="success">{t("fleet.profile.saved")}</Notice>}
        {canManage && (
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}

function Figure({ label: title, value, note, alert }: { label: string; value: string; note: string; alert?: boolean }) {
  return (
    <div className="min-w-0 rounded-[12px] bg-canvas px-3.5 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{title}</p>
      <p className={clsx("num mt-1 text-[17px] font-semibold leading-tight tracking-tight", alert ? "text-danger" : "text-ink")}>{value}</p>
      <p className="mt-0.5 text-[12px] leading-snug text-muted">{note}</p>
    </div>
  );
}
