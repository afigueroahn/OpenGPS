// Map: live it shows vehicles clustered when zoomed out, with a heading arrow
// and the recent trip of the selected one; in history, the trips of a
// period with their markers and the player point.
import { type Geofence, type HistoryPoint, type LonLat, type TrackPoint, VEHICLE_STATUS_COLOR, type Vehicle, labelPoint, outlineOf, vehicleStatus } from "@opengps/shared";
import type { FeatureCollection, LineString, MultiLineString, Point, Polygon } from "geojson";
import {
  type FilterSpecification,
  type GeoJSONSource,
  LngLatBounds,
  Map as MapLibre,
  type MapLayerMouseEvent,
  Marker,
  NavigationControl,
} from "maplibre-gl";
import "../lib/mapSetup";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type GeofenceDraft, type Handle, colorOfGeofence, draftFeatures, handlesOf, polygonOf, withDrag, withTap } from "./geofences/draft";
import { GAP_S, distanceM } from "./history/geo";

const FONT_BOLD = ["Noto Sans Bold"];
const FONT_REGULAR = ["Noto Sans Regular"];
/** Initial view without vehicles: Latin America. */
const HOME: { center: [number, number]; zoom: number } = { center: [-75, -8], zoom: 2.6 };

export interface HistoryRoute {
  points: HistoryPoint[];
  color: string;
}
export interface HistoryMark {
  kind: "start" | "end" | "stop";
  lat: number;
  lon: number;
  /** Marker text: "Inicio", "Fin" or the stop number. */
  label: string;
  color: string;
  /** If two texts overlap, the one with the lower number stays. */
  order?: number;
}
/** What the map draws in history mode. */
export interface HistoryView {
  routes: HistoryRoute[];
  /** Highlighted segments: where one trip diverges from the other. */
  deviations: HistoryRoute[];
  marks: HistoryMark[];
  /** When it changes, the map frames the trips again. */
  fitKey: string;
}
export interface HistoryCursor {
  lat: number;
  lon: number;
  course: number | null;
  color: string;
  /** Moves the map if the point leaves the view. */
  follow: boolean;
}
/** What the player can ask of the map without repainting the screen. */
export interface MapHandle {
  setCursor(cursor: HistoryCursor | null): void;
  flyTo(lat: number, lon: number): void;
  /** Frames a set of points: a geofence, for example. */
  fitPoints(points: LonLat[]): void;
}

interface Props {
  styleUrl: string;
  vehicles: Vehicle[];
  selectedId: string | null;
  track: TrackPoint[];
  now: number;
  onSelect: (id: string | null) => void;
  /** Margin covered by the side or bottom panel, to center on what is visible. */
  padding: { left: number; bottom: number };
  /** With a history, the map stops showing live vehicles. */
  history?: HistoryView | null;
  geofences?: Geofence[];
  /** Geofence being drawn: each tap on the map places or adds a point. */
  draft?: GeofenceDraft | null;
  draftColor?: string;
  onDraft?: (draft: GeofenceDraft) => void;
  /** Geofence being edited: drawn as a stroke, not in its normal layer. */
  editingId?: string | null;
  ref?: Ref<MapHandle>;
}

type Collection = FeatureCollection<Point | LineString | MultiLineString | Polygon>;

function geofencesGeoJSON(geofences: Geofence[], editingId: string | null): Collection {
  const shown = geofences.filter((g) => g.id !== editingId);
  return {
    type: "FeatureCollection",
    features: [
      ...shown.map((g) => ({
        type: "Feature" as const,
        geometry: polygonOf(outlineOf(g.geometry)),
        properties: { color: colorOfGeofence(g), active: g.active },
      })),
      ...shown.map((g) => {
        const at = labelPoint(g.geometry);
        return { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [at[0], at[1]] }, properties: { name: g.name, active: g.active } };
      }),
    ],
  };
}

