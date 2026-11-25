// Operating expenses: what is paid for each vehicle, by category and currency.
// Fills from the fuel module and completed work orders from
// maintenance are entered automatically.
import { CURRENCIES, FLEET_EXPENSE_CATEGORIES, type FleetExpense, type FleetExpenseCategory, type FleetExpenseInput } from "@opengps/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Pencil, Plus, Trash } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { addFleetExpense, deleteFleetExpense, getFleet, getFleetExpenses, updateFleetExpense } from "../../lib/api";
import { HBars } from "../reports/charts";
import { Card, Segmented, inputClass, labelClass, selectClass } from "../reports/kit";
import { ConfirmDialog, errorText } from "../widgets";
import { amountOf, currencyName, dayLabel, money, today } from "./format";

type RangeId = "month" | "last_month" | "year" | "custom";
const RANGES = [
  { id: "month", label: "fleet.range.month" },
  { id: "last_month", label: "fleet.range.lastMonth" },
  { id: "year", label: "fleet.range.year" },
  { id: "custom", label: "fleet.range.custom" },
] as const;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** The two dates of a period, both included. */
function rangeOf(id: Exclude<RangeId, "custom">): { from: string; to: string } {
  const now = new Date();
  if (id === "month") return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  if (id === "year") return { from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(now) };
  return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
}
const fieldSelect = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";

