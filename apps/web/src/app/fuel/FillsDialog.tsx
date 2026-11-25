// Fills of a vehicle: those recorded by hand or imported from a
// file, alongside the loads detected by the tank sensor. Here you can see
// when more fuel was paid for than went in.
import { CURRENCIES, type FuelFill, type FuelFillInput, type FuelImportResult, type FuelSettings, SHARED_TEXT, type Vehicle, fuelFillMismatch } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { FileUp, Pencil, Plus, Trash, TriangleAlert } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { addFuelFill, deleteFuelFill, getFuelFills, getFuelSettings, importFuelFills, saveFuelSettings, updateFuelFill } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import i18n, { currentLanguage } from "../../lib/i18n";
import { type Range, presetRange, rangeLabel, shiftRange } from "../history/range";
import { errorText } from "../widgets";

const liters = new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const lightSelect = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";

/** An amount with its currency: "4.777,50 HNL". */
export function money(amount: number, currency: string): string {
  // "always": in Spanish, a four-digit number has no thousands separator unless requested.
  return `${new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" }).format(amount)} ${currency}`;
}

type CurrencyCode = keyof (typeof SHARED_TEXT)["es"]["currency"];
const namedCurrency = (code: string): code is CurrencyCode => Object.hasOwn(SHARED_TEXT.es.currency, code);
/** The currencies to offer: the known ones, plus the chosen one first if it is not among them. */
const currencyCodes = (chosen: string): string[] => {
  const codes = CURRENCIES.map((c) => c.code);
  return codes.includes(chosen) ? codes : [chosen, ...codes];
};
/** The name of a currency in the language of the interface; an unknown code is its own name. */
const currencyName = (code: string) => (namedCurrency(code) ? i18n.t(`shared.currency.${code}`) : code);

type Editing = { fill: FuelFill | null; seed?: FuelFill };

