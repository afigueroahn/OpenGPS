// A work order: what is done to the vehicle, where, with what parts
// and how much it costs. With its attachments: the invoice, photos of the work.
import { CURRENCIES, MAINT_ORDER_KINDS, MAINT_ORDER_STATUSES, type MaintOrder, type MaintOrderInput, type MaintOrderKind, type MaintOrderStatus } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FileUp, Plus, Trash, X } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice } from "../../components/ui";
import { decimalMark } from "../../lib/format";
import { deleteMaintFile, deleteMaintOrder, getMaintParts, getMaintSettings, getMaintWorkshops, getMaintenance, maintFileUrl, saveMaintOrder, uploadMaintFile } from "../../lib/maintenance";
import { amountOf, currencyName, money, today } from "../fleet/format";
import { ConfirmBar, errorText } from "../widgets";

/** Order proposed when opening it from a pending service. */
export interface OrderDraft {
  vehicleId: string;
  scheduleId: string;
  title: string;
}

const select = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
const small = "h-10 w-full min-w-0 rounded-[10px] border border-line bg-surface px-2.5 text-[14px] text-ink placeholder:text-faint focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
const label = "mb-1.5 block text-[13px] font-medium text-ink-3";
const text = (n: number | null) => (n === null ? "" : String(Math.round(n * 100) / 100));

interface Line {
  key: number;
  partId: string | null;
  name: string;
  quantity: string;
  unitCost: string;
}

