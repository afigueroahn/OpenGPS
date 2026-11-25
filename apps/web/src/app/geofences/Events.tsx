// Vehicle events: geofence entries and exits, dwell times and
// deviations. The full list goes in a dialog; those that need attention
// also appear as a notification over the map as soon as they happen.
import { ALERT_EVENTS, SUBJECT_EVENTS, type VehicleEvent } from "@opengps/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { BellRing, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal, Notice, Spinner } from "../../components/ui";
import { getEvents } from "../../lib/api";
import { decimalMark, formatDateTime, formatDuration, timeAgo } from "../../lib/format";
import i18n from "../../lib/i18n";
import { errorText } from "../widgets";

export const isAlert = (event: Pick<VehicleEvent, "type">) => ALERT_EVENTS.includes(event.type);

/** "Estuvo 6 min" or "lleva 45 min; el máximo es 30 min". */
function noteOf(event: VehicleEvent): string | null {
  const d = event.detail as {
    stayedMin?: number;
    minimumMin?: number;
    maximumMin?: number;
    bySchedule?: boolean;
    speedKmh?: number;
    limitKmh?: number;
    silentMin?: number;
    meters?: number;
    kind?: string;
    minutes?: number;
    limitMinutes?: number;
    driverName?: string;
    liters?: number;
    code?: string;
    description?: string;
    rpm?: number;
    tempC?: number;
    volts?: number;
    limit?: number;
    subject?: string;
    reason?: string;
  };
  if (event.type === "route_deviation" && d.meters) return i18n.t("geofences.events.note.routeDeviation", { meters: d.meters });
  if (SUBJECT_EVENTS.includes(event.type) && d.subject) return d.reason ? `${d.subject}: ${d.reason}` : d.subject;
  if ((event.type === "engine_fault" || event.type === "engine_fault_cleared") && d.code) return `${d.code}: ${d.description ?? i18n.t("geofences.events.note.noDescription")}`;
  if (event.type === "engine_overrev" && d.rpm && d.limit) return i18n.t("geofences.events.note.overrev", { rpm: d.rpm, limit: d.limit });
  if (event.type === "engine_overheat" && d.tempC && d.limit) return i18n.t("geofences.events.note.overheat", { temp: decimalMark(d.tempC), limit: decimalMark(d.limit) });
  if (event.type === "battery_low" && d.volts && d.limit) return i18n.t("geofences.events.note.batteryLow", { volts: decimalMark(d.volts), limit: decimalMark(d.limit) });
  const liters = typeof d.liters === "number" ? decimalMark(d.liters) : null;
  if (event.type === "fuel_theft" && liters) return i18n.t("geofences.events.note.fuelTheft", { liters });
  if (event.type === "fuel_drain" && liters) return i18n.t("geofences.events.note.fuelDrain", { liters });
  if (event.type === "fuel_refuel" && liters) return i18n.t("geofences.events.note.fuelRefuel", { liters });
  if (event.type === "driving_time" && d.minutes && d.limitMinutes) {
    const times = { driver: d.driverName, time: formatDuration(d.minutes * 60), max: formatDuration(d.limitMinutes * 60) };
    if (d.kind === "daily") return d.driverName ? i18n.t("geofences.events.note.drivingDailyDriver", times) : i18n.t("geofences.events.note.drivingDaily", times);
    return d.driverName ? i18n.t("geofences.events.note.drivingNonstopDriver", times) : i18n.t("geofences.events.note.drivingNonstop", times);
  }
  if (event.type === "speeding" && d.speedKmh && d.limitKmh) return i18n.t("geofences.events.note.speeding", { speed: d.speedKmh, limit: d.limitKmh });
  if (event.type === "signal_lost" && d.silentMin) return i18n.t("geofences.events.note.signalLost", { time: formatDuration(d.silentMin * 60) });
  if (event.type === "unauthorized_movement" && d.meters) return i18n.t("geofences.events.note.unauthorizedMovement", { meters: d.meters });
  if (event.type === "tow" && d.speedKmh) return i18n.t("geofences.events.note.tow", { speed: d.speedKmh });
  const stayed =
    typeof d.stayedMin === "number" ? (d.stayedMin < 1 ? i18n.t("geofences.events.note.lessThanMinute") : formatDuration(d.stayedMin * 60)) : null;
  if (event.type === "stay_short" && stayed && d.minimumMin) return i18n.t("geofences.events.note.stayShort", { stayed, min: formatDuration(d.minimumMin * 60) });
  if (event.type === "stay_long" && stayed && d.maximumMin) return i18n.t("geofences.events.note.stayLong", { stayed, max: formatDuration(d.maximumMin * 60) });
  if (d.bySchedule) return i18n.t("geofences.events.note.bySchedule");
  if (stayed && event.type !== "stay_short") return i18n.t("geofences.events.note.stayed", { stayed });
  return null;
}

