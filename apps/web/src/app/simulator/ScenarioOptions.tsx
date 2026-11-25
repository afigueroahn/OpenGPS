// What happens to a simulated vehicle along its route: stops, fuel, speeding,
// its start disabled, a tow, alarms, a loss of signal, and what its device
// reports. Only what the chosen brand carries is offered.
import { SIM_ACTION_KINDS, SIM_ALARMS, SIM_LIMITS, SIM_PRESETS, type SimActionKind, type SimAlarm, type SimBrand, type SimPreset, type SimRouteSummary, simPreset } from "@opengps/shared";
import clsx from "clsx";
import { ChevronDown, Plus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatKm } from "../../lib/format";
import { labelClass } from "../reports/kit";
import { type ActionDraft, type ScenarioDraft, carried, draftOf, newAction } from "./scenarioDraft";

const mini = "h-9 min-w-0 rounded-[9px] border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-ink focus:outline-none disabled:opacity-50";
const small = "mb-1 block text-[12px] text-ink-3";

/** A short field of a row, with its label above. */
function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={clsx("min-w-0", className)}>
      <span className={small}>{label}</span>
      {children}
    </label>
  );
}

export function ScenarioOptions({ draft, onChange, brand, route }: { draft: ScenarioDraft; onChange: (next: ScenarioDraft) => void; brand: SimBrand; route: SimRouteSummary }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(draft.actions.length > 0 || draft.fuelOn || draft.driverKey !== "" || draft.extraIo !== "" || !draft.reportIgnition || !draft.roadSpeeds);
  const [preset, setPreset] = useState<SimPreset | "">("");
  const [adding, setAdding] = useState<SimActionKind>("stop");
  const carries = (kind: SimActionKind, alarm?: SimAlarm) => carried(brand.capabilities, kind, alarm);
  const alarms = SIM_ALARMS.filter((alarm) => carries("alarm", alarm));
  /** A kind is offered if the brand carries it; an alarm, if it carries at least one. */
  const offered = (kind: SimActionKind) => (kind === "alarm" ? alarms.length > 0 : carries(kind));
  const set = (patch: Partial<ScenarioDraft>) => onChange({ ...draft, ...patch });
  const setAction = (key: number, patch: Partial<ActionDraft>) => set({ actions: draft.actions.map((a) => (a.key === key ? { ...a, ...patch } : a)) });

  const apply = () => {
    if (!preset) return;
    const made = simPreset(preset, route.lengthM);
    // What this brand does not carry would never reach the platform: it is left out.
    const actions = made.actions.filter((a) => carries(a.kind, a.kind === "alarm" ? a.alarm : undefined)).map(draftOf);
    const fuel = made.fuel && brand.capabilities.includes("fuel") ? { fuelOn: true, fuelStart: String(made.fuel.startPct), fuelBurn: String(made.fuel.burnPer100Km) } : {};
    set({ actions, ...fuel });
    setPreset("");
  };
  const add = () => {
    if (draft.actions.length >= SIM_LIMITS.actions) return;
    // Past what is already there, so the list reads in the order of the road.
    const last = Math.max(0, ...draft.actions.map((a) => Number(a.km.replace(",", ".")) * 1000 || 0));
    const atM = Math.min(route.lengthM, draft.actions.length === 0 ? route.lengthM * 0.3 : last + route.lengthM * 0.1);
    set({ actions: [...draft.actions, newAction(adding, atM, alarms[0])] });
  };

  const things = draft.actions.length;
  return (
    <div className="rounded-[12px] border border-line">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left">
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold">{t("simulator.options.title")}</span>
          <span className="block text-[12.5px] text-muted">{things > 0 ? t("simulator.options.count", { count: things }) : t("simulator.options.note")}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" className={clsx("shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-5 border-t border-line px-3.5 py-4">
          <div>
            <label htmlFor="sim-preset" className={labelClass}>
              {t("simulator.options.preset")}
            </label>
            <div className="flex gap-2">
              <select id="sim-preset" className={clsx(mini, "flex-1")} value={preset} onChange={(e) => setPreset(e.target.value as SimPreset | "")}>
                <option value="">{t("simulator.options.presetNone")}</option>
                {SIM_PRESETS.map((id) => (
                  <option key={id} value={id}>
                    {t(`simulator.options.presets.${id}`)}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!preset} onClick={apply} className={clsx(mini, "font-medium")}>
                {t("simulator.options.presetApply")}
              </button>
            </div>
            <p className="mt-1.5 text-[12.5px] text-muted">{t("simulator.options.presetNote")}</p>
          </div>

          <div>
            <p className={labelClass}>{t("simulator.options.list")}</p>
            {things === 0 ? (
              <p className="text-[13px] text-muted">{t("simulator.options.empty")}</p>
            ) : (
              <ol className="space-y-2">
                {draft.actions.map((a, i) => {
                  const kind = t(`simulator.options.kind.${a.kind}`);
                  return (
                    <li key={a.key} className="rounded-[10px] bg-canvas px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[13.5px] font-semibold">
                          <span className="num mr-1.5 text-muted">{i + 1}</span>
                          {kind}
                        </span>
                        <button type="button" onClick={() => set({ actions: draft.actions.filter((x) => x.key !== a.key) })} aria-label={t("simulator.options.remove", { what: kind })} className="rounded-md p-1 text-muted hover:bg-surface hover:text-danger">
                          <X size={14} aria-hidden="true" />
                        </button>
                      </div>
                      <div className="mt-1.5 grid grid-cols-2 items-end gap-2 sm:grid-cols-4">
                        <Cell label={t("simulator.options.at")}>
                          <input className={clsx(mini, "num w-full")} inputMode="decimal" value={a.km} onChange={(e) => setAction(a.key, { km: e.target.value.replace(/[^\d.,]/g, "") })} maxLength={8} />
                        </Cell>
                        {(a.kind === "stop" || a.kind === "refuel" || a.kind === "drain" || a.kind === "engineLock" || a.kind === "signalLoss") && (
                          <Cell label={t("simulator.options.seconds")}>
                            <input className={clsx(mini, "num w-full")} inputMode="numeric" value={a.seconds} onChange={(e) => setAction(a.key, { seconds: e.target.value.replace(/\D/g, "") })} maxLength={5} />
                          </Cell>
                        )}
                        {(a.kind === "refuel" || a.kind === "drain") && (
                          <Cell label={t("simulator.options.percent")}>
                            <input className={clsx(mini, "num w-full")} inputMode="numeric" value={a.pct} onChange={(e) => setAction(a.key, { pct: e.target.value.replace(/\D/g, "") })} maxLength={3} />
                          </Cell>
                        )}
                        {(a.kind === "speeding" || a.kind === "towing") && (
                          <Cell label={t("simulator.options.stretch")}>
                            <input className={clsx(mini, "num w-full")} inputMode="numeric" value={a.meters} onChange={(e) => setAction(a.key, { meters: e.target.value.replace(/\D/g, "") })} maxLength={7} />
                          </Cell>
                        )}
                        {a.kind === "speeding" && (
                          <Cell label={t("simulator.options.kmh")}>
                            <input className={clsx(mini, "num w-full")} inputMode="numeric" value={a.kmh} onChange={(e) => setAction(a.key, { kmh: e.target.value.replace(/\D/g, "") })} maxLength={3} />
                          </Cell>
                        )}
                        {a.kind === "stop" && (
                          <label className="col-span-2 flex h-9 items-center gap-2 text-[13px]">
                            <input type="checkbox" checked={a.engineOn} onChange={(e) => setAction(a.key, { engineOn: e.target.checked })} />
                            {t("simulator.options.engineOn")}
                          </label>
                        )}
                        {a.kind === "alarm" && (
                          <Cell label={t("simulator.options.alarmWhich")} className="col-span-2">
                            <select className={clsx(mini, "w-full")} value={a.alarm} onChange={(e) => setAction(a.key, { alarm: e.target.value as SimAlarm })}>
                              {SIM_ALARMS.map((alarm) => (
                                <option key={alarm} value={alarm} disabled={!carries("alarm", alarm)}>
                                  {carries("alarm", alarm) ? t(`simulator.alarm.${alarm}`) : t("simulator.options.notCarried", { what: t(`simulator.alarm.${alarm}`) })}
                                </option>
                              ))}
                            </select>
                          </Cell>
                        )}
                        {a.kind === "driverKey" && (
                          <Cell label={t("simulator.options.driver")} className="col-span-2">
                            <input className={clsx(mini, "num w-full")} value={a.driver} onChange={(e) => setAction(a.key, { driver: e.target.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase() })} maxLength={16} placeholder={t("simulator.options.driverNone")} />
                          </Cell>
                        )}
                        {a.kind === "dtc" && (
                          <Cell label={t("simulator.options.codes")} className="col-span-2">
                            <input className={clsx(mini, "num w-full")} value={a.codes} onChange={(e) => setAction(a.key, { codes: e.target.value.toUpperCase() })} maxLength={80} placeholder={t("simulator.options.codesHint")} />
                          </Cell>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="mt-2.5 flex gap-2">
              <select className={clsx(mini, "flex-1")} value={adding} onChange={(e) => setAdding(e.target.value as SimActionKind)} aria-label={t("simulator.options.add")}>
                {SIM_ACTION_KINDS.map((kind) => (
                  <option key={kind} value={kind} disabled={!offered(kind)}>
                    {offered(kind) ? t(`simulator.options.kind.${kind}`) : t("simulator.options.notCarried", { what: t(`simulator.options.kind.${kind}`) })}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!offered(adding) || things >= SIM_LIMITS.actions} onClick={add} className={clsx(mini, "inline-flex items-center gap-1.5 font-medium")}>
                <Plus size={14} aria-hidden="true" />
                {t("simulator.options.add")}
              </button>
            </div>
            <p className="mt-1.5 text-[12.5px] text-muted">{t("simulator.options.atHint", { km: formatKm(route.lengthM) })}</p>
          </div>

          <div className="space-y-3">
            <p className={labelClass}>{t("simulator.options.device")}</p>
            {brand.capabilities.includes("fuel") && (
              <div>
                <label className="flex items-center gap-2 text-[13.5px]">
                  <input type="checkbox" checked={draft.fuelOn} onChange={(e) => set({ fuelOn: e.target.checked })} />
                  {t("simulator.options.fuel")}
                </label>
                {draft.fuelOn && (
                  <>
                    <div className="mt-2 grid grid-cols-2 items-end gap-2">
                      <Cell label={t("simulator.options.fuelStart")}>
                        <input className={clsx(mini, "num w-full")} inputMode="numeric" value={draft.fuelStart} onChange={(e) => set({ fuelStart: e.target.value.replace(/\D/g, "") })} maxLength={3} />
                      </Cell>
                      <Cell label={t("simulator.options.fuelBurn")}>
                        <input className={clsx(mini, "num w-full")} inputMode="decimal" value={draft.fuelBurn} onChange={(e) => set({ fuelBurn: e.target.value.replace(/[^\d.,]/g, "") })} maxLength={5} />
                      </Cell>
                    </div>
                    <p className="mt-1.5 text-[12.5px] text-muted">{t("simulator.options.fuelNote")}</p>
                  </>
                )}
              </div>
            )}
            {brand.capabilities.includes("driverKey") && (
              <Cell label={t("simulator.options.driverStart")}>
                <input className={clsx(mini, "num w-full")} value={draft.driverKey} onChange={(e) => set({ driverKey: e.target.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase() })} maxLength={16} placeholder={t("simulator.options.driverNone")} />
                <span className="mt-1 block text-[12.5px] text-muted">{t("simulator.options.driverNote")}</span>
              </Cell>
            )}
            {brand.capabilities.includes("voltage") && (
              <label className="flex items-center gap-2 text-[13.5px]">
                <input type="checkbox" checked={!draft.reportIgnition} onChange={(e) => set({ reportIgnition: !e.target.checked })} />
                {t("simulator.options.reportIgnition")}
              </label>
            )}
            {route.timed && (
              <label className="flex items-center gap-2 text-[13.5px]">
                <input type="checkbox" checked={draft.roadSpeeds} onChange={(e) => set({ roadSpeeds: e.target.checked })} />
                {t("simulator.options.roadSpeeds")}
              </label>
            )}
            {brand.capabilities.includes("extraIo") && (
              <Cell label={t("simulator.options.extraIo")}>
                <input className={clsx(mini, "num w-full")} value={draft.extraIo} onChange={(e) => set({ extraIo: e.target.value })} maxLength={300} placeholder="66=11500" />
                <span className="mt-1 block text-[12.5px] text-muted">{t("simulator.options.extraIoHint")}</span>
              </Cell>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
