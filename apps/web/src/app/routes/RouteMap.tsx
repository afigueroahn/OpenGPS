// Small map of a route: its path, its numbered stops and, if wanted,
// where the vehicle is. When tapped it can return the tapped point, to mark
// a stop or draw the path.
import "../../lib/mapSetup";
import { type GeoJSONSource, LngLatBounds, Map as MapLibre, NavigationControl } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FONT_BOLD } from "../../lib/mapSetup";
import { useConfig } from "../../lib/session";

export interface MapPoint {
  lat: number;
  lon: number;
  /** What is written inside the point: its order number. */
  label?: string;
  color?: string;
}

/** Color of each stop on the map and in lists, depending on how it is going. */
export const STOP_COLOR = { pending: "#101623", arrived: "#d08700", done: "#12a065", failed: "#cf3a32", skipped: "#98a2b3" } as const;

const ROUTE = "#7c6cf0";
const STOP = "#101623";

export function RouteMap(props: {
  line?: [number, number][];
  points?: MapPoint[];
  vehicle?: { lat: number; lon: number } | null;
  /** On tapping the map. With it, the cursor is a cross. */
  onPick?: ((lat: number, lon: number) => void) | undefined;
  /** When it changes, the map frames everything it shows again. */
  fitKey?: string | number;
  className?: string;
  label?: string;
}) {
  const { t } = useTranslation();
  const config = useConfig();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const onPick = useRef(props.onPick);
  onPick.current = props.onPick;
  const styleUrl = config.data?.mapStyleUrl;

  useEffect(() => {
    if (!container.current || !styleUrl) return;
    const map = new MapLibre({ container: container.current, style: styleUrl, center: [-87.2, 14.08], zoom: 6, attributionControl: { compact: true }, dragRotate: false });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      const empty = { type: "FeatureCollection" as const, features: [] };
      map.addSource("path", { type: "geojson", data: empty });
      map.addSource("points", { type: "geojson", data: empty });
      map.addSource("vehicle", { type: "geojson", data: empty });
      map.addLayer({ id: "path-outline", type: "line", source: "path", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 7 } });
      map.addLayer({ id: "path", type: "line", source: "path", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ROUTE, "line-width": 4 } });
      map.addLayer({ id: "points", type: "circle", source: "points", paint: { "circle-radius": 11, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 } });
      map.addLayer({ id: "points-label", type: "symbol", source: "points", layout: { "text-field": ["get", "label"], "text-font": FONT_BOLD, "text-size": 11.5, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#ffffff" } });
      map.addLayer({ id: "vehicle-halo", type: "circle", source: "vehicle", paint: { "circle-radius": 20, "circle-color": "#12a065", "circle-opacity": 0.22 } });
      map.addLayer({ id: "vehicle", type: "circle", source: "vehicle", paint: { "circle-radius": 9, "circle-color": "#12a065", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 } });
      map.on("click", (e) => onPick.current?.(Math.round(e.lngLat.lat * 1e6) / 1e6, Math.round(e.lngLat.lng * 1e6) / 1e6));
      // On a small map, the open attribution covers half the route: it stays folded behind its button.
      const credit = container.current?.querySelector(".maplibregl-ctrl-attrib");
      credit?.classList.remove("maplibregl-compact-show");
      credit?.removeAttribute("open");
      setReady(true);
    });
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [styleUrl]);

  const { line, points, vehicle, fitKey } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("path") as GeoJSONSource).setData({ type: "FeatureCollection", features: line && line.length >= 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties: {} }] : [] });
    (map.getSource("points") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (points ?? []).map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { label: p.label ?? "", color: p.color ?? STOP } })),
    });
    (map.getSource("vehicle") as GeoJSONSource).setData({ type: "FeatureCollection", features: vehicle ? [{ type: "Feature", geometry: { type: "Point", coordinates: [vehicle.lon, vehicle.lat] }, properties: {} }] : [] });
  }, [line, points, vehicle, ready]);

  // Frames everything there is: on open and when the user asks, not on every change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const all: [number, number][] = [...(line ?? []), ...(points ?? []).map((p): [number, number] => [p.lon, p.lat]), ...(vehicle ? [[vehicle.lon, vehicle.lat] as [number, number]] : [])];
    if (all.length === 0) return;
    if (all.length === 1) return void map.jumpTo({ center: all[0] as [number, number], zoom: 14 });
    const bounds = all.reduce((b, p) => b.extend(p), new LngLatBounds(all[0], all[0]));
    map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 0 });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only on open and when the signal changes
  }, [fitKey, ready]);

  // The map adds its own classes to its container: ours, which change with the mode, go on the outer one.
  return (
    <div className={`${props.className ?? "h-64"} w-full overflow-hidden rounded-[12px] border border-line ${props.onPick ? "[&_canvas]:!cursor-crosshair" : ""}`}>
      <div ref={container} className="h-full w-full" role="application" aria-label={props.label ?? t("routes.map.label")} />
    </div>
  );
}
