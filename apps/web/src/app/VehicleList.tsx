// Vehicle list with search and filters by status and by group.
import { type Vehicle, type VehicleGroup, type VehicleStatus, VEHICLE_STATUS_COLOR, vehicleStatus } from "@opengps/shared";
import clsx from "clsx";
import { ChevronRight, type LucideIcon, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Spinner, StatusDot } from "../components/ui";
import { formatSpeed, timeAgo } from "../lib/format";
import { groupTree, indented, withChildren } from "./fleet/tree";

export interface Filters {
  search: string;
  status: VehicleStatus | "all";
  /** Group id, "all" or "none" (no group). */
  group: string;
}

export const NO_FILTERS: Filters = { search: "", status: "all", group: "all" };

/** Statuses offered as a filter, in this order; each with its short label, "map.list.status.<status>". */
const FILTER_STATUSES: VehicleStatus[] = ["moving", "idle", "stopped", "offline", "pending", "no_device"];

export interface Tool {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Something pending that needs attention: shown in red over the icon. */
  badge?: number;
  onClick: () => void;
}

/** With groups, the group filter includes those that hang from it. */
export function applyFilters(vehicles: Vehicle[], filters: Filters, now: number, groups: VehicleGroup[] = []): Vehicle[] {
  const term = filters.search.trim().toLowerCase();
  const inGroup = filters.group === "all" || filters.group === "none" ? null : withChildren(groups, filters.group);
  return vehicles.filter((v) => {
    if (filters.status !== "all" && vehicleStatus(v, now) !== filters.status) return false;
    if (filters.group === "none" ? v.groupId !== null : inGroup !== null && (v.groupId === null || !inGroup.has(v.groupId))) return false;
    if (term && !`${v.name} ${v.plate ?? ""} ${v.device?.uniqueId ?? ""}`.toLowerCase().includes(term)) return false;
    return true;
  });
}

