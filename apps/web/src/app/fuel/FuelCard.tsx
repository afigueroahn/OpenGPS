// Fuel of a vehicle: tank level, its configuration, the consumption
// report, loads, drains and costs, and the entry to its fills.
import { FUEL_COUNTER_LITERS, FUEL_KINDS, type FuelCounterUnit, type FuelKind, type FuelReport, type FuelStatus, type FuelTankInput, type Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Fuel, Plus, TriangleAlert, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { getFuel, getFuelReport, removeFuel, saveFuel } from "../../lib/api";
import { formatClock, formatDateTime, formatDay, formatDuration, formatKm, timeAgo } from "../../lib/format";
import i18n, { currentLanguage } from "../../lib/i18n";
import { PRESETS, type Preset, type Range, presetRange, rangeLabel } from "../history/range";
import { errorText } from "../widgets";
import { FillsDialog, money } from "./FillsDialog";

const liters = new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const two = new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const lightSelect = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
const SHORT_PRESETS = PRESETS.filter((p) => p.id !== "custom") as { id: Exclude<Preset, "custom">; label: string }[];

export function FuelCard({ vehicle, canManage, now }: { vehicle: Vehicle; canManage: boolean; now: number }) {
  const { t } = useTranslation();
  const fuel = useQuery({ queryKey: ["fuel", vehicle.id], queryFn: () => getFuel(vehicle.id), refetchInterval: 60_000 });
  const [dialog, setDialog] = useState<"config" | "report" | "fills" | null>(null);
  const status = fuel.data;
  if (!status) return null;
  if (!status.tank && !canManage) return null;
  const { tank, level } = status;

  return (
    <div className="mt-3 rounded-[12px] bg-ink-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <Fuel size={18} className={clsx("mt-0.5 shrink-0", level ? "text-signal" : "text-white/45")} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {level && tank ? (
            <>
              <p className="text-sm font-semibold">
                <Trans i18nKey="fuel.card.level" values={{ liters: liters.format(level.liters) }} components={{ num: <span className="num" /> }} />
                <span className="num font-normal text-white/55"> · {level.percent} %</span>
              </p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink" role="img" aria-label={t("fuel.card.levelAria", { percent: level.percent })}>
                <div className={clsx("h-full rounded-full", level.percent <= 15 ? "bg-coral" : "bg-signal")} style={{ width: `${Math.min(100, Math.max(2, level.percent))}%` }} />
              </div>
              <p className="mt-1.5 text-[12.5px] text-white/45">
                <Trans i18nKey="fuel.card.tank" values={{ capacity: tank.capacityL, when: timeAgo(level.at, now) }} components={{ num: <span className="num" /> }} />
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold">{t("fuel.card.title")}</p>
              <p className="text-[13px] leading-snug text-white/55">{!tank ? t("fuel.card.noTank") : tank.attr ? t("fuel.card.noLevel") : t("fuel.card.noSensor")}</p>
            </>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        {tank && (
          <>
            <button type="button" onClick={() => setDialog("report")} className="flex h-9 flex-1 items-center justify-center rounded-[10px] bg-ink text-[13px] font-semibold hover:bg-ink-3">
              {t("fuel.card.report")}
            </button>
            <button type="button" onClick={() => setDialog("fills")} className="flex h-9 flex-1 items-center justify-center rounded-[10px] bg-ink text-[13px] font-semibold hover:bg-ink-3">
              {t("fuel.card.fills")}
            </button>
          </>
        )}
        {canManage && (
          <button
            type="button"
            onClick={() => setDialog("config")}
            className={clsx("flex h-9 items-center justify-center rounded-[10px] px-3 text-[13px] font-semibold", tank ? "text-white/60 hover:bg-ink hover:text-white" : "flex-1 bg-signal text-ink hover:bg-mint")}
          >
            {tank ? t("fuel.card.configure") : t("fuel.card.configureTank")}
          </button>
        )}
      </div>
      {dialog === "config" && <ConfigDialog vehicle={vehicle} status={status} onClose={() => setDialog(null)} />}
      {dialog === "report" && <ReportDialog vehicle={vehicle} capacityL={tank?.capacityL ?? 0} onClose={() => setDialog(null)} />}
      {dialog === "fills" && <FillsDialog vehicle={vehicle} canManage={canManage} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ─── Configuration ───────────────────────────────────────────────────────────

const numberOf = (text: string) => (text.trim() === "" ? null : Number(text.replace(",", ".")));

function ConfigDialog({ vehicle, status, onClose }: { vehicle: Vehicle; status: FuelStatus; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const tank = status.tank;
  const [capacity, setCapacity] = useState(tank ? String(tank.capacityL) : "");
  const [attr, setAttr] = useState(tank?.attr ?? "");
  const [kind, setKind] = useState<FuelKind>(tank?.kind ?? "percent");
  const [table, setTable] = useState<[string, string][]>(() => (tank?.calibration ?? [[0, 0]]).map(([x, y]) => [String(x), String(y)]));
  const [norm, setNorm] = useState(tank?.normL100km != null ? String(tank.normL100km) : "");
  const [idle, setIdle] = useState(tank?.normIdleLh != null ? String(tank.normIdleLh) : "");
  const [counter, setCounter] = useState(tank?.counterAttr ?? "");
  const [unit, setUnit] = useState<FuelCounterUnit>(tank?.counterUnit ?? "l");
  const [confirming, setConfirming] = useState(false);

  // The data the device sends, plus those already chosen even if they do not arrive today.
  const options = useMemo(() => {
    const names = new Map(status.attrs.map((a) => [a.name, a.value as number | null]));
    for (const chosen of [tank?.attr, tank?.counterAttr]) if (chosen && !names.has(chosen)) names.set(chosen, null);
    return [...names].map(([name, value]) => ({ name, value }));
  }, [status.attrs, tank?.attr, tank?.counterAttr]);
  const current = status.attrs.find((a) => a.name === attr)?.value;

  const body = (): FuelTankInput | string => {
    const capacityL = numberOf(capacity);
    if (capacityL === null || !(capacityL >= 5)) return t("fuel.config.problems.capacity");
    let calibration: [number, number][] | null = null;
    if (attr && kind === "raw") {
      const rows = table.filter(([x, y]) => x.trim() !== "" && y.trim() !== "").map(([x, y]) => [numberOf(x), numberOf(y)] as [number, number]);
      if (rows.length < 2) return t("fuel.config.problems.calibrationPoints");
      if (rows.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || y < 0)) return t("fuel.config.problems.calibrationNumbers");
      rows.sort((a, b) => a[0] - b[0]);
      if (rows.some((row, i) => i > 0 && row[0] === (rows[i - 1] as [number, number])[0])) return t("fuel.config.problems.calibrationRepeated");
      calibration = rows;
    }
    const normL100km = numberOf(norm);
    const normIdleLh = numberOf(idle);
    if ((normL100km !== null && !(normL100km > 0)) || (normIdleLh !== null && !(normIdleLh > 0))) return t("fuel.config.problems.normPositive");
    if (!attr && !counter && normL100km === null && normIdleLh === null) return t("fuel.config.problems.needSource");
    return { capacityL, attr: attr || null, kind, calibration, counterAttr: counter || null, counterUnit: unit, normL100km, normIdleLh };
  };
  const [problem, setProblem] = useState<string | null>(null);
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ["fuel", vehicle.id] });
    onClose();
  };
  const save = useMutation({ mutationFn: (input: FuelTankInput) => saveFuel(vehicle.id, input), onSuccess: done });
  const remove = useMutation({ mutationFn: () => removeFuel(vehicle.id), onSuccess: done });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = body();
    setProblem(typeof input === "string" ? input : null);
    if (typeof input !== "string") save.mutate(input);
  };
  const setRow = (i: number, col: 0 | 1, value: string) => setTable((rows) => rows.map((row, j) => (j === i ? (col === 0 ? [value, row[1]] : [row[0], value]) : row)));
  const describe = (o: { name: string; value: number | null }) => (o.value === null ? o.name : t("fuel.config.attrNow", { name: o.name, value: two.format(o.value) }));

  if (confirming) {
    return (
      <Modal open onClose={onClose} title={t("fuel.config.removeTitle")}>
        <div className="space-y-5">
          <p className="text-[15px] leading-relaxed text-ink-3">
            <Trans i18nKey="fuel.config.removeBody" values={{ name: vehicle.name }} components={{ b: <strong className="font-semibold text-ink" /> }} />
          </p>
          {remove.isError && <Notice tone="error">{errorText(remove.error)}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              {t("common.remove")}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={t("fuel.title", { name: vehicle.name })} wide>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field label={t("fuel.config.capacity")} value={capacity} onChange={(e) => setCapacity(e.target.value)} inputMode="decimal" mono autoFocus={!tank} />

        <Section title={t("fuel.config.sensor")} note={t("fuel.config.sensorNote")}>
          <select aria-label={t("fuel.config.sensorAria")} value={attr} onChange={(e) => setAttr(e.target.value)} className={lightSelect}>
            <option value="">{t("fuel.config.noSensor")}</option>
            {options.map((o) => (
              <option key={o.name} value={o.name}>
                {describe(o)}
              </option>
            ))}
          </select>
          {options.length === 0 && <p className="mt-2 text-[13px] text-muted">{t("fuel.config.noAttrs")}</p>}
          {attr && (
            <div className="mt-3">
              <label htmlFor="como-llega-el-nivel" className="mb-1.5 block text-[13px] font-medium text-ink-3">
                {t("fuel.config.kind")}
              </label>
              <select id="como-llega-el-nivel" value={kind} onChange={(e) => setKind(e.target.value as FuelKind)} className={lightSelect}>
                {FUEL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`shared.fuelKind.${k}`)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {attr && kind === "raw" && (
            <div className="mt-3 rounded-[12px] bg-canvas p-3">
              <p className="text-[13px] leading-relaxed text-ink-3">
                {t("fuel.config.calibrationLead")}
                {current !== undefined && (
                  <>
                    {" "}
                    <Trans i18nKey="fuel.config.currentReading" values={{ value: two.format(current) }} components={{ b: <strong className="num font-semibold text-ink" /> }} />
                  </>
                )}
              </p>
              <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted">{t("fuel.config.readingColumn")}</span>
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted">{t("fuel.config.litersColumn")}</span>
                <span />
                {table.map((row, i) => (
                  // Rows have no identity other than their position.
                  <Row key={i} row={row} onChange={(col, value) => setRow(i, col, value)} onRemove={table.length > 1 ? () => setTable((rows) => rows.filter((_, j) => j !== i)) : null} n={i + 1} />
                ))}
              </div>
              <button type="button" onClick={() => setTable((rows) => [...rows, ["", ""]])} className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-ink hover:underline">
                <Plus size={14} /> {t("fuel.config.addPoint")}
              </button>
            </div>
          )}
        </Section>

        <Section title={t("fuel.config.norm")} note={t("fuel.config.normNote")}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("fuel.config.normDriving")} value={norm} onChange={(e) => setNorm(e.target.value)} inputMode="decimal" mono />
            <Field label={t("fuel.config.normIdle")} value={idle} onChange={(e) => setIdle(e.target.value)} inputMode="decimal" mono />
          </div>
        </Section>

        <details className="rounded-[12px] border border-line px-4 py-3" open={Boolean(counter)}>
          <summary className="cursor-pointer text-[14px] font-semibold text-ink">{t("fuel.config.counter")}</summary>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{t("fuel.config.counterNote")}</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <select aria-label={t("fuel.config.counterAria")} value={counter} onChange={(e) => setCounter(e.target.value)} className={lightSelect}>
              <option value="">{t("fuel.config.counterAuto")}</option>
              {options.map((o) => (
                <option key={o.name} value={o.name}>
                  {describe(o)}
                </option>
              ))}
            </select>
            <select aria-label={t("fuel.config.counterUnit")} value={unit} onChange={(e) => setUnit(e.target.value as FuelCounterUnit)} disabled={!counter} className={clsx(lightSelect, "disabled:opacity-50")}>
              {(Object.keys(FUEL_COUNTER_LITERS) as FuelCounterUnit[]).map((u) => (
                <option key={u} value={u}>
                  {t(`shared.fuelCounter.${u}`)}
                </option>
              ))}
            </select>
          </div>
        </details>

        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        <div className="flex items-center justify-between gap-2">
          {tank ? (
            <button type="button" onClick={() => setConfirming(true)} className="text-[13px] font-semibold text-danger hover:underline">
              {t("fuel.config.remove")}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

const cell = "num h-10 w-full rounded-[10px] border border-line bg-surface px-3 text-[14px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
function Row({ row, n, onChange, onRemove }: { row: [string, string]; n: number; onChange: (col: 0 | 1, value: string) => void; onRemove: (() => void) | null }) {
  const { t } = useTranslation();
  return (
    <>
      <input aria-label={t("fuel.config.pointReading", { n })} value={row[0]} onChange={(e) => onChange(0, e.target.value)} inputMode="decimal" className={cell} />
      <input aria-label={t("fuel.config.pointLiters", { n })} value={row[1]} onChange={(e) => onChange(1, e.target.value)} inputMode="decimal" className={cell} />
      <button type="button" onClick={onRemove ?? undefined} disabled={!onRemove} aria-label={t("fuel.config.pointRemove", { n })} className="rounded-lg p-2 text-muted hover:bg-surface hover:text-ink disabled:opacity-30">
        <X size={15} />
      </button>
    </>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      <p className="mb-2.5 mt-0.5 text-[13px] leading-relaxed text-ink-3">{note}</p>
      {children}
    </section>
  );
}

// ─── Report ─────────────────────────────────────────────────────────────────

function ReportDialog({ vehicle, capacityL, onClose }: { vehicle: Vehicle; capacityL: number; onClose: () => void }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>(() => presetRange("7d"));
  const report = useQuery({
    queryKey: ["fuel", vehicle.id, "report", range.from.getTime(), range.to.getTime()],
    queryFn: () => getFuelReport(vehicle.id, range.from, range.to),
    placeholderData: (previous) => previous,
  });
  const r = report.data;

  return (
    <Modal open onClose={onClose} title={t("fuel.title", { name: vehicle.name })} wide>
      <div className="space-y-5">
        <div className="flex gap-1 rounded-[10px] bg-canvas p-1">
          {SHORT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={range.preset === p.id}
              onClick={() => setRange(presetRange(p.id))}
              className={clsx("h-8 flex-1 rounded-lg text-[13px] font-medium transition-colors", range.preset === p.id ? "bg-primary text-on-primary" : "text-ink-3 hover:text-ink")}
            >
              {p.label}
            </button>
          ))}
        </div>
        {report.isLoading && (
          <div className="flex h-40 items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
        {report.isError && <Notice tone="error">{errorText(report.error)}</Notice>}
        {r && (
          <div className={clsx("space-y-5", report.isFetching && "opacity-60")}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Tile label={t("fuel.report.distance")} value={`${formatKm(r.distanceM)} km`} note={rangeLabel(range)} />
              <Tile
                label={t("fuel.report.real")}
                value={r.real ? `${liters.format(r.real.liters)} L` : "—"}
                note={r.real ? (r.real.method === "ecu" ? t("fuel.report.realEcu") : t("fuel.report.realLevel")) : t("fuel.report.realNone")}
              />
              <Tile label={t("fuel.report.estimated")} value={r.estimated ? `${liters.format(r.estimated.liters)} L` : "—"} note={r.estimated ? normNote(r) : t("fuel.report.estimatedNone")} />
              <Tile
                label={t("fuel.report.efficiency")}
                value={r.efficiency ? `${two.format(r.efficiency.kmPerL)} km/L` : "—"}
                note={
                  r.efficiency
                    ? r.efficiency.basis === "estimated"
                      ? t("fuel.report.per100Norm", { value: two.format(r.efficiency.lPer100km) })
                      : `${two.format(r.efficiency.lPer100km)} L/100 km`
                    : t("fuel.report.efficiencyNone")
                }
              />
              <Tile label={t("fuel.report.refueled")} value={r.real && r.real.refueledL > 0 ? `${liters.format(r.real.refueledL)} L` : "—"} note={t("fuel.report.refueledNote")} />
              <Tile label={t("fuel.report.idle")} value={formatDuration(r.idle.seconds)} note={idleNote(r)} />
              <Tile
                label={t("fuel.report.drained")}
                value={r.real && r.real.drainedL > 0 ? `${liters.format(r.real.drainedL)} L` : "—"}
                note={r.drains.length > 0 ? t("fuel.report.drainedStopped") : r.series.length >= 2 ? t("fuel.report.drainedNone") : t("fuel.report.drainedNoSensor")}
                alert={r.drains.length > 0}
              />
              <Tile
                label={t("fuel.report.costPerKm")}
                value={r.costPerKm ? money(r.costPerKm.value, r.costPerKm.currency) : "—"}
                note={
                  r.costPerKm
                    ? t(r.costPerKm.basis === "estimated" ? "fuel.report.pricePerLNorm" : "fuel.report.pricePerL", { price: money(r.costPerKm.pricePerL, r.costPerKm.currency) })
                    : t("fuel.report.costNone")
                }
              />
              <Tile
                label={t("fuel.report.paid")}
                value={r.costs.length > 0 ? r.costs.map((c) => money(c.spent, c.currency)).join(" + ") : "—"}
                note={
                  r.costs.length > 0
                    ? t("fuel.report.paidNote", { liters: liters.format(r.costs.reduce((n, c) => n + c.liters, 0)), count: r.costs.reduce((sum, c) => sum + c.fills, 0) })
                    : t("fuel.report.paidNone")
                }
              />
            </div>

            {r.drains.some((d) => d.engineOff) && (
              <Notice tone="error">
                <span className="flex items-start gap-2">
                  <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{t("fuel.report.theft")}</span>
                </span>
              </Notice>
            )}

            {r.real && r.estimated && r.estimated.liters > 0 && <Compare real={r.real.liters} estimated={r.estimated.liters} />}

            {r.series.length >= 2 ? (
              <section>
                <h3 className="mb-2 text-[14px] font-semibold text-ink">{t("fuel.report.level")}</h3>
                <LevelChart series={r.series} capacityL={capacityL} />
              </section>
            ) : (
              <p className="rounded-[12px] bg-canvas px-4 py-3 text-[13.5px] leading-relaxed text-ink-3">{r.estimated ? t("fuel.report.noLevelNorm") : t("fuel.report.noLevel")}</p>
            )}

            {r.refuels.length + r.drains.length > 0 && (
              <section>
                <h3 className="mb-2 text-[14px] font-semibold text-ink">{t("fuel.report.jumps")}</h3>
                <ul className="divide-y divide-line">
                  {[...r.refuels.map((j) => ({ ...j, kind: "refuel" as const, engineOff: false })), ...r.drains.map((j) => ({ ...j, kind: "drain" as const }))]
                    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
                    .map((j) => (
                      <li key={`${j.kind}-${j.at}`} className="flex items-baseline justify-between gap-3 py-2 text-[14px]">
                        <span className={clsx("font-medium", j.kind === "drain" ? "text-danger" : "text-ink")}>
                          <Trans
                            i18nKey={j.kind === "refuel" ? "fuel.report.refuel" : j.engineOff ? "fuel.report.drainOff" : "fuel.report.drainOn"}
                            values={{ liters: liters.format(j.liters) }}
                            components={{ num: <span className="num" /> }}
                          />
                        </span>
                        <span className="num shrink-0 text-[13px] text-muted">{formatDateTime(j.at)}</span>
                      </li>
                    ))}
                </ul>
              </section>
            )}

            {r.drivers.length > 0 && (
              <section>
                <h3 className="mb-2 text-[14px] font-semibold text-ink">{t("fuel.report.byDriver")}</h3>
                <table className="w-full text-left text-[14px]">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-muted">
                      <th className="pb-1.5 font-medium">{t("fuel.report.driver")}</th>
                      <th className="pb-1.5 text-right font-medium">{t("fuel.report.distance")}</th>
                      <th className="pb-1.5 text-right font-medium">{t("fuel.report.consumption")}</th>
                      <th className="pb-1.5 text-right font-medium">{t("fuel.report.efficiency")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.drivers.map((d) => (
                      <tr key={d.driverId} className="border-t border-line">
                        <td className="py-2 pr-2 font-medium">{d.name}</td>
                        <td className="num py-2 text-right">{formatKm(d.distanceM)} km</td>
                        <td className="num py-2 text-right">{d.liters === null ? "—" : `${liters.format(d.liters)} L`}</td>
                        <td className="num py-2 text-right">{d.kmPerL === null ? "—" : `${two.format(d.kmPerL)} km/L`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

const normNote = (r: FuelReport) =>
  r.estimated ? i18n.t("fuel.report.normNote", { driving: liters.format(r.estimated.byDistanceL), idle: liters.format(r.estimated.byIdleL) }) : "";

/** What it consumed while idling: what the sensor measured, or what the norm says. */
const idleNote = (r: FuelReport) =>
  r.idle.realL !== null && r.idle.seconds > 0
    ? r.idle.estimatedL !== null
      ? i18n.t("fuel.report.idleSensorNorm", { liters: liters.format(r.idle.realL), norm: liters.format(r.idle.estimatedL) })
      : i18n.t("fuel.report.idleSensor", { liters: liters.format(r.idle.realL) })
    : r.idle.estimatedL !== null
      ? i18n.t("fuel.report.idleNorm", { liters: liters.format(r.idle.estimatedL) })
      : i18n.t("fuel.report.idleNone");

function Tile({ label, value, note, alert }: { label: string; value: string; note: string; alert?: boolean }) {
  return (
    <div className="rounded-[12px] bg-canvas px-3.5 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</p>
      <p className={clsx("num mt-1 text-[19px] font-semibold leading-tight tracking-tight", alert ? "text-danger" : "text-ink")}>{value}</p>
      <p className="mt-0.5 text-[12px] leading-snug text-muted">{note}</p>
    </div>
  );
}

/** What it consumed compared with what the norm says it should have consumed. */
function Compare({ real, estimated }: { real: number; estimated: number }) {
  const { t } = useTranslation();
  const diff = ((real - estimated) / estimated) * 100;
  const over = diff > 5;
  const text =
    Math.abs(diff) <= 5
      ? t("fuel.report.compareSame")
      : t(diff > 0 ? "fuel.report.compareMore" : "fuel.report.compareLess", { percent: Math.round(Math.abs(diff)) });
  return <Notice tone={over ? "error" : "success"}>{text}</Notice>;
}

const SERIES = "#2a78d6";
const PLOT = { left: 34, right: 10, top: 10, bottom: 20 };
const HEIGHT = 190;

/** Tank level over time: a single series, with the exact value when the pointer passes. */
function LevelChart({ series, capacityL }: { series: FuelReport["series"]; capacityL: number }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const first = series[0] as { t: number; l: number };
  const last = series[series.length - 1] as { t: number; l: number };
  const top = Math.max(capacityL, ...series.map((p) => p.l));
  const plotW = Math.max(0, width - PLOT.left - PLOT.right);
  const plotH = HEIGHT - PLOT.top - PLOT.bottom;
  const x = (t: number) => (last.t === first.t ? 0 : ((t - first.t) / (last.t - first.t)) * plotW);
  const y = (l: number) => plotH - (l / top) * plotH;
  const line = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.l).toFixed(1)}`).join(" ");
  const area = `${line} L${x(last.t).toFixed(1)} ${plotH} L0 ${plotH} Z`;
  const severalDays = new Date(first.t * 1000).toDateString() !== new Date(last.t * 1000).toDateString();
  const when = (t: number) => (severalDays ? `${formatDay(t * 1000)} ${formatClock(t * 1000)}` : formatClock(t * 1000));
  const shown = hover === null ? null : (series[hover] ?? null);
  const nearest = (clientX: number, rect: DOMRect) => {
    const t = first.t + ((clientX - rect.left) / Math.max(1, rect.width)) * (last.t - first.t);
    let best = 0;
    for (let i = 1; i < series.length; i++) if (Math.abs((series[i] as { t: number }).t - t) < Math.abs((series[best] as { t: number }).t - t)) best = i;
    return best;
  };

  return (
    <div ref={box} className="relative select-none">
      {width > 0 && (
        <svg width={width} height={HEIGHT} className="block" role="img" aria-label={t("fuel.chart.aria", { from: liters.format(first.l), to: liters.format(last.l) })}>
          <g transform={`translate(${PLOT.left} ${PLOT.top})`}>
            {[top, top / 2].map((v) => (
              <g key={v}>
                <line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke="rgb(16 22 35 / 0.08)" strokeWidth={1} />
                <text x={-7} y={y(v) + 3.5} textAnchor="end" className="num fill-current text-[10px] text-muted">
                  {Math.round(v)}
                </text>
              </g>
            ))}
            <line x1={0} x2={plotW} y1={plotH} y2={plotH} stroke="rgb(16 22 35 / 0.14)" strokeWidth={1} />
            <path d={area} fill={SERIES} fillOpacity={0.1} />
            <path d={line} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(last.t)} cy={y(last.l)} r={4} fill={SERIES} stroke="#fff" strokeWidth={2} />
            {shown && (
              <>
                <line x1={x(shown.t)} x2={x(shown.t)} y1={0} y2={plotH} stroke={SERIES} strokeOpacity={0.35} strokeWidth={1} />
                <circle cx={x(shown.t)} cy={y(shown.l)} r={5} fill={SERIES} stroke="#fff" strokeWidth={2} />
              </>
            )}
            <text x={0} y={plotH + 14} className="num fill-current text-[10px] text-muted">
              {when(first.t)}
            </text>
            <text x={plotW} y={plotH + 14} textAnchor="end" className="num fill-current text-[10px] text-muted">
              {when(last.t)}
            </text>
            <rect
              x={0}
              y={-PLOT.top}
              width={plotW}
              height={HEIGHT}
              fill="transparent"
              className="touch-none"
              onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
              onPointerDown={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
              onPointerLeave={() => setHover(null)}
            />
          </g>
        </svg>
      )}
      {shown && (
        <div
          className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-lg bg-panel px-2.5 py-1.5 text-[12px] text-white shadow-lg"
          style={{ left: Math.min(Math.max(PLOT.left + x(shown.t), 70), width - 70), transform: "translate(-50%, -20%)" }}
        >
          <span className="num font-semibold">{liters.format(shown.l)} L</span>
          <span className="num text-white/60"> · {when(shown.t)}</span>
        </div>
      )}
      <p className="mt-1 text-[12px] text-muted">{t("fuel.chart.note")}</p>
    </div>
  );
}
