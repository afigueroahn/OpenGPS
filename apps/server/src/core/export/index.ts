// Exporting a trip to a file: Excel, PDF, CSV, GPX and KML.
import type { ExportFormat, Language, Stop, Trip } from "@opengps/shared";
import { tr } from "../../i18n";
import type { HistoryData, HistorySample } from "../history";
import { type Clock, type ExportLabel, coords, createClock, duration, exportLabel, km, slug, xml } from "./format";
import { buildPdf } from "./pdf";
import { STYLE, type Sheet, buildXlsx } from "./xlsx";

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

const TYPES: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
  gpx: "application/gpx+xml",
  kml: "application/vnd.google-earth.kml+xml",
};

const engine = (ignition: boolean | null, language: Language) => (ignition === null ? "" : tr(language, ignition ? "exports.engine.on" : "exports.engine.off"));
const iso = (ms: number) => new Date(ms).toISOString();

/** Positions between two times, both included. The positions come sorted. */
function between(samples: HistorySample[], startMs: number, endMs: number): HistorySample[] {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid] as HistorySample).t < startMs) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < samples.length && (samples[end] as HistorySample).t <= endMs) end++;
  return samples.slice(lo, end);
}

/** Segments drawn as lines: each trip, or everything if the period has no trips. */
function tracks(data: HistoryData, clock: Clock): { name: string; desc: string; start: string; end: string; points: HistorySample[] }[] {
  if (data.trips.length === 0) {
    const first = data.samples[0];
    const last = data.samples[data.samples.length - 1];
    if (!first || !last || data.samples.length < 2) return [];
    return [
      {
        name: exportLabel(clock.language, "positions"),
        desc: tr(clock.language, "exports.history.positionCount", { count: data.samples.length }),
        start: iso(first.t),
        end: iso(last.t),
        points: data.samples,
      },
    ];
  }
  return data.trips.map((trip, i) => ({
    name: tr(clock.language, "exports.history.trip", { n: i + 1 }),
    desc: tripLine(trip, clock),
    start: trip.start,
    end: trip.end,
    points: between(data.samples, Date.parse(trip.start), Date.parse(trip.end)),
  }));
}

const tripLine = (t: Trip, clock: Clock) =>
  tr(clock.language, "exports.history.tripLine", {
    start: clock.human(Date.parse(t.start)),
    end: clock.hour(Date.parse(t.end)),
    distance: km(t.distanceM, 1, clock.language),
    duration: duration(t.durationS),
    maxSpeed: t.maxSpeedKmh,
  });
const stopLine = (s: Stop, clock: Clock) =>
  tr(clock.language, "exports.history.stopLine", { start: clock.human(Date.parse(s.start)), end: clock.hour(Date.parse(s.end)), place: s.address ?? coords(s.lat, s.lon) });
/** The file's title, with the vehicle's name, in the clock's language. */
const titleOf = (data: HistoryData, clock: Clock) => tr(clock.language, "exports.history.title", { vehicle: data.vehicle.name });
/** A stop's name, with its number and duration, in the clock's language. */
const stopName = (stop: Stop, i: number, clock: Clock) => tr(clock.language, "exports.history.stop", { n: i + 1, duration: duration(stop.durationS) });

// ─── CSV ─────────────────────────────────────────────────────────────────────

