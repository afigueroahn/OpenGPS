// Schedules in cron format, with the hours in UTC: used by the backup
// scheduler.
import { BACKUP_MIN_GAP_MIN, BACKUP_PRESETS, type Cron, type SharedSay, backupSettingsSchema, cronNext, cronProblem, cronUpcoming, isCron, parseCron, sharedText } from "@opengps/shared";
import { describe, expect, it } from "vitest";

const utc = (iso: string) => Date.parse(`${iso}Z`);
const cron = (expression: string): Cron => {
  const parsed = parseCron(expression);
  if (!isCron(parsed)) throw new Error(parsed.key);
  return parsed;
};
/** What a problem says in Spanish. */
const said = (text: Cron | SharedSay | null) => (text === null ? null : "key" in text ? sharedText("es")(text.key, text.params) : "a schedule");
const next = (expression: string, after: string) => new Date(cronNext(cron(expression), utc(after)) as number).toISOString().slice(0, 16);

describe("cron schedules", () => {
  it("understands numbers, lists, ranges, steps and asterisks", () => {
    expect(cron("0 8 * * *")).toMatchObject({ minutes: [0], hours: [8], anyDay: true, anyWeekday: true });
    expect(cron("*/15 0-6/2 1,15 * 1-5")).toMatchObject({ minutes: [0, 15, 30, 45], hours: [0, 2, 4, 6], days: [1, 15], weekdays: [1, 2, 3, 4, 5], anyDay: false, anyWeekday: false });
    // 7 is also Sunday, and extra spaces do not matter.
    expect(cron("  30   2  *  *  7 ").weekdays).toEqual([0]);
    expect(cron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
  });

  it("says what is wrong with an expression", () => {
    expect(said(parseCron("0 8 * *"))).toContain("cinco datos");
    expect(said(parseCron("60 8 * * *"))).toContain("minuto");
    expect(said(parseCron("0 24 * * *"))).toContain("hora");
    expect(said(parseCron("0 8 0 * *"))).toContain("día del mes");
    expect(said(parseCron("0 8 * 13 *"))).toContain("mes");
    expect(said(parseCron("0 8 * * lunes"))).toContain("día de la semana");
    expect(said(parseCron("0 8-2 * * *"))).toContain("hora");
    expect(said(parseCron("*/0 * * * *"))).toContain("paso");
    expect(said(cronProblem("0 0 31 2 *"))).toBe("Ese horario no llega nunca");
    expect(said(cronProblem("0 8 * * *"))).toBeNull();
  });

  it("computes the next run time, in UTC", () => {
    expect(next("0 8 * * *", "2026-11-22T07:59:00")).toBe("2026-11-22T08:00");
    expect(next("0 8 * * *", "2026-11-22T08:00:00")).toBe("2026-11-23T08:00");
    expect(next("0 */6 * * *", "2026-11-22T13:10:00")).toBe("2026-11-22T18:00");
    expect(next("0 */12 * * *", "2026-11-22T13:10:00")).toBe("2026-11-23T00:00");
    // Weekly, on Sundays: 22 November 2026 is a Sunday.
    expect(next("0 0 * * 0", "2026-11-22T00:00:00")).toBe("2026-11-29T00:00");
    expect(next("30 2 1 * *", "2026-11-22T00:00:00")).toBe("2026-12-01T02:30");
    expect(next("0 0 1 1 *", "2026-11-22T00:00:00")).toBe("2027-01-01T00:00");
    // With both day of month and day of week, matching either one is enough: the 13th or a Friday.
    expect(next("0 0 13 * 5", "2026-11-22T00:00:00")).toBe("2026-11-27T00:00");
    expect(next("0 0 29 2 *", "2026-11-22T00:00:00")).toBe("2028-02-29T00:00");
    expect(cronUpcoming(cron("0 */6 * * *"), utc("2026-11-22T00:00:00"), 4).map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(["06:00", "12:00", "18:00", "00:00"]);
  });

  it("the schedules offered by the buttons are valid, and one that is too frequent is not", () => {
    for (const preset of BACKUP_PRESETS) expect(cronProblem(preset.cron, BACKUP_MIN_GAP_MIN), preset.label).toBeNull();
    expect(said(cronProblem("* * * * *", BACKUP_MIN_GAP_MIN))).toContain("demasiado seguido");
    expect(said(cronProblem("*/30 * * * *", BACKUP_MIN_GAP_MIN))).toContain("demasiado seguido");
    expect(said(cronProblem("59,0 23,0 * * *", BACKUP_MIN_GAP_MIN))).toContain("demasiado seguido");
    expect(said(cronProblem("0 * * * *", BACKUP_MIN_GAP_MIN))).toBeNull();
    const parse = (expression: string) => backupSettingsSchema.safeParse({ scheduled: true, cron: expression, retentionDays: 7, upload: false });
    expect(parse("0   3 * * 1")).toMatchObject({ success: true, data: { cron: "0 3 * * 1" } });
    expect(parse("cada día").success).toBe(false);
    expect(parse("*/5 * * * *").success).toBe(false);
  });
});