/** Draggable stroke point: round for vertices and center, square for the circle size. */
function handleElement(role: Handle["role"], color: string): HTMLDivElement {
  const el = document.createElement("div");
  const size = role === "radius" ? 14 : 16;
  el.style.cssText = `width:${size}px;height:${size}px;box-sizing:border-box;background:#fff;border:3px solid ${color};border-radius:${role === "radius" ? "4px" : "50%"};box-shadow:0 1px 4px rgb(16 22 35 / 0.35);cursor:grab;touch-action:none;`;
  // Tapping a point must not count as a tap on the map.
  el.addEventListener("click", (e) => e.stopPropagation());
  return el;
}
const EMPTY: Collection = { type: "FeatureCollection", features: [] };
const LIVE_LAYERS = ["trail-outline", "trail", "clusters", "cluster-count", "vehicle-halo", "vehicle", "vehicle-heading", "vehicle-label"];

/** Trip line, cut where data is missing so two places are not joined by a straight line. */
function routeLines(points: HistoryPoint[]): [number, number][][] {
  const lines: [number, number][][] = [];
  let current: [number, number][] = [];
  points.forEach((p, i) => {
    const prev = points[i - 1];
    if (prev && p.t - prev.t > GAP_S && distanceM(prev.lat, prev.lon, p.lat, p.lon) > 300) {
      if (current.length > 1) lines.push(current);
      current = [];
    }
    current.push([p.lon, p.lat]);
  });
  if (current.length > 1) lines.push(current);
  return lines;
}

function historyGeoJSON(view: HistoryView): { routes: Collection; marks: Collection } {
  return {
    routes: {
      type: "FeatureCollection",
      features: [
        ...view.deviations.map((stretch) => ({
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: stretch.points.map((p) => [p.lon, p.lat]) },
          properties: { kind: "desvio", color: stretch.color },
        })),
        ...view.routes.map((route) => ({
          type: "Feature" as const,
          geometry: { type: "MultiLineString" as const, coordinates: routeLines(route.points) },
          properties: { kind: "ruta", color: route.color },
        })),
      ],
    },
    marks: {
      type: "FeatureCollection",
      features: view.marks.map((mark) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [mark.lon, mark.lat] },
        properties: { kind: mark.kind, label: mark.label, color: mark.color, order: mark.order ?? 0 },
      })),
    },
  };
}

function vehiclesGeoJSON(vehicles: Vehicle[], now: number, selectedId: string | null): Collection {
  return {
    type: "FeatureCollection",
    features: vehicles
      .filter((v) => v.state?.lat != null && v.state?.lon != null)
      .map((v) => {
        const status = vehicleStatus(v, now);
        return {
          type: "Feature",
          id: v.id,
          geometry: { type: "Point", coordinates: [v.state?.lon as number, v.state?.lat as number] },
          properties: {
            id: v.id,
            name: v.name,
            color: VEHICLE_STATUS_COLOR[status],
            moving: status === "moving",
            course: v.state?.course ?? 0,
            selected: v.id === selectedId,
          },
        };
      }),
  };
}

function trackGeoJSON(track: TrackPoint[]): Collection {
  return {
    type: "FeatureCollection",
    features:
      track.length > 1
        ? [{ type: "Feature", geometry: { type: "LineString", coordinates: track.map((p) => [p.lon, p.lat]) }, properties: {} }]
        : [],
  };
}