function EventLine({ event, now }: { event: VehicleEvent; now?: number }) {
  const { t } = useTranslation();
  const note = noteOf(event);
  return (
    <>
      <p className="text-[15px] leading-snug">
        <strong className="font-semibold">{event.vehicleName}</strong> · {t(`shared.event.${event.type}`).toLowerCase()}
        {(event.geofenceName ?? (event.type === "custom" ? event.ruleName : null)) && (
          <>
            : <span className="font-medium">{event.geofenceName ?? event.ruleName}</span>
          </>
        )}
      </p>
      <p className="mt-0.5 text-[13px] text-muted">
        {now === undefined ? formatDateTime(event.at) : timeAgo(event.at, now)}
        {note && ` · ${note}`}
      </p>
    </>
  );
}

export function EventsDialog({ open, onClose, onShow }: { open: boolean; onClose: () => void; onShow: (event: VehicleEvent) => void }) {
  const { t } = useTranslation();
  const [alertsOnly, setAlertsOnly] = useState(false);
  const events = useInfiniteQuery({
    queryKey: ["events", alertsOnly],
    queryFn: ({ pageParam }) => getEvents({ before: pageParam, alerts: alertsOnly }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 40 ? last[last.length - 1]?.id : undefined),
    enabled: open,
  });
  const list = events.data?.pages.flat() ?? [];
  const chip = (active: boolean) =>
    clsx("inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium transition-colors", active ? "bg-primary text-on-primary" : "bg-canvas text-ink-3 hover:bg-line");
  return (
    <Modal open={open} onClose={onClose} title={t("geofences.events.title")} wide>
      <div className="mb-4 flex gap-1.5" role="group" aria-label={t("geofences.events.filter")}>
        <button type="button" aria-pressed={!alertsOnly} onClick={() => setAlertsOnly(false)} className={chip(!alertsOnly)}>
          {t("common.all")}
        </button>
        <button type="button" aria-pressed={alertsOnly} onClick={() => setAlertsOnly(true)} className={chip(alertsOnly)}>
          {t("geofences.events.alertsOnly")}
        </button>
      </div>
      {events.isLoading && (
        <div className="flex h-32 items-center justify-center text-muted">
          <Spinner />
        </div>
      )}
      {events.isError && <Notice tone="error">{errorText(events.error)}</Notice>}
      {events.isSuccess && list.length === 0 && (
        <p className="py-6 text-center text-[15px] leading-relaxed text-muted">
          {alertsOnly ? t("geofences.events.noAlerts") : t("geofences.events.empty")}
        </p>
      )}
      <ul className="divide-y divide-line">
        {list.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              disabled={event.lat === null || event.lon === null}
              onClick={() => onShow(event)}
              className="flex w-full items-start gap-3 py-3 text-left enabled:hover:bg-canvas"
            >
              <span
                className={clsx("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", isAlert(event) ? "bg-danger" : "bg-faint")}
                role="img"
                aria-label={isAlert(event) ? t("geofences.events.alert") : t("geofences.events.record")}
              />
              <span className="min-w-0 flex-1">
                <EventLine event={event} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {events.hasNextPage && (
        <div className="pt-3 text-center">
          <Button variant="secondary" size="sm" loading={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
            {t("geofences.events.older")}
          </Button>
        </div>
      )}
    </Modal>
  );
}

const TOAST_MS = 9000;

/** Recently occurred notifications, over the map. They go away on their own after a while. */
export function EventToasts({ events, onDismiss, onOpen }: { events: VehicleEvent[]; onDismiss: (id: number) => void; onOpen: (event: VehicleEvent) => void }) {
  const { t } = useTranslation();
  const newest = events[0];
  useEffect(() => {
    if (!newest) return;
    const timer = setTimeout(() => onDismiss(newest.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [newest, onDismiss]);
  if (events.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-14" aria-live="assertive">
      {events.slice(0, 3).map((event) => (
        <div key={event.id} className="pointer-events-auto flex w-full max-w-[440px] items-start gap-3 rounded-[14px] bg-surface p-3 pl-4 shadow-[0_2px_6px_rgb(16_22_35/0.12),0_12px_34px_rgb(16_22_35/0.2)]">
          <BellRing size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
          <button type="button" onClick={() => onOpen(event)} className="min-w-0 flex-1 text-left">
            <EventLine event={event} now={Date.now()} />
          </button>
          <button type="button" onClick={() => onDismiss(event.id)} aria-label={t("geofences.events.dismiss")} className="rounded-lg p-1.5 text-muted hover:bg-canvas hover:text-ink">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
