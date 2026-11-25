// Main screen: vehicle list, detail and live map.
import { type LonLat, type ModuleKey, type Permission, type TrackPoint, type Vehicle, type VehicleEvent, offset } from "@opengps/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";
import { Logo } from "../components/ui";
import { Bell, CarFront, ChartColumn, FolderCog, Hexagon, IdCard, Plug, Route, ShieldExclamationPoint, Siren, Wrench } from "lucide-react";
import { getGeofences, getGroups, getIncidents, getTrack, getVehicles } from "../lib/api";
import { useLive } from "../lib/live";
import { useConfig, useMe, useNow } from "../lib/session";
import { AddGpsWizard } from "./AddGpsWizard";
import { AlertsPanel } from "./alerts/AlertsPanel";
import { DriversPanel } from "./drivers/DriversPanel";
import { type HistoryView, type MapHandle, MapView } from "./MapView";
import { EventToasts, EventsDialog, isAlert } from "./geofences/Events";
import { type Editing, GeofencePanel } from "./geofences/GeofencePanel";
import { pointsOf } from "./geofences/draft";
import { HistoryPanel } from "./history/HistoryPanel";
import { ConsentDialog } from "./PrivacyDialogs";
import { IncidentsPanel } from "./security/IncidentsPanel";
import { VehicleDetail } from "./VehicleDetail";
import { type Filters, NO_FILTERS, type Tool, VehicleList, applyFilters } from "./VehicleList";
import { AccountMenu, FullScreenError, FullScreenSpinner, LiveBadge, SuspendedScreen } from "./widgets";

/** Approximate height of the player over the map, to frame above it. */
const PLAYER_HEIGHT = 250;
const NO_HISTORY: HistoryView = { routes: [], deviations: [], marks: [], fitKey: "" };
const TRACK_MINUTES = 60;
const TRACK_MAX_POINTS = 2000;

function useIsDesktop() {
  const query = "(min-width: 1024px)";
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return matches;
}

