// Common pieces of the reports section: data formatting, periods,
// controls on a light background and the vehicle selector.
import { EVENT_TYPES, type EventType, HISTORY_MAX_DAYS, type ReportCell, type ReportParams, type ReportPlace, type ReportValue, type Vehicle, type VehicleGroup } from "@opengps/shared";
import clsx from "clsx";
import { Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "../../components/ui";
import { geocodePoint } from "../../lib/api";
import { formatCoords, formatDuration, formatKm } from "../../lib/format";
import i18n, { currentLanguage } from "../../lib/i18n";
import { addDays, startOfDay } from "../history/range";

// ─── Format ─────────────────────────────────────────────────────────────────

const dateTime = new Intl.DateTimeFormat(currentLanguage(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayLong = new Intl.DateTimeFormat(currentLanguage(), { weekday: "short", day: "numeric", month: "short" });
const dayShort = new Intl.DateTimeFormat(currentLanguage(), { day: "numeric", month: "short" });
const whole = new Intl.NumberFormat(currentLanguage());
const one = new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const two = new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 2 });

/** "2026-11-21" as a date in this browser, without time zone shifts. */
const localDate = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};
const isDate = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text);
/** "sáb, 21 nov" */
export const formatDate = (date: string) => (isDate(date) ? dayLong.format(localDate(date)) : date);
/** "21 nov" */
export const formatDateShort = (date: string) => (isDate(date) ? dayShort.format(localDate(date)) : date);

export const isPlace = (value: ReportValue): value is ReportPlace => typeof value === "object" && value !== null;