export function ExpensesTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rangeId, setRangeId] = useState<RangeId>("month");
  const [range, setRange] = useState(() => rangeOf("month"));
  const [vehicleId, setVehicleId] = useState("all");
  const [editing, setEditing] = useState<FleetExpense | "new" | null>(null);
  const [removing, setRemoving] = useState<FleetExpense | null>(null);
  const fleet = useQuery({ queryKey: ["fleet"], queryFn: getFleet });
  const valid = range.from !== "" && range.to !== "" && range.to >= range.from;
  const expenses = useQuery({
    queryKey: ["fleet-expenses", range.from, range.to, vehicleId],
    queryFn: () => getFleetExpenses(range.from, range.to, vehicleId === "all" ? undefined : vehicleId),
    enabled: valid,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["fleet-expenses"] });
    // The cost of owning each vehicle counts its expenses.
    void queryClient.invalidateQueries({ queryKey: ["fleet"] });
  };
  const choose = (id: RangeId) => {
    setRangeId(id);
    if (id !== "custom") setRange(rangeOf(id));
  };
  const data = expenses.data;
  const vehicles = fleet.data ?? [];
  // The most used currency in what is shown is the one proposed when recording another expense.
  const usual = data?.totals[0]?.currency ?? "HNL";

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-tight">{t("fleet.expenses.title")}</h1>
            <p className="mt-0.5 text-sm text-muted">{valid ? t("fleet.expenses.leadRange", { from: dayLabel(range.from), to: dayLabel(range.to) }) : t("fleet.expenses.lead")}</p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setEditing("new")} disabled={vehicles.length === 0}>
              <Plus size={15} aria-hidden="true" /> {t("fleet.expenses.add")}
            </Button>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Segmented label={t("fleet.expenses.period")} options={RANGES.map((r) => ({ id: r.id, label: t(r.label) }))} value={rangeId} onChange={choose} />
          <select aria-label={t("common.vehicle")} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={clsx(selectClass, "max-w-full")}>
            <option value="all">{t("fleet.expenses.allVehicles")}</option>
            {vehicles.map((v) => (
              <option key={v.vehicleId} value={v.vehicleId}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        {rangeId === "custom" && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label>
              <span className={labelClass}>{t("common.from")}</span>
              <input type="date" className={inputClass} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </label>
            <label>
              <span className={labelClass}>{t("common.to")}</span>
              <input type="date" className={inputClass} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </label>
            {!valid && <p className="pb-2.5 text-[13px] text-danger">{range.from && range.to ? t("fleet.expenses.endBeforeStart") : t("fleet.expenses.needDates")}</p>}
          </div>
        )}
      </Card>

      {expenses.isError && <Notice tone="error">{errorText(expenses.error)}</Notice>}
      {!data && expenses.isLoading && (
        <div className="flex h-40 items-center justify-center text-muted">
          <Spinner size={22} />
        </div>
      )}
      {data && (
        <>
          {data.totals.length > 0 && (
            <div className={clsx("grid grid-cols-1 gap-4", data.totals.length > 1 && "lg:grid-cols-2")}>
              {data.totals.map((total) => (
                <Card key={total.currency} title={t("fleet.expenses.totalIn", { currency: total.currency })} note={t("fleet.expenses.byCategory")}>
                  <p className="num mb-4 text-[26px] font-semibold leading-none tracking-tight">{money(total.total, total.currency)}</p>
                  <HBars rows={total.byCategory.toSorted((a, b) => b.total - a.total).map((c) => ({ key: c.category, label: t(`shared.fleetExpense.${c.category}`), value: c.total }))} format={(value) => money(value, total.currency)} />
                </Card>
              ))}
            </div>
          )}
          <Card title={t("fleet.expenses.recorded")} {...(data.items.length > 0 ? { note: t("fleet.expenses.count", { count: data.items.length }) } : {})}>
            {data.items.length === 0 ? (
              <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{canManage ? t("fleet.expenses.emptyManage") : t("fleet.expenses.empty")}</p>
            ) : (
              <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
                {data.items.map((e, i) => (
                  <li key={e.id ?? `auto-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[14.5px] font-medium text-ink">{t(`shared.fleetExpense.${e.category}`)}</span>
                        <span className="truncate text-[13px] text-ink-3">{e.vehicleName}</span>
                      </span>
                      <span className="block text-[12.5px] text-muted">
                        <span className="num">{dayLabel(e.date)}</span>
                        {e.note && <> · {e.note}</>}
                        {e.id === null && <> · {e.category === "fuel" ? t("fleet.expenses.fromFuel") : t("fleet.expenses.fromMaintenance")}</>}
                      </span>
                    </span>
                    <span className="num shrink-0 whitespace-nowrap text-right text-[14px] font-semibold text-ink">{money(e.amount, e.currency)}</span>
                    {canManage && (
                      <span className="flex w-[68px] shrink-0 justify-end">
                        {e.id !== null && (
                          <>
                            <button type="button" onClick={() => setEditing(e)} aria-label={t("fleet.expenses.edit", { vehicle: e.vehicleName, date: dayLabel(e.date) })} title={t("common.edit")} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-ink">
                              <Pencil size={15} />
                            </button>
                            <button type="button" onClick={() => setRemoving(e)} aria-label={t("fleet.expenses.remove", { vehicle: e.vehicleName, date: dayLabel(e.date) })} title={t("common.delete")} className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-danger">
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
        </>
      )}

      {editing && (
        <ExpenseForm
          expense={editing === "new" ? null : editing}
          vehicles={vehicles.map((v) => ({ id: v.vehicleId, name: v.name }))}
          defaults={{ vehicleId: vehicleId === "all" ? (vehicles[0]?.vehicleId ?? "") : vehicleId, currency: usual }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      <ConfirmDialog open={removing !== null} title={t("fleet.expenses.removeTitle")} confirm={t("common.delete")} onClose={() => setRemoving(null)} action={() => (removing?.id ? deleteFleetExpense(removing.id) : Promise.resolve())} onDone={refresh}>
        {removing && t("fleet.expenses.removeBody", { amount: money(removing.amount, removing.currency), vehicle: removing.vehicleName, date: dayLabel(removing.date) })}
      </ConfirmDialog>
    </div>
  );
}

function ExpenseForm(props: { expense: FleetExpense | null; vehicles: { id: string; name: string }[]; defaults: { vehicleId: string; currency: string }; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { expense } = props;
  const [vehicleId, setVehicleId] = useState(expense?.vehicleId ?? props.defaults.vehicleId);
  const [date, setDate] = useState(expense?.date ?? today());
  const [category, setCategory] = useState<FleetExpenseCategory>(expense?.category ?? "toll");
  const [amount, setAmount] = useState(expense ? String(expense.amount) : "");
  const [currency, setCurrency] = useState(expense?.currency ?? props.defaults.currency);
  const [note, setNote] = useState(expense?.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (body: FleetExpenseInput) => (expense?.id ? updateFleetExpense(expense.id, body) : addFleetExpense(body)), onSuccess: props.onSaved });
  const listed = CURRENCIES.map((c) => c.code);
  const coins = listed.includes(currency) ? listed : [currency, ...listed];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = amountOf(amount);
    if (value === null || !(value > 0)) return setProblem(t("fleet.expenses.needAmount"));
    if (!date) return setProblem(t("fleet.expenses.needDate"));
    setProblem(null);
    save.mutate({ vehicleId, date, category, amount: value, currency, note: note || null });
  };
  return (
    <Modal open onClose={props.onClose} title={expense ? t("fleet.expenses.editTitle") : t("fleet.expenses.newTitle")}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label htmlFor="gasto-vehiculo" className={labelClass}>
            {t("common.vehicle")}
          </label>
          <select id="gasto-vehiculo" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={fieldSelect}>
            {props.vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="gasto-categoria" className={labelClass}>
              {t("fleet.expenses.category")}
            </label>
            <select id="gasto-categoria" value={category} onChange={(e) => setCategory(e.target.value as FleetExpenseCategory)} className={fieldSelect}>
              {FLEET_EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`shared.fleetExpense.${c}`)}
                </option>
              ))}
            </select>
          </div>
          <Field label={t("common.date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} max={today()} mono />
          <Field label={t("fleet.expenses.amount")} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" mono autoFocus={!expense} />
          <div>
            <label htmlFor="gasto-moneda" className={labelClass}>
              {t("fleet.expenses.currency")}
            </label>
            <select id="gasto-moneda" value={currency} onChange={(e) => setCurrency(e.target.value)} className={fieldSelect}>
              {coins.map((code) => (
                <option key={code} value={code}>
                  {code} · {currencyName(code)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Field label={t("fleet.expenses.note")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={t("fleet.expenses.notePlaceholder")} />
        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={props.onClose}>
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