export function VehicleList(props: {
  vehicles: Vehicle[];
  shown: Vehicle[];
  groups: VehicleGroup[];
  filters: Filters;
  onFilters: (filters: Filters) => void;
  loading: boolean;
  failed: boolean;
  now: number;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** Sections entered from the list: geofences, alerts, and those of the account's modules. */
  tools: Tool[];
  /** Can add and edit vehicles. */
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const { vehicles, shown, groups, filters, now } = props;
  const set = (patch: Partial<Filters>) => props.onFilters({ ...filters, ...patch });

  // Counts by status respect the selected group, so they match the list.
  const inGroup = applyFilters(vehicles, { ...NO_FILTERS, group: filters.group }, now, groups);
  const counts = new Map<VehicleStatus, number>();
  for (const v of inGroup) counts.set(vehicleStatus(v, now), (counts.get(vehicleStatus(v, now)) ?? 0) + 1);
  const filtering = filters.status !== "all" || filters.group !== "all" || filters.search.trim() !== "";
  const moving = counts.get("moving") ?? 0;

  return (
    <>
      <div className="px-5 pb-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-[22px] font-semibold tracking-tight">{t("common.myVehicles")}</h1>
          {vehicles.length > 0 && (
            <div className="flex shrink-0 items-center gap-1.5">
              {props.canManage && (
                <Button variant="signal" size="sm" onClick={props.onAdd}>
                  <Plus size={15} strokeWidth={2.5} /> {t("map.list.addGps")}
                </Button>
              )}
            </div>
          )}
        </div>
        {vehicles.length > 0 && (
          <p className="mt-0.5 text-[13px] text-white/55">
            {filtering ? t("map.list.filtered", { shown: shown.length, total: vehicles.length }) : t("map.list.count", { count: vehicles.length })}
            {!filtering && moving > 0 && ` · ${t("map.list.moving", { n: moving })}`}
          </p>
        )}
      </div>

      {vehicles.length > 0 && props.tools.length > 0 && (
        // Up to five sections fit in a row; with more, they go four at a time so their name can be read.
        <nav aria-label={t("map.list.sections")} className={clsx("gap-1 px-4 pb-3", props.tools.length > 5 ? "grid grid-cols-4" : "flex")}>
          {props.tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              onClick={tool.onClick}
              aria-label={tool.badge ? t("map.list.toolPending", { label: tool.label, n: tool.badge }) : tool.label}
              className="flex min-w-0 flex-auto flex-col items-center gap-1.5 rounded-[12px] bg-ink-2 px-1 pb-2 pt-2.5 text-white/70 transition-colors hover:bg-ink-3 hover:text-white"
            >
              <span className="relative">
                <tool.icon size={17} />
                {Boolean(tool.badge) && (
                  <span className="num absolute -right-3 -top-2 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-[#fff]">
                    {(tool.badge as number) > 9 ? "9+" : tool.badge}
                  </span>
                )}
              </span>
              <span className="w-full truncate text-center text-[10.5px] font-medium leading-none tracking-tight">{tool.label}</span>
            </button>
          ))}
        </nav>
      )}

      {vehicles.length > 1 && (
        <div className="space-y-2.5 px-5 pb-3">
          {(vehicles.length > 5 || filters.search) && (
            <label className="flex h-10 items-center gap-2 rounded-[10px] bg-ink-2 px-3 text-white/50 focus-within:text-white">
              <Search size={15} />
              <input
                value={filters.search}
                onChange={(e) => set({ search: e.target.value })}
                placeholder={t("map.list.searchPlaceholder")}
                aria-label={t("map.list.searchLabel")}
                className="h-full w-full bg-transparent text-sm text-white placeholder:text-white/40 focus:outline-none"
              />
            </label>
          )}

          {groups.length > 0 && (
            <select
              value={filters.group}
              onChange={(e) => set({ group: e.target.value })}
              aria-label={t("map.list.groupFilter")}
              className="h-9 w-full rounded-[10px] border-0 bg-ink-2 px-3 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              <option value="all">{t("map.list.allGroups")}</option>
              {groupTree(groups).map((g) => (
                <option key={g.id} value={g.id}>
                  {indented(g)} ({g.total})
                </option>
              ))}
              <option value="none">{t("map.vehicle.noGroup")}</option>
            </select>
          )}

          <div className="-mx-1 flex flex-wrap gap-1.5 px-1" role="group" aria-label={t("map.list.statusFilter")}>
            <Chip active={filters.status === "all"} onClick={() => set({ status: "all" })}>
              {t("common.all")} <span className="num opacity-60">{inGroup.length}</span>
            </Chip>
            {FILTER_STATUSES.filter((s) => (counts.get(s) ?? 0) > 0 || filters.status === s).map((s) => (
              <Chip key={s} active={filters.status === s} onClick={() => set({ status: filters.status === s ? "all" : s })}>
                <span className="h-2 w-2 rounded-full" style={{ background: VEHICLE_STATUS_COLOR[s] }} />
                {t(`map.list.status.${s}`)} <span className="num opacity-60">{counts.get(s) ?? 0}</span>
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {props.loading && (
          <div className="flex h-28 items-center justify-center text-white/50">
            <Spinner />
          </div>
        )}
        {props.failed && <p className="px-2 py-4 text-sm text-white/60">{t("map.list.failed")}</p>}
        {!props.loading && !props.failed && vehicles.length === 0 && (props.canManage ? <EmptyState onAdd={props.onAdd} /> : <NothingToSee />)}
        {vehicles.length > 0 && shown.length === 0 && (
          <div className="px-2 py-4 text-sm text-white/60">
            <p>{t("map.list.noMatch")}</p>
            <button type="button" onClick={() => props.onFilters(NO_FILTERS)} className="mt-2 font-semibold text-signal hover:underline">
              {t("map.list.clearFilters")}
            </button>
          </div>
        )}
        <ul className="space-y-1.5">
          {shown.map((v) => (
            <li key={v.id}>
              <VehicleRow vehicle={v} now={now} group={groups.find((g) => g.id === v.groupId)?.name} onClick={() => props.onSelect(v.id)} />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-colors",
        active ? "bg-white text-ink" : "bg-ink-2 text-white/75 hover:bg-ink-3 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

function VehicleRow({ vehicle, now, group, onClick }: { vehicle: Vehicle; now: number; group: string | undefined; onClick: () => void }) {
  const { t } = useTranslation();
  const status = vehicleStatus(vehicle, now);
  return (
    <button type="button" onClick={onClick} className="group flex w-full items-center gap-3 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-ink-2">
      <StatusDot status={status} pulse={status === "moving" || status === "pending"} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold">{vehicle.name}</span>
        <span className="block truncate text-[13px] text-white/55">
          {t(`shared.vehicleStatus.${status}`)}
          {status !== "pending" && status !== "no_device" && vehicle.state && ` · ${timeAgo(vehicle.state.lastSeenAt, now)}`}
          {group && ` · ${group}`}
        </span>
      </span>
      {status === "moving" && (
        <span className="text-right">
          <span className="num block text-[17px] font-semibold leading-none">{formatSpeed(vehicle.state?.speedKmh)}</span>
          <span className="text-[11px] text-white/45">km/h</span>
        </span>
      )}
      <ChevronRight size={16} className="shrink-0 text-white/25 group-hover:text-white/60" />
    </button>
  );
}

function NothingToSee() {
  const { t } = useTranslation();
  return (
    <div className="mx-2 mt-2 rounded-[16px] bg-ink-2 p-5">
      <p className="text-[17px] font-semibold leading-snug">{t("map.list.nothing.title")}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-white/60">{t("map.list.nothing.body")}</p>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mx-2 mt-2 rounded-[16px] bg-ink-2 p-5">
      <p className="text-[17px] font-semibold leading-snug">{t("map.list.empty.title")}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-white/60">{t("map.list.empty.body")}</p>
      <Button variant="signal" className="mt-4" onClick={onAdd}>
        <Plus size={16} strokeWidth={2.5} /> {t("map.list.empty.add")}
      </Button>
    </div>
  );
}
