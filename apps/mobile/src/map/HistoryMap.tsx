// History map: the trip of a period or of one trip, its numbered stops, where
// it started and ended, and the player's point. Same layers as the web app's
// history mode (apps/web/src/app/MapView.tsx).
import {
  Camera,
  type CameraRef,
  type CircleLayerSpecification,
  type FilterSpecification,
  GeoJSONSource,
  Images,
  Layer,
  type LineLayerSpecification,
  Map as MapLibre,
  type SymbolLayerSpecification,
} from "@maplibre/maplibre-react-native";
import { type HistoryPoint, VEHICLE_STATUS_COLOR } from "@opengps/shared";
import type { FeatureCollection, MultiLineString, Point } from "geojson";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { type Moment, routeLines } from "../lib/history";

const FONT_BOLD = ["Noto Sans Bold"];
const IMAGES = { "opengps-heading": { source: require("../../assets/arrow.png") } };
/** Colors of the history, the same as the web app's. */
export const COLOR_ROUTE = "#101623";
export const COLOR_START = "#12a065";

export interface HistoryMark {
  kind: "start" | "end" | "stop";
  lat: number;
  lon: number;
  /** "Inicio", "Fin" or the stop number. */
  label: string;
  color: string;
}

type LonLat = [number, number];

const isStop: FilterSpecification = ["==", ["get", "kind"], "stop"];
const isEnd: FilterSpecification = ["!=", ["get", "kind"], "stop"];
const round = { "line-cap": "round", "line-join": "round" } satisfies LineLayerSpecification["layout"];
const outline: Pick<LineLayerSpecification, "layout" | "paint"> = { layout: round, paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.9 } };
const route: Pick<LineLayerSpecification, "layout" | "paint"> = { layout: round, paint: { "line-color": COLOR_ROUTE, "line-width": 3.5 } };
const stop: Pick<CircleLayerSpecification, "filter" | "paint"> = {
  filter: isStop,
  paint: { "circle-radius": 10, "circle-color": "#ffffff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2.5 },
};
const stopNumber: Pick<SymbolLayerSpecification, "filter" | "layout" | "paint"> = {
  filter: isStop,
  layout: { "text-field": ["get", "label"], "text-font": FONT_BOLD, "text-size": 11.5, "text-allow-overlap": true, "text-ignore-placement": true },
  paint: { "text-color": "#101623" },
};
const end: Pick<CircleLayerSpecification, "filter" | "paint"> = {
  filter: isEnd,
  paint: { "circle-radius": 7.5, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
};
const endLabel: Pick<SymbolLayerSpecification, "filter" | "layout" | "paint"> = {
  filter: isEnd,
  layout: { "text-field": ["get", "label"], "text-font": FONT_BOLD, "text-size": 12.5, "text-offset": [0, 1.1], "text-anchor": "top" },
  paint: { "text-color": "#101623", "text-halo-color": "#ffffff", "text-halo-width": 1.8 },
};
const cursorHalo: Pick<CircleLayerSpecification, "paint"> = { paint: { "circle-radius": 24, "circle-color": ["get", "color"], "circle-opacity": 0.22 } };
const cursor: Pick<CircleLayerSpecification, "paint"> = {
  paint: { "circle-radius": 12, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
};
const cursorHeading: Pick<SymbolLayerSpecification, "filter" | "layout" | "paint"> = {
  filter: ["has", "course"],
  layout: {
    "icon-image": "opengps-heading",
    "icon-size": 0.34,
    "icon-rotate": ["get", "course"],
    "icon-rotation-alignment": "map",
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
  },
  paint: { "icon-color": "#ffffff" },
};

/** Color of the player's point: the same as a vehicle in that state on the live map. */
export function momentColor(m: Moment): string {
  return VEHICLE_STATUS_COLOR[m.speed >= 3 ? "moving" : m.ignition ? "idle" : "stopped"];
}

export function HistoryMap(props: {
  styleUrl: string;
  points: HistoryPoint[];
  marks: HistoryMark[];
  moment: Moment | null;
  /** The map follows the point while it plays. */
  follow: boolean;
  /** Changes when the trip shown changes: the map frames it again. */
  fitKey: string;
  /** Where to fly, when the person picks a stop. */
  flyTo: { lat: number; lon: number; n: number } | null;
  /** Space taken by what floats over the map, kept clear when framing the trip. */
  topInset: number;
  bottomInset: number;
  /** Where the map opens before the trip arrives: the vehicle's last position. */
  around: { lat: number; lon: number } | null;
}) {
  const { styleUrl, points, marks, moment, follow, fitKey, flyTo, topInset, bottomInset, around } = props;
  const camera = useRef<CameraRef>(null);
  const [loaded, setLoaded] = useState(false);

  const routes = useMemo<FeatureCollection<MultiLineString>>(
    () => ({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "MultiLineString", coordinates: routeLines(points) }, properties: {} }] }),
    [points],
  );
  const markData = useMemo<FeatureCollection<Point>>(
    () => ({
      type: "FeatureCollection",
      features: marks.map((m) => ({ type: "Feature", geometry: { type: "Point", coordinates: [m.lon, m.lat] }, properties: { kind: m.kind, label: m.label, color: m.color } })),
    }),
    [marks],
  );
  const cursorData = useMemo<FeatureCollection<Point>>(
    () => ({
      type: "FeatureCollection",
      features: moment
        ? [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [moment.lon, moment.lat] },
              properties: { color: momentColor(moment), ...(moment.speed >= 3 && moment.course !== null ? { course: moment.course } : {}) },
            },
          ]
        : [],
    }),
    [moment],
  );

  // The whole trip is framed when it changes.
  useEffect(() => {
    if (!loaded || points.length === 0) return;
    const lons = points.map((p) => p.lon);
    const lats = points.map((p) => p.lat);
    const bounds: [number, number, number, number] = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    const padding = { top: topInset + 30, right: 50, bottom: 40 + bottomInset, left: 50 };
    if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) camera.current?.easeTo({ center: [bounds[0], bounds[1]], zoom: 15, padding, duration: 600 });
    else camera.current?.fitBounds(bounds, { padding, duration: 600 });
  }, [loaded, fitKey]);

  // A stop chosen in the list.
  useEffect(() => {
    if (flyTo) camera.current?.easeTo({ center: [flyTo.lon, flyTo.lat], zoom: 15.5, duration: 700 });
  }, [flyTo]);

  // While it plays, the map goes with the point, without chasing every frame.
  const lastFollow = useRef(0);
  useEffect(() => {
    if (!follow || !moment) return;
    const now = Date.now();
    if (now - lastFollow.current < 1200) return;
    lastFollow.current = now;
    camera.current?.easeTo({ center: [moment.lon, moment.lat] as LonLat, duration: 1000 });
  }, [follow, moment]);

  return (
    <MapLibre
      style={styles.map}
      mapStyle={styleUrl}
      touchRotate={false}
      touchPitch={false}
      compass={false}
      logo={false}
      attribution
      onDidFinishLoadingMap={() => setLoaded(true)}
    >
      <Camera ref={camera} initialViewState={around ? { center: [around.lon, around.lat], zoom: 12 } : { center: [-75, -8], zoom: 2.6 }} />
      <Images images={IMAGES} />
      <GeoJSONSource id="history-routes" data={routes}>
        <Layer type="line" id="history-outline" {...outline} />
        <Layer type="line" id="history-route" {...route} />
      </GeoJSONSource>
      <GeoJSONSource id="history-marks" data={markData}>
        <Layer type="circle" id="history-stop" {...stop} />
        <Layer type="symbol" id="history-stop-number" {...stopNumber} />
        <Layer type="circle" id="history-end" {...end} />
        <Layer type="symbol" id="history-end-label" {...endLabel} />
      </GeoJSONSource>
      <GeoJSONSource id="history-cursor" data={cursorData}>
        <Layer type="circle" id="history-cursor-halo" {...cursorHalo} />
        <Layer type="circle" id="history-cursor" {...cursor} />
        <Layer type="symbol" id="history-cursor-heading" {...cursorHeading} />
      </GeoJSONSource>
    </MapLibre>
  );
}

const styles = StyleSheet.create({ map: { flex: 1 } });
