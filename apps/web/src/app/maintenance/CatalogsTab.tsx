// Catalogs: the workshops and suppliers the account works with, and the
// parts it uses, with their reference cost and, if wanted, stock.
import { MAINT_WORKSHOP_KINDS, type MaintPart, type MaintPartInput, type MaintWorkshop, type MaintWorkshopInput, type MaintWorkshopKind } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { currentLanguage } from "../../lib/i18n";
import { deleteMaintPart, deleteMaintWorkshop, getMaintParts, getMaintSettings, getMaintWorkshops, saveMaintPart, saveMaintWorkshop } from "../../lib/maintenance";
import { amountOf, money } from "../fleet/format";
import { Card } from "../reports/kit";
import { ConfirmBar, errorText } from "../widgets";

const select = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
const label = "mb-1.5 block text-[13px] font-medium text-ink-3";
const qty = (n: number) => new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 2, useGrouping: "always" }).format(n);

export function CatalogsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const workshops = useQuery({ queryKey: ["maintenance", "workshops"], queryFn: getMaintWorkshops });
  const parts = useQuery({ queryKey: ["maintenance", "parts"], queryFn: getMaintParts });
  const settings = useQuery({ queryKey: ["maintenance", "settings"], queryFn: getMaintSettings });
  const [workshop, setWorkshop] = useState<MaintWorkshop | "new" | null>(null);
  const [part, setPart] = useState<MaintPart | "new" | null>(null);
  const currency = settings.data?.currency ?? "HNL";
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card
        title={t("maintenance.catalogs.workshops")}
        note={t("maintenance.catalogs.workshopsNote")}
        action={
          canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setWorkshop("new")}>
              <Plus size={14} aria-hidden="true" /> {t("common.add")}
            </Button>
          ) : undefined
        }
      >
        {workshops.isLoading && <Spinner className="text-muted" />}
        {workshops.isError && <Notice tone="error">{errorText(workshops.error)}</Notice>}
        {workshops.data &&
          (workshops.data.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{t("maintenance.catalogs.noWorkshops")}</p>
          ) : (
            <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
              {workshops.data.map((w) => (
                <li key={w.id}>
                  <button type="button" onClick={() => setWorkshop(w)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-canvas/70">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-ink">{w.name}</span>
                      <span className="block truncate text-[12.5px] text-muted">{[t(`shared.maintWorkshop.${w.kind}`), w.phone, w.contact, w.address].filter(Boolean).join(" · ")}</span>
                    </span>
                    {w.orders > 0 && (
                      <span className="num shrink-0 text-[12.5px] text-ink-3">{t("maintenance.catalogs.orders", { count: w.orders })}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Card>

      <Card
        title={t("maintenance.catalogs.parts")}
        note={t("maintenance.catalogs.partsNote")}
        action={
          canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setPart("new")}>
              <Plus size={14} aria-hidden="true" /> {t("common.add")}
            </Button>
          ) : undefined
        }
      >
        {parts.isLoading && <Spinner className="text-muted" />}
        {parts.isError && <Notice tone="error">{errorText(parts.error)}</Notice>}
        {parts.data &&
          (parts.data.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{t("maintenance.catalogs.noParts")}</p>
          ) : (
            <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
              {parts.data.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => setPart(p)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-canvas/70">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-ink">{p.name}</span>
                      <span className="block truncate text-[12.5px] text-muted">
                        {[p.code, p.unitCost !== null ? t("maintenance.catalogs.costPer", { cost: money(p.unitCost, currency), unit: p.unit }) : null, p.used > 0 ? t("maintenance.catalogs.used", { count: p.used, n: qty(p.used) }) : null].filter(Boolean).join(" · ") || t("maintenance.catalogs.noCost")}
                      </span>
                    </span>
                    {p.stock !== null && <span className={`num shrink-0 text-[12.5px] ${p.stock <= 0 ? "font-semibold text-danger" : "text-ink-3"}`}>{t("maintenance.catalogs.stockLeft", { n: qty(p.stock) })}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Card>

      {workshop && <WorkshopDialog workshop={workshop === "new" ? null : workshop} canManage={canManage} onClose={() => setWorkshop(null)} />}
      {part && <PartDialog part={part === "new" ? null : part} canManage={canManage} currency={currency} onClose={() => setPart(null)} />}
    </div>
  );
}

/** The dialog's footer; deleting asks first, saying what goes away (`confirm`). */
function Actions(props: { existing: boolean; canManage: boolean; saving: boolean; removing: boolean; confirm: string; onRemove: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  if (props.canManage && confirming) {
    return (
      <ConfirmBar pending={props.removing} onCancel={() => setConfirming(false)} onConfirm={props.onRemove}>
        {props.confirm}
      </ConfirmBar>
    );
  }
  if (!props.canManage) {
    return (
      <div className="flex justify-end">
        <Button type="button" variant="secondary" onClick={props.onClose}>
          {t("common.close")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      {props.existing ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          <Trash size={14} aria-hidden="true" /> {t("common.delete")}
        </Button>
      ) : (
        <span />
      )}
      <span className="flex gap-2">
        <Button type="button" variant="secondary" onClick={props.onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={props.saving}>
          {t("common.save")}
        </Button>
      </span>
    </div>
  );
}

function WorkshopDialog({ workshop, canManage, onClose }: { workshop: MaintWorkshop | null; canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: workshop?.name ?? "", contact: workshop?.contact ?? "", phone: workshop?.phone ?? "", email: workshop?.email ?? "", address: workshop?.address ?? "", notes: workshop?.notes ?? "" });
  const [kind, setKind] = useState<MaintWorkshopKind>(workshop?.kind ?? "workshop");
  const done = (next?: MaintWorkshop[]) => {
    if (next) queryClient.setQueryData(["maintenance", "workshops"], next);
    else void queryClient.invalidateQueries({ queryKey: ["maintenance", "workshops"] });
    onClose();
  };
  const save = useMutation({ mutationFn: (body: MaintWorkshopInput) => saveMaintWorkshop(workshop?.id ?? null, body), onSuccess: done });
  const remove = useMutation({ mutationFn: () => deleteMaintWorkshop(workshop?.id ?? ""), onSuccess: () => done() });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    save.mutate({ name: form.name.trim(), kind, contact: form.contact || null, phone: form.phone || null, email: form.email || null, address: form.address || null, notes: form.notes || null });
  };
  return (
    <Modal open onClose={onClose} title={workshop ? workshop.name : t("maintenance.catalogs.newWorkshop")}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <fieldset disabled={!canManage} className="space-y-3">
          <Field label={t("common.name")} value={form.name} onChange={set("name")} maxLength={80} />
          <div>
            <label htmlFor="taller-tipo" className={label}>
              {t("maintenance.catalogs.workshopKind")}
            </label>
            <select id="taller-tipo" value={kind} onChange={(e) => setKind(e.target.value as MaintWorkshopKind)} className={select}>
              {MAINT_WORKSHOP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`shared.maintWorkshop.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("maintenance.catalogs.phone")} value={form.phone} onChange={set("phone")} maxLength={40} mono />
            <Field label={t("maintenance.catalogs.contact")} value={form.contact} onChange={set("contact")} maxLength={80} />
          </div>
          <Field label={t("maintenance.catalogs.email")} type="email" value={form.email} onChange={set("email")} maxLength={120} />
          <Field label={t("maintenance.catalogs.address")} value={form.address} onChange={set("address")} maxLength={200} />
          <Field label={t("common.notes")} value={form.notes} onChange={set("notes")} maxLength={500} />
        </fieldset>
        {(save.isError || remove.isError) && <Notice tone="error">{errorText(save.error ?? remove.error)}</Notice>}
        <Actions existing={workshop !== null} canManage={canManage} saving={save.isPending} removing={remove.isPending} confirm={t("maintenance.catalogs.confirmDeleteWorkshop")} onRemove={() => remove.mutate()} onClose={onClose} />
      </form>
    </Modal>
  );
}

function PartDialog({ part, canManage, currency, onClose }: { part: MaintPart | null; canManage: boolean; currency: string; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const text = (n: number | null) => (n === null ? "" : String(n));
  const [form, setForm] = useState({ name: part?.name ?? "", code: part?.code ?? "", unit: part?.unit ?? t("maintenance.catalogs.defaultUnit"), unitCost: text(part?.unitCost ?? null), stock: text(part?.stock ?? null), notes: part?.notes ?? "" });
  const [problem, setProblem] = useState<string | null>(null);
  const done = (next?: MaintPart[]) => {
    if (next) queryClient.setQueryData(["maintenance", "parts"], next);
    else void queryClient.invalidateQueries({ queryKey: ["maintenance", "parts"] });
    onClose();
  };
  const save = useMutation({ mutationFn: (body: MaintPartInput) => saveMaintPart(part?.id ?? null, body), onSuccess: done });
  const remove = useMutation({ mutationFn: () => deleteMaintPart(part?.id ?? ""), onSuccess: () => done() });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const unitCost = amountOf(form.unitCost);
    const stock = amountOf(form.stock);
    if (!form.name.trim()) return setProblem(t("maintenance.catalogs.needName"));
    if ((unitCost !== null && !(unitCost >= 0)) || (stock !== null && Number.isNaN(stock))) return setProblem(t("maintenance.catalogs.partNumbers"));
    setProblem(null);
    save.mutate({ name: form.name.trim(), code: form.code || null, unit: form.unit.trim() || t("maintenance.catalogs.defaultUnit"), unitCost, stock, notes: form.notes || null });
  };
  return (
    <Modal open onClose={onClose} title={part ? part.name : t("maintenance.catalogs.newPart")}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <fieldset disabled={!canManage} className="space-y-3">
          <Field label={t("common.name")} value={form.name} onChange={set("name")} maxLength={120} placeholder={t("maintenance.catalogs.partPlaceholder")} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("maintenance.catalogs.code")} value={form.code} onChange={set("code")} maxLength={40} mono />
            <Field label={t("maintenance.catalogs.unit")} value={form.unit} onChange={set("unit")} maxLength={20} placeholder={t("maintenance.catalogs.unitPlaceholder")} />
            <Field label={t("maintenance.catalogs.unitCost", { currency })} value={form.unitCost} onChange={set("unitCost")} inputMode="decimal" mono />
            <Field label={t("maintenance.catalogs.stock")} value={form.stock} onChange={set("stock")} inputMode="decimal" mono />
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted">{t("maintenance.catalogs.stockNote")}</p>
          <Field label={t("common.notes")} value={form.notes} onChange={set("notes")} maxLength={500} />
        </fieldset>
        {(problem || save.isError || remove.isError) && <Notice tone="error">{problem ?? errorText(save.error ?? remove.error)}</Notice>}
        <Actions existing={part !== null} canManage={canManage} saving={save.isPending} removing={remove.isPending} confirm={t("maintenance.catalogs.confirmDeletePart")} onRemove={() => remove.mutate()} onClose={onClose} />
      </form>
    </Modal>
  );
}
