import type { HistoryPoint } from "@opengps/shared";
import { describe, expect, it } from "vitest";
import { advance, daysRange, indexAt, matchPreset, momentAt, pickRate, presetRange, rangeProblem, routeLines, shiftRange, wholeDays } from "./history";

const NOW = new Date(2026, 10, 26, 15, 30); // 26 Nov 2026, 15:30, local time
const p = (t: number, lat: number, s = 40, i: boolean | null = true): HistoryPoint => ({ t, lat, lon: -87, s, c: 90, i });

describe("the history period", () => {
  it("today goes from midnight to the next midnight", () => {
    const r = presetRange("today", NOW);
    expect(r.from).toEqual(new Date(2026, 10, 26));
    expect(r.to).toEqual(new Date(2026, 10, 27));
  });

  it("the 7 and 30 days end tomorrow at midnight and include today", () => {
    expect(wholeDays(presetRange("7d", NOW))).toBe(7);
    expect(wholeDays(presetRange("30d", NOW))).toBe(30);
  });

  it("going back from today is yesterday, and back from 7 days the 7 before", () => {
    const back = matchPreset(shiftRange(presetRange("today", NOW), -1), NOW);
    expect(back.preset).toBe("yesterday");
    const week = shiftRange(presetRange("7d", NOW), -1);
    expect(week.from).toEqual(new Date(2026, 10, 13));
    expect(week.to).toEqual(new Date(2026, 10, 20));
    expect(week.preset).toBe("custom");
  });

  it("a range of days includes the last day", () => {
    const r = daysRange(new Date(2026, 10, 20, 9), new Date(2026, 10, 22, 18));
    expect(r.from).toEqual(new Date(2026, 10, 20));
    expect(r.to).toEqual(new Date(2026, 10, 23));
  });

  it("is not valid backwards or longer than 31 days", () => {
    expect(rangeProblem(daysRange(new Date(2026, 10, 22), new Date(2026, 10, 20)))).toBe("endBeforeStart");
    expect(rangeProblem(daysRange(new Date(2026, 9, 1), new Date(2026, 10, 20)))).toBe("tooLong");
    expect(rangeProblem(daysRange(new Date(2026, 10, 1), new Date(2026, 10, 30)))).toBeNull();
  });
});

describe("where the vehicle was", () => {
  const points = [p(0, 14.0), p(10, 14.001), p(20, 14.002)];

  it("finds the last point not after an instant", () => {
    expect(indexAt(points, -5)).toBe(0);
    expect(indexAt(points, 10)).toBe(1);
    expect(indexAt(points, 15)).toBe(1);
    expect(indexAt(points, 99)).toBe(2);
  });

  it("is between two points halfway through", () => {
    expect(momentAt(points, 5)?.lat).toBeCloseTo(14.0005, 6);
  });

  it("does not invent a path through a stretch without data", () => {
    const gap = [p(0, 14.0), p(5000, 14.5)];
    expect(momentAt(gap, 2500)?.lat).toBe(14.0);
  });

  it("cuts the line where data is missing far away", () => {
    const lines = routeLines([p(0, 14.0), p(10, 14.001), p(5000, 14.5), p(5010, 14.501)]);
    expect(lines).toHaveLength(2);
  });
});

describe("the player", () => {
  it("chooses a rate that plays the moving part in about forty seconds", () => {
    // 40 minutes moving → 2400 s / 40 s = 60×
    const moving = Array.from({ length: 241 }, (_, i) => p(i * 10, 14 + i * 0.001));
    expect(pickRate(moving)).toBe(60);
  });

  it("skips a stop and does not pass the end", () => {
    const withStop = [p(0, 14.0), p(10, 14.001), p(1000, 14.001, 0, false), p(1010, 14.002)];
    expect(advance(withStop, 12, 0.1, 10)).toBe(1000);
    expect(advance(withStop, 1005, 10, 600)).toBe(1010);
  });
});
