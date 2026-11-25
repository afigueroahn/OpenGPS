// PDF report of a trip: totals, route drawing, trips and stops.
import { PDFDocument, type PDFFont, StandardFonts, rgb } from "pdf-lib";
import { tr } from "../../i18n";
import type { HistoryData } from "../history";
import { MAX_GAP_S } from "../trips";
import { type Clock, type ExportLabel, coords, duration, exportLabel, km } from "./format";

const PAGE = { w: 595.28, h: 841.89 }; // A4
const MARGIN = 40;
const WIDTH = PAGE.w - MARGIN * 2;
const INK = rgb(0.063, 0.086, 0.137);
const MUTED = rgb(0.4, 0.443, 0.525);
const LINE = rgb(0.886, 0.902, 0.933);
const PANEL = rgb(0.957, 0.965, 0.98);
const GREEN = rgb(0.071, 0.627, 0.396);
const WHITE = rgb(1, 1, 1);

/** The PDF's standard fonts only include the Latin alphabet: everything else is replaced. */
export const latin = (text: string) =>
  text
    .normalize("NFC")
    .replace(/[^\x20-\x7E\xA1-\xFF–—‘’“”•…]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();

interface Column {
  title: string;
  width: number;
  align?: "right";
}
interface Row {
  cells: string[];
  /** Second line, small, at full width. */
  sub?: string;
}

/** The PDF is written in the clock's language. */
export async function buildPdf(data: HistoryData, clock: Clock, appName: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { vehicle, summary, trips, stops, samples } = data;
  const { language } = clock;
  const text = (key: ExportLabel) => exportLabel(language, key);
  const heading = tr(language, "exports.history.title", { vehicle: vehicle.name });
  doc.setTitle(latin(heading));
  doc.setCreator(latin(appName));
  doc.setProducer(latin(appName));

  let page = doc.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - MARGIN;

  /** Trims the text with an ellipsis if it does not fit. */
  function fit(value: string, font: PDFFont, size: number, max: number): string {
    let out = latin(value);
    if (font.widthOfTextAtSize(out, size) <= max) return out;
    while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > max) out = out.slice(0, -1);
    return `${out.trimEnd()}…`;
  }
  function write(
    value: string,
    x: number,
    baseline: number,
    opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; max?: number; align?: "right" } = {},
  ) {
    const size = opts.size ?? 9;
    const font = opts.font ?? regular;
    const shown = opts.max ? fit(value, font, size, opts.max) : latin(value);
    const dx = opts.align === "right" ? (opts.max ?? 0) - font.widthOfTextAtSize(shown, size) : 0;
    page.drawText(shown, { x: x + dx, y: baseline, size, font, color: opts.color ?? INK });
  }
  /** Opens another page if what comes next does not fit. */
  function room(height: number): boolean {
    if (y - height >= MARGIN + 22) return false;
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - MARGIN;
    return true;
  }

  // ─── Header ────────────────────────────────────────────────────────────────
  write(appName.toUpperCase(), MARGIN, y - 8, { size: 8, font: bold, color: GREEN });
  y -= 34;
  write(heading, MARGIN, y, { size: 20, font: bold, max: WIDTH });
  y -= 17;
  const from = Date.parse(summary.from);
  const to = Date.parse(summary.to);
  const period = `${clock.human(from)} — ${clock.human(to)}`;
  write([vehicle.plate, period, tr(language, "exports.pdf.hoursIn", { zone: clock.zone, offset: clock.offset(from) })].filter(Boolean).join("  ·  "), MARGIN, y, {
    size: 9.5,
    color: MUTED,
    max: WIDTH,
  });
  y -= 22;

  // ─── Totals ────────────────────────────────────────────────────────────────
  const tiles: [string, string][] = [
    [text("distance"), km(summary.distanceM, 1, language)],
    [text("moving"), duration(summary.movingS)],
    [text("idling"), duration(summary.idleS)],
    [text("stopped"), duration(summary.stoppedS)],
    [text("maxSpeed"), `${summary.maxSpeedKmh} km/h`],
    [text("avgSpeed"), `${summary.avgSpeedKmh} km/h`],
    [text("trips"), String(summary.trips)],
    [text("stops"), String(summary.stops)],
  ];
  const gap = 8;
  const tileW = (WIDTH - gap * 3) / 4;
  const tileH = 42;
  tiles.forEach(([label, value], i) => {
    const x = MARGIN + (i % 4) * (tileW + gap);
    const top = y - Math.floor(i / 4) * (tileH + gap);
    page.drawRectangle({ x, y: top - tileH, width: tileW, height: tileH, color: PANEL });
    write(label.toUpperCase(), x + 10, top - 15, { size: 6.8, font: bold, color: MUTED, max: tileW - 20 });
    write(value, x + 10, top - 32, { size: 13, font: bold, max: tileW - 20 });
  });
  y -= tileH * 2 + gap + 22;

  // ─── Route drawing ─────────────────────────────────────────────────────────
  write(tr(language, "exports.pdf.route"), MARGIN, y, { size: 12, font: bold });
  y -= 10;
  const boxH = 230;
  const boxTop = y;
  page.drawRectangle({ x: MARGIN, y: boxTop - boxH, width: WIDTH, height: boxH, borderColor: LINE, borderWidth: 0.8 });
  if (samples.length === 0) {
    write(tr(language, "exports.pdf.noPositions"), MARGIN, boxTop - boxH / 2, { size: 10, color: MUTED, max: WIDTH });
  } else {
    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;
    for (const s of samples) {
      minLat = Math.min(minLat, s.lat);
      maxLat = Math.max(maxLat, s.lat);
      minLon = Math.min(minLon, s.lon);
      maxLon = Math.max(maxLon, s.lon);
    }
    // A degree of longitude is shorter the farther from the equator.
    const squeeze = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const spanX = Math.max((maxLon - minLon) * squeeze, 1e-5);
    const spanY = Math.max(maxLat - minLat, 1e-5);
    const inner = 18;
    const scale = Math.min((WIDTH - inner * 2) / spanX, (boxH - inner * 2) / spanY);
    const offX = (WIDTH - spanX * scale) / 2;
    const offY = (boxH - spanY * scale) / 2;
    // Coordinates inside the box, with the origin at the top left.
    const px = (lon: number) => offX + (lon - minLon) * squeeze * scale;
    const py = (lat: number) => offY + (maxLat - lat) * scale;

    const step = Math.max(1, Math.ceil(samples.length / 1500));
    let path = "";
    let lift = true;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] as (typeof samples)[number];
      const prev = samples[i - 1];
      // A gap with no reports is not joined with a straight line.
      if (prev && s.t - prev.t > MAX_GAP_S * 1000) lift = true;
      if (i % step !== 0 && i !== samples.length - 1) continue;
      path += `${lift ? "M" : "L"}${px(s.lon).toFixed(1)} ${py(s.lat).toFixed(1)} `;
      lift = false;
    }
    page.drawSvgPath(path.trim(), { x: MARGIN, y: boxTop, borderColor: INK, borderWidth: 1.5 });

    const at = (lat: number, lon: number) => ({ x: MARGIN + px(lon), y: boxTop - py(lat) });
    stops.forEach((stop, i) => {
      const p = at(stop.lat, stop.lon);
      page.drawCircle({ x: p.x, y: p.y, size: 5, color: WHITE, borderColor: INK, borderWidth: 1 });
      if (stops.length <= 40) {
        const label = String(i + 1);
        write(label, p.x - bold.widthOfTextAtSize(label, 5.5) / 2, p.y - 2, { size: 5.5, font: bold });
      }
    });
    const first = samples[0] as (typeof samples)[number];
    const last = samples[samples.length - 1] as (typeof samples)[number];
    const end = at(last.lat, last.lon);
    page.drawRectangle({ x: end.x - 4.5, y: end.y - 4.5, width: 9, height: 9, color: INK, borderColor: WHITE, borderWidth: 1.2 });
    const start = at(first.lat, first.lon);
    page.drawCircle({ x: start.x, y: start.y, size: 5, color: GREEN, borderColor: WHITE, borderWidth: 1.2 });
  }
  y = boxTop - boxH - 13;
  page.drawCircle({ x: MARGIN + 4, y: y + 3, size: 3.5, color: GREEN });
  write(text("start"), MARGIN + 12, y, { size: 8, color: MUTED });
  page.drawRectangle({ x: MARGIN + 46, y: y - 0.5, width: 7, height: 7, color: INK });
  write(text("end"), MARGIN + 58, y, { size: 8, color: MUTED });
  page.drawCircle({ x: MARGIN + 84, y: y + 3, size: 3.5, color: WHITE, borderColor: INK, borderWidth: 0.9 });
  write(text("stop"), MARGIN + 92, y, { size: 8, color: MUTED });
  y -= 26;

  // ─── Tables ────────────────────────────────────────────────────────────────
  function table(title: string, columns: Column[], rows: Row[], empty: string) {
    const head = () => {
      page.drawRectangle({ x: MARGIN, y: y - 16, width: WIDTH, height: 16, color: PANEL });
      let x = MARGIN;
      for (const col of columns) {
        write(col.title.toUpperCase(), x + 5, y - 11, { size: 6.8, font: bold, color: MUTED, max: col.width - 10, ...(col.align ? { align: col.align } : {}) });
        x += col.width;
      }
      y -= 16;
    };
    room(70);
    write(title, MARGIN, y, { size: 12, font: bold });
    y -= 10;
    if (rows.length === 0) {
      y -= 8;
      write(empty, MARGIN, y, { size: 9.5, color: MUTED });
      y -= 24;
      return;
    }
    head();
    for (const row of rows) {
      const height = row.sub ? 27 : 16;
      if (room(height)) head();
      let x = MARGIN;
      row.cells.forEach((cell, i) => {
        const col = columns[i] as Column;
        write(cell, x + 5, y - 11, { size: 9, max: col.width - 10, ...(col.align ? { align: col.align } : {}) });
        x += col.width;
      });
      if (row.sub) write(row.sub, MARGIN + (columns[0] as Column).width + 5, y - 22, { size: 7.8, color: MUTED, max: WIDTH - (columns[0] as Column).width - 10 });
      y -= height;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + WIDTH, y }, thickness: 0.5, color: LINE });
    }
    y -= 24;
  }

  const place = (address: string | null, lat: number, lon: number) => address ?? coords(lat, lon);
  table(
    text("trips"),
    [
      { title: text("number"), width: 30 },
      { title: text("start"), width: 112 },
      { title: text("end"), width: 112 },
      { title: text("duration"), width: 70, align: "right" },
      { title: text("distance"), width: 66, align: "right" },
      { title: text("maxSpeedShort"), width: 62, align: "right" },
      { title: text("idle"), width: WIDTH - 452, align: "right" },
    ],
    trips.map((t, i) => ({
      cells: [
        String(i + 1),
        clock.human(Date.parse(t.start)),
        clock.human(Date.parse(t.end)),
        duration(t.durationS),
        km(t.distanceM, 1, language),
        `${t.maxSpeedKmh} km/h`,
        t.idleS > 0 ? duration(t.idleS) : "—",
      ],
      sub: tr(language, "exports.pdf.tripPlaces", { from: place(t.startAddress, t.startLat, t.startLon), to: place(t.endAddress, t.endLat, t.endLon) }),
    })),
    tr(language, "exports.pdf.noTrips"),
  );
  table(
    text("stops"),
    [
      { title: text("number"), width: 30 },
      { title: text("start"), width: 112 },
      { title: text("end"), width: 112 },
      { title: text("duration"), width: 70, align: "right" },
      { title: text("engineOn"), width: WIDTH - 324, align: "right" },
    ],
    stops.map((s, i) => ({
      cells: [String(i + 1), clock.human(Date.parse(s.start)), clock.human(Date.parse(s.end)), duration(s.durationS), s.idleS > 0 ? duration(s.idleS) : "—"],
      sub: tr(language, "exports.pdf.stopPlace", { place: place(s.address, s.lat, s.lon) }),
    })),
    tr(language, "exports.pdf.noStops"),
  );

  // ─── Footer ────────────────────────────────────────────────────────────────
  const pages = doc.getPages();
  const stamp = tr(language, "exports.pdf.generated", { date: clock.human(Date.now()), app: appName });
  pages.forEach((p, i) => {
    page = p;
    write(stamp, MARGIN, 24, { size: 7.5, color: MUTED, max: WIDTH - 90 });
    write(tr(language, "exports.pdf.page", { page: i + 1, pages: pages.length }), MARGIN + WIDTH - 90, 24, { size: 7.5, color: MUTED, max: 90, align: "right" });
  });

  return Buffer.from(await doc.save());
}