export function AppShell() {
  const { t } = useTranslation();
  const me = useMe();
  const config = useConfig();
  const queryClient = useQueryClient();
  const now = useNow();
  const isDesktop = useIsDesktop();
  const navigate = useNavigate();

  // With the account suspended no data is requested: the API would deny it.
  const signedIn = Boolean(me.data) && !me.data?.account.suspended;
  const vehiclesQuery = useQuery({ queryKey: ["vehicles"], queryFn: getVehicles, enabled: signedIn, refetchInterval: 60_000 });
  const groupsQuery = useQuery({ queryKey: ["groups"], queryFn: getGroups, enabled: signedIn });
  const geofencesQuery = useQuery({ queryKey: ["geofences"], queryFn: getGeofences, enabled: signedIn });
  const vehicles = vehiclesQuery.data ?? [];
  const groups = groupsQuery.data ?? [];
  const geofences = geofencesQuery.data ?? [];
  // Optional account modules: their sections only exist if enabled.
  const modules: ModuleKey[] = (signedIn && me.data?.account.modules) || [];
  const openIncidents = useQuery({ queryKey: ["incidents", "list", true], queryFn: () => getIncidents(true), enabled: modules.includes("A"), refetchInterval: 60_000 });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ open: boolean; vehicle: Vehicle | null }>({ open: false, vehicle: null });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const selected = vehicles.find((v) => v.id === selectedId) ?? null;

  // ─── Selected vehicle history ────────────────────────────────────────
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyView, setHistoryView] = useState<HistoryView>(NO_HISTORY);
  const [playerSlot, setPlayerSlot] = useState<HTMLElement | null>(null);
  const mapHandle = useRef<MapHandle>(null);
  const inHistory = historyOpen && selected !== null;
  useEffect(() => {
    if (!selectedId) setHistoryOpen(false);
  }, [selectedId]);
  useEffect(() => {
    if (!inHistory) setHistoryView(NO_HISTORY);
  }, [inHistory]);

  // ─── Geofences and events ───────────────────────────────────────────────────
  const [geofencesOpen, setGeofencesOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [incidentsOpen, setIncidentsOpen] = useState(false);
  const [driversOpen, setDriversOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [eventsOpen, setEventsOpen] = useState(false);
  /** Notifications that arrived live and have not been seen yet. */
  const [toasts, setToasts] = useState<VehicleEvent[]>([]);
  const [unseen, setUnseen] = useState(0);
  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((e) => e.id !== id)), []);
  const closeGeofences = () => {
    setEditing(null);
    setGeofencesOpen(false);
  };
  // Go to a place: the open section closes, the vehicle is selected and the map goes to the point.
  const showPlace = (place: { vehicleId: string; lat: number | null; lon: number | null }) => {
    closeGeofences();
    setAlertsOpen(false);
    setIncidentsOpen(false);
    setDriversOpen(false);
    setHistoryOpen(false);
    if (vehicles.some((v) => v.id === place.vehicleId)) setSelectedId(place.vehicleId);
    if (place.lat !== null && place.lon !== null) {
      const { lat, lon } = place;
      setTimeout(() => mapHandle.current?.flyTo(lat, lon), 950);
    }
  };
  const showEvent = (event: VehicleEvent) => {
    setEventsOpen(false);
    dismissToast(event.id);
    showPlace(event);
  };

  // If the group being filtered by is deleted, the filter goes back to "all".
  useEffect(() => {
    if (filters.group !== "all" && filters.group !== "none" && groupsQuery.isSuccess && !groups.some((g) => g.id === filters.group)) {
      setFilters((f) => ({ ...f, group: "all" }));
    }
  }, [filters.group, groups, groupsQuery.isSuccess]);

  // The list and the map show the same thing: what passes the filters.
  const shown = useMemo(() => applyFilters(vehicles, filters, now, groups), [vehicles, filters, now, groups]);
  const onMap = useMemo(() => (selected && !shown.includes(selected) ? [...shown, selected] : shown), [shown, selected]);

  // ─── Recent trip of the selected vehicle ───────────────────────────────
  const [track, setTrack] = useState<TrackPoint[]>([]);
  const trackFor = useRef<string | null>(null);
  useEffect(() => {
    trackFor.current = selectedId;
    setTrack([]);
    if (!selectedId) return;
    let cancelled = false;
    getTrack(selectedId, TRACK_MINUTES)
      .then((points) => {
        if (!cancelled) setTrack((live) => mergeTrack(points, live));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const liveStatus = useLive(
    signedIn,
    useCallback((vehicleId, message) => {
      const s = message.state;
      if (vehicleId !== trackFor.current || s.lat === null || s.lon === null || !s.fixTime) return;
      const point: TrackPoint = { t: s.fixTime, lat: s.lat, lon: s.lon, speedKmh: s.speedKmh, course: s.course };
      setTrack((points) => mergeTrack(points, [point]));
    }, []),
    useCallback((event: VehicleEvent) => {
      if (!isAlert(event)) return;
      setToasts((list) => [event, ...list.filter((e) => e.id !== event.id)].slice(0, 5));
      setUnseen((n) => n + 1);
    }, []),
  );

  // If the selected vehicle no longer exists, go back to the list.
  useEffect(() => {
    if (selectedId && vehiclesQuery.isSuccess && !selected) setSelectedId(null);
  }, [selectedId, selected, vehiclesQuery.isSuccess]);

  // On the phone the panel covers the bottom of the map: it is measured to center on what is visible.
  // The panel appears once there is a session and settings; measuring starts on mount.
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  useEffect(() => {
    if (!panel) return;
    const observer = new ResizeObserver(() => setPanelHeight(panel.getBoundingClientRect().height));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panel]);
  // On wide screens, during history the player covers the bottom of the map.
  const padding = useMemo(
    () => ({ left: 0, bottom: isDesktop ? (inHistory ? PLAYER_HEIGHT : 0) : panelHeight }),
    [isDesktop, panelHeight, inHistory],
  );

  if (me.isLoading || config.isLoading) return <FullScreenSpinner />;
  if (me.isError || config.isError || !config.data) return <FullScreenError onRetry={() => void queryClient.invalidateQueries()} />;
  if (!me.data) return <Navigate to="/login" replace />;
  if (me.data.account.suspended) return <SuspendedScreen me={me.data} />;

  const openWizard = (vehicle: Vehicle | null = null) => setWizard({ open: true, vehicle });
  // What this person's role allows in the active account.
  const can = (permission: Permission) => me.data?.account.permissions.includes(permission) ?? false;
  const canManage = can("vehicles.manage");
  const seesEverything = me.data.account.groups === null;
  const openSection = (open: () => void) => () => {
    setHistoryOpen(false);
    open();
  };
  const tools: Tool[] = [
    { id: "geofences", label: t("map.tools.geofences"), icon: Hexagon, onClick: openSection(() => setGeofencesOpen(true)) },
    { id: "alerts", label: t("map.tools.alerts"), icon: Siren, onClick: openSection(() => setAlertsOpen(true)) },
    ...(modules.includes("A")
      ? [{ id: "incidents", label: t("map.tools.incidents"), icon: ShieldExclamationPoint, badge: openIncidents.data?.filter((i) => i.status === "open").length ?? 0, onClick: openSection(() => setIncidentsOpen(true)) }]
      : []),
    ...(modules.includes("B") ? [{ id: "drivers", label: t("map.tools.drivers"), icon: IdCard, onClick: openSection(() => setDriversOpen(true)) }] : []),
    // Fleet, maintenance and reports have their own page: their tables need the full width.
    ...(modules.includes("D") ? [{ id: "fleet", label: t("map.tools.fleet"), icon: CarFront, onClick: () => void navigate("/fleet") }] : []),
    ...(modules.includes("E") ? [{ id: "maintenance", label: t("map.tools.maintenance"), icon: Wrench, onClick: () => void navigate("/maintenance") }] : []),
    ...(modules.includes("H") ? [{ id: "routes", label: t("map.tools.routes"), icon: Route, onClick: () => void navigate("/routes") }] : []),
    ...(modules.includes("G") ? [{ id: "reports", label: t("map.tools.reports"), icon: ChartColumn, onClick: () => void navigate("/reports") }] : []),
    ...(modules.includes("I") ? [{ id: "integrations", label: t("map.tools.integrations"), icon: Plug, onClick: () => void navigate("/integrations") }] : []),
    ...(canManage && seesEverything ? [{ id: "groups", label: t("map.tools.groups"), icon: FolderCog, onClick: () => void navigate("/admin/groups") }] : []),
  ];

  return (
    <div className="relative h-full overflow-hidden lg:flex">
      <aside
        ref={setPanel}
        className={clsx(
          "side-panel z-10 flex flex-col bg-ink text-white",
          "max-lg:absolute max-lg:inset-x-0 max-lg:bottom-0 max-lg:max-h-[52dvh] max-lg:rounded-t-[22px] max-lg:shadow-[0_-8px_30px_rgb(16_22_35/0.25)] lg:border-r lg:border-white/[0.06]",
          "lg:h-full lg:w-[384px] lg:shrink-0",
        )}
      >
        <header className="flex items-center justify-between gap-3 px-5 pb-3 pt-4 lg:pt-5">
          <Logo dark />
          <div className="flex items-center gap-2">
            <LiveBadge status={liveStatus} />
            <button
              type="button"
              onClick={() => {
                setUnseen(0);
                setToasts([]);
                setEventsOpen(true);
              }}
              aria-label={unseen > 0 ? t("map.shell.eventsUnseen", { count: unseen }) : t("map.shell.events")}
              title={t("map.shell.events")}
              className="relative flex h-9 w-9 items-center justify-center rounded-full text-white/65 hover:bg-ink-2 hover:text-white"
            >
              <Bell size={17} />
              {unseen > 0 && (
                <span className="num absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10.5px] font-bold text-[#fff]">
                  {unseen > 9 ? "9+" : unseen}
                </span>
              )}
            </button>
            <AccountMenu me={me.data} />
          </div>
        </header>

        {incidentsOpen && modules.includes("A") ? (
          <IncidentsPanel vehicles={vehicles} canManage={can("incidents.manage")} now={now} onShow={showPlace} onBack={() => setIncidentsOpen(false)} />
        ) : driversOpen && modules.includes("B") ? (
          <DriversPanel vehicles={vehicles} groups={groups} canManage={can("drivers.manage")} onShow={showPlace} onBack={() => setDriversOpen(false)} />
        ) : alertsOpen ? (
          <AlertsPanel
            vehicles={vehicles}
            groups={groups}
            geofences={geofences}
            canManage={can("alerts.manage")}
            scope={me.data.account.groups}
            onBack={() => setAlertsOpen(false)}
          />
        ) : geofencesOpen ? (
          <GeofencePanel
            geofences={geofences}
            loading={geofencesQuery.isLoading}
            groups={groups}
            vehicles={vehicles}
            canManage={can("geofences.manage")}
            scope={me.data.account.groups}
            editing={editing}
            onEditing={setEditing}
            onShow={(g) => mapHandle.current?.fitPoints(g.geometry.shape === "circle" ? circleBox(g.geometry.center, g.geometry.radiusM) : pointsOf(g.geometry))}
            onEvents={() => setEventsOpen(true)}
            onBack={closeGeofences}
          />
        ) : inHistory && selected ? (
          <HistoryPanel
            key={selected.id}
            vehicle={selected}
            vehicles={vehicles}
            geocoding={config.data.geocoding}
            map={mapHandle}
            playerSlot={isDesktop ? playerSlot : null}
            onView={setHistoryView}
            onBack={() => setHistoryOpen(false)}
          />
        ) : selected ? (
          <VehicleDetail
            vehicle={selected}
            groups={groups}
            geocoding={config.data.geocoding}
            canManage={canManage}
            canShare={can("links.share")}
            modules={modules}
            canCommand={can("commands.send")}
            canDrivers={can("drivers.manage")}
            now={now}
            onBack={() => setSelectedId(null)}
            onHistory={() => setHistoryOpen(true)}
            onConnect={() => openWizard(selected)}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <VehicleList
            vehicles={vehicles}
            shown={shown}
            groups={groups}
            filters={filters}
            onFilters={setFilters}
            canManage={canManage}
            tools={tools}
            loading={vehiclesQuery.isLoading}
            failed={vehiclesQuery.isError}
            now={now}
            onSelect={setSelectedId}
            onAdd={() => openWizard()}
          />
        )}
      </aside>

      <main className="relative h-full min-w-0 flex-1">
        <MapView
          ref={mapHandle}
          styleUrl={config.data.mapStyleUrl}
          vehicles={onMap}
          selectedId={selectedId}
          track={track}
          now={now}
          onSelect={(id) => {
            // Selecting a vehicle on the map closes the geofence list.
            if (id && geofencesOpen) closeGeofences();
            if (id) {
              setAlertsOpen(false);
              setIncidentsOpen(false);
              setDriversOpen(false);
            }
            setSelectedId(id);
          }}
          padding={padding}
          history={inHistory && !geofencesOpen ? historyView : null}
          geofences={geofences}
          draft={editing?.draft ?? null}
          {...(editing ? { draftColor: editing.color } : {})}
          onDraft={(draft) => setEditing((e) => (e ? { ...e, draft } : e))}
          editingId={editing?.id ?? null}
        />
        <EventToasts events={toasts} onDismiss={dismissToast} onOpen={showEvent} />
        {/* The history player goes here; leaves the map credits corner free. */}
        <div ref={setPlayerSlot} className="pointer-events-none absolute inset-x-0 bottom-0 hidden px-4 pb-10 lg:block" />
      </main>

      <AddGpsWizard
        open={wizard.open}
        onClose={() => setWizard((w) => ({ ...w, open: false }))}
        config={config.data}
        vehicles={vehicles}
        vehicle={wizard.vehicle}
        onShow={setSelectedId}
      />
      <EventsDialog open={eventsOpen} onClose={() => setEventsOpen(false)} onShow={showEvent} />
      <ConsentDialog open={me.data.needsConsent} />
    </div>
  );
}

/** Extremes of a circle, to frame it on the map. */
const circleBox = (center: LonLat, radiusM: number): LonLat[] => [0, 90, 180, 270].map((b) => offset(center, radiusM, b));

/** Joins trip points without repeating times, sorted and capped. */
function mergeTrack(a: TrackPoint[], b: TrackPoint[]): TrackPoint[] {
  const byTime = new Map<string, TrackPoint>();
  for (const p of [...a, ...b]) byTime.set(p.t, p);
  return [...byTime.values()].sort((x, y) => (x.t < y.t ? -1 : 1)).slice(-TRACK_MAX_POINTS);
}