export function FillsDialog({ vehicle, canManage, onClose }: { vehicle: Vehicle; canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<Range>(() => presetRange("30d"));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<FuelFill | null>(null);
  const fills = useQuery({
    queryKey: ["fuel", vehicle.id, "fills", range.from.getTime(), range.to.getTime()],
    queryFn: () => getFuelFills(vehicle.id, range.from, range.to),
    placeholderData: (previous) => previous,
  });
  const settings = useQuery({ queryKey: ["fuel", "settings"], queryFn: getFuelSettings });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["fuel", vehicle.id] });
  const remove = useMutation({
    mutationFn: (id: string) => deleteFuelFill(id),
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
  });

  if (editing && settings.data) {
    return (
      <FillForm
        vehicle={vehicle}
        editing={editing}
        currency={settings.data.currency}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
    );
  }
  if (importing) {
    return (
      <ImportForm
        onClose={() => {
          setImporting(false);
          refresh();
        }}
      />
    );
  }
  if (removing) {
    return (
      <Modal open onClose={() => setRemoving(null)} title={t("fuel.fills.removeTitle")}>
        <div className="space-y-5">
          <p className="text-[15px] leading-relaxed text-ink-3">
            <Trans
              i18nKey="fuel.fills.removeBody"
              values={{ liters: liters.format(removing.liters), when: formatDateTime(removing.at) }}
              components={{ b: <strong className="num font-semibold text-ink" /> }}
            />
          </p>
          {remove.isError && <Notice tone="error">{errorText(remove.error)}</Notice>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setRemoving(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="danger" loading={remove.isPending} onClick={() => remove.mutate(removing.id as string)}>
              {t("common.delete")}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const list = fills.data ?? [];
  const totals = new Map<string, number>();
  for (const f of list) if (f.total !== null && f.currency) totals.set(f.currency, (totals.get(f.currency) ?? 0) + f.total);
  const recorded = list.filter((f) => f.id !== null);

  return (
    <Modal open onClose={onClose} title={t("fuel.fills.title", { name: vehicle.name })} wide>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button type="button" aria-label={t("fuel.fills.previous")} onClick={() => setRange(shiftRange(range, -1))} className="rounded-lg px-2.5 py-1.5 text-[15px] text-ink-3 hover:bg-canvas hover:text-ink">
              ‹
            </button>
            <span className="num text-[13.5px] font-medium text-ink">{rangeLabel(range)}</span>
            <button
              type="button"
              aria-label={t("fuel.fills.next")}
              disabled={range.to.getTime() > Date.now()}
              onClick={() => setRange(shiftRange(range, 1))}
              className="rounded-lg px-2.5 py-1.5 text-[15px] text-ink-3 hover:bg-canvas hover:text-ink disabled:opacity-30"
            >
              ›
            </button>
          </div>
          {canManage && (
            <div className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setImporting(true)}>
                <FileUp size={15} aria-hidden="true" />
                {t("fuel.fills.import")}
              </Button>
              <Button type="button" size="sm" onClick={() => setEditing({ fill: null })}>
                <Plus size={15} aria-hidden="true" />
                {t("fuel.fills.record")}
              </Button>
            </div>
          )}
        </div>

        {fills.isLoading && (
          <div className="flex h-32 items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
        {fills.isError && <Notice tone="error">{errorText(fills.error)}</Notice>}
        {fills.data && list.length === 0 && (
          <p className="rounded-[12px] bg-canvas px-4 py-3 text-[13.5px] leading-relaxed text-ink-3">{t("fuel.fills.empty")}</p>
        )}
        {list.length > 0 && (
          <ul className={clsx("divide-y divide-line", fills.isFetching && "opacity-60")}>
            {list.map((f) => (
              <FillRow key={f.id ?? `d-${f.at}`} fill={f} canManage={canManage} onEdit={() => setEditing({ fill: f })} onRecord={() => setEditing({ fill: null, seed: f })} onRemove={() => setRemoving(f)} />
            ))}
          </ul>
        )}
        {recorded.length > 0 && (
          <p className="text-[13px] text-ink-3">
            {totals.size > 0 ? (
              <Trans
                i18nKey="fuel.fills.periodTotalPaid"
                values={{ liters: liters.format(recorded.reduce((n, f) => n + f.liters, 0)), paid: [...totals].map(([currency, total]) => money(total, currency)).join(" + ") }}
                components={{ b: <strong className="num font-semibold text-ink" /> }}
              />
            ) : (
              <Trans
                i18nKey="fuel.fills.periodTotal"
                values={{ liters: liters.format(recorded.reduce((n, f) => n + f.liters, 0)) }}
                components={{ b: <strong className="num font-semibold text-ink" /> }}
              />
            )}
          </p>
        )}

        {canManage && settings.data && <SettingsBox current={settings.data} />}
      </div>
    </Modal>
  );
}

function FillRow({ fill, canManage, onEdit, onRecord, onRemove }: { fill: FuelFill; canManage: boolean; onEdit: () => void; onRecord: () => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const detectedOnly = fill.id === null;
  const mismatch = fuelFillMismatch(fill);
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14.5px] font-semibold text-ink">
            <span className="num">{liters.format(fill.liters)} L</span>
            {fill.total !== null && fill.currency && <span className="num font-normal text-ink-3"> · {money(fill.total, fill.currency)}</span>}
          </p>
          <p className="mt-0.5 text-[12.5px] text-muted">
            <span className="num">{formatDateTime(fill.at)}</span>
            {fill.station && <> · {fill.station}</>}
            {fill.pricePerL !== null && fill.currency && (
              <>
                {" "}
                · <Trans i18nKey="fuel.fills.pricePerL" values={{ price: money(fill.pricePerL, fill.currency) }} components={{ num: <span className="num" /> }} />
              </>
            )}
            {fill.odometerKm !== null && (
              <>
                {" "}
                · <span className="num">{new Intl.NumberFormat(currentLanguage()).format(Math.round(fill.odometerKm))}</span> km
              </>
            )}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            {detectedOnly ? (
              t("fuel.fills.detectedOnly")
            ) : (
              <>
                {t(`shared.fuelFillSource.${fill.source}`)}
                {fill.detectedL !== null && !mismatch && (
                  <>
                    {" "}
                    · <Trans i18nKey="fuel.fills.rose" values={{ liters: liters.format(fill.detectedL) }} components={{ num: <span className="num" /> }} />
                  </>
                )}
                {fill.note && <> · {fill.note}</>}
              </>
            )}
          </p>
          {mismatch && fill.detectedL !== null && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[13px] font-medium text-danger">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                <Trans
                  i18nKey="fuel.fills.mismatch"
                  values={{ recorded: liters.format(fill.liters), detected: liters.format(fill.detectedL), missing: liters.format(fill.liters - fill.detectedL) }}
                  components={{ num: <span className="num" /> }}
                />
              </span>
            </p>
          )}
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-1">
            {detectedOnly ? (
              <Button type="button" variant="secondary" size="sm" aria-label={t("fuel.fills.recordDetected")} onClick={onRecord}>
                {t("fuel.fills.record")}
              </Button>
            ) : (
              <>
                <button type="button" onClick={onEdit} aria-label={t("fuel.fills.editTitle")} title={t("fuel.fills.edit")} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-ink">
                  <Pencil size={15} />
                </button>
                <button type="button" onClick={onRemove} aria-label={t("fuel.fills.removeTitle")} title={t("common.delete")} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-danger">
                  <Trash size={15} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// ─── Record or correct ───────────────────────────────────────────────────────

const numberOf = (text: string) => (text.trim() === "" ? null : Number(text.replace(",", ".")));
/** The local time of an instant, as a date and time field requires. */
const localInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function FillForm({ vehicle, editing, currency, onClose, onSaved }: { vehicle: Vehicle; editing: Editing; currency: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const base = editing.fill ?? editing.seed ?? null;
  const [at, setAt] = useState(localInput(base?.at ?? new Date().toISOString()));
  const [qty, setQty] = useState(base ? String(base.liters) : "");
  const [total, setTotal] = useState(editing.fill?.total != null ? String(editing.fill.total) : "");
  const [coin, setCoin] = useState(editing.fill?.currency ?? currency);
  const [odometer, setOdometer] = useState(editing.fill?.odometerKm != null ? String(editing.fill.odometerKm) : "");
  const [station, setStation] = useState(editing.fill?.station ?? "");
  const [note, setNote] = useState(editing.fill?.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: FuelFillInput) => (editing.fill?.id ? updateFuelFill(editing.fill.id, input) : addFuelFill(vehicle.id, input)),
    onSuccess: onSaved,
  });
  const coins = currencyCodes(coin);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const litersN = numberOf(qty);
    const totalN = numberOf(total);
    const odometerN = numberOf(odometer);
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return setProblem(t("fuel.fills.problems.date"));
    if (litersN === null || !(litersN > 0)) return setProblem(t("fuel.fills.problems.liters"));
    if ((totalN !== null && !(totalN >= 0)) || (odometerN !== null && !(odometerN >= 0))) return setProblem(t("fuel.fills.problems.numbers"));
    setProblem(null);
    save.mutate({
      at: when.toISOString() as unknown as Date,
      liters: litersN,
      total: totalN,
      currency: totalN === null ? null : coin,
      odometerKm: odometerN,
      station: station || null,
      note: note || null,
      source: editing.seed ? "detected" : "manual",
    });
  };

  return (
    <Modal open onClose={onClose} title={editing.fill ? t("fuel.fills.editTitle") : t("fuel.fills.newTitle", { name: vehicle.name })} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {editing.seed && (
          <Notice>
            <Trans i18nKey="fuel.fills.seed" values={{ liters: liters.format(editing.seed.liters) }} components={{ num: <span className="num" /> }} />
          </Notice>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("fuel.fills.at")} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} mono />
          <Field label={t("fuel.fills.liters")} value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" mono autoFocus />
          <Field label={t("fuel.fills.paidTotal")} value={total} onChange={(e) => setTotal(e.target.value)} inputMode="decimal" mono />
          <div>
            <label htmlFor="moneda-del-abastecimiento" className="mb-1.5 block text-[13px] font-medium text-ink-3">
              {t("fuel.fills.currency")}
            </label>
            <select id="moneda-del-abastecimiento" value={coin} onChange={(e) => setCoin(e.target.value)} className={lightSelect}>
              {coins.map((code) => (
                <option key={code} value={code}>
                  {code} · {currencyName(code)}
                </option>
              ))}
            </select>
          </div>
          <Field label={t("fuel.fills.odometer")} value={odometer} onChange={(e) => setOdometer(e.target.value)} inputMode="decimal" mono />
          <Field label={t("fuel.fills.station")} value={station} onChange={(e) => setStation(e.target.value)} maxLength={80} />
        </div>
        <Field label={t("fuel.fills.note")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} hint={t("fuel.fills.noteHint")} />
        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        <div className="flex justify-end gap-2">
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

// ─── Import ────────────────────────────────────────────────────────────────

function ImportForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [result, setResult] = useState<FuelImportResult | null>(null);
  const run = useMutation({ mutationFn: (csv: string) => importFuelFills(csv), onSuccess: setResult });
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setName(file.name);
    setResult(null);
    run.mutate(await file.text());
  };
  return (
    <Modal open onClose={onClose} title={t("fuel.import.title")} wide>
      <div className="space-y-4">
        <p className="text-[14.5px] leading-relaxed text-ink-3">
          <Trans i18nKey="fuel.import.lead" components={{ b: <strong className="font-semibold text-ink" /> }} />
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={input} type="file" accept=".csv,text/csv,text/plain" className="sr-only" aria-label={t("fuel.import.fileAria")} onChange={(e) => void pick(e.target.files?.[0])} />
          <Button type="button" loading={run.isPending} onClick={() => input.current?.click()}>
            <FileUp size={16} aria-hidden="true" />
            {t("fuel.import.pick")}
          </Button>
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(`﻿${t("fuel.import.templateHeader")}\r\n${t("fuel.import.templateRow")}\r\n`)}`}
            download={t("fuel.import.templateFile")}
            className="text-[13.5px] font-semibold text-ink underline underline-offset-2"
          >
            {t("fuel.import.template")}
          </a>
          {name && <span className="num text-[13px] text-muted">{name}</span>}
        </div>
        {run.isError && <Notice tone="error">{errorText(run.error)}</Notice>}
        {result && (
          <div className="space-y-3">
            <Notice tone={result.imported > 0 ? "success" : "info"}>
              {t("fuel.import.imported", { count: result.imported })}
              {result.repeated > 0 && ` ${t("fuel.import.repeated", { count: result.repeated })}`}
            </Notice>
            {result.errors.length > 0 && (
              <div>
                <p className="mb-1.5 text-[13.5px] font-semibold text-ink">{t("fuel.import.errors", { count: result.errors.length })}</p>
                <ul className="max-h-52 space-y-1 overflow-y-auto rounded-[12px] bg-canvas px-3.5 py-2.5 text-[13px] text-ink-3">
                  {result.errors.map((e) => (
                    <li key={e.line}>
                      <span className="num font-medium text-ink">{t("fuel.import.line", { line: e.line })}</span> {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            {result ? t("common.done") : t("common.cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Account settings ────────────────────────────────────────────────────

function SettingsBox({ current }: { current: FuelSettings }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: saveFuelSettings,
    onSuccess: (saved) => queryClient.setQueryData(["fuel", "settings"], saved),
  });
  const coins = currencyCodes(current.currency);
  return (
    <details className="rounded-[12px] border border-line px-4 py-3">
      <summary className="cursor-pointer text-[14px] font-semibold text-ink">{t("fuel.settings.title")}</summary>
      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor="moneda-de-la-cuenta" className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("fuel.settings.currency")}
          </label>
          <select
            id="moneda-de-la-cuenta"
            value={current.currency}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ currency: e.target.value })}
            className={lightSelect}
          >
            {coins.map((code) => (
              <option key={code} value={code}>
                {code} · {currencyName(code)}
              </option>
            ))}
          </select>
        </div>
        <p className="text-[13px] leading-relaxed text-ink-3">{t("fuel.settings.who")}</p>
        {save.isError && <Notice tone="error">{errorText(save.error)}</Notice>}
      </div>
    </details>
  );
}
