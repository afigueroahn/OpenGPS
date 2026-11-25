// The inventory: each vehicle with its availability, who it is assigned to and
// its documents. Tapping one opens its profile.
import { FLEET_STATES, type FleetAvailability, type FleetState, type FleetVehicle, type VehicleGroup } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Search, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Notice, Spinner } from "../../components/ui";
import { getFleet } from "../../lib/api";
import { currentLanguage } from "../../lib/i18n";
import { Card, Tile, selectClass } from "../reports/kit";
import { errorText } from "../widgets";
import { FleetDialog } from "./FleetDialog";
import { kindLabel } from "./format";
import { groupTree, indented, withChildren } from "./tree";

const whole = new Intl.NumberFormat(currentLanguage(), { useGrouping: "always" });
const AVAILABILITIES: FleetAvailability[] = ["on_route", "available", "workshop", "out_of_service"];

const AVAILABILITY_STYLE: Record<FleetAvailability, string> = {
  on_route: "bg-moving/10 text-signal-ink",
  available: "bg-stopped/10 text-[#2a5c9e]",
  workshop: "bg-idle/15 text-[#8a5a00]",
  out_of_service: "bg-danger/10 text-danger",
};

export function AvailabilityBadge({ value }: { value: FleetAvailability }) {
  const { t } = useTranslation();
  return <span className={clsx("inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold", AVAILABILITY_STYLE[value])}>{t(`shared.fleetAvailability.${value}`)}</span>;
}

function StateBadge({ value }: { value: FleetState }) {
  const { t } = useTranslation();
  if (value === "active") return null;
  return <span className="inline-flex h-6 items-center whitespace-nowrap rounded-full border border-line bg-canvas px-2.5 text-[12px] font-semibold text-ink-3">{t(`shared.fleetState.${value}`)}</span>;
}

/** "Toyota Hilux 2022" with whatever is known. */
const modelOf = (v: FleetVehicle) => [v.brand, v.model, v.year].filter(Boolean).join(" ");

