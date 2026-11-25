// What is done by hand to a simulated device while it runs: an alarm, its
// start cut, a theft, a change of fuel, a disconnection, or its whole route
// sent as a trip of the past. Only what its brand carries is offered.
import { SIM_ALARMS, type SimAlarm, type SimBrand, type SimInjectInput, type SimulationDetail } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice } from "../../components/ui";
import { backfillSimulation, injectSimulation } from "../../lib/simulator";
import { errorText } from "../widgets";

const mini = "h-9 min-w-0 rounded-[9px] border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-ink focus:outline-none";
const small = "mb-1 block text-[12px] text-ink-3";

/** A whole number typed by hand, within its range; null if it is not one. */
const whole = (text: string, min: number, max: number): number | null => {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export function LiveControl({ simulation, brand }: { simulation: SimulationDetail; brand: SimBrand }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const carries = (capability: SimBrand["capabilities"][number]) => brand.capabilities.includes(capability);
  const alarms = SIM_ALARMS.filter((alarm) => carries(alarm));
  const [alarm, setAlarm] = useState<SimAlarm>(alarms[0] ?? "sos");
  const [seconds, setSeconds] = useState("300");
  const [points, setPoints] = useState("20");
  const [hours, setHours] = useState("24");
  const [problem, setProblem] = useState<string | null>(null);
  const device = simulation.devices[0];

  const done = (next: SimulationDetail) => queryClient.setQueryData(["admin", "simulator", "simulation", simulation.id], next);
  const inject = useMutation({ mutationFn: (body: SimInjectInput) => injectSimulation(simulation.id, body), onSuccess: done });
  const backfill = useMutation({ mutationFn: (hoursAgo: number) => backfillSimulation(simulation.id, hoursAgo), onSuccess: (r) => done(r.simulation) });
  const busy = inject.isPending || backfill.isPending;

  /** Sends what needs seconds, or points, once they are numbers within their range. */
  const withNumbers = (make: (s: number, p: number) => SimInjectInput) => {
    const s = whole(seconds, 1, 86_400);
    const p = whole(points, 1, 100);
    if (s === null || p === null) return setProblem(t("simulator.control.range"));
    setProblem(null);
    backfill.reset();
    inject.mutate(make(s, p));
  };
  const sendPast = () => {
    const h = Number(hours.trim().replace(",", "."));
    if (hours.trim() === "" || !Number.isFinite(h) || h < 0 || h > 720) return setProblem(t("simulator.control.range"));
    setProblem(null);
    inject.reset();
    backfill.mutate(h);
  };

  if (!simulation.running) {
    return (
      <div>
        <h3 className="text-[13px] font-semibold text-ink-3">{t("simulator.control.title")}</h3>
        <p className="mt-1.5 text-sm text-muted">{t("simulator.control.stopped")}</p>
      </div>
    );
  }
  const failed = inject.error ?? backfill.error;
  return (
    <div>
      <h3 className="text-[13px] font-semibold text-ink-3">{t("simulator.control.title")}</h3>
      <p className="mt-0.5 text-[12.5px] text-muted">{t("simulator.control.note")}</p>
      <div className="mt-2.5 space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          {alarms.length > 0 && (
            <>
              <label className="min-w-0 flex-1 basis-44">
                <span className={small}>{t("simulator.control.alarm")}</span>
                <select className={clsx(mini, "w-full")} value={alarm} onChange={(e) => setAlarm(e.target.value as SimAlarm)}>
                  {alarms.map((id) => (
                    <option key={id} value={id}>
                      {t(`simulator.alarm.${id}`)}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="button" variant="secondary" size="sm" className="h-9" disabled={busy} onClick={() => inject.mutate({ kind: "alarm", alarm })}>
                {t("simulator.control.send")}
              </Button>
            </>
          )}
          {carries("lockState") && (
            <Button type="button" variant="secondary" size="sm" className="h-9" disabled={busy} onClick={() => inject.mutate({ kind: "engineLock", on: !device?.engineCut })}>
              {device?.engineCut ? t("simulator.control.unlock") : t("simulator.control.lock")}
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" className="h-9" disabled={busy} title={t("simulator.control.theftNote")} onClick={() => inject.mutate({ kind: "theft", seconds: 300 })}>
            {t("simulator.control.theft")}
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="w-24">
            <span className={small}>{t("simulator.control.seconds")}</span>
            <input className={clsx(mini, "num w-full")} inputMode="numeric" value={seconds} onChange={(e) => setSeconds(e.target.value.replace(/\D/g, ""))} maxLength={5} />
          </label>
          {carries("stored") && (
            <Button type="button" variant="secondary" size="sm" className="h-9" disabled={busy} title={t("simulator.control.disconnectNote")} onClick={() => withNumbers((s) => ({ kind: "disconnect", seconds: s }))}>
              {t("simulator.control.disconnect")}
            </Button>
          )}
          {device?.fuelPct != null && (
            <>
              <label className="w-32">
                <span className={small}>{t("simulator.control.points")}</span>
                <input className={clsx(mini, "num w-full")} inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ""))} maxLength={3} />
              </label>
              <Button type="button" variant="secondary" size="sm" className="h-9" disabled={busy} title={t("simulator.control.fuelNote")} onClick={() => withNumbers((s, p) => ({ kind: "fuel", pct: p, seconds: s }))}>
                {t("simulator.control.fuelUp")}
              </Button>
              <Button type="button" variant="secondary" size="sm" className="h-9" disabled={busy} title={t("simulator.control.fuelNote")} onClick={() => withNumbers((s, p) => ({ kind: "fuel", pct: -p, seconds: s }))}>
                {t("simulator.control.fuelDown")}
              </Button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="w-40">
            <span className={small}>{t("simulator.control.hoursAgo")}</span>
            <input className={clsx(mini, "num w-full")} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value.replace(/[^\d.,]/g, ""))} maxLength={6} />
          </label>
          <Button type="button" variant="secondary" size="sm" className="h-9" loading={backfill.isPending} disabled={busy} onClick={sendPast}>
            {t("simulator.control.backfill")}
          </Button>
          <p className="basis-full text-[12.5px] text-muted">{t("simulator.control.backfillNote")}</p>
        </div>

        {backfill.data && !problem && !failed && <Notice tone="success">{t("simulator.control.backfillDone", { count: backfill.data.reports })}</Notice>}
        {(problem || failed) && <Notice tone="error">{problem ?? errorText(failed)}</Notice>}
      </div>
    </div>
  );
}
