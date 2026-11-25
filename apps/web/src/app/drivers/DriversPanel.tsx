// Drivers: the score ranking, each one's detail and their profiles.
import { DRIVER_EVENT_POINTS, DRIVER_EVENT_TYPES, type Driver, type DriverEvent, type DriverEventType, type DriverRank, SCORE_MIN_KM, type Vehicle, type VehicleGroup } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, CornerUpRight, Gauge, KeyRound, type LucideIcon, Plus, Settings2, TrendingDown, TrendingUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Spinner } from "../../components/ui";
import { getDriverRanking, getDriverReport, getDriverSettings, getDrivers } from "../../lib/api";
import { formatClock, formatDay, formatDuration, formatKm } from "../../lib/format";
import { Segment, input, label } from "../geofences/GeofencePanel";
import { PRESETS, type Preset, type Range, presetRange, rangeLabel } from "../history/range";
import { errorText } from "../widgets";
import { DriverDialog, DriverSettingsDialog } from "./DriverDialog";

const EVENT_ICON: Record<DriverEventType, LucideIcon> = { accel: TrendingUp, brake: TrendingDown, corner: CornerUpRight, speeding: Gauge };
const SHORT_PRESETS = PRESETS.filter((p) => p.id !== "custom") as { id: Exclude<Preset, "custom">; label: string }[];

/** Score color: green, amber or red. */
const scoreColor = (score: number | null) => (score === null ? "text-white/40" : score >= 85 ? "text-signal" : score >= 60 ? "text-apricot" : "text-coral");
const eventsOf = (rank: DriverRank) => DRIVER_EVENT_TYPES.reduce((n, t) => n + rank.counts[t], 0);

interface Props {
  vehicles: Vehicle[];
  groups: VehicleGroup[];
  /** Can register drivers, assign them and change settings. */
  canManage: boolean;
  /** Takes the map to the place of an event. */
  onShow: (event: DriverEvent) => void;
  onBack: () => void;
}

