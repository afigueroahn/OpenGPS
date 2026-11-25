// The map where a simulator route is built: its path, and the points it goes
// through, which are added with a tap and moved by dragging them.
import "../../lib/mapSetup";
import type { LonLat } from "@opengps/shared";
import { type GeoJSONSource, LngLatBounds, Map as MapLibre, Marker, NavigationControl } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { useConfig } from "../../lib/session";

const ROUTE = "#7c6cf0";
const START = "#12a065";
const END = "#101623";

/** The letter of a point by its place: A, B, C… */
export const letterOf = (index: number) => String.fromCharCode(65 + (index % 26));

function pointElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText =
    "width:26px;height:26px;box-sizing:border-box;border:2.5px solid #fff;border-radius:50%;color:#fff;font:600 12px/21px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgb(16 22 35 / 0.4);cursor:grab;touch-action:none;user-select:none;";
  // Tapping a point must not count as a tap on the map.
  el.addEventListener("click", (e) => e.stopPropagation());
  return el;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function SimRouteMap(props: {
  /** The path as it was last traced. */
  line: LonLat[];
  /** The points changed since: the path is drawn faded, with straight dashes between the points as they are now. */
  stale: boolean;
  points: { lon: number; lat: number }[];
  onAdd(lon: number, lat: number): void;
  onMove(index: number, lon: number, lat: number): void;
  /** When it changes, the map frames everything it shows again. */
  fitKey: string | number;
  className?: string;
  label: string;
}) {
  const config = useConfig();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const onAdd = useRef(props.onAdd);
  onAdd.current = props.onAdd;
  const onMove = useRef(props.onMove);
  onMove.current = props.onMove;
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
      map.addSource("draft", { type: "geojson", data: empty });
      map.addLayer({ id: "path-outline", type: "line", source: "path", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": ["get", "opacity"] } });
      map.addLayer({ id: "path", type: "line", source: "path", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ROUTE, "line-width": 4, "line-opacity": ["get", "opacity"] } });
      map.addLayer({ id: "draft", type: "line", source: "draft", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ROUTE, "line-width": 2.5, "line-dasharray": [1.5, 2] } });
      map.on("click", (e) => onAdd.current(round(e.lngLat.lng), round(e.lngLat.lat)));
      // On a small map, the open attribution covers the route: it stays folded behind its button.
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

  const { line, stale, points, fitKey } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("path") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: line.length >= 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties: { opacity: stale ? 0.3 : 1 } }] : [],
    });
    (map.getSource("draft") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: stale && points.length >= 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) }, properties: {} }] : [],
    });
  }, [line, stale, points, ready]);

  // The points, each one with its letter; dragging one moves it.
  const markers = useRef<Marker[]>([]);
  const dragging = useRef<number | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const current = markers.current;
    if (current.length !== points.length) {
      for (const marker of current) marker.remove();
      markers.current = points.map((point, i) => {
        const marker = new Marker({ element: pointElement(), draggable: true }).setLngLat([point.lon, point.lat]).addTo(map);
        marker.on("dragstart", () => {
          dragging.current = i;
        });
        marker.on("dragend", () => {
          dragging.current = null;
          const at = marker.getLngLat();
          onMove.current(i, round(at.lng), round(at.lat));
        });
        return marker;
      });
    }
    markers.current.forEach((marker, i) => {
      const point = points[i];
      if (!point) return;
      const el = marker.getElement();
      el.textContent = letterOf(i);
      el.style.background = i === 0 ? START : i === points.length - 1 ? END : ROUTE;
      if (dragging.current !== i) marker.setLngLat([point.lon, point.lat]);
    });
  }, [points, ready]);
  useEffect(
    () => () => {
      for (const marker of markers.current) marker.remove();
      markers.current = [];
    },
    [],
  );

  // Frames everything there is: on open and when asked, not on every change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const all: [number, number][] = [...line, ...points.map((p): [number, number] => [p.lon, p.lat])];
    if (all.length === 0) return;
    if (all.length === 1) return void map.jumpTo({ center: all[0] as [number, number], zoom: 14 });
    const bounds = all.reduce((b, p) => b.extend(p), new LngLatBounds(all[0], all[0]));
    map.fitBounds(bounds, { padding: 56, maxZoom: 16, duration: 0 });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only on open and when the signal changes
  }, [fitKey, ready]);

  // The map adds its own classes to its container: ours go on the outer one.
  return (
    <div className={`${props.className ?? "h-80"} w-full overflow-hidden rounded-[12px] border border-line [&_canvas]:!cursor-crosshair`}>
      <div ref={container} className="h-full w-full" role="application" aria-label={props.label} />
    </div>
  );
}