export function VehiclesTab({ groups, canManage }: { groups: VehicleGroup[]; canManage: boolean }) {
  const { t } = useTranslation();
  const fleet = useQuery({ queryKey: ["fleet"], queryFn: getFleet, refetchInterval: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [availability, setAvailability] = useState<"all" | FleetAvailability>("all");
  const [state, setState] = useState<"all" | FleetState>("all");
  const [groupId, setGroupId] = useState("all");

  const tree = useMemo(() => groupTree(groups), [groups]);
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const all = fleet.data ?? [];
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const inGroup = groupId === "all" ? null : withChildren(groups, groupId);
    return all.filter(
      (v) =>
        (availability === "all" || v.availability === availability) &&
        (state === "all" || v.state === state) &&
        (!inGroup || (v.groupId !== null && inGroup.has(v.groupId))) &&
        (!term || `${v.name} ${v.plate ?? ""} ${v.brand ?? ""} ${v.model ?? ""} ${v.vin ?? ""} ${v.assignedTo ?? ""}`.toLowerCase().includes(term)),
    );
  }, [all, search, availability, state, groupId, groups]);

  if (fleet.isLoading) {
    return (
      <div className="flex h-48 items-center justify-center text-muted">
        <Spinner size={22} />
      </div>
    );
  }
  if (fleet.isError) return <Notice tone="error">{errorText(fleet.error)}</Notice>;

  const inService = all.filter((v) => v.state === "active");
  const count = (a: FleetAvailability) => inService.filter((v) => v.availability === a).length;
  const expiring = all.reduce((n, v) => n + v.expiring, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile raised label={t("common.vehicles")} value={whole.format(all.length)} foot={t("fleet.vehicles.tiles.active", { n: whole.format(inService.length) })} />
        <Tile raised label={t("fleet.vehicles.tiles.onRoute")} value={whole.format(count("on_route"))} foot={t("fleet.vehicles.tiles.onRouteFoot")} />
        <Tile raised label={t("fleet.vehicles.tiles.available")} value={whole.format(count("available"))} foot={t("fleet.vehicles.tiles.availableFoot")} />
        <Tile raised label={t("fleet.vehicles.tiles.workshop")} value={whole.format(count("workshop"))} />
        <Tile raised label={t("fleet.vehicles.tiles.outOfService")} value={whole.format(count("out_of_service"))} />
        <Tile raised label={t("fleet.vehicles.tiles.expiring")} value={whole.format(expiring)} foot={t("fleet.vehicles.tiles.expiringFoot", { count: expiring })} />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-10 min-w-0 flex-1 basis-56 items-center gap-2 rounded-[10px] border border-line px-3 text-muted focus-within:border-ink">
            <Search size={15} className="shrink-0" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("fleet.vehicles.search")} aria-label={t("fleet.vehicles.searchLabel")} className="h-full w-full min-w-0 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none" />
          </label>
          <select aria-label={t("fleet.vehicles.availability")} value={availability} onChange={(e) => setAvailability(e.target.value as "all" | FleetAvailability)} className={clsx(selectClass, "flex-1 basis-40 sm:flex-none")}>
            <option value="all">{t("fleet.vehicles.anyAvailability")}</option>
            {AVAILABILITIES.map((a) => (
              <option key={a} value={a}>
                {t(`shared.fleetAvailability.${a}`)}
              </option>
            ))}
          </select>
          <select aria-label={t("fleet.vehicles.state")} value={state} onChange={(e) => setState(e.target.value as "all" | FleetState)} className={clsx(selectClass, "flex-1 basis-40 sm:flex-none")}>
            <option value="all">{t("fleet.vehicles.anyState")}</option>
            {FLEET_STATES.map((s) => (
              <option key={s} value={s}>
                {t(`shared.fleetState.${s}`)}
              </option>
            ))}
          </select>
          {tree.length > 0 && (
            <select aria-label={t("common.group")} value={groupId} onChange={(e) => setGroupId(e.target.value)} className={clsx(selectClass, "flex-1 basis-40 sm:flex-none")}>
              <option value="all">{t("fleet.vehicles.allGroups")}</option>
              {tree.map((g) => (
                <option key={g.id} value={g.id}>
                  {indented(g)}
                </option>
              ))}
            </select>
          )}
        </div>

        {all.length === 0 ? (
          <p className="mt-4 rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{t("fleet.vehicles.empty")}</p>
        ) : shown.length === 0 ? (
          <p className="mt-4 rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{t("fleet.vehicles.noMatch")}</p>
        ) : (
          <>
            {/* On wide screens, a table; on the phone, a list. */}
            <div className="-mx-4 mt-4 hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-line bg-canvas/60 text-left text-[12px] uppercase tracking-wider text-muted">
                    <th scope="col" className="px-3 py-2 pl-4 font-medium">
                      {t("common.vehicle")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("fleet.vehicles.columns.brandModel")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("common.group")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("fleet.vehicles.availability")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("fleet.vehicles.columns.assignedTo")}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      {t("fleet.vehicles.columns.odometer")}
                    </th>
                    <th scope="col" className="px-3 py-2 pr-4 text-right font-medium">
                      {t("fleet.vehicles.columns.documents")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shown.map((v) => (
                    <tr key={v.vehicleId} onClick={() => setOpen(v.vehicleId)} className={clsx("cursor-pointer hover:bg-canvas/70", v.state === "retired" && "text-muted")}>
                      <td className="px-3 py-2.5 pl-4">
                        <button type="button" onClick={() => setOpen(v.vehicleId)} className="text-left font-medium text-ink hover:underline" aria-label={t("fleet.vehicles.open", { name: v.name })}>
                          {v.name}
                        </button>
                        {v.plate && <span className="num block text-[12px] text-muted">{v.plate}</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {modelOf(v) || <span className="text-faint">—</span>}
                        {v.kind && <span className="block text-[12px] text-muted">{kindLabel(v.kind)}</span>}
                      </td>
                      <td className="px-3 py-2.5">{(v.groupId && groupName.get(v.groupId)) || <span className="text-faint">—</span>}</td>
                      <td className="px-3 py-2.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <AvailabilityBadge value={v.availability} />
                          <StateBadge value={v.state} />
                        </span>
                      </td>
                      <td className="max-w-[200px] truncate px-3 py-2.5">{v.assignedTo ?? <span className="text-faint">—</span>}</td>
                      <td className="num whitespace-nowrap px-3 py-2.5 text-right text-[13px]">{v.odometerKm === null ? "—" : `${whole.format(Math.round(v.odometerKm))} km`}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 pr-4 text-right">
                        <span className="num text-[13px]">{v.documents}</span>
                        {v.expiring > 0 && (
                          <span className="ml-2 inline-flex items-center gap-1 text-[12px] font-medium text-danger">
                            <TriangleAlert size={13} aria-hidden="true" />
                            {t("fleet.vehicles.expiring", { n: v.expiring })}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="-mx-4 mt-4 divide-y divide-line border-t border-line md:hidden">
              {shown.map((v) => (
                <li key={v.vehicleId}>
                  <button type="button" onClick={() => setOpen(v.vehicleId)} className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-canvas/70">
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium text-ink">{v.name}</span>
                      <span className="block truncate text-[12.5px] text-muted">{[v.plate, modelOf(v), v.assignedTo].filter(Boolean).join(" · ") || t("fleet.vehicles.noData")}</span>
                      {v.expiring > 0 && (
                        <span className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-danger">
                          <TriangleAlert size={13} aria-hidden="true" />
                          {t("fleet.vehicles.expiringDocs", { count: v.expiring })}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <AvailabilityBadge value={v.availability} />
                      <StateBadge value={v.state} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {open && <FleetDialog vehicleId={open} canManage={canManage} onClose={() => setOpen(null)} />}
    </div>
  );
}