function csv(data: HistoryData, clock: Clock): Buffer {
  const header = (["date", "time", "latitude", "longitude", "speedKmh", "courseDeg", "altitudeM", "engine"] as const).map((key) => exportLabel(clock.language, key));
  const lines = [header.join(",")];
  for (const s of data.samples) {
    lines.push(
      [
        clock.date(s.t),
        clock.time(s.t),
        s.lat.toFixed(6),
        s.lon.toFixed(6),
        s.speedKmh.toFixed(1),
        s.course === null ? "" : Math.round(s.course),
        s.altitude === null ? "" : Math.round(s.altitude),
        engine(s.ignition, clock.language),
      ].join(","),
    );
  }
  // The leading mark makes Excel read the accents correctly.
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

// ─── GPX ─────────────────────────────────────────────────────────────────────

function gpx(data: HistoryData, clock: Clock, appName: string): Buffer {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xml(appName)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<metadata><name>${xml(titleOf(data, clock))}</name><time>${data.summary.from}</time></metadata>`,
  ];
  data.stops.forEach((stop, i) => {
    out.push(
      `<wpt lat="${stop.lat.toFixed(6)}" lon="${stop.lon.toFixed(6)}"><time>${stop.start}</time><name>${xml(stopName(stop, i, clock))}</name><desc>${xml(stopLine(stop, clock))}</desc></wpt>`,
    );
  });
  for (const track of tracks(data, clock)) {
    out.push(`<trk><name>${xml(track.name)}</name><desc>${xml(track.desc)}</desc><trkseg>`);
    for (const p of track.points) {
      out.push(
        `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${p.altitude === null ? "" : `<ele>${p.altitude.toFixed(1)}</ele>`}<time>${iso(p.t)}</time></trkpt>`,
      );
    }
    out.push("</trkseg></trk>");
  }
  out.push("</gpx>");
  return Buffer.from(out.join("\n"), "utf8");
}

// ─── KML ─────────────────────────────────────────────────────────────────────

function kml(data: HistoryData, clock: Clock): Buffer {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
    `<name>${xml(titleOf(data, clock))}</name>`,
    // Colors go as opacity, blue, green and red.
    '<Style id="ruta"><LineStyle><color>ff65a012</color><width>4</width></LineStyle></Style>',
    `<Folder><name>${xml(exportLabel(clock.language, "trips"))}</name>`,
  ];
  for (const track of tracks(data, clock)) {
    out.push(
      `<Placemark><name>${xml(track.name)}</name><description>${xml(track.desc)}</description><TimeSpan><begin>${track.start}</begin><end>${track.end}</end></TimeSpan><styleUrl>#ruta</styleUrl><LineString><tessellate>1</tessellate><coordinates>${track.points
        .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)},0`)
        .join(" ")}</coordinates></LineString></Placemark>`,
    );
  }
  out.push(`</Folder><Folder><name>${xml(exportLabel(clock.language, "stops"))}</name>`);
  data.stops.forEach((stop, i) => {
    out.push(
      `<Placemark><name>${xml(stopName(stop, i, clock))}</name><description>${xml(stopLine(stop, clock))}</description><TimeSpan><begin>${stop.start}</begin><end>${stop.end}</end></TimeSpan><Point><coordinates>${stop.lon.toFixed(6)},${stop.lat.toFixed(6)},0</coordinates></Point></Placemark>`,
    );
  });
  out.push("</Folder></Document></kml>");
  return Buffer.from(out.join("\n"), "utf8");
}

// ─── Excel ───────────────────────────────────────────────────────────────────

