// Geofence geometry and schedules.
import {
  type GeofenceGeometry,
  type LonLat,
  type WeekSchedule,
  activeSince,
  boundsOf,
  circleRing,
  corridorRing,
  geofenceSchema,
  type SharedSay,
  geometryProblem as geometryProblemSaid,
  insideRing,
  isActive,
  metersBetween,
  offset,
  selfIntersects,
  signedDistanceM,
  sharedText,
} from "@opengps/shared";
import { describe, expect, it } from "vitest";

/** A geometry problem as Spanish says it. */
const geometryProblem = (g: GeofenceGeometry) => {
  const problem: SharedSay | null = geometryProblemSaid(g);
  return problem && sharedText("es")(problem.key, problem.params);
};

const center: LonLat = [-87.2068, 14.0818];
/** Point so many metres east and north of the centre. */
const at = (east: number, north: number): LonLat => offset(offset(center, east, 90), north, 0);

describe("geofence geometry", () => {
  it("measures distances in metres", () => {
    expect(metersBetween(center, at(1000, 0))).toBeCloseTo(1000, 0);
    expect(metersBetween(center, at(0, -250))).toBeCloseTo(250, 0);
  });

  it("circle: inside, outside and distance to the edge", () => {
    const circle: GeofenceGeometry = { shape: "circle", center, radiusM: 200 };
    expect(signedDistanceM(circle, center)).toBeCloseTo(-200, 0);
    expect(signedDistanceM(circle, at(150, 0))).toBeCloseTo(-50, 0);
    expect(signedDistanceM(circle, at(260, 0))).toBeCloseTo(60, 0);
  });

  it("polygon: inside, outside and distance to the nearest side", () => {
    // A square 400 m on a side centred on the point.
    const square: GeofenceGeometry = { shape: "polygon", ring: [at(-200, -200), at(200, -200), at(200, 200), at(-200, 200)] };
    expect(insideRing(center, square.ring)).toBe(true);
    expect(signedDistanceM(square, center)).toBeCloseTo(-200, 0);
    expect(signedDistanceM(square, at(150, 0))).toBeCloseTo(-50, 0);
    expect(signedDistanceM(square, at(230, 0))).toBeCloseTo(30, 0);
    expect(signedDistanceM(square, at(300, 300))).toBeCloseTo(Math.hypot(100, 100), 0);
    // An L shape: the notch at the corner is outside.
    const ell: LonLat[] = [at(0, 0), at(300, 0), at(300, 100), at(100, 100), at(100, 300), at(0, 300)];
    expect(insideRing(at(50, 250), ell)).toBe(true);
    expect(insideRing(at(250, 50), ell)).toBe(true);
    expect(insideRing(at(200, 200), ell)).toBe(false);
  });

  it("corridor: everything within half the width of the route", () => {
    const route: GeofenceGeometry = { shape: "corridor", line: [at(0, 0), at(1000, 0), at(1000, 800)], widthM: 100 };
    expect(signedDistanceM(route, at(500, 30))).toBeCloseTo(-20, 0);
    expect(signedDistanceM(route, at(500, 120))).toBeCloseTo(70, 0);
    expect(signedDistanceM(route, at(1040, 400))).toBeCloseTo(-10, 0);
    // Beyond the end of the route the distance also counts.
    expect(signedDistanceM(route, at(1000, 900))).toBeCloseTo(50, 0);
  });

  it("the bounding box contains the geofence with a margin", () => {
    const box = boundsOf({ shape: "circle", center, radiusM: 500 });
    for (const p of [at(590, 0), at(-590, 0), at(0, 590), at(0, -590)]) {
      expect(p[0]).toBeGreaterThan(box.minLon);
      expect(p[0]).toBeLessThan(box.maxLon);
      expect(p[1]).toBeGreaterThan(box.minLat);
      expect(p[1]).toBeLessThan(box.maxLat);
    }
    expect(at(700, 0)[0]).toBeGreaterThan(box.maxLon);
  });

  it("draws the outline of circles and corridors", () => {
    const ring = circleRing(center, 300);
    expect(ring).toHaveLength(72);
    for (const p of ring) expect(metersBetween(center, p)).toBeCloseTo(300, 0);
    const line = [at(0, 0), at(1000, 0), at(1000, 800)];
    const outline = corridorRing(line, 100);
    // The whole outline is half a width from the route, except at the corner, where it opens up a little.
    for (const p of outline) {
      const d = signedDistanceM({ shape: "corridor", line, widthM: 100 }, p);
      expect(d).toBeGreaterThan(-1);
      expect(d).toBeLessThan(25);
    }
    expect(selfIntersects(outline)).toBe(false);
  });

  it("rejects unusable shapes and explains why", () => {
    expect(geometryProblem({ shape: "circle", center, radiusM: 5 })).toContain("radio mínimo");
    expect(geometryProblem({ shape: "polygon", ring: [at(0, 0), at(100, 0)] })).toContain("tres puntos");
    // A bow tie: two sides cross.
    const bow: LonLat[] = [at(0, 0), at(200, 200), at(200, 0), at(0, 200)];
    expect(selfIntersects(bow)).toBe(true);
    expect(geometryProblem({ shape: "polygon", ring: bow })).toContain("se cruzan");
    expect(geometryProblem({ shape: "polygon", ring: [at(0, 0), at(5, 0), at(0, 5)] })).toContain("pequeña");
    expect(geometryProblem({ shape: "corridor", line: [at(0, 0)], widthM: 100 })).toContain("dos puntos");
    expect(geometryProblem({ shape: "polygon", ring: [at(0, 0), at(200, 0), at(200, 200), at(0, 200)] })).toBeNull();
  });

  it("the schema validates the whole geofence", () => {
    const good = { name: " Patio ", geometry: { shape: "circle", center, radiusM: 150 } };
    const parsed = geofenceSchema.parse(good);
    expect(parsed).toMatchObject({ name: "Patio", kind: "notify", schedule: null, groupIds: null, active: true });
    expect(geofenceSchema.safeParse({ ...good, geometry: { shape: "circle", center, radiusM: 2 } }).success).toBe(false);
    const order = geofenceSchema.safeParse({ ...good, minStayMin: 30, maxStayMin: 10 }).error?.issues[0];
    // The schema writes the key of its text; whoever shows it says it in the reader's language.
    expect(order && sharedText("es")(order.message as never)).toContain("menor que la máxima");
    expect(geofenceSchema.safeParse({ ...good, schedule: { zone: "Marte/Olimpo", days: [null, [0, 60], null, null, null, null, null] } }).success).toBe(false);
    expect(geofenceSchema.safeParse({ ...good, schedule: { zone: "UTC", days: [null, null, null, null, null, null, null] } }).success).toBe(false);
  });
});