/** A report data value, written to be read. */
export function formatCell(value: ReportValue, type: ReportCell): string {
  if (value === null || value === "") return "—";
  if (isPlace(value)) return value.address ?? formatCoords(value.lat, value.lon);
  if (typeof value === "string") {
    if (type === "datetime" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return dateTime.format(new Date(value));
    if (type === "date") return formatDate(value);
    return value;
  }
  switch (type) {
    case "duration":
      return formatDuration(value);
    case "distance":
      return `${formatKm(value)} km`;
    case "speed":
      return `${whole.format(Math.round(value))} km/h`;
    case "liters":
      return `${one.format(value)} L`;
    case "percent":
      return `${one.format(value)} %`;
    case "decimal":
      return two.format(value);
    default:
      return whole.format(Math.round(value));
  }
}

/** Types written right-aligned, like numbers. */
export const isNumeric = (type: ReportCell) => type !== "text" && type !== "place" && type !== "datetime" && type !== "date";

const isEventType = (type: string): type is EventType => (EVENT_TYPES as readonly string[]).includes(type);
/** The name of an event, or its identifier when this version of the web does not know it. */
export const eventLabel = (type: string): string => (isEventType(type) ? i18n.t(`shared.event.${type}`) : type);

// ─── Periods ────────────────────────────────────────────────────────────────

export type PeriodId = "today" | "yesterday" | "7d" | "30d" | "month" | "last_month" | "custom";
export interface Period {
  id: PeriodId;
  from: Date;
  /** Not included. */
  to: Date;
}
const PERIOD_LABEL = {
  today: "common.today",
  yesterday: "common.yesterday",
  "7d": "reports.period.days7",
  "30d": "reports.period.days30",
  month: "reports.period.month",
  last_month: "reports.period.lastMonth",
  custom: "reports.period.custom",
} as const satisfies Record<PeriodId, string>;
/** The periods to choose from. Each label is read when it is shown, in the language of the interface. */
export const PERIODS: { id: PeriodId; label: string }[] = (Object.keys(PERIOD_LABEL) as PeriodId[]).map((id) => ({
  id,
  get label() {
    return i18n.t(PERIOD_LABEL[id]);
  },
}));

export function periodOf(id: Exclude<PeriodId, "custom">, now = new Date()): Period {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  switch (id) {
    case "today":
      return { id, from: today, to: tomorrow };
    case "yesterday":
      return { id, from: addDays(today, -1), to: today };
    case "7d":
      return { id, from: addDays(today, -6), to: tomorrow };
    case "30d":
      return { id, from: addDays(today, -29), to: tomorrow };
    case "month":
      return { id, from: monthStart, to: tomorrow };
    default:
      return { id, from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: monthStart };
  }
}

/** "sáb, 21 nov" or "15 nov – 21 nov". */
export function periodLabel(period: Pick<Period, "from" | "to">): string {
  const last = addDays(period.to, -1);
  if (last.getTime() <= period.from.getTime()) return dayLong.format(period.from);
  return `${dayShort.format(period.from)} – ${dayShort.format(last)}`;
}

/** Value of a date field: "2026-11-21". */
export const toDateInput = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Period from two manually typed dates, both included; or why it is not valid. */
export function customPeriod(from: string, to: string): Period | string {
  if (!isDate(from) || !isDate(to)) return i18n.t("reports.custom.bothDates");
  const start = localDate(from);
  const end = addDays(localDate(to), 1);
  if (end.getTime() <= start.getTime()) return i18n.t("reports.custom.endBeforeStart");
  if (Math.round((end.getTime() - start.getTime()) / 86_400_000) > HISTORY_MAX_DAYS) return i18n.t("reports.custom.tooLong", { days: HISTORY_MAX_DAYS });
  if (start.getTime() > Date.now()) return i18n.t("reports.custom.notStarted");
  return { id: "custom", from: start, to: end };
}

// ─── Controls on a light background ─────────────────────────────────────────────

export const selectClass = "h-10 min-w-0 rounded-[10px] border border-line bg-surface px-3 text-sm text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
export const inputClass = selectClass;
export const labelClass = "mb-1.5 block text-[13px] font-medium text-ink-3";

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-[12px] bg-ink/[0.06] p-1 align-top">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={clsx(
            "h-8 shrink-0 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-medium transition-colors",
            value === o.id ? "bg-surface text-ink shadow-[0_1px_2px_rgb(16_22_35/0.12)]" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, note, action, children, className }: { title?: string; note?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("min-w-0 rounded-[14px] border border-line bg-surface", className)}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-3.5">
          {/* On a narrow screen, the action drops to its own line instead of squashing the text. */}
          <div className="min-w-0 flex-1 basis-48">
            {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
            {note && <p className="mt-0.5 text-[12.5px] text-muted">{note}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Totals of a report or a dashboard: a big figure with its name. */
export function Tile({ label, value, foot, raised }: { label: string; value: string; foot?: ReactNode; /** It sits on the page background, not inside a card. */ raised?: boolean }) {
  return (
    <div className={clsx("min-w-0 rounded-[12px] px-3.5 py-3", raised ? "border border-line bg-surface" : "bg-canvas")}>
      <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 truncate text-[20px] font-semibold tracking-tight" title={value}>
        {value}
      </p>
      {foot && <p className="mt-0.5 truncate text-[12px] text-muted">{foot}</p>}
    </div>
  );
}

// ─── Which vehicles it refers to ──────────────────────────────────────────────

export type Scope = Pick<ReportParams, "groupId" | "vehicleIds">;

/** "Todos los vehículos", a group, or vehicles chosen one by one. */
export function ScopeSelect({ scope, onChange, groups, vehicles, id }: { scope: Scope; onChange: (scope: Scope) => void; groups: VehicleGroup[]; vehicles: Vehicle[]; id?: string }) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const value = scope.vehicleIds ? "picked" : scope.groupId ? `g:${scope.groupId}` : "all";
  return (
    <>
      <select
        id={id}
        aria-label={t("common.vehicles")}
        className={clsx(selectClass, "max-w-full")}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "pick" || v === "picked") setPicking(true);
          else onChange(v === "all" ? { groupId: null, vehicleIds: null } : { groupId: v.slice(2), vehicleIds: null });
        }}
      >
        <option value="all">{t("reports.scope.all")}</option>
        {groups.length > 0 && (
          <optgroup label={t("reports.scope.group")}>
            {groups.map((g) => (
              <option key={g.id} value={`g:${g.id}`}>
                {g.name}
              </option>
            ))}
          </optgroup>
        )}
        {scope.vehicleIds && (
          <option value="picked">
            {scope.vehicleIds.length === 1 ? (vehicles.find((v) => v.id === scope.vehicleIds?.[0])?.name ?? t("reports.scope.picked", { count: 1 })) : t("reports.scope.picked", { count: scope.vehicleIds.length })}
          </option>
        )}
        <option value="pick">{scope.vehicleIds ? t("reports.scope.change") : t("reports.scope.pick")}</option>
      </select>
      <VehiclePicker open={picking} vehicles={vehicles} chosen={scope.vehicleIds ?? []} onClose={() => setPicking(false)} onDone={(ids) => onChange({ groupId: null, vehicleIds: ids })} />
    </>
  );
}

