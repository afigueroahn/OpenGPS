// Comparison of two trips: how much road they share and where they diverge.
// `awayFrom` looks one way (which part of a trip does not follow the other);
// to truly compare it is called twice, once each way.
import { type HistoryPoint, metersBetween } from "@opengps/shared";

export interface RouteDiff {
  /** Meters of the trip that follow the other's path. */
  sharedM: number;
  /** Meters of the trip in total. */
  totalM: number;
  /** Greatest distance at which it diverges from the other, in meters. */
  maxSeparationM: number;
  /** Segments that diverge from the other. */
  deviations: HistoryPoint[][];
}

/** Two points closer than this follow the same path (GPS is not exact). */
const TOLERANCE_M = 80;
/** A diverging segment shorter than this is not flagged. */
const MIN_DEVIATION_M = 150;
/** Between two points farther apart than this a straight line is not assumed. */
const MAX_SEGMENT_M = 2000;
const METERS_PER_DEGREE = 111_320;

/** Which part of trip `b` does not follow the path of `a`. */
export function awayFrom(a: HistoryPoint[], b: HistoryPoint[]): RouteDiff | null {
  if (a.length < 2 || b.length < 2) return null;
  const first = a[0] as HistoryPoint;
  const latCell = TOLERANCE_M / METERS_PER_DEGREE;
  const lonCell = TOLERANCE_M / (METERS_PER_DEGREE * Math.max(0.2, Math.cos((first.lat * Math.PI) / 180)));
  const key = (lat: number, lon: number) => `${Math.floor(lat / latCell)}:${Math.floor(lon / lonCell)}`;

  // Grid with the first one's path, filling in between points so no gaps are left.
  const grid = new Map<string, [number, number][]>();
  const put = (lat: number, lon: number) => {
    const k = key(lat, lon);
    const cell = grid.get(k);
    if (cell) cell.push([lat, lon]);
    else grid.set(k, [[lat, lon]]);
  };
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as HistoryPoint;
    put(p.lat, p.lon);
    const q = a[i + 1];
    if (!q) continue;
    const length = metersBetween([p.lon, p.lat], [q.lon, q.lat]);
    if (length > MAX_SEGMENT_M) continue;
    const steps = Math.floor(length / (TOLERANCE_M / 2));
    for (let s = 1; s < steps; s++) put(p.lat + ((q.lat - p.lat) * s) / steps, p.lon + ((q.lon - p.lon) * s) / steps);
  }
  const near = (p: HistoryPoint): boolean => {
    const row = Math.floor(p.lat / latCell);
    const col = Math.floor(p.lon / lonCell);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cell = grid.get(`${row + dr}:${col + dc}`);
        if (cell?.some(([lat, lon]) => metersBetween([p.lon, p.lat], [lon, lat]) <= TOLERANCE_M)) return true;
      }
    }
    return false;
  };

  const isNear = b.map(near);
  let total = 0;
  let shared = 0;
  const deviations: HistoryPoint[][] = [];
  let run: HistoryPoint[] = [];
  let runLength = 0;
  const close = () => {
    if (runLength >= MIN_DEVIATION_M && run.length > 1) deviations.push(run);
    run = [];
    runLength = 0;
  };
  for (let i = 0; i < b.length - 1; i++) {
    const p = b[i] as HistoryPoint;
    const q = b[i + 1] as HistoryPoint;
    const length = metersBetween([p.lon, p.lat], [q.lon, q.lat]);
    if (length > MAX_SEGMENT_M) {
      close();
      continue;
    }
    total += length;
    if (isNear[i] && isNear[i + 1]) {
      shared += length;
      close();
    } else {
      if (run.length === 0) run.push(p);
      run.push(q);
      runLength += length;
    }
  }
  close();

  // The greatest separation is searched with fewer points: an approximation is enough.
  const sample = <T>(list: T[], max: number) => (list.length <= max ? list : list.filter((_, i) => i % Math.ceil(list.length / max) === 0));
  const reference = sample(a, 600);
  let maxSeparationM = 0;
  for (const p of sample(deviations.flat(), 400)) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const q of reference) nearest = Math.min(nearest, metersBetween([p.lon, p.lat], [q.lon, q.lat]));
    maxSeparationM = Math.max(maxSeparationM, nearest);
  }

  return { sharedM: shared, totalM: total, maxSeparationM, deviations };
}
