import { describe, expect, it } from "vitest";
import { LOCK_AFTER_MS, locksOnReturn } from "./lock";

const LEFT = Date.parse("2026-11-26T12:00:00Z");
const MINUTE = 60_000;

describe("when the app asks for Face ID again", () => {
  it("asks after 5 minutes or more away", () => {
    expect(LOCK_AFTER_MS).toBe(5 * MINUTE);
    expect(locksOnReturn(LEFT, LEFT + 5 * MINUTE)).toBe(true);
    expect(locksOnReturn(LEFT, LEFT + 60 * MINUTE)).toBe(true);
  });

  it("does not ask before 5 minutes away", () => {
    expect(locksOnReturn(LEFT, LEFT + 5 * MINUTE - 1)).toBe(false);
    expect(locksOnReturn(LEFT, LEFT + 10_000)).toBe(false);
  });

  it("does not ask when the app never went to the background", () => {
    expect(locksOnReturn(null, LEFT + 60 * MINUTE)).toBe(false);
  });
});
