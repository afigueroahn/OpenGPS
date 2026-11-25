// Minimal writer of Excel workbooks (.xlsx): several sheets, frozen header,
// dates, durations and formatted numbers. No dependencies: an .xlsx is a
// ZIP with a few XML files inside.
import { crc32, deflateRawSync } from "node:zlib";
import { xml } from "./format";

/** Available cell styles; the number is its position in styles.xml. */
export const STYLE = {
  text: 0,
  header: 1,
  dateTime: 2,
  decimal1: 3,
  integer: 4,
  duration: 5,
  bold: 6,
  coordinate: 7,
  decimal2: 8,
  date: 9,
} as const;

export type Cell = string | number | null | { v: string | number; s: number };

export interface Sheet {
  name: string;
  /** Width of each column, in characters. */
  widths: number[];
  /** The first row is the header unless `header` is false. */
  rows: Cell[][];
  header?: boolean;
  /** Style of each column in the data rows; this way cells go as plain values. */
  styles?: number[];
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="165" formatCode="[h]:mm:ss"/><numFmt numFmtId="166" formatCode="0.000000"/><numFmt numFmtId="167" formatCode="0.0"/><numFmt numFmtId="168" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E6EE"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function cellXml(cell: Cell, ref: string, fallbackStyle: number): string {
  if (cell === null || cell === "") return "";
  const value = typeof cell === "object" ? cell.v : cell;
  const style = typeof cell === "object" ? cell.s : fallbackStyle;
  const s = style ? ` s="${style}"` : "";
  if (typeof value === "number") return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function sheetXml(sheet: Sheet): Buffer {
  const withHeader = sheet.header !== false;
  const chunks: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}>`,
    withHeader ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "",
    `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`,
    "<sheetData>",
  ];
  sheet.rows.forEach((row, r) => {
    const isHeader = withHeader && r === 0;
    let cells = "";
    for (let c = 0; c < row.length; c++) {
      cells += cellXml(row[c] as Cell, `${columnName(c)}${r + 1}`, isHeader ? STYLE.header : (sheet.styles?.[c] ?? STYLE.text));
    }
    chunks.push(`<row r="${r + 1}">${cells}</row>`);
  });
  chunks.push("</sheetData></worksheet>");
  return Buffer.from(chunks.join(""), "utf8");
}

/** Valid sheet name: without the symbols Excel forbids and at most 31 characters. */
const sheetName = (name: string) => name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31);

// ─── ZIP ─────────────────────────────────────────────────────────────────────

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const now = new Date();
  const dosTime = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
  const dosDate = ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const packed = deflateRawSync(file.data, { level: 6 });
    const sum = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const rels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const main = "application/vnd.openxmlformats-officedocument.spreadsheetml";
  const files: { name: string; data: Buffer }[] = [
    {
      name: "[Content_Types].xml",
      data: `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${main}.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${main}.styles+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${main}.worksheet+xml"/>`)
        .join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rels}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `${head}<workbook ${NS} xmlns:r="${rels}"><sheets>${sheets
        .map((s, i) => `<sheet name="${xml(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rels}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("")}<Relationship Id="rId${sheets.length + 1}" Type="${rels}/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
  ].map((f): { name: string; data: Buffer } => ({ name: f.name, data: Buffer.from(f.data, "utf8") }));
  sheets.forEach((sheet, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) }));
  return zip(files);
}
