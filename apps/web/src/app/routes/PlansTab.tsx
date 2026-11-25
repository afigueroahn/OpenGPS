// Planned routes: where each route goes (its path, drawn on the map or
// taken from a real trip), how far a vehicle may stray from it and at
// which places it stops, with its schedule. They serve as a mold for dispatches.
import type { Poi, RoutePlan, RoutePlanInput, Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, Route, Trash, Undo2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { formatKm } from "../../lib/format";
import { deleteRoutePlan, getPois, getRouteLine, getRoutePlans, saveRoutePlan } from "../../lib/routes";
import { today } from "../fleet/format";
import { Card } from "../reports/kit";
import { errorText } from "../widgets";
import { RouteMap } from "./RouteMap";
import { type StopDraft, StopsEditor, newStop } from "./StopsEditor";

export function PlansTab({ vehicles, canManage }: { vehicles: Vehicle[]; canManage: boolean }) {
  const { t } = useTranslation();
  const plans = useQuery({ queryKey: ["routes", "plans"], queryFn: getRoutePlans });
  const pois = useQuery({ queryKey: ["routes", "pois"], queryFn: getPois });
  const [editing, setEditing] = useState<RoutePlan | "new" | null>(null);
  return (
    <div className="space-y-4">
      <Card
        title={t("routes.plans.title")}
        note={t("routes.plans.note")}
        action={
          canManage ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus size={15} aria-hidden="true" /> {t("routes.plans.new")}
            </Button>
          ) : undefined
        }
      >
        {plans.isLoading && (
          <div className="flex h-24 items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
        {plans.isError && <Notice tone="error">{errorText(plans.error)}</Notice>}
        {plans.data &&
          (plans.data.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm leading-relaxed text-ink-3">{canManage ? t("routes.plans.emptyManage") : t("routes.plans.empty")}</p>
          ) : (
            <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
              {plans.data.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => setEditing(p)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas/70">
                    <Route size={18} className="shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-ink">{p.name}</span>
                      <span className="block truncate text-[12.5px] text-muted">{p.stops.map((s) => s.name).join(" → ")}</span>
                    </span>
                    <span className="num shrink-0 text-right text-[12.5px] text-ink-3">
                      {t("routes.plans.stopCount", { count: p.stops.length })}
                      <span className="block text-muted">{p.line.length >= 2 ? `${formatKm(p.lengthM)} km · ±${p.toleranceM} m` : t("routes.plans.noPath")}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Card>
      {editing && <PlanDialog plan={editing === "new" ? null : editing} pois={pois.data ?? []} vehicles={vehicles} canManage={canManage} onClose={() => setEditing(null)} />}
    </div>
  );
}

type Mode = "none" | "stop" | "line";
// Without colors: whoever uses it sets them, so the "active" one does not clash with the normal one.
const miniBase = "h-9 rounded-[9px] border px-2.5 text-[13px] focus:outline-none";
const mini = `${miniBase} border-line bg-surface text-ink focus:border-ink`;
const toggle = (on: boolean) => clsx(miniBase, "font-medium", on ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink");
/** An integer typed by hand; empty is null. */
const whole = (text: string) => (text.trim() === "" ? null : Number(text.trim()));

function PlanDialog({ plan, pois, vehicles, canManage, onClose }: { plan: RoutePlan | null; pois: Poi[]; vehicles: Vehicle[]; canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(plan?.name ?? "");
  const [tolerance, setTolerance] = useState(String(plan?.toleranceM ?? 150));
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const [line, setLine] = useState<[number, number][]>(plan?.line ?? []);
  const [stops, setStops] = useState<StopDraft[]>(() => (plan?.stops ?? []).map((s) => newStop(s, s.name, { radiusM: s.radiusM, etaMin: s.etaMin === null ? "" : String(s.etaMin), stayMin: s.stayMin === null ? "" : String(s.stayMin), contact: s.contact ?? "" })));
  const [mode, setMode] = useState<Mode>("none");
  const [fit, setFit] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  // Take the path from a real trip.
  const [fromTrip, setFromTrip] = useState(false);
  const [source, setSource] = useState({ vehicleId: vehicles[0]?.id ?? "", date: today(), from: "06:00", to: "18:00" });
  const done = (next?: RoutePlan[]) => {
    if (next) queryClient.setQueryData(["routes", "plans"], next);
    else void queryClient.invalidateQueries({ queryKey: ["routes", "plans"] });
    onClose();
  };
  const save = useMutation({ mutationFn: (body: RoutePlanInput) => saveRoutePlan(plan?.id ?? null, body), onSuccess: done });
  const remove = useMutation({ mutationFn: () => deleteRoutePlan(plan?.id ?? ""), onSuccess: () => done() });
  const take = useMutation({
    mutationFn: () => getRouteLine(source.vehicleId, new Date(`${source.date}T${source.from}:00`), new Date(`${source.date}T${source.to}:00`)),
    onSuccess: (found) => {
      setLine(found.line);
      setFromTrip(false);
      setMode("none");
      setFit((n) => n + 1);
    },
  });

  const pick = (lat: number, lon: number) => {
    if (mode === "stop") setStops((old) => [...old, newStop({ lat, lon }, t("routes.plans.stopName", { n: old.length + 1 }))]);
    if (mode === "line") setLine((old) => [...old, [lon, lat]]);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const tol = Number(tolerance);
    if (!name.trim()) return setProblem(t("routes.plans.needName"));
    if (stops.length === 0) return setProblem(t("routes.plans.needStop"));
    if (stops.some((s) => !s.name.trim())) return setProblem(t("routes.plans.stopNeedsName"));
    if (!Number.isInteger(tol) || tol < 30 || tol > 2000) return setProblem(t("routes.plans.toleranceRange"));
    if (line.length === 1) return setProblem(t("routes.plans.pathPoints"));
    const list = [];
    for (const s of stops) {
      const etaMin = whole(s.etaMin);
      const stayMin = whole(s.stayMin);
      if ([etaMin, stayMin].some((n) => n !== null && (!Number.isInteger(n) || n < 0))) return setProblem(t("routes.plans.minutes", { name: s.name.trim() }));
      list.push({ name: s.name.trim(), lat: s.lat, lon: s.lon, radiusM: s.radiusM, etaMin, stayMin, contact: s.contact || null });
    }
    setProblem(null);
    save.mutate({ name: name.trim(), line, toleranceM: tol, notes: notes || null, stops: list });
  };

  return (
    <Modal open onClose={onClose} title={plan ? t("routes.plans.editTitle") : t("routes.plans.newTitle")} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <fieldset disabled={!canManage} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.7fr_1fr]">
            <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("routes.plans.namePlaceholder")} />
            <Field label={t("routes.plans.tolerance")} value={tolerance} onChange={(e) => setTolerance(e.target.value)} inputMode="numeric" mono hint={t("routes.plans.toleranceHint")} />
          </div>

          <div>
            <RouteMap line={line} points={stops.map((s, i) => ({ lat: s.lat, lon: s.lon, label: String(i + 1) }))} onPick={canManage && mode !== "none" ? pick : undefined} fitKey={fit} className="h-64" />
            {canManage && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button type="button" aria-pressed={mode === "stop"} onClick={() => setMode(mode === "stop" ? "none" : "stop")} className={toggle(mode === "stop")}>
                  {t("routes.plans.markStops")}
                </button>
                <button type="button" aria-pressed={mode === "line"} onClick={() => setMode(mode === "line" ? "none" : "line")} className={toggle(mode === "line")}>
                  {t("routes.plans.drawPath")}
                </button>
                {mode === "line" && line.length > 0 && (
                  <button type="button" onClick={() => setLine((old) => old.slice(0, -1))} className={clsx(mini, "inline-flex items-center gap-1")}>
                    <Undo2 size={13} aria-hidden="true" /> {t("routes.plans.undo")}
                  </button>
                )}
                <button type="button" onClick={() => setFromTrip((v) => !v)} className={clsx(miniBase, "bg-surface text-ink", fromTrip ? "border-ink" : "border-line")}>
                  {t("routes.plans.fromTrip")}
                </button>
                {stops.length >= 2 && (
                  <button type="button" onClick={() => setLine(stops.map((s) => [s.lon, s.lat]))} className={mini}>
                    {t("routes.plans.joinStops")}
                  </button>
                )}
                {line.length > 0 && (
                  <button type="button" onClick={() => setLine([])} className={clsx(miniBase, "border-line bg-surface text-danger")}>
                    {t("routes.plans.clearPath")}
                  </button>
                )}
              </div>
            )}
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
              {mode === "stop" ? t("routes.plans.hintStop") : mode === "line" ? t("routes.plans.hintLine") : line.length >= 2 ? t("routes.plans.hintWithPath") : t("routes.plans.hintNoPath")}
            </p>
            {fromTrip && (
              <div className="mt-2 flex flex-wrap items-end gap-2 rounded-[12px] border border-line px-3 py-2.5">
                <label className="min-w-0 flex-1 basis-40 text-[12.5px] text-ink-3">
                  {t("common.vehicle")}
                  <select value={source.vehicleId} onChange={(e) => setSource({ ...source, vehicleId: e.target.value })} className={clsx(mini, "mt-1 block w-full")}>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-[12.5px] text-ink-3">
                  {t("routes.plans.day")}
                  <input type="date" value={source.date} max={today()} onChange={(e) => setSource({ ...source, date: e.target.value })} className={clsx(mini, "num mt-1 block")} />
                </label>
                <label className="text-[12.5px] text-ink-3">
                  {t("common.from")}
                  <input type="time" value={source.from} onChange={(e) => setSource({ ...source, from: e.target.value })} className={clsx(mini, "num mt-1 block")} />
                </label>
                <label className="text-[12.5px] text-ink-3">
                  {t("common.to")}
                  <input type="time" value={source.to} onChange={(e) => setSource({ ...source, to: e.target.value })} className={clsx(mini, "num mt-1 block")} />
                </label>
                <Button type="button" size="sm" loading={take.isPending} disabled={!source.vehicleId || !source.date || source.to <= source.from} onClick={() => take.mutate()}>
                  {t("routes.plans.take")}
                </Button>
                {take.isError && <p className="w-full text-[13px] text-danger">{errorText(take.error)}</p>}
              </div>
            )}
          </div>

          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-ink-3">
              <Trans i18nKey="routes.plans.stopsLabel" components={{ muted: <span className="font-normal text-muted" /> }} />
            </span>
            <StopsEditor stops={stops} onChange={setStops} pois={pois} schedule />
          </div>
          <Field label={t("routes.plans.notes")} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </fieldset>
        {(problem || save.isError || remove.isError) && <Notice tone="error">{problem ?? errorText(save.error ?? remove.error)}</Notice>}
        {canManage ? (
          <div className="flex items-center justify-between gap-2">
            {plan ? (
              <Button type="button" variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
                <Trash size={14} aria-hidden="true" /> {t("common.delete")}
              </Button>
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={save.isPending}>
                {t("common.save")}
              </Button>
            </span>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
