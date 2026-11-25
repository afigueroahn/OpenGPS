// Dispatch: assign stops to the nearest available vehicle, see how
// each route is going stop by stop and give the links to the driver and to whoever
// is waiting for a delivery.
import type { RoutePlan, RouteStopStatus, RouteTrip, RouteTripInput, RouteTripStatus, RouteTripStop, Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Image, Link2, MessageCircle, PenLine, Plus, Send, Trash, TriangleAlert, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, CopyText, Field, Modal, Notice, Spinner } from "../../components/ui";
import { formatDateTime, formatKm } from "../../lib/format";
import { createDriverLink, createRouteTrip, createTrackLink, deleteRouteTrip, driverPageUrl, getNearest, getPois, getRoutePlans, getRouteTrips, proofUrl, setRouteTripStatus, trackPageUrl, updateRouteStop } from "../../lib/routes";
import { Card, Tile } from "../reports/kit";
import { errorText } from "../widgets";
import { RouteMap, STOP_COLOR } from "./RouteMap";
import { type StopDraft, StopsEditor, newStop } from "./StopsEditor";

const TRIP_STYLE: Record<RouteTripStatus, string> = { assigned: "bg-stopped/10 text-[#2a5c9e]", in_progress: "bg-moving/10 text-signal-ink", done: "border border-line bg-canvas text-ink-3", cancelled: "border border-line bg-canvas text-muted" };
const STOP_STYLE: Record<RouteStopStatus, string> = { pending: "border border-line bg-canvas text-ink-3", arrived: "bg-idle/15 text-[#8a5a00]", done: "bg-moving/10 text-signal-ink", failed: "bg-danger/10 text-danger", skipped: "border border-line bg-canvas text-muted" };
const badge = "inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold";
export const TripBadge = ({ status }: { status: RouteTripStatus }) => {
  const { t } = useTranslation();
  return <span className={clsx(badge, TRIP_STYLE[status])}>{t(`shared.routeTripStatus.${status}`)}</span>;
};
export const StopBadge = ({ status }: { status: RouteStopStatus }) => {
  const { t } = useTranslation();
  return <span className={clsx(badge, STOP_STYLE[status])}>{t(`shared.routeStopStatus.${status}`)}</span>;
};
const attended = (t: RouteTrip) => t.stops.filter((s) => s.status === "done" || s.status === "failed" || s.status === "skipped").length;
const select = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
const label = "mb-1.5 block text-[13px] font-medium text-ink-3";

