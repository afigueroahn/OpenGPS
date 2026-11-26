import type { TrackPoint } from "@opengps/shared";
import { describe, expect, it } from "vitest";
import { mergeTrack, TRACK_MAX_POINTS, trackPoint } from "./track";

const at = (minute: number, lat = 14): TrackPoint => ({ t: `2026-11-26T12:${String(minute).padStart(2, "0")}:00.000Z`, lat, lon: -87, speedKmh: 40, course: 90 });

describe("the recent trip on the map", () => {
  it("adds the live positions after what the platform kept, in time order", () => {
    expect(mergeTrack([at(1), at(2)], [at(4), at(3)]).map((p) => p.t)).toEqual([at(1).t, at(2).t, at(3).t, at(4).t]);
  });

  it("does not repeat a position that arrives twice", () => {
    expect(mergeTrack([at(1), at(2)], [at(2, 15)])).toEqual([at(1), at(2, 15)]);
  });

  it("keeps only the latest points", () => {
    const many = Array.from({ length: TRACK_MAX_POINTS + 5 }, (_, i) => ({ ...at(0), t: new Date(Date.UTC(2026, 10, 26, 0, 0, i)).toISOString() }));
    const merged = mergeTrack(many, []);
    expect(merged).toHaveLength(TRACK_MAX_POINTS);
    expect(merged[merged.length - 1]).toEqual(many[many.length - 1]);
  });

  it("takes a live position only when it has a fix", () => {
    const state = { lastSeenAt: at(5).t, fixTime: at(5).t, lat: 14, lon: -87, altitude: null, speedKmh: 40, course: 90, accuracy: null, ignition: true, ignitionInferred: false, motion: true, powerVoltage: null, batteryVoltage: null, batteryLevel: null, satellites: null, signalBars: null };
    expect(trackPoint(state)).toEqual(at(5));
    expect(trackPoint({ ...state, fixTime: null })).toBeNull();
    expect(trackPoint({ ...state, lat: null })).toBeNull();
    expect(trackPoint(null)).toBeNull();
  });
});
