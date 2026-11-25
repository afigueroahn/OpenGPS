// A simulated device as it is right now: where it is on its route, what it
// sent, whether the platform is receiving it, and what happened to it.
import type { SimAction, SimBrand, SimStatus, SimulationDetail } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Notice, Spinner } from "../../components/ui";
import { formatClockSeconds, formatKm, timeAgo } from "../../lib/format";
import { getSimulation } from "../../lib/simulator";
import { Card, Tile } from "../reports/kit";
import { RouteMap } from "../routes/RouteMap";
import { errorText } from "../widgets";
import { LiveControl } from "./LiveControl";

export function SimStatusChip({ status }: { status: SimStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[12px] font-medium",
        status === "online" && "bg-moving/15 text-signal-ink",
        (status === "stopped" || status === "connecting" || status === "offline" || status === "noSignal") && "bg-ink/[0.07] text-ink-3",
        (status === "rejected" || status === "silent" || status === "unreachable") && "bg-danger/10 text-danger",
      )}
    >
      {t(`simulator.status.${status}`)}
    </span>
  );
}

type SimAlarmId = Extract<SimAction, { kind: "alarm" }>["alarm"];

/** What is wrong with it, said so the person knows what to do. */
function problemOf(simulation: SimulationDetail, t: TFunction): string | null {
  if (simulation.status === "rejected") return t("simulator.problem.rejected");
  if (simulation.status === "silent") return t("simulator.problem.silent");
  if (simulation.status === "unreachable") return t("simulator.problem.unreachable", { host: simulation.host, port: simulation.port });
  if (simulation.status === "noSignal") return t("simulator.problem.noSignal", { count: simulation.devices[0]?.stored ?? 0 });
  // Sending elsewhere, it does not matter whether this platform knows the device.
  if (simulation.unregistered > 0 && simulation.toPlatform) return t("simulator.problem.unregistered");
  return null;
}

/** What a thing along the route is, in a few words. */
function summaryOf(action: SimAction, t: TFunction): string {
  switch (action.kind) {
    case "stop":
      return t(action.engineOn ? "simulator.options.summary.stopOn" : "simulator.options.summary.stop", { seconds: action.seconds });
    case "refuel":
    case "drain":
      return t(`simulator.options.summary.${action.kind}`, { pct: action.pct, seconds: action.seconds });
    case "speeding":
      return t("simulator.options.summary.speeding", { meters: Math.round(action.lengthM), kmh: action.kmh });
    case "towing":
      return t("simulator.options.summary.towing", { meters: Math.round(action.lengthM) });
    case "engineLock":
    case "signalLoss":
      return t(`simulator.options.summary.${action.kind}`, { seconds: action.seconds });
    case "alarm":
      return t(`simulator.alarm.${action.alarm}`);
    case "driverKey":
      return action.key ? t("simulator.options.summary.driverKey", { key: action.key }) : t("simulator.options.summary.driverNone");
    case "dtc":
      return action.codes.length > 0 ? t("simulator.options.summary.dtc", { codes: action.codes.join(", ") }) : t("simulator.options.summary.dtcNone");
  }
}