export function DispatchTab({ vehicles, canManage }: { vehicles: Vehicle[]; canManage: boolean }) {
  const { t } = useTranslation();
  const trips = useQuery({ queryKey: ["routes", "trips"], queryFn: getRouteTrips, refetchInterval: 20_000 });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = trips.data ?? [];
  const open = list.find((t) => t.id === openId) ?? null;
  const count = (status: RouteTripStatus) => list.filter((t) => t.status === status).length;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-tight">{t("routes.dispatch.title")}</h1>
            <p className="mt-0.5 text-sm text-muted">{t("routes.dispatch.lead")}</p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setCreating(true)} disabled={vehicles.length === 0}>
              <Plus size={15} aria-hidden="true" /> {t("routes.dispatch.new")}
            </Button>
          )}
        </div>
      </Card>
      {trips.isError && <Notice tone="error">{errorText(trips.error)}</Notice>}
      {trips.isLoading && (
        <div className="flex h-40 items-center justify-center text-muted">
          <Spinner size={22} />
        </div>
      )}
      {trips.data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile raised label={t("routes.dispatch.tiles.inProgress")} value={String(count("in_progress"))} />
            <Tile raised label={t("routes.dispatch.tiles.assigned")} value={String(count("assigned"))} />
            <Tile raised label={t("routes.dispatch.tiles.offRoute")} value={String(list.filter((trip) => trip.offRoute).length)} foot={t("routes.dispatch.tiles.offRouteFoot")} />
            <Tile raised label={t("routes.dispatch.tiles.done")} value={String(count("done"))} foot={t("routes.dispatch.tiles.doneFoot")} />
          </div>
          <Card>
            {list.length === 0 ? (
              <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm leading-relaxed text-ink-3">{canManage ? t("routes.dispatch.emptyManage") : t("routes.dispatch.empty")}</p>
            ) : (
              <ul className="-m-4 divide-y divide-line">
                {list.map((trip) => (
                  <li key={trip.id}>
                    <button type="button" onClick={() => setOpenId(trip.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas/70">
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[14.5px] font-medium text-ink">{trip.name}</span>
                          <span className="truncate text-[13px] text-ink-3">
                            {trip.vehicleName}
                            {trip.driver && ` · ${trip.driver}`}
                          </span>
                        </span>
                        <span className="block text-[12.5px] text-muted">
                          <span className="num">{formatDateTime(trip.startsAt)}</span> · {t("routes.dispatch.progress", { done: attended(trip), count: trip.stops.length })}
                          {trip.offRoute && (
                            <span className="ml-2 inline-flex items-center gap-1 font-medium text-danger">
                              <TriangleAlert size={13} aria-hidden="true" /> {t("routes.dispatch.offRoute")}
                            </span>
                          )}
                        </span>
                        <span className="mt-1.5 flex h-1.5 max-w-[280px] gap-0.5" role="img" aria-label={t("routes.dispatch.attended", { done: attended(trip), count: trip.stops.length })}>
                          {trip.stops.map((s) => (
                            <span key={s.id} className="h-full flex-1 rounded-full" style={{ background: s.status === "pending" ? "var(--color-line)" : STOP_COLOR[s.status] }} />
                          ))}
                        </span>
                      </span>
                      <TripBadge status={trip.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {creating && <TripDialog vehicles={vehicles} onClose={() => setCreating(false)} onCreated={(t) => setOpenId(t.id)} />}
      {open && <TripDetail trip={open} vehicles={vehicles} canManage={canManage} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// ─── New dispatch ──────────────────────────────────────────────────────────

/** Current date and time for a `datetime-local` field. */
const nowLocal = () => {
  const d = new Date(Date.now() + 10 * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function TripDialog({ vehicles, onClose, onCreated }: { vehicles: Vehicle[]; onClose: () => void; onCreated: (trip: RouteTrip) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const plans = useQuery({ queryKey: ["routes", "plans"], queryFn: getRoutePlans });
  const pois = useQuery({ queryKey: ["routes", "pois"], queryFn: getPois });
  const [planId, setPlanId] = useState("");
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState(nowLocal);
  const [driver, setDriver] = useState("");
  const [stops, setStops] = useState<StopDraft[]>([]);
  const [marking, setMarking] = useState(false);
  const [vehicleId, setVehicleId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const plan: RoutePlan | null = plans.data?.find((p) => p.id === planId) ?? null;
  // The first destination rules: it is used to measure which vehicle is closest.
  const first = plan ? plan.stops[0] : stops[0];
  const nearest = useQuery({ queryKey: ["routes", "nearest", first?.lat, first?.lon], queryFn: () => getNearest(first?.lat ?? 0, first?.lon ?? 0), enabled: Boolean(first) });
  const create = useMutation({
    mutationFn: (body: RouteTripInput) => createRouteTrip(body),
    onSuccess: (trip) => {
      void queryClient.invalidateQueries({ queryKey: ["routes", "trips"] });
      onClose();
      onCreated(trip);
    },
  });
  const points = plan ? plan.stops : stops;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!plan && stops.length === 0) return setProblem(t("routes.dispatch.needStops"));
    if (stops.some((s) => !s.name.trim())) return setProblem(t("routes.dispatch.stopName"));
    if (!vehicleId) return setProblem(t("routes.dispatch.needVehicle"));
    if (!startsAt) return setProblem(t("routes.dispatch.needStart"));
    setProblem(null);
    create.mutate({
      name: name.trim() || plan?.name || (stops.length === 1 ? t("routes.dispatch.deliveryTo", { name: stops[0]?.name.trim() }) : t("routes.dispatch.routeOf", { n: stops.length })),
      planId: plan?.id ?? null,
      vehicleId,
      driver: driver || null,
      startsAt: new Date(startsAt),
      ...(plan ? {} : { stops: stops.map((s) => ({ name: s.name.trim(), lat: s.lat, lon: s.lon, radiusM: s.radiusM, contact: s.contact || null, plannedAt: null })) }),
    });
  };
  return (
    <Modal open onClose={onClose} title={t("routes.dispatch.newTitle")} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="despacho-ruta" className={label}>
              {t("routes.dispatch.what")}
            </label>
            <select
              id="despacho-ruta"
              value={planId}
              onChange={(e) => {
                setPlanId(e.target.value);
                setMarking(false);
              }}
              className={select}
            >
              <option value="">{t("routes.dispatch.loose")}</option>
              {(plans.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {t("routes.dispatch.plan", { name: p.name })}
                </option>
              ))}
            </select>
          </div>
          <Field label={t("routes.dispatch.startsAt")} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} mono />
        </div>

        <div>
          <RouteMap
            line={plan?.line ?? []}
            points={points.map((s, i) => ({ lat: s.lat, lon: s.lon, label: String(i + 1) }))}
            onPick={!plan && marking ? (lat, lon) => setStops((old) => [...old, newStop({ lat, lon }, t("routes.dispatch.destination", { n: old.length + 1 }))]) : undefined}
            fitKey={`${planId}:${plan ? 0 : stops.length}`}
            className="h-52"
          />
          {!plan && (
            <div className="mt-2 space-y-2">
              <button type="button" aria-pressed={marking} onClick={() => setMarking((v) => !v)} className={clsx("h-9 rounded-[9px] border px-2.5 text-[13px] font-medium", marking ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink")}>
                {marking ? t("routes.dispatch.marking") : t("routes.dispatch.mark")}
              </button>
              <StopsEditor stops={stops} onChange={setStops} pois={pois.data ?? []} schedule={false} />
            </div>
          )}
          {plan && (
            <p className="mt-1.5 text-[12.5px] text-muted">{t("routes.dispatch.planStops", { count: plan.stops.length, list: plan.stops.map((s) => s.name).join(" → ") })}</p>
          )}
        </div>

        <div>
          <span className={label}>
            <Trans i18nKey="routes.dispatch.vehicle" components={{ muted: <span className="font-normal text-muted" /> }} />
          </span>
          {!first ? (
            <p className="rounded-[10px] bg-canvas px-3 py-2.5 text-[13px] text-ink-3">{t("routes.dispatch.pickFirst")}</p>
          ) : nearest.isLoading ? (
            <Spinner className="text-muted" />
          ) : (
            <ul className="max-h-[30dvh] divide-y divide-line overflow-y-auto rounded-[10px] border border-line">
              {(nearest.data ?? vehicles.map((v) => ({ vehicleId: v.id, name: v.name, distanceM: null, available: true, busy: null }))).map((v) => (
                <li key={v.vehicleId}>
                  <label className={clsx("flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-canvas", !v.available && "text-muted")}>
                    <input type="radio" name="vehiculo" checked={vehicleId === v.vehicleId} onChange={() => setVehicleId(v.vehicleId)} className="h-4 w-4 accent-ink" />
                    <span className="min-w-0 flex-1">
                      <span className={clsx("block truncate", v.available && "font-medium text-ink")}>{v.name}</span>
                      {v.busy && <span className="block truncate text-[12px]">{v.busy}</span>}
                    </span>
                    <span className="num shrink-0 text-[12.5px]">{v.distanceM === null ? "—" : `${formatKm(v.distanceM)} km`}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("routes.dispatch.driver")} value={driver} onChange={(e) => setDriver(e.target.value)} maxLength={80} />
          <Field label={t("routes.dispatch.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={plan?.name ?? t("routes.dispatch.namePlaceholder")} />
        </div>
        {(problem || create.isError) && <Notice tone="error">{problem ?? errorText(create.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            <Send size={15} aria-hidden="true" /> {t("routes.dispatch.send")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── A dispatch ─────────────────────────────────────────────────────────────

function TripDetail({ trip, vehicles, canManage, onClose }: { trip: RouteTrip; vehicles: Vehicle[]; canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [driverUrl, setDriverUrl] = useState<string | null>(null);
  const [track, setTrack] = useState<{ stopId: string; url: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const put = (next: RouteTrip) => {
    queryClient.setQueryData<RouteTrip[]>(["routes", "trips"], (old) => old?.map((item) => (item.id === next.id ? next : item)));
    setFailed(null);
  };
  const fail = (err: unknown) => setFailed(errorText(err));
  const status = useMutation({ mutationFn: (s: "in_progress" | "done" | "cancelled") => setRouteTripStatus(trip.id, s), onSuccess: put, onError: fail });
  const stop = useMutation({ mutationFn: (v: { id: string; status: RouteStopStatus }) => updateRouteStop(v.id, { status: v.status, recipient: null, note: null }), onSuccess: put, onError: fail });
  const link = useMutation({ mutationFn: () => createDriverLink(trip.id), onSuccess: (token) => setDriverUrl(driverPageUrl(token)), onError: fail });
  const trackLink = useMutation({ mutationFn: (stopId: string) => createTrackLink(stopId).then((token) => ({ stopId, url: trackPageUrl(token) })), onSuccess: setTrack, onError: fail });
  const remove = useMutation({
    mutationFn: () => deleteRouteTrip(trip.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["routes", "trips"] });
      onClose();
    },
    onError: fail,
  });
  const live = vehicles.find((v) => v.id === trip.vehicleId)?.state;
  const open = trip.status === "assigned" || trip.status === "in_progress";
  const message = (url: string, text: string) => `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
  return (
    <Modal open onClose={onClose} title={trip.name} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-ink-3">
          <TripBadge status={trip.status} />
          <span>
            {trip.vehicleName}
            {trip.driver && ` · ${trip.driver}`}
          </span>
          <span className="num text-muted">{t("routes.dispatch.leaves", { date: formatDateTime(trip.startsAt) })}</span>
          {trip.offRoute && (
            <span className="inline-flex items-center gap-1 font-medium text-danger">
              <TriangleAlert size={14} aria-hidden="true" /> {t("routes.dispatch.offRoute")}
            </span>
          )}
        </div>
        <RouteMap
          line={trip.line}
          points={trip.stops.map((s) => ({ lat: s.lat, lon: s.lon, label: String(s.seq), color: STOP_COLOR[s.status] }))}
          vehicle={open && live?.lat != null && live.lon != null ? { lat: live.lat, lon: live.lon } : null}
          fitKey={trip.id}
          className="h-56"
        />
        {failed && <Notice tone="error">{failed}</Notice>}

        <ol className="divide-y divide-line rounded-[12px] border border-line">
          {trip.stops.map((s) => (
            <StopRow key={s.id} stop={s} canManage={canManage && trip.status !== "cancelled"} busy={stop.isPending || trackLink.isPending} onStatus={(next) => stop.mutate({ id: s.id, status: next })} onTrack={() => trackLink.mutate(s.id)} track={track?.stopId === s.id ? track.url : null} whatsapp={message} />
          ))}
        </ol>

        {canManage && open && (
          <section className="space-y-2 rounded-[12px] bg-canvas px-4 py-3">
            <h3 className="text-[14px] font-semibold text-ink">{t("routes.dispatch.driverLink")}</h3>
            <p className="text-[13px] leading-relaxed text-ink-3">{t("routes.dispatch.driverLinkLead")}</p>
            {driverUrl ? (
              <>
                <CopyText value={driverUrl} label={t("routes.dispatch.tapToCopy")} />
                <a href={message(driverUrl, t("routes.dispatch.driverMessage", { name: trip.name }))} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-line bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-canvas">
                  <MessageCircle size={15} aria-hidden="true" /> {t("routes.dispatch.whatsapp")}
                </a>
              </>
            ) : (
              <Button variant="secondary" size="sm" loading={link.isPending} onClick={() => link.mutate()}>
                <Link2 size={14} aria-hidden="true" /> {t("routes.dispatch.createLink")}
              </Button>
            )}
          </section>
        )}

        {canManage &&
          (confirming ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-danger/25 bg-danger/5 px-3.5 py-2.5">
              <span className="text-sm text-danger">{t("routes.dispatch.confirmDelete")}</span>
              <span className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
                  {t("common.cancel")}
                </Button>
                <Button variant="danger" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
                  {t("common.delete")}
                </Button>
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                <Trash size={14} aria-hidden="true" /> {t("common.delete")}
              </Button>
              <span className="flex flex-wrap gap-2">
                {open && (
                  <Button variant="secondary" size="sm" loading={status.isPending && status.variables === "cancelled"} onClick={() => status.mutate("cancelled")}>
                    {t("routes.dispatch.cancel")}
                  </Button>
                )}
                {trip.status === "assigned" && (
                  <Button size="sm" loading={status.isPending && status.variables === "in_progress"} onClick={() => status.mutate("in_progress")}>
                    {t("routes.dispatch.start")}
                  </Button>
                )}
                {trip.status === "in_progress" && (
                  <Button size="sm" loading={status.isPending && status.variables === "done"} onClick={() => status.mutate("done")}>
                    {t("routes.dispatch.finish")}
                  </Button>
                )}
              </span>
            </div>
          ))}
      </div>
    </Modal>
  );
}

function StopRow(props: { stop: RouteTripStop; canManage: boolean; busy: boolean; onStatus: (status: RouteStopStatus) => void; onTrack: () => void; track: string | null; whatsapp: (url: string, text: string) => string }) {
  const { t } = useTranslation();
  const s = props.stop;
  const closed = s.status === "done" || s.status === "failed" || s.status === "skipped";
  const icon = "rounded-lg p-1.5 text-muted hover:bg-canvas disabled:opacity-40";
  const num = <span className="num" />;
  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <span className="num mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold text-white" style={{ background: STOP_COLOR[s.status] }}>
          {s.seq}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14.5px] font-medium text-ink">{s.name}</span>
            <StopBadge status={s.status} />
          </span>
          <span className="block text-[12.5px] text-muted">
            {s.plannedAt && <Trans i18nKey="routes.stop.planned" values={{ date: formatDateTime(s.plannedAt) }} components={{ num }} />}
            {s.arrivedAt && (
              <>
                {s.plannedAt && " · "}
                <Trans i18nKey="routes.stop.arrived" values={{ date: formatDateTime(s.arrivedAt) }} components={{ num }} />
              </>
            )}
            {s.doneAt && s.status !== "skipped" && (
              <>
                {" "}
                <Trans i18nKey="routes.stop.closed" values={{ date: formatDateTime(s.doneAt) }} components={{ num }} />
              </>
            )}
            {!s.plannedAt && !s.arrivedAt && s.contact && <>{t("routes.stop.receives", { name: s.contact })}</>}
          </span>
          {(s.recipient || s.note || s.hasPhoto || s.hasSignature) && (
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
              {s.recipient && <span>{t("routes.stop.received", { name: s.recipient })}</span>}
              {s.note && <span>{t("routes.stop.note", { note: s.note })}</span>}
              {s.hasPhoto && (
                <a href={proofUrl(s.id, "photo")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-ink hover:underline">
                  <Image size={14} aria-hidden="true" /> {t("routes.stop.photo")}
                </a>
              )}
              {s.hasSignature && (
                <a href={proofUrl(s.id, "signature")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-ink hover:underline">
                  <PenLine size={14} aria-hidden="true" /> {t("routes.stop.signature")}
                </a>
              )}
            </span>
          )}
        </span>
        {props.canManage && (
          <span className="flex shrink-0">
            {!closed && (
              <>
                <button type="button" disabled={props.busy} onClick={() => props.onStatus("done")} aria-label={t("routes.stop.markDone", { name: s.name })} title={t("routes.stop.done")} className={clsx(icon, "hover:text-signal-ink")}>
                  <Check size={16} />
                </button>
                <button type="button" disabled={props.busy} onClick={() => props.onStatus("failed")} aria-label={t("routes.stop.markFailed", { name: s.name })} title={t("routes.stop.failed")} className={clsx(icon, "hover:text-danger")}>
                  <X size={16} />
                </button>
              </>
            )}
            <button type="button" disabled={props.busy} onClick={props.onTrack} aria-label={t("routes.stop.createTrack", { name: s.name })} title={t("routes.stop.trackTitle")} className={clsx(icon, "hover:text-ink")}>
              <Link2 size={16} />
            </button>
          </span>
        )}
      </div>
      {props.track && (
        <div className="mt-2 space-y-2 pl-8">
          <CopyText value={props.track} label={t("routes.stop.trackCopy")} />
          <a href={props.whatsapp(props.track, t("routes.stop.trackMessage"))} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-2 rounded-[10px] border border-line bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-canvas">
            <MessageCircle size={14} aria-hidden="true" /> {t("routes.dispatch.whatsapp")}
          </a>
        </div>
      )}
    </li>
  );
}

