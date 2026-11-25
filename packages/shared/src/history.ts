// Trip history.

/** Trip point, compact: many are sent. */
export interface HistoryPoint {
  /** GPS time, in seconds since 1970. */
  t: number;
  lat: number;
  lon: number;
  /** Speed in km/h. */
  s: number;
  /** Heading in degrees. */
  c: number | null;
  /** Engine on, if known. */
  i: boolean | null;
}

export interface Trip {
  start: string;
  end: string;
  durationS: number;
  distanceM: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  /** Time with the engine on and not moving, within the trip. */
  idleS: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  /** Approximate address, if already known; if not, it is requested separately. */
  startAddress: string | null;
  endAddress: string | null;
}

export interface Stop {
  start: string;
  end: string;
  durationS: number;
  lat: number;
  lon: number;
  /** Part of the stop with the engine on. */
  idleS: number;
  /** Approximate address, if already known; if not, it is requested separately. */
  address: string | null;
}

export interface HistorySummary {
  from: string;
  to: string;
  distanceM: number;
  movingS: number;
  /** Engine on without moving, in trips and in stops. */
  idleS: number;
  stoppedS: number;
  maxSpeedKmh: number;
  /** Average while it was moving. */
  avgSpeedKmh: number;
  trips: number;
  stops: number;
  /** Positions of the period, before thinning them for the map. */
  positions: number;
}

export interface VehicleHistory {
  summary: HistorySummary;
  trips: Trip[];
  stops: Stop[];
  /** Trip for the map and the player; thinned if the period is long. */
  points: HistoryPoint[];
}

/** Days a history query can span. */
export const HISTORY_MAX_DAYS = 31;
/** Maximum number of points in the trip sent to the map. */
export const HISTORY_MAX_POINTS = 8000;
export const EXPORT_FORMATS = ["xlsx", "pdf", "csv", "gpx", "kml"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  xlsx: "Excel",
  pdf: "PDF",
  csv: "CSV",
  gpx: "GPX",
  kml: "KML",
};