/** Heading arrow, drawn once and colored by the map. */
function arrowImage(): ImageData {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(size / 2, 5);
  ctx.lineTo(size - 11, size - 9);
  ctx.lineTo(size / 2, size - 17);
  ctx.lineTo(11, size - 9);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

export function MapView(props: Props) {
  const { t } = useTranslation();
  const { styleUrl, vehicles, selectedId, track, now, onSelect, padding, history = null, ref } = props;
  const { geofences, draft = null, draftColor = "#3f7fd1", editingId = null } = props;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onDraftRef = useRef(props.onDraft);
  onDraftRef.current = props.onDraft;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const cursor = useRef<HistoryCursor | null>(null);
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  const fitted = useRef(false);
  const following = useRef(true);
  const previousId = useRef<string | null>(null);
  /** The person moved or zoomed the map after the last framing. */
  const movedByHand = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // ─── Create the map only once ────────────────────────────────────────────
  useEffect(() => {
    if (!container.current) return;
    const map = new MapLibre({
      container: container.current,
      style: styleUrl,
      center: HOME.center,
      zoom: HOME.zoom,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addImage("arrow", arrowImage(), { sdf: true });
      const empty = EMPTY;
      map.addSource("trail", { type: "geojson", data: empty });
      map.addSource("vehicles", { type: "geojson", data: empty, cluster: true, clusterRadius: 46, clusterMaxZoom: 13 });
      map.addSource("geofences", { type: "geojson", data: empty });
      map.addSource("draft", { type: "geojson", data: empty });
      map.addSource("history-routes", { type: "geojson", data: empty });

      // ─── Geofences: below trips and vehicles ─────────────────────
      const isArea = ["==", ["geometry-type"], "Polygon"] as unknown as FilterSpecification;
      map.addLayer({
        id: "geofence-fill",
        type: "fill",
        source: "geofences",
        filter: isArea,
        paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "active"], 0.13, 0.04] },
      });
      map.addLayer({
        id: "geofence-outline",
        type: "line",
        source: "geofences",
        filter: isArea,
        paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": ["case", ["get", "active"], 0.95, 0.4] },
      });
      map.addLayer({
        id: "geofence-label",
        type: "symbol",
        source: "geofences",
        filter: ["==", ["geometry-type"], "Point"] as unknown as FilterSpecification,
        layout: { "text-field": ["get", "name"], "text-font": FONT_BOLD, "text-size": 12, "text-max-width": 9 },
        paint: { "text-color": "#101623", "text-halo-color": "#ffffff", "text-halo-width": 1.6, "text-opacity": ["case", ["get", "active"], 1, 0.55] },
      });
      map.addLayer({
        id: "draft-fill",
        type: "fill",
        source: "draft",
        filter: isArea,
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.2 },
      });
      map.addLayer({
        id: "draft-outline",
        type: "line",
        source: "draft",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-dasharray": [2, 1.6] },
      });
      map.addSource("history-marks", { type: "geojson", data: empty });
      map.addSource("history-cursor", { type: "geojson", data: empty });

      map.addLayer({
        id: "trail-outline",
        type: "line",
        source: "trail",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "trail",
        type: "line",
        source: "trail",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#101623", "line-width": 3.5 },
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "vehicles",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#101623",
          "circle-radius": ["step", ["get", "point_count"], 18, 10, 22, 50, 27],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "vehicles",
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": FONT_BOLD, "text-size": 13, "text-allow-overlap": true },
        paint: { "text-color": "#ffffff" },
      });

      const single = ["!", ["has", "point_count"]] as unknown as FilterSpecification;
      map.addLayer({
        id: "vehicle-halo",
        type: "circle",
        source: "vehicles",
        filter: ["all", single, ["==", ["get", "selected"], true]] as unknown as FilterSpecification,
        paint: { "circle-radius": 24, "circle-color": ["get", "color"], "circle-opacity": 0.22 },
      });
      map.addLayer({
        id: "vehicle",
        type: "circle",
        source: "vehicles",
        filter: single,
        paint: {
          "circle-radius": 12,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        },
      });
      map.addLayer({
        id: "vehicle-heading",
        type: "symbol",
        source: "vehicles",
        filter: ["all", single, ["==", ["get", "moving"], true]] as unknown as FilterSpecification,
        layout: {
          "icon-image": "arrow",
          "icon-size": 0.34,
          "icon-rotate": ["get", "course"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": "#ffffff" },
      });
      map.addLayer({
        id: "vehicle-label",
        type: "symbol",
        source: "vehicles",
        filter: single,
        layout: {
          "text-field": ["get", "name"],
          "text-font": FONT_REGULAR,
          "text-size": 12.5,
          "text-offset": [0, 1.5],
          "text-anchor": "top",
          "text-max-width": 10,
          "text-optional": true,
        },
        paint: { "text-color": "#101623", "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
      });

      // ─── History ───────────────────────────────────────────────────────
      const isRoute = ["==", ["get", "kind"], "ruta"] as unknown as FilterSpecification;
      const isStop = ["==", ["get", "kind"], "stop"] as unknown as FilterSpecification;
      const isEnd = ["!=", ["get", "kind"], "stop"] as unknown as FilterSpecification;
      const round = { "line-cap": "round", "line-join": "round" } as const;
      map.addLayer({
        id: "history-deviation",
        type: "line",
        source: "history-routes",
        filter: ["==", ["get", "kind"], "desvio"] as unknown as FilterSpecification,
        layout: round,
        paint: { "line-color": ["get", "color"], "line-width": 16, "line-opacity": 0.3 },
      });
      map.addLayer({
        id: "history-outline",
        type: "line",
        source: "history-routes",
        filter: isRoute,
        layout: round,
        paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "history-route",
        type: "line",
        source: "history-routes",
        filter: isRoute,
        layout: round,
        paint: { "line-color": ["get", "color"], "line-width": 3.5 },
      });
      map.addLayer({
        id: "history-stop",
        type: "circle",
        source: "history-marks",
        filter: isStop,
        paint: { "circle-radius": 10, "circle-color": "#ffffff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2.5 },
      });
      map.addLayer({
        id: "history-stop-number",
        type: "symbol",
        source: "history-marks",
        filter: isStop,
        layout: { "text-field": ["get", "label"], "text-font": FONT_BOLD, "text-size": 11.5, "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": "#101623" },
      });
      map.addLayer({
        id: "history-end",
        type: "circle",
        source: "history-marks",
        filter: isEnd,
        paint: { "circle-radius": 7.5, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
      });
      map.addLayer({
        id: "history-end-label",
        type: "symbol",
        source: "history-marks",
        filter: isEnd,
        layout: {
          "text-field": ["get", "label"],
          "text-font": FONT_BOLD,
          "text-size": 12.5,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          // Two trips can start at the same place: only one text is written.
          "symbol-sort-key": ["get", "order"],
        },
        paint: { "text-color": "#101623", "text-halo-color": "#ffffff", "text-halo-width": 1.8 },
      });
      map.addLayer({
        id: "history-cursor-halo",
        type: "circle",
        source: "history-cursor",
        paint: { "circle-radius": 24, "circle-color": ["get", "color"], "circle-opacity": 0.22 },
      });
      map.addLayer({
        id: "history-cursor",
        type: "circle",
        source: "history-cursor",
        paint: { "circle-radius": 12, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
      });
      map.addLayer({
        id: "history-cursor-heading",
        type: "symbol",
        source: "history-cursor",
        filter: ["has", "course"] as unknown as FilterSpecification,
        layout: {
          "icon-image": "arrow",
          "icon-size": 0.34,
          "icon-rotate": ["get", "course"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": "#ffffff" },
      });

      // While a geofence is being drawn, each tap places or adds a point.
      map.on("click", (e) => {
        const current = draftRef.current;
        if (current) onDraftRef.current?.(withTap(current, [e.lngLat.lng, e.lngLat.lat]));
      });
      map.on("click", "vehicle", (e: MapLayerMouseEvent) => {
        if (draftRef.current) return;
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) onSelectRef.current(id);
      });
      map.on("click", "clusters", async (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature || draftRef.current) return;
        const source = map.getSource("vehicles") as GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(feature.properties?.cluster_id as number);
        map.easeTo({ center: (feature.geometry as Point).coordinates as [number, number], zoom: zoom + 0.4 });
      });
      for (const layer of ["vehicle", "clusters"]) {
        map.on("mouseenter", layer, () => {
          if (!draftRef.current) map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = draftRef.current ? "crosshair" : "";
        });
      }
      // If the person moves the map, it stops following the selected vehicle.
      map.on("dragstart", () => {
        following.current = false;
        movedByHand.current = true;
      });
      map.on("zoomstart", (e) => {
        if (e.originalEvent) movedByHand.current = true;
      });
      setReady(true);
    });

    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  // The panel or the player covers part of the map: the camera always centers and frames
  // on what remains visible.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPadding({ top: 0, right: 0, bottom: padding.bottom, left: padding.left });
  }, [ready, padding.left, padding.bottom]);

  // ─── Vehicles ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("vehicles") as GeoJSONSource).setData(vehiclesGeoJSON(vehicles, now, selectedId));

    // The first time, frame all vehicles that have a position.
    const located = vehicles.filter((v) => v.state?.lat != null && v.state?.lon != null);
    if (!fitted.current && located.length > 0) {
      fitted.current = true;
      const bounds = new LngLatBounds();
      for (const v of located) bounds.extend([v.state?.lon as number, v.state?.lat as number]);
      map.fitBounds(bounds, { padding: { top: 90, right: 70, bottom: 70, left: 70 }, maxZoom: 15, duration: 0 });
    }
  }, [vehicles, now, selectedId, ready]);

  // ─── Geofences ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("geofences") as GeoJSONSource).setData(geofences ? geofencesGeoJSON(geofences, editingId) : EMPTY);
  }, [geofences, editingId, ready]);

  // Stroke of the geofence being drawn, with its draggable points.
  const handles = useRef<{ marker: Marker; role: Handle["role"] }[]>([]);
  const dragging = useRef<number | null>(null);
  const radiusBearing = useRef(90);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = draft ? "crosshair" : "";
    (map.getSource("draft") as GeoJSONSource).setData(
      draft ? { type: "FeatureCollection", features: draftFeatures(draft).map((f) => ({ ...f, properties: { ...f.properties, color: draftColor } })) } : EMPTY,
    );

    const wanted = draft ? handlesOf(draft, radiusBearing.current) : [];
    const current = handles.current;
    const same = current.length === wanted.length && current.every((h, i) => h.role === wanted[i]?.role);
    if (same) {
      // Same points: they are only repositioned, without touching the one the person is dragging.
      current.forEach((h, i) => {
        h.marker.getElement().style.borderColor = draftColor;
        if (dragging.current !== i) h.marker.setLngLat((wanted[i] as Handle).at);
      });
      return;
    }
    for (const h of current) h.marker.remove();
    handles.current = wanted.map((handle, i) => {
      const marker = new Marker({ element: handleElement(handle.role, draftColor), draggable: true }).setLngLat(handle.at).addTo(map);
      const move = () => {
        const now = draftRef.current;
        if (!now) return;
        const at = marker.getLngLat();
        const moved = withDrag(now, handle, [at.lng, at.lat]);
        if (moved.radiusBearing !== undefined) radiusBearing.current = moved.radiusBearing;
        onDraftRef.current?.(moved.draft);
      };
      marker.on("dragstart", () => {
        dragging.current = i;
      });
      marker.on("drag", move);
      marker.on("dragend", () => {
        dragging.current = null;
        move();
      });
      return { marker, role: handle.role };
    });
  }, [draft, draftColor, ready]);
  useEffect(
    () => () => {
      for (const h of handles.current) h.marker.remove();
      handles.current = [];
    },
    [],
  );

  // ─── Selected vehicle trip ────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("trail") as GeoJSONSource).setData(trackGeoJSON(track));
  }, [track, ready]);

  // ─── History ─────────────────────────────────────────────────────────────
  const drawCursor = () => {
    const map = mapRef.current;
    if (!map || !map.getSource("history-cursor")) return;
    const c = cursor.current;
    (map.getSource("history-cursor") as GeoJSONSource).setData(
      c
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: [c.lon, c.lat] },
                properties: { color: c.color, ...(c.course === null ? {} : { course: c.course }) },
              },
            ],
          }
        : EMPTY,
    );
    if (!c?.follow || map.isMoving()) return;
    // If the point leaves the visible part, the map catches up to it.
    const at = map.project([c.lon, c.lat]);
    const size = map.getContainer().getBoundingClientRect();
    const inside = at.x > 50 && at.x < size.width - 50 && at.y > 70 && at.y < size.height - paddingRef.current.bottom - 40;
    if (!inside) map.easeTo({ center: [c.lon, c.lat], duration: 500 });
  };
  useImperativeHandle(ref, () => ({
    setCursor(next) {
      cursor.current = next;
      drawCursor();
    },
    flyTo(lat, lon) {
      const map = mapRef.current;
      if (!map) return;
      map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15.5), duration: 700 });
    },
    fitPoints(points) {
      const map = mapRef.current;
      if (!map || points.length === 0) return;
      const bounds = new LngLatBounds();
      for (const p of points) bounds.extend(p);
      map.fitBounds(bounds, { padding: { top: 80, right: 80, bottom: 80, left: 80 }, maxZoom: 16, duration: 700 });
    },
  }));

  const inHistory = history !== null;
  const wasInHistory = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const id of LIVE_LAYERS) map.setLayoutProperty(id, "visibility", inHistory ? "none" : "visible");
    const data = history ? historyGeoJSON(history) : { routes: EMPTY, marks: EMPTY };
    (map.getSource("history-routes") as GeoJSONSource).setData(data.routes);
    (map.getSource("history-marks") as GeoJSONSource).setData(data.marks);
    if (!inHistory) cursor.current = null;
    drawCursor();
    // On leaving history, the map goes back to the selected vehicle.
    if (wasInHistory.current && !inHistory) {
      following.current = true;
      previousId.current = null;
    }
    wasInHistory.current = inHistory;
    // Deliberate dependencies: drawCursor reads from refs.
  }, [history, inHistory, ready]);

  // Frames the trips when what is shown changes. If the visible
  // space changes (the panel grows when data arrives) it frames again,
  // unless the person has already moved the map as they like.
  const fitKey = history && history.routes.some((r) => r.points.length > 0) ? history.fitKey : null;
  const fittedKey = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !fitKey || !history) return;
    const isNew = fittedKey.current !== fitKey;
    if (!isNew && movedByHand.current) return;
    if (isNew) movedByHand.current = false;
    fittedKey.current = fitKey;
    const bounds = new LngLatBounds();
    for (const route of history.routes) for (const p of route.points) bounds.extend([p.lon, p.lat]);
    if (bounds.isEmpty()) return;
    map.fitBounds(bounds, { padding: { top: 80, right: 70, bottom: 60, left: 70 }, maxZoom: 16, duration: 700 });
    // Deliberate dependencies: the trip goes with its key.
  }, [fitKey, ready, padding.left, padding.bottom]);

  // ─── Follow the selected vehicle ────────────────────────────────────────────
  const selected = vehicles.find((v) => v.id === selectedId);
  const lat = selected?.state?.lat ?? null;
  const lon = selected?.state?.lon ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || inHistory || !selectedId || lat === null || lon === null) {
      previousId.current = selectedId;
      return;
    }
    const justSelected = previousId.current !== selectedId;
    previousId.current = selectedId;
    if (justSelected) following.current = true;
    if (!following.current) return;
    map.easeTo({ center: [lon, lat], zoom: justSelected ? Math.max(map.getZoom(), 15) : map.getZoom(), duration: justSelected ? 900 : 700 });
  }, [selectedId, lat, lon, ready, inHistory]);

  return <div ref={container} className="h-full w-full" role="application" aria-label={t("map.shell.mapLabel")} />;
}
