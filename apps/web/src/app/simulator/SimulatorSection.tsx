// Administration → System → Simulator: simulated GPS devices that connect to
// the gateway like real ones, to test the platform without hardware.
import type { SimRouteSummary, SimulationSummary } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Pencil, Play, Plus, Square, Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice, Spinner } from "../../components/ui";
import { formatKm, timeAgo } from "../../lib/format";
import { deleteSimRoute, deleteSimulation, getSimRoutes, getSimulations, getSimulatorMeta, runAllSimulations, runSimulation } from "../../lib/simulator";
import { Card, Segmented } from "../reports/kit";
import { ConfirmDialog, errorText } from "../widgets";
import { LivePanel, SimStatusChip } from "./LivePanel";
import { RouteEditor } from "./RouteEditor";
import { SimulationDialog } from "./SimulationDialog";

const KEY = ["admin", "simulator"] as const;

export function SimulatorSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const meta = useQuery({ queryKey: [...KEY, "meta"], queryFn: getSimulatorMeta });
  const routes = useQuery({ queryKey: [...KEY, "routes"], queryFn: getSimRoutes });
  const simulations = useQuery({
    queryKey: [...KEY, "simulations"],
    queryFn: getSimulations,
    // While something runs, the list follows it.
    refetchInterval: (q) => (q.state.data?.some((s) => s.running) ? 2000 : false),
  });
  const [editing, setEditing] = useState<SimulationSummary | "new" | null>(null);
  const [removing, setRemoving] = useState<SimulationSummary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"devices" | "routes">("devices");
  /** The route being built or changed: it takes the whole section while it is open. */
  const [routeEditing, setRouteEditing] = useState<string | "new" | null>(null);
  const [routeRemoving, setRouteRemoving] = useState<SimRouteSummary | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const run = useMutation({ mutationFn: ({ id, on }: { id: string; on: boolean }) => runSimulation(id, on), onSettled: refresh });
  const runAll = useMutation({ mutationFn: (on: boolean) => runAllSimulations(on), onSettled: refresh });

  const failed = meta.error ?? routes.error ?? simulations.error;
  if (!meta.data || !routes.data || !simulations.data) {
    if (failed) return <Notice tone="error">{errorText(failed)}</Notice>;
    return (
      <div className="flex h-40 items-center justify-center text-muted">
        <Spinner size={22} />
      </div>
    );
  }
  const list = simulations.data;
  const running = list.filter((s) => s.running).length;
  const shown = list.find((s) => s.id === selected) ?? list[0] ?? null;

  if (routeEditing) return <RouteEditor key={routeEditing} routeId={routeEditing === "new" ? null : routeEditing} meta={meta.data} onClose={() => setRouteEditing(null)} />;

  const tabs = (
    <Segmented
      label={t("simulator.tabs.label")}
      value={tab}
      onChange={setTab}
      options={[
        { id: "devices", label: t("simulator.tabs.devices") },
        { id: "routes", label: t("simulator.tabs.routes") },
      ]}
    />
  );
  if (tab === "routes") {
    return (
      <div className="space-y-6">
        {tabs}
        <Card
          title={t("simulator.routes.title")}
          note={t("simulator.routes.note")}
          action={
            <Button size="sm" onClick={() => setRouteEditing("new")}>
              <Plus size={15} aria-hidden="true" />
              {t("simulator.routes.new")}
            </Button>
          }
        >
          {routes.data.length === 0 ? (
            <p className="py-2 text-sm text-muted">{t("simulator.routes.empty")}</p>
          ) : (
            <ul className="divide-y divide-line">
              {routes.data.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="truncate font-semibold">{r.name}</p>
                    <p className="truncate text-[13px] text-muted">
                      {t("simulator.routes.km", { km: formatKm(r.lengthM) })} · {r.closed ? t("simulator.routes.circuit") : t("simulator.routes.open")} · {t(`simulator.routes.kind.${r.timed ? "streets" : "straight"}`)}
                      {r.inUse > 0 && ` · ${t("simulator.routes.inUse", { count: r.inUse })}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setRouteEditing(r.id)} aria-label={`${t("common.edit")}: ${r.name}`} title={t("common.edit")}>
                      <Pencil size={15} aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRouteRemoving(r)} aria-label={`${t("common.delete")}: ${r.name}`} title={t("common.delete")}>
                      <Trash size={15} aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {routeRemoving && (
          <ConfirmDialog open title={t("simulator.routes.removeTitle")} confirm={t("simulator.routes.removeConfirm")} onClose={() => setRouteRemoving(null)} action={() => deleteSimRoute(routeRemoving.id)} onDone={refresh}>
            {t("simulator.routes.removeText", { name: routeRemoving.name })}
          </ConfirmDialog>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {tabs}
      <Notice>{t("simulator.intro")}</Notice>
      <Card
        title={t("simulator.list.title")}
        note={t("simulator.list.capacity", { running, max: meta.data.maxDevices })}
        action={
          <div className="flex flex-wrap gap-2">
            {list.length > 1 && (
              <Button variant="secondary" size="sm" loading={runAll.isPending} onClick={() => runAll.mutate(running === 0)}>
                {running === 0 ? t("simulator.list.startAll") : t("simulator.list.stopAll")}
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus size={15} aria-hidden="true" />
              {t("simulator.list.new")}
            </Button>
          </div>
        }
      >
        {(run.isError || runAll.isError) && (
          <div className="mb-3">
            <Notice tone="error">{errorText(run.error ?? runAll.error)}</Notice>
          </div>
        )}
        {list.length === 0 ? (
          <p className="py-2 text-sm text-muted">{t("simulator.list.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((s) => {
              const brand = meta.data.brands.find((b) => b.modelId === s.modelId)?.brand ?? s.modelId;
              const busy = run.isPending && run.variables?.id === s.id;
              return (
                <li key={s.id} className={clsx("flex flex-wrap items-center gap-x-4 gap-y-2 py-3", shown?.id === s.id && list.length > 1 && "-mx-4 bg-canvas px-4")}>
                  <button type="button" onClick={() => setSelected(s.id)} aria-label={t("simulator.list.view", { name: s.name })} className="min-w-0 flex-1 basis-64 text-left">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold">{s.name}</span>
                      <SimStatusChip status={s.status} />
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] text-muted">
                      {brand} · <span className="num">{s.identifiers[0]}</span> · {s.routeName}
                    </span>
                    <span className="block truncate text-[12.5px] text-muted">
                      <span className="num">{t("simulator.list.target", { host: s.host, port: s.port })}</span> · {t("simulator.list.every", { seconds: s.intervalS })} ·{" "}
                      {s.lastSentAt ? t("simulator.list.sent", { when: timeAgo(s.lastSentAt) }) : t("simulator.list.neverSent")}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant={s.running ? "secondary" : "signal"} size="sm" loading={busy} onClick={() => run.mutate({ id: s.id, on: !s.running })}>
                      {s.running ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                      {s.running ? t("simulator.list.stop") : t("simulator.list.start")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(s)} aria-label={`${t("common.edit")}: ${s.name}`} title={t("common.edit")}>
                      <Pencil size={15} aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(s)} aria-label={`${t("common.delete")}: ${s.name}`} title={t("common.delete")}>
                      <Trash size={15} aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {shown && <LivePanel key={shown.id} id={shown.id} brands={meta.data.brands} />}

      {editing && (
        <SimulationDialog
          simulation={editing === "new" ? null : editing}
          meta={meta.data}
          routes={routes.data}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setSelected(id);
            setEditing(null);
          }}
        />
      )}
      {removing && (
        <ConfirmDialog open title={t("simulator.remove.title")} confirm={t("simulator.remove.confirm")} onClose={() => setRemoving(null)} action={() => deleteSimulation(removing.id)} onDone={refresh}>
          {t("simulator.remove.text", { name: removing.name })}
        </ConfirmDialog>
      )}
    </div>
  );
}