export function VehiclePicker({
  open,
  vehicles,
  chosen,
  onClose,
  onDone,
  allowNone,
}: {
  open: boolean;
  vehicles: Vehicle[];
  chosen: string[];
  onClose: () => void;
  onDone: (ids: string[]) => void;
  /** Leaving none chosen is a valid answer. */
  allowNone?: boolean;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (open) {
      setPicked(new Set(chosen));
      setSearch("");
    }
    // Only on open: while it is open, the selection belongs to whoever touches it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return vehicles.filter((v) => !term || `${v.name} ${v.plate ?? ""}`.toLowerCase().includes(term));
  }, [vehicles, search]);
  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <Modal open={open} onClose={onClose} title={t("reports.picker.title")}>
      {vehicles.length > 6 && (
        <label className="mb-3 flex h-10 items-center gap-2 rounded-[10px] border border-line px-3 text-muted focus-within:border-ink">
          <Search size={15} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("reports.picker.search")} aria-label={t("reports.picker.searchLabel")} className="h-full w-full bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none" />
        </label>
      )}
      <ul className="max-h-[46dvh] divide-y divide-line overflow-y-auto rounded-[10px] border border-line">
        {shown.map((v) => (
          <li key={v.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-canvas">
              <input type="checkbox" checked={picked.has(v.id)} onChange={() => toggle(v.id)} className="h-4 w-4 accent-ink" />
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              {v.plate && <span className="num shrink-0 text-[12px] text-muted">{v.plate}</span>}
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-4 text-sm text-muted">{t("reports.picker.noMatch")}</li>}
      </ul>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[13px] text-muted">{picked.size === 0 ? t("reports.picker.none") : t("reports.picker.chosen", { count: picked.size })}</span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={picked.size === 0 && !allowNone}
            onClick={() => {
              onDone([...picked]);
              onClose();
            }}
          >
            {t("common.done")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Places ─────────────────────────────────────────────────────────────────

const addresses = new Map<string, string | null>();
const keyOf = (p: ReportPlace) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

/** Place of a row: its address if known; otherwise, requested when the row comes into view. */
export function PlaceCell({ place, geocoding }: { place: ReportPlace; geocoding: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [address, setAddress] = useState<string | null>(place.address ?? addresses.get(keyOf(place)) ?? null);
  useEffect(() => {
    setAddress(place.address ?? addresses.get(keyOf(place)) ?? null);
  }, [place]);
  useEffect(() => {
    const node = ref.current;
    if (address || !geocoding || !node || addresses.has(keyOf(place))) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      addresses.set(keyOf(place), null);
      geocodePoint(place.lat, place.lon)
        .then((found) => {
          addresses.set(keyOf(place), found);
          if (!cancelled && found) setAddress(found);
        })
        .catch(() => addresses.delete(keyOf(place)));
    });
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [place, address, geocoding]);
  return (
    <span ref={ref} className={clsx(!address && "num text-[12.5px] text-muted")} title={formatCoords(place.lat, place.lon)}>
      {address ?? formatCoords(place.lat, place.lon)}
    </span>
  );
}