export function OrderDialog(props: { order: MaintOrder | null; draft?: OrderDraft | null; vehicles: { id: string; name: string }[]; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [order, setOrder] = useState(props.order);
  const workshops = useQuery({ queryKey: ["maintenance", "workshops"], queryFn: getMaintWorkshops });
  const catalog = useQuery({ queryKey: ["maintenance", "parts"], queryFn: getMaintParts });
  const overview = useQuery({ queryKey: ["maintenance", "overview"], queryFn: getMaintenance });
  const settings = useQuery({ queryKey: ["maintenance", "settings"], queryFn: getMaintSettings });

  const [vehicleId, setVehicleId] = useState(order?.vehicleId ?? props.draft?.vehicleId ?? props.vehicles[0]?.id ?? "");
  const [kind, setKind] = useState<MaintOrderKind>(order?.kind ?? (props.draft ? "preventive" : "corrective"));
  const [status, setStatus] = useState<MaintOrderStatus>(order?.status ?? "open");
  const [title, setTitle] = useState(order?.title ?? props.draft?.title ?? "");
  const [description, setDescription] = useState(order?.description ?? "");
  const [scheduleId, setScheduleId] = useState(order?.scheduleId ?? props.draft?.scheduleId ?? "");
  const [workshopId, setWorkshopId] = useState(order?.workshopId ?? "");
  const [openedOn, setOpenedOn] = useState(order?.openedOn ?? today());
  const [doneOn, setDoneOn] = useState(order?.doneOn ?? "");
  const [odometer, setOdometer] = useState(text(order?.odometerKm ?? null));
  const [hours, setHours] = useState(text(order?.engineHours ?? null));
  const [labor, setLabor] = useState(order ? text(order.laborCost) : "");
  const [currency, setCurrency] = useState(order?.currency ?? "");
  const next = useRef(0);
  const [lines, setLines] = useState<Line[]>(() => (order?.parts ?? []).map((p) => ({ key: next.current++, partId: p.partId, name: p.name, quantity: text(p.quantity), unitCost: text(p.unitCost) })));
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** The attached file being asked about before deleting it. */
  const [askingFile, setAskingFile] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const coin = currency || settings.data?.currency || "HNL";
  const listed = CURRENCIES.map((c) => c.code);
  const coins = listed.includes(coin) ? listed : [coin, ...listed];
  const services = (overview.data?.schedules ?? []).filter((s) => s.vehicleId === vehicleId);
  const partsCost = lines.reduce((n, l) => n + (amountOf(l.quantity) || 0) * (amountOf(l.unitCost) || 0), 0);
  const total = (amountOf(labor) || 0) + partsCost;
  const editable = props.canManage;

  const changed = (saved: MaintOrder | null) => {
    void queryClient.invalidateQueries({ queryKey: ["maintenance"] });
    // What a completed order costs counts in the fleet expenses.
    void queryClient.invalidateQueries({ queryKey: ["fleet"] });
    void queryClient.invalidateQueries({ queryKey: ["fleet-expenses"] });
    props.onChanged();
    if (saved) setOrder(saved);
  };
  const save = useMutation({
    mutationFn: (body: MaintOrderInput) => saveMaintOrder(order?.id ?? null, body),
    onSuccess: (saved) => {
      changed(saved);
      // A new order stays open to attach files to it; an already saved one is closed.
      if (order) props.onClose();
      else {
        setDoneOn(saved.doneOn ?? "");
        setOdometer(text(saved.odometerKm));
        setHours(text(saved.engineHours));
      }
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteMaintOrder(order?.id ?? ""),
    onSuccess: () => {
      changed(null);
      props.onClose();
    },
  });
  const upload = useMutation({ mutationFn: (file: File) => uploadMaintFile(order?.id ?? "", file), onSuccess: (saved) => changed(saved) });
  const dropFile = useMutation({ mutationFn: (id: string) => deleteMaintFile(id), onSuccess: (saved) => changed(saved) });

  const setLine = (key: number, patch: Partial<Line>) => setLines((old) => old.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = (partId: string | null) => {
    const part = catalog.data?.find((p) => p.id === partId);
    setLines((old) => [...old, { key: next.current++, partId: part?.id ?? null, name: part?.name ?? "", quantity: "1", unitCost: part?.unitCost === null || part?.unitCost === undefined ? "" : text(part.unitCost) }]);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setProblem(t("maintenance.order.needTitle"));
    const laborN = amountOf(labor) ?? 0;
    const odometerN = amountOf(odometer);
    const hoursN = amountOf(hours);
    if ([laborN, odometerN, hoursN].some((n) => n !== null && !(n >= 0))) return setProblem(t("maintenance.order.numbers"));
    const parts = [];
    for (const l of lines) {
      if (!l.name.trim() && !l.quantity.trim() && !l.unitCost.trim()) continue;
      const quantity = amountOf(l.quantity);
      const unitCost = amountOf(l.unitCost) ?? 0;
      if (!l.name.trim()) return setProblem(t("maintenance.order.partName"));
      if (quantity === null || !(quantity > 0) || !(unitCost >= 0)) return setProblem(t("maintenance.order.checkPart", { name: l.name.trim() }));
      parts.push({ partId: l.partId, name: l.name.trim(), quantity, unitCost });
    }
    if (status === "done" && doneOn && doneOn < openedOn) return setProblem(t("maintenance.order.doneBeforeOpened"));
    setProblem(null);
    save.mutate({
      vehicleId,
      kind,
      status,
      title: title.trim(),
      description: description || null,
      scheduleId: scheduleId || null,
      workshopId: workshopId || null,
      openedOn,
      // Completed without a date: today, in the calendar of whoever records it.
      doneOn: status === "done" ? doneOn || (today() < openedOn ? openedOn : today()) : null,
      odometerKm: odometerN,
      engineHours: hoursN,
      laborCost: laborN,
      currency: coin,
      parts,
    });
  };

  return (
    <Modal open onClose={props.onClose} title={order ? t("maintenance.order.title", { n: order.number }) : t("maintenance.order.newTitle")} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <fieldset disabled={!editable} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="orden-vehiculo" className={label}>
                {t("common.vehicle")}
              </label>
              <select
                id="orden-vehiculo"
                value={vehicleId}
                onChange={(e) => {
                  setVehicleId(e.target.value);
                  setScheduleId("");
                }}
                className={select}
              >
                {props.vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="orden-tipo" className={label}>
                  {t("maintenance.order.kind")}
                </label>
                <select id="orden-tipo" value={kind} onChange={(e) => setKind(e.target.value as MaintOrderKind)} className={select}>
                  {MAINT_ORDER_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`shared.maintOrderKind.${k}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="orden-estado" className={label}>
                  {t("maintenance.order.status")}
                </label>
                <select id="orden-estado" value={status} onChange={(e) => setStatus(e.target.value as MaintOrderStatus)} className={select}>
                  {MAINT_ORDER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`shared.maintOrderStatus.${s}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <Field label={t("maintenance.order.work")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={t("maintenance.order.workPlaceholder")} />
          <div>
            <label htmlFor="orden-detalle" className={label}>
              {t("maintenance.order.detail")}
            </label>
            <textarea id="orden-detalle" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} className="w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="orden-servicio" className={label}>
                {t("maintenance.order.schedule")}
              </label>
              <select id="orden-servicio" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} className={select}>
                <option value="">{t("common.none")}</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.planName} · {s.reason}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="orden-taller" className={label}>
                {t("maintenance.order.workshop")}
              </label>
              <select id="orden-taller" value={workshopId} onChange={(e) => setWorkshopId(e.target.value)} className={select}>
                <option value="">{t("maintenance.order.noWorkshop")}</option>
                {(workshops.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <Field label={t("maintenance.order.openedOn")} type="date" value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} mono />
            {status === "done" ? <Field label={t("maintenance.order.doneOn")} type="date" value={doneOn} onChange={(e) => setDoneOn(e.target.value)} mono hint={t("maintenance.order.doneOnHint")} /> : <span className="hidden sm:block" />}
            <Field label={t("maintenance.order.odometer")} value={odometer} onChange={(e) => setOdometer(e.target.value)} inputMode="decimal" mono hint={t("maintenance.order.odometerHint")} />
            <Field label={t("maintenance.order.hours")} value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" mono />
          </div>

          <section>
            <h3 className="mb-2 text-[14px] font-semibold text-ink">{t("maintenance.order.parts")}</h3>
            {lines.length > 0 && (
              <ul className="mb-2 space-y-2">
                {lines.map((l) => (
                  <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_4.2rem_6rem_2rem] items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_5rem_7.5rem_2rem] sm:gap-2">
                    <input aria-label={t("maintenance.order.part")} value={l.name} onChange={(e) => setLine(l.key, { name: e.target.value, partId: null })} maxLength={120} placeholder={t("maintenance.order.partPlaceholder")} className={small} />
                    <input aria-label={l.name ? t("maintenance.order.quantityOf", { name: l.name }) : t("maintenance.order.quantityOfPart")} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} inputMode="decimal" placeholder={t("maintenance.order.quantity")} className={`${small} num text-right`} />
                    <input aria-label={l.name ? t("maintenance.order.unitCostOf", { name: l.name }) : t("maintenance.order.unitCostOfPart")} value={l.unitCost} onChange={(e) => setLine(l.key, { unitCost: e.target.value })} inputMode="decimal" placeholder={t("maintenance.order.unitCost")} className={`${small} num text-right`} />
                    <button type="button" onClick={() => setLines((old) => old.filter((x) => x.key !== l.key))} aria-label={l.name ? t("maintenance.order.removeLine", { name: l.name }) : t("maintenance.order.removeEmptyLine")} title={t("common.remove")} className="rounded-lg p-1.5 text-muted hover:bg-canvas hover:text-danger">
                      <X size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {editable && (
              <div className="flex flex-wrap items-center gap-2">
                {(catalog.data ?? []).length > 0 && (
                  <select
                    aria-label={t("maintenance.order.fromCatalog")}
                    value=""
                    onChange={(e) => {
                      if (e.target.value) addLine(e.target.value);
                    }}
                    className="h-9 max-w-[240px] rounded-[10px] border border-line bg-surface px-2.5 text-[13px] text-ink"
                  >
                    <option value="">{t("maintenance.order.fromCatalogOption")}</option>
                    {(catalog.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.stock !== null ? t("maintenance.order.partWithStock", { name: p.name, n: decimalMark(p.stock) }) : p.name}
                      </option>
                    ))}
                  </select>
                )}
                <Button type="button" variant="secondary" size="sm" onClick={() => addLine(null)}>
                  <Plus size={14} aria-hidden="true" /> {t("maintenance.order.addLine")}
                </Button>
              </div>
            )}
          </section>

          <div className="grid grid-cols-2 items-end gap-3">
            <Field label={t("maintenance.order.labor")} value={labor} onChange={(e) => setLabor(e.target.value)} inputMode="decimal" mono />
            <div>
              <label htmlFor="orden-moneda" className={label}>
                {t("maintenance.order.currency")}
              </label>
              <select id="orden-moneda" value={coin} onChange={(e) => setCurrency(e.target.value)} className={select}>
                {coins.map((code) => (
                  <option key={code} value={code}>
                    {code} · {currencyName(code)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>

        <dl className="grid grid-cols-3 gap-2 rounded-[12px] bg-canvas px-4 py-3 text-[13px]">
          <div>
            <dt className="text-muted">{t("maintenance.order.labor")}</dt>
            <dd className="num font-medium text-ink">{money(amountOf(labor) || 0, coin)}</dd>
          </div>
          <div>
            <dt className="text-muted">{t("maintenance.order.partsCost")}</dt>
            <dd className="num font-medium text-ink">{money(partsCost, coin)}</dd>
          </div>
          <div>
            <dt className="text-muted">{t("maintenance.order.total")}</dt>
            <dd className="num text-[15px] font-semibold text-ink">{money(total, coin)}</dd>
          </div>
        </dl>

        {order ? (
          <section>
            <h3 className="mb-2 text-[14px] font-semibold text-ink">{t("maintenance.order.attachments")}</h3>
            {order.files.length === 0 ? (
              <p className="text-[13px] text-muted">{t("maintenance.order.noFiles")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {order.files.map((f) =>
                  askingFile === f.id ? (
                    <li key={f.id} className="py-2">
                      <ConfirmBar pending={dropFile.isPending} onCancel={() => setAskingFile(null)} onConfirm={() => dropFile.mutate(f.id)}>
                        {t("maintenance.order.confirmDeleteFile", { name: f.name })}
                      </ConfirmBar>
                    </li>
                  ) : (
                    <li key={f.id} className="flex items-center justify-between gap-3 py-2">
                      <a href={maintFileUrl(f.id)} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2 text-[14px] text-ink hover:underline">
                        <FileText size={16} className="shrink-0 text-muted" aria-hidden="true" />
                        <span className="truncate">{f.name}</span>
                      </a>
                      {editable && (
                        <button type="button" onClick={() => setAskingFile(f.id)} aria-label={t("maintenance.order.deleteFile", { name: f.name })} title={t("common.delete")} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-canvas hover:text-danger">
                          <Trash size={15} />
                        </button>
                      )}
                    </li>
                  ),
                )}
              </ul>
            )}
            {editable && (
              <div className="mt-2">
                <input
                  ref={input}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="sr-only"
                  aria-label={t("maintenance.order.file")}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) upload.mutate(file);
                    e.target.value = "";
                  }}
                />
                <Button type="button" variant="secondary" size="sm" loading={upload.isPending} onClick={() => input.current?.click()}>
                  <FileUp size={14} aria-hidden="true" /> {t("maintenance.order.attach")}
                </Button>
              </div>
            )}
          </section>
        ) : (
          editable && <p className="text-[12.5px] text-muted">{t("maintenance.order.attachLater")}</p>
        )}

        {(problem || save.isError || remove.isError || upload.isError || dropFile.isError) && <Notice tone="error">{problem ?? errorText(save.error ?? remove.error ?? upload.error ?? dropFile.error)}</Notice>}
        {status === "done" && scheduleId && order?.status !== "done" && editable && <Notice>{t("maintenance.order.restartsSchedule")}</Notice>}

        {editable ? (
          confirming ? (
            <ConfirmBar pending={remove.isPending} onCancel={() => setConfirming(false)} onConfirm={() => remove.mutate()}>
              {t("maintenance.order.confirmDelete")}
            </ConfirmBar>
          ) : (
            <div className="flex items-center justify-between gap-2">
              {order ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                  <Trash size={14} aria-hidden="true" /> {t("common.delete")}
                </Button>
              ) : (
                <span />
              )}
              <span className="flex gap-2">
                <Button type="button" variant="secondary" onClick={props.onClose}>
                  {order ? t("common.close") : t("common.cancel")}
                </Button>
                <Button type="submit" loading={save.isPending}>
                  {t("common.save")}
                </Button>
              </span>
            </div>
          )
        ) : (
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={props.onClose}>
              {t("common.close")}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