describe("schedules", () => {
  // Monday to Friday from 08:00 to 18:00 in Honduras (UTC-6).
  const office: WeekSchedule = { zone: "America/Tegucigalpa", days: [null, [480, 1080], [480, 1080], [480, 1080], [480, 1080], [480, 1080], null] };
  // Every night from 22:00 to 06:00.
  const night: WeekSchedule = { zone: "America/Tegucigalpa", days: Array.from({ length: 7 }, () => [1320, 360] as [number, number]) };
  // 2026-11-23 is a Monday.
  const local = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour + 6, minute);

  it("applies within the day's window and not outside it", () => {
    expect(isActive(office, local(23, 9))).toBe(true);
    expect(isActive(office, local(23, 7, 59))).toBe(false);
    expect(isActive(office, local(23, 18))).toBe(false);
    expect(isActive(office, local(22, 12))).toBe(false); // Sunday
    expect(isActive(null, local(22, 12))).toBe(true);
  });

  it("says since when it applies", () => {
    expect(activeSince(office, local(23, 9, 30))).toBe(local(23, 8));
    expect(activeSince(office, local(23, 20))).toBeNull();
    expect(activeSince(null, 0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("a window that crosses midnight still applies in the early hours", () => {
    expect(isActive(night, local(23, 23))).toBe(true);
    expect(isActive(night, local(24, 3))).toBe(true);
    expect(isActive(night, local(24, 6))).toBe(false);
    expect(isActive(night, local(24, 12))).toBe(false);
    expect(activeSince(night, local(24, 3))).toBe(local(23, 22));
  });
});
