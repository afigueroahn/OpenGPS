import { mkdirSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import type { Vehicle } from "@opengps/shared";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { exportHistory } from "../src/core/export";
import { createClock, duration, km, slug } from "../src/core/export/format";
import { type HistoryData, type HistorySample, mapPoints } from "../src/core/history";
import { analyze } from "../src/core/trips";

/** Delivery morning in Tegucigalpa: two trips with a stop in between. */
function sample(): HistoryData {
  const samples: HistorySample[] = [];
  let t = Date.UTC(2026, 10, 21, 14, 0, 0); // 08:00 in Honduras
  let lat = 14.0818;
  let lon = -87.2068;
  const add = (speedKmh: number, ignition: boolean) => samples.push({ t, lat, lon, speedKmh, course: 45, altitude: 990, ignition, odometer: null });
  add(0, false);
  const leg = (minutes: number, kmh: number, ignition: boolean, heading: [number, number]) => {
    for (let s = 0; s < minutes * 60; s += 10) {
      t += 10_000;
      const meters = (kmh / 3.6) * 10;
      lat += (meters * heading[0]) / 111_320;
      lon += (meters * heading[1]) / 108_000;
      add(kmh, ignition);
    }
  };
  leg(12, 42, true, [0.8, 0.6]);
  leg(4, 0, true, [0, 0]);
  leg(9, 0, false, [0, 0]);
  leg(8, 55, true, [-0.3, 0.95]);
  const { trips, stops, summary } = analyze(samples);
  (trips[0] as (typeof trips)[number]).startAddress = "Bulevar Morazán, Colonia Palmira, Tegucigalpa";
  (stops[0] as (typeof stops)[number]).address = "Calle <La Fuente> & Cía., Comayagüela";
  const vehicle = { id: "v1", name: "Camión Ñandú 3", plate: "HAA-1234", groupId: null, createdAt: "", device: null, state: null } as unknown as Vehicle;
  const from = new Date(Date.UTC(2026, 10, 21, 6, 0, 0)).toISOString();
  const to = new Date(Date.UTC(2026, 10, 22, 6, 0, 0)).toISOString();
  return { vehicle, summary: { from, to, ...summary }, trips, stops, samples };
}

/** Reads the files of a ZIP, to look inside the Excel file. */
function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extra;
    files.set(buffer.toString("utf8", offset + 30, offset + 30 + nameLength), inflateRawSync(buffer.subarray(start, start + size)).toString("utf8"));
    offset = start + size;
  }
  return files;
}

const opts = { zone: "America/Tegucigalpa", appName: "OpenGPS", language: "es" as const };
const keep = process.env.EXPORT_SAMPLES_DIR;
const save = (name: string, body: Buffer) => {
  if (!keep) return;
  mkdirSync(keep, { recursive: true });
  writeFileSync(`${keep}/${name}`, body);
};

describe("export texts", () => {
  it("converts times to the time zone of whoever exports", () => {
    const clock = createClock("America/Tegucigalpa", "es");
    const t = Date.UTC(2026, 10, 21, 14, 5, 9);
    expect(clock.dateTime(t)).toBe("2026-11-21 08:05:09");
    expect(clock.human(t)).toBe("21 nov 2026, 08:05");
    expect(clock.offset(t)).toBe("UTC-06:00");
    // A zone with a time change: summer and winter in Madrid.
    const madrid = createClock("Europe/Madrid", "es");
    expect(madrid.hour(Date.UTC(2026, 6, 1, 10, 0))).toBe("12:00");
    expect(madrid.hour(Date.UTC(2026, 11, 1, 10, 0))).toBe("11:00");
    // 2026-11-21 00:00 local is day 46347 of a spreadsheet.
    expect(clock.serial(Date.UTC(2026, 10, 21, 6, 0, 0))).toBe(46_347);
    expect(() => createClock("Marte/Olimpo", "es")).toThrow("Zona horaria no válida");
  });

  it("writes durations, distances and file names", () => {
    expect(duration(45)).toBe("45 s");
    expect(duration(12 * 60)).toBe("12 min");
    expect(duration(2 * 3600 + 5 * 60)).toBe("2 h 05 min");
    expect(duration(137 * 3600 + 33 * 60)).toBe("5 d 18 h");
    expect(km(12_345, 1, "es")).toBe("12,3 km");
    expect(slug("Camión Ñandú 3", "es")).toBe("camion-nandu-3");
    expect(slug("🚚", "es")).toBe("vehiculo");
  });
});

