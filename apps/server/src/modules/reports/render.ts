// A report as a file: Excel with one sheet per table, or landscape PDF.
import type { Language, ReportCell, ReportColumn, ReportDocument, ReportFormat, ReportPlace, ReportTable, ReportValue } from "@opengps/shared";
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { ExportFile } from "../../core/export";
import { type Clock, coords, createClock, dateLabel, decimalMark, duration, exportLabel, km, periodLabel, slug } from "../../core/export/format";
import { latin } from "../../core/export/pdf";
import { type Cell, STYLE, type Sheet, buildXlsx } from "../../core/export/xlsx";
import { tr } from "../../i18n";

/** Most rows of each table that fit in the PDF; the Excel carries them all. */
const PDF_MAX_ROWS = 1500;

const decimal = (n: number, digits: number, language: Language) => decimalMark(language, n.toFixed(digits));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;
const isPlace = (value: ReportValue): value is ReportPlace => typeof value === "object" && value !== null;
const placeText = (p: ReportPlace) => p.address ?? coords(p.lat, p.lon);

/** A report value written to be read, in the clock's language: "12,3 km", "2 h 05 min", "21 nov, 14:05". */
export function textOf(value: ReportValue, type: ReportCell, clock: Clock): string {
  const { language } = clock;
  if (value === null || value === "") return "";
  if (isPlace(value)) return placeText(value);
  if (typeof value === "string") {
    // Text in a date column (the first one's "Total") stays as text.
    if (type === "datetime" && ISO_TIME.test(value)) return clock.short(Date.parse(value));
    if (type === "date" && ISO_DATE.test(value)) return dateLabel(value, language);
    return value;
  }
  switch (type) {
    case "duration":
      return duration(value);
    case "distance":
      return km(value, 1, language);
    case "speed":
      return `${Math.round(value)} km/h`;
    case "liters":
      return `${decimal(value, 1, language)} L`;
    case "percent":
      return `${decimal(value, 1, language)} %`;
    case "decimal":
      return decimal(value, Number.isInteger(value) ? 0 : value < 10 ? 2 : 1, language);
    default:
      return String(Math.round(value));
  }
}

const period = (doc: ReportDocument, clock: Clock) => periodLabel(clock, Date.parse(doc.from), Date.parse(doc.to));

// ─── Excel ───────────────────────────────────────────────────────────────────

const UNIT: Partial<Record<ReportCell, string>> = { distance: " (km)", speed: " (km/h)", liters: " (L)", percent: " (%)" };
const XLSX_STYLE: Record<ReportCell, number> = {
  text: STYLE.text,
  place: STYLE.text,
  datetime: STYLE.dateTime,
  date: STYLE.date,
  duration: STYLE.duration,
  distance: STYLE.decimal2,
  speed: STYLE.integer,
  integer: STYLE.integer,
  decimal: STYLE.decimal2,
  liters: STYLE.decimal1,
  percent: STYLE.decimal1,
};
const XLSX_WIDTH: Record<ReportCell, number> = { text: 26, place: 44, datetime: 20, date: 12, duration: 11, distance: 13, speed: 12, integer: 10, decimal: 10, liters: 11, percent: 9 };

function xlsxValue(value: ReportValue, type: ReportCell, clock: Clock): string | number | null {
  if (value === null) return null;
  if (isPlace(value)) return placeText(value);
  if (typeof value === "string") {
    if (type === "datetime" && ISO_TIME.test(value)) return clock.serial(Date.parse(value));
    if (type === "date" && ISO_DATE.test(value)) {
      const [y, m, d] = value.split("-").map(Number);
      return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000 + 25_569;
    }
    return value;
  }
  if (type === "duration") return value / 86_400;
  if (type === "distance") return value / 1000;
  return value;
}

function tableSheet(table: ReportTable, clock: Clock): Sheet {
  const header = table.columns.map((c) => `${c.label}${UNIT[c.type] ?? ""}`);
  const typed = (row: ReportValue[], bold: boolean): Cell[] =>
    row.map((value, i) => {
      const type = (table.columns[i] as ReportColumn).type;
      const v = xlsxValue(value, type, clock);
      if (v === null) return null;
      // Text in a number column (the first one's "Total") goes as text.
      const style = typeof v === "string" ? (bold ? STYLE.bold : STYLE.text) : XLSX_STYLE[type];
      return { v, s: style };
    });
  return {
    name: table.title,
    widths: table.columns.map((c, i) => Math.max(XLSX_WIDTH[c.type], (header[i] as string).length + 3)),
    rows: [header, ...table.rows.map((row) => typed(row, false)), ...(table.totals ? [typed(table.totals, true)] : [])],
  };
}