export function DriversPanel(props: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"ranking" | "drivers">("ranking");
  const [range, setRange] = useState<Range>(() => presetRange("7d"));
  const [groupId, setGroupId] = useState("");
  const [report, setReport] = useState<string | null>(null);
  const [editing, setEditing] = useState<Driver | "new" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const ranking = useQuery({
    queryKey: ["drivers", "ranking", range.from.getTime(), range.to.getTime(), groupId],
    queryFn: () => getDriverRanking(range.from, range.to, groupId || null),
    enabled: tab === "ranking" && !report,
  });
  const drivers = useQuery({ queryKey: ["drivers", "list"], queryFn: getDrivers });

  if (report) {
    return <Report driverId={report} range={range} onRange={setRange} onShow={props.onShow} onBack={() => setReport(null)} />;
  }

  const periods = (
    <div className="flex gap-1 rounded-[10px] bg-ink-2 p-1">
      {SHORT_PRESETS.map((p) => (
        <Segment key={p.id} active={range.preset === p.id} onClick={() => setRange(presetRange(p.id))}>
          {p.label}
        </Segment>
      ))}
    </div>
  );
  const list = drivers.data ?? [];
  const ranks = ranking.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <button type="button" onClick={props.onBack} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white">
          <ArrowLeft size={15} /> {t("common.myVehicles")}
        </button>
      </div>
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-2">
        <h1 className="text-[22px] font-semibold tracking-tight">{t("drivers.title")}</h1>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={t("drivers.settings.title")}
            aria-label={t("drivers.settings.title")}
            className="flex h-8 w-8 items-center justify-center rounded-[10px] text-white/60 hover:bg-ink-2 hover:text-white"
          >
            <Settings2 size={17} />
          </button>
          {props.canManage && (
            <Button variant="signal" size="sm" onClick={() => setEditing("new")}>
              <Plus size={15} strokeWidth={2.5} /> {t("drivers.new")}
            </Button>
          )}
        </div>
      </div>
      <div className="mx-5 mb-3 flex gap-1 rounded-[10px] bg-ink-2 p-1">
        <Segment active={tab === "ranking"} onClick={() => setTab("ranking")}>
          {t("drivers.tabs.ranking")}
        </Segment>
        <Segment active={tab === "drivers"} onClick={() => setTab("drivers")}>
          {t("drivers.tabs.profiles")}
          {list.length > 0 ? ` · ${list.length}` : ""}
        </Segment>
      </div>

      {tab === "ranking" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <div className="space-y-2 px-2 pb-3">
            {periods}
            {props.groups.length > 0 && (
              <select aria-label={t("common.group")} value={groupId} onChange={(e) => setGroupId(e.target.value)} className={clsx(input, "h-9 text-[14px]")}>
                <option value="">{t("drivers.allGroups")}</option>
                {props.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {ranking.isLoading && (
            <div className="flex h-28 items-center justify-center text-white/50">
              <Spinner />
            </div>
          )}
          {ranking.isError && <p className="px-2 py-4 text-sm text-white/60">{errorText(ranking.error)}</p>}
          {ranking.isSuccess && ranks.length === 0 && (
            <p className="mx-2 rounded-[14px] bg-ink-2 p-4 text-sm leading-relaxed text-white/60">
              {list.length === 0 ? t("drivers.ranking.emptyNoDrivers") : t("drivers.ranking.empty", { period: rangeLabel(range) })}
            </p>
          )}
          <ol className="space-y-1.5">
            {ranks.map((rank, i) => {
              const row = (
                <>
                  <span className="num w-5 shrink-0 text-center text-[13px] font-semibold text-white/40">{rank.driverId ? i + 1 : "—"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{rank.name}</span>
                    <span className="block truncate text-[13px] text-white/55">
                      <span className="num">{formatKm(rank.distanceM)}</span> km · {formatDuration(rank.drivingS)} · {t("drivers.events", { count: eventsOf(rank) })}
                    </span>
                  </span>
                  {/* What was driven without a driver belongs to no one: it has no score. */}
                  {rank.driverId && (
                    <span
                      className={clsx("num shrink-0 text-[26px] font-semibold leading-none tracking-tight", scoreColor(rank.score))}
                      title={rank.score === null ? t("drivers.noScoreTitle", { km: SCORE_MIN_KM }) : t("drivers.scoreTitle")}
                    >
                      {rank.score ?? "—"}
                    </span>
                  )}
                </>
              );
              return (
                <li key={rank.driverId ?? "nadie"}>
                  {rank.driverId ? (
                    <button type="button" onClick={() => setReport(rank.driverId)} className="flex w-full items-center gap-3 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-ink-2">
                      {row}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 rounded-[12px] px-3 py-3 opacity-70">{row}</div>
                  )}
                </li>
              );
            })}
          </ol>
          {ranks.length > 0 && (
            <p className="mx-2 mt-4 text-[12.5px] leading-relaxed text-white/45">{t("drivers.ranking.note")}</p>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {drivers.isLoading && (
            <div className="flex h-28 items-center justify-center text-white/50">
              <Spinner />
            </div>
          )}
          {drivers.isError && <p className="px-2 py-4 text-sm text-white/60">{errorText(drivers.error)}</p>}
          {drivers.isSuccess && list.length === 0 && (
            <p className="mx-2 rounded-[14px] bg-ink-2 p-4 text-sm leading-relaxed text-white/60">{t("drivers.list.empty")}</p>
          )}
          <ul className="space-y-1.5">
            {list.map((driver) => {
              const vehicle = props.vehicles.find((v) => v.id === driver.vehicleId);
              const body = (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[15px] font-semibold">{driver.name}</span>
                      {driver.keyId && <KeyRound size={13} className="shrink-0 text-white/50" aria-label={t("drivers.list.hasKey")} />}
                    </span>
                    <span className="block truncate text-[13px] text-white/55">
                      {!driver.active ? t("drivers.list.inactive") : vehicle ? t("drivers.list.drives", { vehicle: vehicle.name }) : t("drivers.list.noVehicle")}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={driver.id} className={clsx(!driver.active && "opacity-60")}>
                  {props.canManage ? (
                    <button type="button" onClick={() => setEditing(driver)} className="flex w-full items-center gap-3 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-ink-2">
                      {body}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-3 py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {editing && <DriverDialog key={editing === "new" ? "new" : editing.id} driver={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {settingsOpen && <DriverSettingsDialog canManage={props.canManage} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

// ─── Detail of a driver ─────────────────────────────────────────────────

function Report({ driverId, range, onRange, onShow, onBack }: { driverId: string; range: Range; onRange: (range: Range) => void; onShow: (event: DriverEvent) => void; onBack: () => void }) {
  const { t } = useTranslation();
  const report = useQuery({
    queryKey: ["drivers", "report", driverId, range.from.getTime(), range.to.getTime()],
    queryFn: () => getDriverReport(driverId, range.from, range.to),
    placeholderData: (previous) => previous,
  });
  const settings = useQuery({ queryKey: ["drivers", "settings"], queryFn: getDriverSettings });
  const data = report.data;
  const limits = settings.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white">
          <ArrowLeft size={15} /> {t("drivers.title")}
        </button>
      </div>
      {report.isLoading && (
        <div className="flex h-28 items-center justify-center text-white/50">
          <Spinner />
        </div>
      )}
      {report.isError && <p className="px-5 py-4 text-sm text-white/60">{errorText(report.error)}</p>}
      {data && (
        <div className={clsx("min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2", report.isFetching && "opacity-70")}>
          <h1 className="truncate text-[22px] font-semibold tracking-tight">{data.rank.name}</h1>
          <p className="text-[13px] text-white/55">{rangeLabel(range)}</p>
          <div className="mt-3 flex gap-1 rounded-[10px] bg-ink-2 p-1">
            {SHORT_PRESETS.map((p) => (
              <Segment key={p.id} active={range.preset === p.id} onClick={() => onRange(presetRange(p.id))}>
                {p.label}
              </Segment>
            ))}
          </div>

          <div className="mt-5 flex items-baseline gap-2">
            <span className={clsx("num text-[52px] font-semibold leading-none tracking-tight", scoreColor(data.rank.score))}>{data.rank.score ?? "—"}</span>
            <span className="text-[15px] text-white/50">{data.rank.score === null ? t("drivers.report.noScore", { km: SCORE_MIN_KM }) : t("drivers.report.outOf")}</span>
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
            <Datum label={t("drivers.report.distance")} value={`${formatKm(data.rank.distanceM)} km`} />
            <Datum label={t("drivers.report.driving")} value={formatDuration(data.rank.drivingS)} />
            <Datum
              label={t("drivers.report.longest")}
              value={formatDuration(data.rank.longestStretchS)}
              warn={Boolean(limits && data.rank.longestStretchS > limits.maxContinuousMin * 60)}
              note={limits ? t("drivers.report.max", { duration: formatDuration(limits.maxContinuousMin * 60) }) : undefined}
            />
            <Datum
              label={t("drivers.report.daysOver")}
              value={String(data.rank.daysOverDaily)}
              warn={data.rank.daysOverDaily > 0}
              note={limits ? t("drivers.report.maxPerDay", { duration: formatDuration(limits.maxDailyMin * 60) }) : undefined}
            />
          </dl>

          <h2 className={clsx(label, "mb-2 mt-6")}>{t("drivers.report.deductions")}</h2>
          <ul className="space-y-1">
            {DRIVER_EVENT_TYPES.map((type) => {
              const Icon = EVENT_ICON[type];
              const count = data.rank.counts[type];
              return (
                <li key={type} className="flex items-center gap-3 rounded-[10px] bg-ink-2 px-3 py-2.5">
                  <Icon size={16} className={clsx("shrink-0", count > 0 ? "text-apricot" : "text-white/35")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{t(`shared.driverEvent.${type}`)}</span>
                  <span className="shrink-0 text-[12.5px] text-white/45">{count > 0 ? t("drivers.report.penalty", { points: count * DRIVER_EVENT_POINTS[type] }) : ""}</span>
                  <span className="num w-8 shrink-0 text-right text-[15px] font-semibold">{count}</span>
                </li>
              );
            })}
          </ul>

          <h2 className={clsx(label, "mb-2 mt-6")}>{t("drivers.report.days")}</h2>
          {data.days.length === 0 && <p className="rounded-[12px] bg-ink-2 p-3 text-[13.5px] text-white/60">{t("drivers.report.noDays")}</p>}
          <ul className="space-y-1">
            {data.days.map((day) => {
              const over = limits ? day.drivingS > limits.maxDailyMin * 60 || day.longestStretchS > limits.maxContinuousMin * 60 : false;
              const events = DRIVER_EVENT_TYPES.reduce((n, type) => n + day.counts[type], 0);
              return (
                <li key={day.start} className="rounded-[10px] bg-ink-2 px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[14px] font-semibold">
                      {formatDay(Date.parse(day.start))} · {formatClock(Date.parse(day.start))}–{formatClock(Date.parse(day.end))}
                    </span>
                    <span className={clsx("num shrink-0 text-[14px] font-semibold", over && "text-apricot")}>{formatDuration(day.drivingS)}</span>
                  </div>
                  <p className="mt-0.5 text-[13px] text-white/55">
                    <span className="num">{formatKm(day.distanceM)}</span> km · {t("drivers.report.stretch", { duration: formatDuration(day.longestStretchS) })} ·{" "}
                    {t("drivers.report.rests", { count: day.rests })}
                    {events > 0 && ` · ${t("drivers.events", { count: events })}`}
                  </p>
                </li>
              );
            })}
          </ul>

          {data.events.length > 0 && (
            <>
              <h2 className={clsx(label, "mb-2 mt-6")}>{t("drivers.report.events")}</h2>
              <ul className="space-y-1">
                {data.events.map((event) => {
                  const Icon = EVENT_ICON[event.type];
                  return (
                    <li key={event.id}>
                      <button
                        type="button"
                        disabled={event.lat === null}
                        onClick={() => onShow(event)}
                        className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-ink-2 disabled:hover:bg-transparent"
                      >
                        <Icon size={15} className="shrink-0 text-apricot" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px]">
                            {t(`shared.driverEventOne.${event.type}`)}
                            {event.speedKmh !== null && <span className="num text-white/55"> · {event.speedKmh} km/h</span>}
                          </span>
                          <span className="block truncate text-[12.5px] text-white/45">
                            {formatDay(Date.parse(event.at))} {formatClock(Date.parse(event.at))} · {event.vehicleName}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Datum({ label: text, value, note, warn }: { label: string; value: string; note?: string | undefined; warn?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-white/45">{text}</dt>
      <dd className={clsx("num mt-0.5 text-[15px]", warn && "font-semibold text-apricot")}>{value}</dd>
      {note && <dd className="text-[12px] text-white/45">{note}</dd>}
    </div>
  );
}
