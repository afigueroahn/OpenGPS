// Live map: vehicles clustered when zoomed out, each with its status color,
// heading arrow and name, and the recent trip of the chosen one. The camera
// frames everything the first time and follows the chosen vehicle until the
// person moves the map.
import { Camera, type CameraRef, GeoJSONSource, type GeoJSONSourceRef, Images, Layer, Map as MapLibre } from "@maplibre/maplibre-react-native";
import type { TrackPoint, Vehicle } from "@opengps/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { LAYERS, trackGeoJSON, vehiclesGeoJSON } from "./layers";

/** Initial view without vehicles: Latin America, as on the web. */
const HOME = { center: [-75, -8] as [number, number], zoom: 2.6 };
/** Zoom to show a chosen vehicle: past the last one with clusters (13). */
const FOLLOW_ZOOM = 15;
/**
 * Heading arrow: white, at 1x, 2x and 3x for each screen. Its name is the app's own: the map's style already has
 * an "arrow" (the one-way streets), and that one would be drawn instead.
 */
const IMAGES = { "opengps-heading": { source: require("../../assets/arrow.png") } };

type LonLat = [number, number];

export interface VehicleMapProps {
  styleUrl: string;
  vehicles: Vehicle[];
  selectedId: string | null;
  track: TrackPoint[];
  now: number;
  onSelect: (id: string | null) => void;
  /** Screen covered below the map (the vehicle sheet), to center on what is visible. */
  bottomInset: number;
  /** Changes when the person asks to see every vehicle again. */
  fitKey: number;
}

export function VehicleMap(props: VehicleMapProps) {
  const { styleUrl, vehicles, selectedId, track, now, onSelect, bottomInset, fitKey } = props;
  const camera = useRef<CameraRef>(null);
  const source = useRef<GeoJSONSourceRef>(null);
  const framed = useRef(false);
  const following = useRef(true);
  const data = useMemo(() => vehiclesGeoJSON(vehicles, now, selectedId), [vehicles, now, selectedId]);
  const trail = useMemo(() => trackGeoJSON(track), [track]);
  const points = data.features.map((f) => f.geometry.coordinates as LonLat);
  const selectedAt = data.features.find((f) => f.properties.id === selectedId)?.geometry.coordinates as LonLat | undefined;
  const padding = { top: 80, right: 48, bottom: 48 + bottomInset, left: 48 };

  const frameAll = () => {
    if (points.length === 0) return;
    if (points.length === 1) {
      camera.current?.easeTo({ center: points[0] as LonLat, zoom: 14, padding, duration: 600 });
      return;
    }
    const lons = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    camera.current?.fitBounds([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)], { padding, duration: 600 });
  };

  // The first time there are vehicles and the map is ready to move, all of them are framed.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!loaded || framed.current || points.length === 0) return;
    framed.current = true;
    frameAll();
  }, [loaded, points.length]);

  // "Show all".
  useEffect(() => {
    if (fitKey === 0) return;
    following.current = false;
    frameAll();
  }, [fitKey]);

  // Choosing a vehicle goes to it, close enough that it is not in a cluster, and follows it again.
  const lon = selectedAt?.[0];
  const lat = selectedAt?.[1];
  const arrived = useRef<string | null>(null);
  useEffect(() => {
    following.current = true;
    arrived.current = null;
  }, [selectedId]);

  // The chosen vehicle stays in view while it moves, until the person moves the map.
  useEffect(() => {
    if (!selectedId || lon === undefined || lat === undefined || !following.current) return;
    const first = arrived.current !== selectedId;
    arrived.current = selectedId;
    camera.current?.easeTo({ center: [lon, lat], padding, duration: 500, ...(first ? { zoom: FOLLOW_ZOOM } : {}) });
  }, [lon, lat, selectedId, bottomInset]);

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
      onPress={() => onSelect(null)}
      onRegionWillChange={(event) => {
        if (event.nativeEvent.userInteraction) following.current = false;
      }}
    >
      <Camera ref={camera} initialViewState={HOME} />
      <Images images={IMAGES} />
      <GeoJSONSource id="trail" data={trail}>
        <Layer type="line" id="trail-outline" {...LAYERS.trailOutline} />
        <Layer type="line" id="trail" {...LAYERS.trail} />
      </GeoJSONSource>
      <GeoJSONSource
        ref={source}
        id="vehicles"
        data={data}
        cluster
        clusterRadius={46}
        clusterMaxZoom={13}
        onPress={(event) => {
          event.stopPropagation();
          const feature = event.nativeEvent.features[0];
          if (!feature) return;
          const properties = (feature.properties ?? {}) as { cluster?: boolean; cluster_id?: number; id?: string };
          if (properties.cluster && properties.cluster_id !== undefined && feature.geometry.type === "Point") {
            const center = feature.geometry.coordinates as LonLat;
            following.current = false;
            void source.current?.getClusterExpansionZoom(properties.cluster_id).then((zoom) => camera.current?.easeTo({ center, zoom, duration: 500 }));
          } else if (properties.id) {
            onSelect(properties.id);
          }
        }}
      >
        <Layer type="circle" id="clusters" {...LAYERS.clusters} />
        <Layer type="symbol" id="cluster-count" {...LAYERS.clusterCount} />
        <Layer type="circle" id="vehicle-halo" {...LAYERS.vehicleHalo} />
        <Layer type="circle" id="vehicle" {...LAYERS.vehicle} />
        <Layer type="symbol" id="vehicle-heading" {...LAYERS.vehicleHeading} />
        <Layer type="symbol" id="vehicle-label" {...LAYERS.vehicleLabel} />
      </GeoJSONSource>
    </MapLibre>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
});