describe("track export", () => {
  const data = sample();

  it("the sample track has two trips and one stop", () => {
    expect(data.trips).toHaveLength(2);
    expect(data.stops).toHaveLength(1);
    expect(data.stops[0]?.idleS).toBeGreaterThan(200);
  });

  it("CSV: one row per position, with the local time", async () => {
    const file = await exportHistory("csv", data, opts);
    save(file.filename, file.body);
    expect(file.filename).toBe("recorrido-camion-nandu-3-2026-11-21.csv");
    // Starts with the mark Excel needs to read accents.
    expect([...file.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = file.body.subarray(3).toString("utf8").trimEnd().split("\r\n");
    expect(lines[0]).toBe("Fecha,Hora,Latitud,Longitud,Velocidad (km/h),Rumbo (grados),Altitud (m),Motor");
    expect(lines).toHaveLength(data.samples.length + 1);
    expect(lines[1]).toBe("2026-11-21,08:00:00,14.081800,-87.206800,0.0,45,990,Apagado");
    expect(lines[2]).toContain("08:00:10");
    expect(lines[2]).toContain(",42.0,45,990,Encendido");
  });

  it("GPX: one track per trip and the stops as points", async () => {
    const file = await exportHistory("gpx", data, opts);
    save(file.filename, file.body);
    const text = file.body.toString("utf8");
    expect(text.match(/<trk>/g)).toHaveLength(2);
    expect(text.match(/<wpt /g)).toHaveLength(1);
    expect(text).toContain("<name>Recorrido de Camión Ñandú 3</name>");
    expect(text).toContain("Calle &lt;La Fuente&gt; &amp; Cía., Comayagüela");
    expect(text).toContain('<trkpt lat="14.081800" lon="-87.206800"><ele>990.0</ele><time>2026-11-21T14:00:00.000Z</time></trkpt>');
  });

  it("KML: lines for the trips and marks for the stops", async () => {
    const file = await exportHistory("kml", data, opts);
    save(file.filename, file.body);
    const text = file.body.toString("utf8");
    expect(text.match(/<LineString>/g)).toHaveLength(2);
    expect(text.match(/<Point>/g)).toHaveLength(1);
    expect(text).toContain("-87.206800,14.081800,0");
    expect(text).toContain("<name>Viaje 2</name>");
  });

  it("Excel: four sheets with totals, trips, stops and positions", async () => {
    const file = await exportHistory("xlsx", data, opts);
    save(file.filename, file.body);
    const files = unzip(file.body);
    expect([...files.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
      "xl/worksheets/sheet3.xml",
      "xl/worksheets/sheet4.xml",
    ]);
    expect(files.get("xl/workbook.xml")).toContain('<sheet name="Resumen" sheetId="1" r:id="rId1"/>');
    expect(files.get("xl/worksheets/sheet1.xml")).toContain("Camión Ñandú 3");
    const trips = files.get("xl/worksheets/sheet2.xml") as string;
    expect(trips.match(/<row /g)).toHaveLength(3);
    expect(trips).toContain("Bulevar Morazán, Colonia Palmira, Tegucigalpa");
    expect(files.get("xl/worksheets/sheet3.xml")).toContain("Calle &lt;La Fuente&gt; &amp; Cía., Comayagüela");
    const positions = files.get("xl/worksheets/sheet4.xml") as string;
    expect(positions.match(/<row /g)).toHaveLength(data.samples.length + 1);
    // 08:00:00 on 21 November, local time.
    const firstTime = Number(positions.match(/<c r="A2" s="2"><v>([0-9.]+)</)?.[1]);
    expect(firstTime).toBeCloseTo(46_347 + 8 / 24, 8);
  });

  it("PDF: is generated even if the name has symbols outside the Latin alphabet", async () => {
    const odd = { ...data, vehicle: { ...data.vehicle, name: "Camión Ñandú 3 🚚 東京" } };
    const file = await exportHistory("pdf", odd, opts);
    save(file.filename, file.body);
    expect(file.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(file.body.length).toBeGreaterThan(3000);
    expect(file.filename).toBe("recorrido-camion-nandu-3-2026-11-21.pdf");
  });

  it("PDF: a week with many trips spills onto several pages", async () => {
    const week: HistoryData = { ...data, trips: [], stops: [], samples: [] };
    for (let day = 0; day < 7; day++) {
      for (const sampleOfDay of data.samples) week.samples.push({ ...sampleOfDay, t: sampleOfDay.t + day * 86_400_000, lat: sampleOfDay.lat + day * 0.01 });
    }
    // Each day, the same pair of trips and their stop three times.
    for (let day = 0; day < 7; day++) {
      for (let n = 0; n < 3; n++) {
        const shift = (iso: string) => new Date(Date.parse(iso) + day * 86_400_000 + n * 3_600_000).toISOString();
        for (const trip of data.trips) week.trips.push({ ...trip, start: shift(trip.start), end: shift(trip.end) });
        for (const stop of data.stops) week.stops.push({ ...stop, start: shift(stop.start), end: shift(stop.end) });
      }
    }
    week.summary = { ...data.summary, trips: week.trips.length, stops: week.stops.length, stoppedS: 137 * 3600 };
    const file = await exportHistory("pdf", week, opts);
    save("semana.pdf", file.body);
    expect((await PDFDocument.load(file.body)).getPageCount()).toBeGreaterThanOrEqual(3);
  });

  it("a period without positions can also be exported", async () => {
    const empty: HistoryData = { ...data, trips: [], stops: [], samples: [], summary: { ...data.summary, ...analyze([]).summary } };
    for (const format of ["csv", "gpx", "kml", "xlsx", "pdf"] as const) {
      const file = await exportHistory(format, empty, opts);
      expect(file.body.length).toBeGreaterThan(20);
    }
  });

  it("the track for the map drops the repeated points of a stop", () => {
    const points = mapPoints(data.samples);
    expect(points.length).toBeLessThan(data.samples.length - 60);
    expect(points[0]?.t).toBe(Math.round((data.samples[0] as HistorySample).t / 1000));
    expect(points.at(-1)?.t).toBe(Math.round((data.samples.at(-1) as HistorySample).t / 1000));
    expect(mapPoints(data.samples, 50)).toHaveLength(50);
  });
});