export function LivePanel({ id, brands }: { id: string; brands: SimBrand[] }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["admin", "simulator", "simulation", id],
    queryFn: () => getSimulation(id),
    // While it runs, the screen follows it; stopped, there is nothing to follow.
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
    retry: false,
  });
  const simulation = query.data;
  if (!simulation) {
    return <Card>{query.error ? <Notice tone="error">{errorText(query.error)}</Notice> : <Spinner />}</Card>;
  }
  const device = simulation.devices[0];
  const problem = problemOf(simulation, t);
  const brand = brands.find((b) => b.modelId === simulation.modelId);
  const engine = device?.engineCut ? "cut" : device?.ignition ? "on" : "off";
  const position = device?.lat != null && device.lon != null ? { lat: device.lat, lon: device.lon } : null;
  const { actions } = simulation.scenario;
  // Each thing of the route with its number, on the map and in the list.
  const marks = simulation.route.marks.map((mark, i) => ({ lat: mark.lat, lon: mark.lon, label: String(i + 1) }));

  return (
    <Card title={simulation.name} note={`${simulation.identifiers[0] ?? ""} · ${simulation.routeName}`} action={<SimStatusChip status={simulation.status} />}>
      <div className="space-y-4">
        {problem && <Notice tone={simulation.status === "stopped" || simulation.status === "online" || simulation.status === "connecting" || simulation.status === "noSignal" ? "info" : "error"}>{problem}</Notice>}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
          <RouteMap line={simulation.route.line} points={marks} vehicle={position} fitKey={`${simulation.id}:${simulation.routeId}`} className="h-72 lg:h-full lg:min-h-80" label={t("simulator.live.map")} />
          <div className="grid grid-cols-2 gap-3 self-start lg:grid-cols-1">
            <Tile label={t("simulator.live.sent")} value={String(device?.sent ?? 0)} foot={device?.lastSentAt ? t("simulator.live.lastSent", { when: timeAgo(device.lastSentAt) }) : undefined} />
            <Tile
              label={t("simulator.live.received")}
              value={!simulation.toPlatform ? "—" : device?.lastReceivedAt ? timeAgo(device.lastReceivedAt) : t("simulator.live.never")}
              foot={!simulation.toPlatform ? t("simulator.live.notExpected") : device?.latencyMs != null ? t("simulator.live.latency", { ms: device.latencyMs }) : undefined}
            />
            <Tile label={t("simulator.live.speed")} value={position ? t("simulator.live.kmh", { speed: device?.speedKmh ?? 0 }) : "—"} foot={position ? t(`simulator.live.engine.${engine}`) : t("simulator.live.notMoving")} />
            {device?.fuelPct != null && <Tile label={t("simulator.live.fuel")} value={t("simulator.live.fuelPct", { pct: device.fuelPct })} foot={t("simulator.live.fuelFoot")} />}
            <Tile label={t("simulator.live.target")} value={simulation.host} foot={`${t("simulator.form.port")} ${simulation.port} · ${t("simulator.list.every", { seconds: simulation.intervalS })}`} />
          </div>
        </div>
        {actions.length > 0 && (
          <div>
            <h3 className="text-[13px] font-semibold text-ink-3">{t("simulator.live.marks")}</h3>
            <ol className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {actions.map((action, i) => (
                <li key={`${action.kind}:${action.atM}:${i}`} className="flex min-w-0 gap-2">
                  <span className="num w-5 shrink-0 text-right text-muted">{i + 1}</span>
                  <span className="min-w-0 truncate">
                    {t(`simulator.options.kind.${action.kind}`)} · <span className="text-ink-3">{summaryOf(action, t)}</span> · <span className="text-muted">{t("simulator.live.markAt", { km: formatKm(action.atM) })}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {brand && <LiveControl simulation={simulation} brand={brand} />}
        <div>
          <h3 className="text-[13px] font-semibold text-ink-3">{t("simulator.live.log")}</h3>
          {simulation.log.length === 0 ? (
            <p className="mt-1.5 text-sm text-muted">{t("simulator.live.logEmpty")}</p>
          ) : (
            <ul className="mt-1.5 max-h-64 divide-y divide-line overflow-y-auto">
              {simulation.log.map((entry, i) => (
                <li key={`${entry.at}:${i}`} className="flex gap-3 py-1.5 text-sm">
                  <span className="num shrink-0 text-[12.5px] text-muted">{formatClockSeconds(Date.parse(entry.at))}</span>
                  <span className={clsx("min-w-0 break-words", (entry.code === "rejected" || entry.code === "unreachable") && "text-danger")}>{t(`simulator.log.${entry.code}`, entry.code === "alarm" ? { alarm: t(`simulator.alarm.${entry.params.alarm as SimAlarmId}`) } : entry.params)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
