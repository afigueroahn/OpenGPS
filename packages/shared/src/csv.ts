// Reading of text files with columns (CSV), such as those exported by a
// spreadsheet or delivered by a provider. Used by the imports.

/**
 * Splits the text into rows and cells. The separator is inferred from the first
 * line: comma, semicolon or tab. Quoted cells may
 * contain the separator and line breaks; a quote inside is written doubled.
 * Empty rows are discarded.
 */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const separator = [";", "\t", ","].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ",");

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endCell = () => {
    row.push(cell.trim());
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i] as string;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (ch === separator) endCell();
    else if (ch === "\n") endRow();
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/** A column title without capitals, accents or symbols, to recognize it however each person writes it. */
export const headerKey = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * A number as written in a spreadsheet: with a comma or point as decimal,
 * with or without a thousands separator and with currency symbols around it. `null` if
 * it is not a number.
 */
export function parseAmount(text: string): number | null {
  let t = text.replace(/[^\d.,-]/g, "");
  if (t === "" || !/\d/.test(t)) return null;
  const comma = t.lastIndexOf(",");
  const dot = t.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    // With both signs, the last one is the decimal.
    t = comma > dot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (comma >= 0) {
    // Commas only: a single one followed by one or two digits is a decimal; otherwise they are thousands.
    t = /^-?\d+,\d{1,2}$/.test(t) ? t.replace(",", ".") : t.replace(/,/g, "");
  } else if ((t.match(/\./g) ?? []).length > 1) {
    t = t.replace(/\./g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The universal time of a wall-clock date and time in a time zone. */
export function zonedToUtc(zone: string, year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const shown = (ms: number) => {
    const p = Object.fromEntries(format.formatToParts(ms).map((x) => [x.type, Number(x.value)])) as Record<string, number>;
    return Date.UTC(p.year as number, (p.month as number) - 1, p.day as number, p.hour as number, p.minute as number, p.second as number);
  };
  // What the zone's clock shows at that instant says how far ahead or behind it is; two passes cover clock changes.
  let utc = wall;
  for (let i = 0; i < 2; i++) utc = wall - (shown(utc) - utc);
  return utc;
}

/**
 * Date and time typed by hand or exported: "2026-11-22 14:30", with T or with
 * seconds, or "22/11/2026 14:30" with the day first. Without a time, it is
 * noon. If it carries its own offset (Z, -06:00), it is respected; otherwise it is the
 * time in `zone`. Returns milliseconds, or `null` if it is not understood.
 */
export function parseDateTime(text: string, zone: string): number | null {
  const t = text.trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(t) && /^\d{4}-\d\d-\d\d[T ]/.test(t)) {
    const ms = Date.parse(t.replace(" ", "T"));
    return Number.isNaN(ms) ? null : ms;
  }
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const latin = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const m = iso ?? latin;
  if (!m) return null;
  const [year, month, day] = iso ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[3]), Number(m[2]), Number(m[1])];
  const hour = m[4] === undefined ? 12 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  // A day that does not exist in that month (30 February) does not roll over to the next month: it is invalid.
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;
  return zonedToUtc(zone, year, month, day, hour, minute, second);
}
