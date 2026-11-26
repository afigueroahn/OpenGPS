// Live map layers: the same as the web app's (apps/web/src/app/MapView.tsx), so
// a vehicle looks the same on the web and on the phone.
import { type TrackPoint, type Vehicle, VEHICLE_STATUS_COLOR, vehicleStatus } from "@opengps/shared";
import type {
  CircleLayerSpecification,
  FilterSpecification,
  LayerSpecification,
  LineLayerSpecification,
  SymbolLayerSpecification,
} from "@maplibre/maplibre-react-native";
import type { FeatureCollection, LineString, Point } from "geojson";

const FONT_BOLD = ["Noto Sans Bold"];
const FONT_REGULAR = ["Noto Sans Regular"];

export interface VehicleProps {
  id: string;
  name: string;
  color: string;
  moving: boolean;
  course: number;
  selected: boolean;
}

export function vehiclesGeoJSON(vehicles: Vehicle[], now: number, selectedId: string | null): FeatureCollection<Point, VehicleProps> {
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

export function trackGeoJSON(track: TrackPoint[]): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: track.length > 1 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: track.map((p) => [p.lon, p.lat]) }, properties: {} }] : [],
  };
}

/** What a layer of the live map draws; its id, type and source go in the map. */
type Style<T extends LayerSpecification> = Pick<T, Extract<keyof T, "filter" | "paint" | "layout">>;

const round = { "line-cap": "round", "line-join": "round" } satisfies LineLayerSpecification["layout"];
const clustered: FilterSpecification = ["has", "point_count"];
const single: FilterSpecification = ["!", ["has", "point_count"]];

const trailOutline: Style<LineLayerSpecification> = { layout: round, paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.9 } };
const trail: Style<LineLayerSpecification> = { layout: round, paint: { "line-color": "#101623", "line-width": 3.5 } };
const clusters: Style<CircleLayerSpecification> = {
  filter: clustered,
  paint: {
    "circle-color": "#101623",
    "circle-radius": ["step", ["get", "point_count"], 18, 10, 22, 50, 27],
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 3,
  },
};
const clusterCount: Style<SymbolLayerSpecification> = {
  filter: clustered,
  layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": FONT_BOLD, "text-size": 13, "text-allow-overlap": true },
  paint: { "text-color": "#ffffff" },
};
const vehicleHalo: Style<CircleLayerSpecification> = {
  filter: ["all", single, ["==", ["get", "selected"], true]],
  paint: { "circle-radius": 24, "circle-color": ["get", "color"], "circle-opacity": 0.22 },
};
const vehicle: Style<CircleLayerSpecification> = {
  filter: single,
  paint: { "circle-radius": 12, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
};
const vehicleHeading: Style<SymbolLayerSpecification> = {
  filter: ["all", single, ["==", ["get", "moving"], true]],
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
const vehicleLabel: Style<SymbolLayerSpecification> = {
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
};

export const LAYERS = { trailOutline, trail, clusters, clusterCount, vehicleHalo, vehicle, vehicleHeading, vehicleLabel };