function xlsx(doc: ReportDocument, clock: Clock, appName: string): Buffer {
  const { language } = clock;
  const label = (text: string): Cell => ({ v: text, s: STYLE.bold });
  const rows: Cell[][] = [
    [label(doc.title)],
    [label(tr(language, "reports.file.period")), period(doc, clock)],
    [label(exportLabel(language, "zone")), `${clock.zone} (${clock.offset(Date.parse(doc.from))})`],
    [label(tr(language, "reports.labels.vehicles")), doc.scope],
    ...doc.options.map((option): Cell[] => [label(tr(language, "reports.file.option")), option]),
    [label(tr(language, "reports.file.generated")), { v: clock.serial(Date.parse(doc.generatedAt)), s: STYLE.dateTime }],
    [label(tr(language, "reports.file.platform")), appName],
    [],
    ...doc.stats.map((s): Cell[] => {
      const v = xlsxValue(s.value, s.type, clock);
      return [label(`${s.label}${UNIT[s.type] ?? ""}`), v === null ? "—" : typeof v === "string" ? v : { v, s: XLSX_STYLE[s.type] }];
    }),
    ...(doc.notes.length ? [[], ...doc.notes.map((note): Cell[] => [note])] : []),
    ...doc.tables.filter((t) => t.total > t.rows.length).map((t): Cell[] => [tr(language, "reports.file.truncatedSheet", { title: t.title, total: t.total, shown: t.rows.length })]),
  ];
  return buildXlsx([{ name: exportLabel(language, "summary"), header: false, widths: [30, 44], rows }, ...doc.tables.map((t) => tableSheet(t, clock))]);
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

const PAGE = { w: 841.89, h: 595.28 }; // A4 landscape
const MARGIN = 36;
const WIDTH = PAGE.w - MARGIN * 2;
const INK = rgb(0.063, 0.086, 0.137);
const BAR = rgb(0.157, 0.196, 0.282);
const MUTED = rgb(0.4, 0.443, 0.525);
const LINE = rgb(0.886, 0.902, 0.933);
const PANEL = rgb(0.957, 0.965, 0.98);
const GREEN = rgb(0.071, 0.627, 0.396);
const AMBER = rgb(0.816, 0.529, 0);
const RIGHT: ReportCell[] = ["duration", "distance", "speed", "integer", "decimal", "liters", "percent"];
/** Most width a column can take before its text is cut off, by type. */
const PDF_MAX: Partial<Record<ReportCell, number>> = { place: 230, text: 190 };

async function pdf(doc: ReportDocument, clock: Clock, appName: string): Promise<Buffer> {
  const { language } = clock;
  const out = await PDFDocument.create();
  const regular = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  out.setTitle(latin(doc.title));
  out.setCreator(latin(appName));
  out.setProducer(latin(appName));

  let page: PDFPage = out.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - MARGIN;

  function fit(value: string, font: PDFFont, size: number, max: number): string {
    let shown = latin(value);
    // A hair of margin: the column width comes from adding and subtracting its padding.
    if (font.widthOfTextAtSize(shown, size) <= max + 0.01) return shown;
    while (shown.length > 1 && font.widthOfTextAtSize(`${shown}…`, size) > max) shown = shown.slice(0, -1);
    return `${shown.trimEnd()}…`;
  }
  function write(value: string, x: number, baseline: number, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; max?: number; align?: "right" } = {}) {
    const size = opts.size ?? 8.5;
    const font = opts.font ?? regular;
    const shown = opts.max ? fit(value, font, size, opts.max) : latin(value);
    const dx = opts.align === "right" ? (opts.max ?? 0) - font.widthOfTextAtSize(shown, size) : 0;
    page.drawText(shown, { x: x + dx, y: baseline, size, font, color: opts.color ?? INK });
  }
  function room(height: number): boolean {
    if (y - height >= MARGIN + 20) return false;
    page = out.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - MARGIN;
    return true;
  }

  // ─── Header ────────────────────────────────────────────────────────────────
  write(appName.toUpperCase(), MARGIN, y - 8, { size: 8, font: bold, color: GREEN });
  y -= 32;
  write(doc.title, MARGIN, y, { size: 19, font: bold, max: WIDTH });
  y -= 16;
  write([period(doc, clock), doc.scope, ...doc.options, tr(language, "exports.pdf.hoursIn", { zone: clock.zone, offset: clock.offset(Date.parse(doc.from)) })].join("  ·  "), MARGIN, y, {
    size: 9.5,
    color: MUTED,
    max: WIDTH,
  });
  y -= 20;

  // ─── Totals ────────────────────────────────────────────────────────────────
  if (doc.stats.length > 0) {
    const gap = 8;
    const perRow = Math.min(doc.stats.length, 5);
    const tileW = (WIDTH - gap * (perRow - 1)) / perRow;
    const tileH = 42;
    doc.stats.forEach((s, i) => {
      const x = MARGIN + (i % perRow) * (tileW + gap);
      const top = y - Math.floor(i / perRow) * (tileH + gap);
      page.drawRectangle({ x, y: top - tileH, width: tileW, height: tileH, color: PANEL });
      write(s.label.toUpperCase(), x + 10, top - 15, { size: 6.8, font: bold, color: MUTED, max: tileW - 20 });
      write(textOf(s.value, s.type, clock) || "—", x + 10, top - 32, { size: 13, font: bold, max: tileW - 20 });
    });
    const tileRows = Math.ceil(doc.stats.length / perRow);
    y -= tileRows * tileH + (tileRows - 1) * gap + 20;
  }

  // ─── Chart ─────────────────────────────────────────────────────────────────
  const chart = doc.chart;
  if (chart && chart.labels.length > 0 && chart.series.some((s) => s.values.some((v) => v > 0))) {
    const height = 120;
    room(height + 44);
    write(chart.title, MARGIN, y, { size: 11.5, font: bold });
    const colors = chart.series.length > 1 ? [GREEN, AMBER] : [BAR];
    if (chart.series.length > 1) {
      let x = MARGIN + bold.widthOfTextAtSize(latin(chart.title), 11.5) + 18;
      chart.series.forEach((s, i) => {
        page.drawRectangle({ x, y: y - 0.5, width: 8, height: 8, color: colors[i % colors.length] as ReturnType<typeof rgb> });
        write(s.name, x + 12, y, { size: 8, color: MUTED });
        x += 12 + regular.widthOfTextAtSize(latin(s.name), 8) + 14;
      });
    }
    y -= 12;
    const base = y - height;
    const totals = chart.labels.map((_, i) => chart.series.reduce((n, s) => n + (s.values[i] ?? 0), 0));
    const top = Math.max(...totals, 1e-9);
    const slot = WIDTH / chart.labels.length;
    const barW = Math.min(34, slot * 0.7);
    // Three reference lines with their value, and the base.
    for (const share of [0.5, 1]) {
      const lineY = base + height * share * 0.9;
      page.drawLine({ start: { x: MARGIN, y: lineY }, end: { x: MARGIN + WIDTH, y: lineY }, thickness: 0.4, color: LINE });
      write(textOf(top * share, chart.unit, clock), MARGIN, lineY + 2.5, { size: 6.5, color: MUTED });
    }
    page.drawLine({ start: { x: MARGIN, y: base }, end: { x: MARGIN + WIDTH, y: base }, thickness: 0.6, color: MUTED });
    const everyLabel = Math.ceil(chart.labels.length / 16);
    chart.labels.forEach((label, i) => {
      const x = MARGIN + slot * i + (slot - barW) / 2;
      let from = base;
      chart.series.forEach((s, n) => {
        const h = ((s.values[i] ?? 0) / top) * height * 0.9;
        if (h <= 0) return;
        // A thin gap separates the stacked segments.
        page.drawRectangle({ x, y: from + (n > 0 ? 1 : 0), width: barW, height: Math.max(0.5, h - (n > 0 ? 1 : 0)), color: colors[n % colors.length] as ReturnType<typeof rgb> });
        from += h;
      });
      if (i % everyLabel === 0) {
        const text = chart.labelType === "date" ? dateLabel(label, language).split(" ").slice(0, 2).join(" ") : label;
        const shown = fit(text, regular, 6.5, slot * everyLabel - 2);
        write(shown, x + barW / 2 - regular.widthOfTextAtSize(shown, 6.5) / 2, base - 9, { size: 6.5, color: MUTED });
      }
    });
    y = base - 26;
  }

  // ─── Tables ────────────────────────────────────────────────────────────────
  for (const t of doc.tables) {
    const rows = t.rows.slice(0, PDF_MAX_ROWS).map((row) => row.map((value, i) => textOf(value, (t.columns[i] as ReportColumn).type, clock) || "—"));
    const totals = t.totals?.map((value, i) => textOf(value, (t.columns[i] as ReportColumn).type, clock));
    // Each column asks for what its widest text takes; if not everything fits, it is shared out proportionally.
    const natural = t.columns.map((c, i) => {
      let w = bold.widthOfTextAtSize(latin(c.label.toUpperCase()), 6.8);
      for (const row of rows.slice(0, 300)) w = Math.max(w, regular.widthOfTextAtSize(latin(row[i] as string), 8.5));
      if (totals?.[i]) w = Math.max(w, bold.widthOfTextAtSize(latin(totals[i] as string), 8.5));
      return Math.min(w, PDF_MAX[c.type] ?? 400) + 12;
    });
    const sum = natural.reduce((a, b) => a + b, 0);
    const widths = sum > WIDTH ? natural.map((w) => (w * WIDTH) / sum) : natural;
    const tableW = widths.reduce((a, b) => a + b, 0);
    const align = (c: ReportColumn) => (RIGHT.includes(c.type) ? { align: "right" as const } : {});

    const head = () => {
      page.drawRectangle({ x: MARGIN, y: y - 16, width: tableW, height: 16, color: PANEL });
      let x = MARGIN;
      t.columns.forEach((c, i) => {
        write(c.label.toUpperCase(), x + 6, y - 11, { size: 6.8, font: bold, color: MUTED, max: (widths[i] as number) - 12, ...align(c) });
        x += widths[i] as number;
      });
      y -= 16;
    };
    const line = (cells: string[], font: PDFFont) => {
      let x = MARGIN;
      cells.forEach((cell, i) => {
        write(cell, x + 6, y - 11, { font, max: (widths[i] as number) - 12, ...align(t.columns[i] as ReportColumn) });
        x += widths[i] as number;
      });
      y -= 16;
    };

    room(70);
    write(t.title, MARGIN, y, { size: 11.5, font: bold });
    y -= 10;
    if (rows.length === 0) {
      y -= 8;
      write(tr(language, "reports.file.noData"), MARGIN, y, { size: 9, color: MUTED });
      y -= 24;
      continue;
    }
    head();
    for (const row of rows) {
      if (room(16)) head();
      line(row, regular);
      page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + tableW, y }, thickness: 0.4, color: LINE });
    }
    if (totals) {
      if (room(16)) head();
      line(totals, bold);
      page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + tableW, y }, thickness: 0.8, color: MUTED });
    }
    if (t.total > rows.length) {
      room(16);
      y -= 12;
      write(tr(language, "reports.file.truncatedPdf", { total: t.total, shown: rows.length }), MARGIN, y, { size: 8, color: MUTED, max: WIDTH });
    }
    y -= 24;
  }

  // ─── Notes ─────────────────────────────────────────────────────────────────
  for (const note of doc.notes) {
    room(14);
    write(note, MARGIN, y, { size: 8, color: MUTED, max: WIDTH });
    y -= 12;
  }

  const pages = out.getPages();
  const stamp = tr(language, "exports.pdf.generated", { date: clock.human(Date.parse(doc.generatedAt)), app: appName });
  pages.forEach((p, i) => {
    page = p;
    write(stamp, MARGIN, 22, { size: 7.5, color: MUTED, max: WIDTH - 90 });
    write(tr(language, "exports.pdf.page", { page: i + 1, pages: pages.length }), MARGIN + WIDTH - 90, 22, { size: 7.5, color: MUTED, max: 90, align: "right" });
  });
  return Buffer.from(await out.save());
}

// ─── Input ───────────────────────────────────────────────────────────────────

const TYPES: Record<ReportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

/** The report as a file, written in `language`: the one the report itself was built in. */
export async function renderReport(doc: ReportDocument, format: ReportFormat, appName: string, language: Language): Promise<ExportFile> {
  const clock = createClock(doc.zone, language);
  const first = clock.date(Date.parse(doc.from));
  const last = clock.date(Date.parse(doc.to) - 1);
  const filename = `${slug(doc.title, language)}-${first}${last === first ? "" : `_${last}`}.${format}`;
  return { filename, contentType: TYPES[format], body: format === "xlsx" ? xlsx(doc, clock, appName) : await pdf(doc, clock, appName) };
}

/** The period and totals on one line, for the email that carries the file, in the language the report was built in. */
export function summaryLine(doc: ReportDocument, language: Language): string {
  const clock = createClock(doc.zone, language);
  const stats = doc.stats.map((s) => `${s.label}: ${textOf(s.value, s.type, clock) || "—"}`).join(" · ");
  return `${period(doc, clock)}. ${doc.scope}.${stats ? ` ${stats}.` : ""}`;
}