function xlsx(data: HistoryData, clock: Clock): Buffer {
  const { vehicle, summary, trips, stops, samples } = data;
  const day = (seconds: number) => ({ v: seconds / 86_400, s: STYLE.duration });
  const text = (key: ExportLabel) => exportLabel(clock.language, key);
  const label = (key: ExportLabel) => ({ v: text(key), s: STYLE.bold });
  const when = (isoTime: string) => clock.serial(Date.parse(isoTime));

  const resumen: Sheet = {
    name: text("summary"),
    header: false,
    widths: [26, 34],
    rows: [
      [label("vehicle"), vehicle.name],
      [label("plate"), vehicle.plate ?? ""],
      [label("from"), { v: when(summary.from), s: STYLE.dateTime }],
      [label("to"), { v: when(summary.to), s: STYLE.dateTime }],
      [label("zone"), `${clock.zone} (${clock.offset(Date.parse(summary.from))})`],
      [],
      [label("distanceKm"), { v: summary.distanceM / 1000, s: STYLE.decimal2 }],
      [label("moving"), day(summary.movingS)],
      [label("idling"), day(summary.idleS)],
      [label("stopped"), day(summary.stoppedS)],
      [label("maxSpeedKmh"), { v: summary.maxSpeedKmh, s: STYLE.integer }],
      [label("avgSpeedKmh"), { v: summary.avgSpeedKmh, s: STYLE.integer }],
      [label("trips"), { v: summary.trips, s: STYLE.integer }],
      [label("stops"), { v: summary.stops, s: STYLE.integer }],
      [label("positions"), { v: summary.positions, s: STYLE.integer }],
    ],
  };
  const viajes: Sheet = {
    name: text("trips"),
    widths: [6, 20, 20, 11, 14, 16, 18, 11, 38, 38, 12, 12, 12, 12],
    styles: [
      STYLE.integer,
      STYLE.dateTime,
      STYLE.dateTime,
      STYLE.duration,
      STYLE.decimal2,
      STYLE.integer,
      STYLE.integer,
      STYLE.duration,
      STYLE.text,
      STYLE.text,
      STYLE.coordinate,
      STYLE.coordinate,
      STYLE.coordinate,
      STYLE.coordinate,
    ],
    rows: [
      [
        text("number"),
        text("start"),
        text("end"),
        text("duration"),
        text("distanceKm"),
        text("maxSpeedShortKmh"),
        text("avgSpeedShortKmh"),
        text("idle"),
        text("origin"),
        text("destination"),
        text("originLat"),
        text("originLon"),
        text("destinationLat"),
        text("destinationLon"),
      ],
      ...trips.map((t, i) => [
        i + 1,
        when(t.start),
        when(t.end),
        t.durationS / 86_400,
        t.distanceM / 1000,
        t.maxSpeedKmh,
        t.avgSpeedKmh,
        t.idleS / 86_400,
        t.startAddress ?? "",
        t.endAddress ?? "",
        t.startLat,
        t.startLon,
        t.endLat,
        t.endLon,
      ]),
    ],
  };
  const paradas: Sheet = {
    name: text("stops"),
    widths: [6, 20, 20, 11, 11, 42, 12, 12],
    styles: [STYLE.integer, STYLE.dateTime, STYLE.dateTime, STYLE.duration, STYLE.duration, STYLE.text, STYLE.coordinate, STYLE.coordinate],
    rows: [
      [text("number"), text("start"), text("end"), text("duration"), text("idle"), text("place"), text("latitude"), text("longitude")],
      ...stops.map((s, i) => [i + 1, when(s.start), when(s.end), s.durationS / 86_400, s.idleS / 86_400, s.address ?? "", s.lat, s.lon]),
    ],
  };
  const posiciones: Sheet = {
    name: text("positions"),
    widths: [20, 12, 12, 17, 14, 11, 12],
    styles: [STYLE.dateTime, STYLE.coordinate, STYLE.coordinate, STYLE.decimal1, STYLE.integer, STYLE.integer, STYLE.text],
    rows: [
      [text("dateTime"), text("latitude"), text("longitude"), text("speedKmh"), text("courseDeg"), text("altitudeM"), text("engine")],
      ...samples.map((s) => [clock.serial(s.t), s.lat, s.lon, s.speedKmh, s.course, s.altitude, engine(s.ignition, clock.language)]),
    ],
  };
  return buildXlsx([resumen, viajes, paradas, posiciones]);
}

// ─── Input ───────────────────────────────────────────────────────────────────

/** The file is written in `language`, the language of whoever exports it. */
export async function exportHistory(format: ExportFormat, data: HistoryData, opts: { zone: string; appName: string; language: Language }): Promise<ExportFile> {
  const clock = createClock(opts.zone, opts.language);
  const first = clock.date(Date.parse(data.summary.from));
  // The end of the period is not included: the last day is that of the previous instant.
  const last = clock.date(Date.parse(data.summary.to) - 1);
  const filename = `${tr(clock.language, "exports.files.history")}-${slug(data.vehicle.name, clock.language)}-${first}${last === first ? "" : `_${last}`}.${format}`;
  const body =
    format === "xlsx"
      ? xlsx(data, clock)
      : format === "pdf"
        ? await buildPdf(data, clock, opts.appName)
        : format === "csv"
          ? csv(data, clock)
          : format === "gpx"
            ? gpx(data, clock, opts.appName)
            : kml(data, clock);
  return { filename, contentType: TYPES[format], body };
}
