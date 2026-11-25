// Catalog of compatible devices. Each entry is a family that shares
// protocol and port, with the models known to belong to it. The backend copies
// the families to the gps.device_models table at startup, so changing it here
// is enough.
//
// Texts accept {host}, {ip} and {port}; the web app replaces them with the
// server's. The commands are the usual ones for each family: some models
// use variants, which is why each guide refers to the manual.
import { type DeviceModel, LANGUAGES, type Language } from "@opengps/shared";
import type { Queryable } from "../db";
import { tr } from "../i18n";
import { KNOWN_MODELS } from "./catalog-models";

type Family = Omit<DeviceModel, "models" | "verified">;

/** The families with their names and guides in a language. */
function families(language: Language): Family[] {
  const sim = { title: tr(language, "core.catalog.steps.simTitle"), text: tr(language, "core.catalog.steps.simText") };
  const wait = { title: tr(language, "core.catalog.steps.powerTitle"), text: tr(language, "core.catalog.steps.powerText") };
  const apnTitle = tr(language, "core.catalog.steps.apnTitle");
  const serverTitle = tr(language, "core.catalog.steps.serverTitle");
  const idTitle = tr(language, "core.catalog.steps.idTitle");
  const sendSms = tr(language, "core.catalog.steps.sendSms");
  const sendSmsCode123456 = tr(language, "core.catalog.steps.sendSmsCode123456");
  // What the person replaces in the commands with their own.
  const apn = tr(language, "core.catalog.placeholders.apn");
  const user = tr(language, "core.catalog.placeholders.user");
  const password = tr(language, "core.catalog.placeholders.password");
  return [
    {
      id: "teltonika",
      brand: "Teltonika",
      name: tr(language, "core.catalog.teltonika.name"),
      examples: "FMC920, FMC130, FMC150, FMC003, FMC650, FMB920",
      protocol: "teltonika",
      port: 5027,
      idLabel: "IMEI",
      setup: [
        sim,
        { title: apnTitle, text: tr(language, "core.catalog.teltonika.apn"), command: `  setparam 2001:${apn};2002:${user};2003:${password}` },
        { title: serverTitle, text: tr(language, "core.catalog.teltonika.server"), command: "  setparam 2004:{host};2005:{port};2006:0" },
        wait,
      ],
    },
    {
      id: "gt06",
      brand: "Concox / Jimi",
      name: tr(language, "core.catalog.gt06.name"),
      examples: "GT06N, VL103M, VL802, WeTrack2",
      protocol: "gt06",
      port: 5023,
      idLabel: "IMEI",
      setup: [
        sim,
        { title: apnTitle, text: tr(language, "core.catalog.steps.sendSmsToSim"), command: `APN,${apn}#` },
        { title: serverTitle, text: tr(language, "core.catalog.gt06.server"), command: "SERVER,1,{host},{port},0#" },
        wait,
      ],
    },
    {
      id: "h02",
      brand: "SinoTrack / MiCODUS",
      name: tr(language, "core.catalog.h02.name"),
      examples: "ST-901, ST-906, MV720",
      protocol: "h02",
      port: 5013,
      idLabel: "ID",
      setup: [
        sim,
        { title: apnTitle, text: tr(language, "core.catalog.h02.apn"), command: `8030000 ${apn}` },
        { title: serverTitle, text: tr(language, "core.catalog.h02.server"), command: "8040000 {ip} {port}" },
        { title: idTitle, text: tr(language, "core.catalog.h02.id") },
        wait,
      ],
    },
    {
      id: "gps103",
      brand: "Coban",
      name: tr(language, "core.catalog.gps103.name"),
      examples: "TK103A, TK103B, GPS303F, GPS303G",
      protocol: "gps103",
      port: 5001,
      idLabel: "IMEI",
      setup: [
        sim,
        { title: apnTitle, text: sendSmsCode123456, command: `apn123456 ${apn}` },
        { title: serverTitle, text: sendSms, command: "adminip123456 {ip} {port}" },
        { title: tr(language, "core.catalog.steps.dataTitle"), text: sendSms, command: "gprs123456" },
        wait,
      ],
    },
    {
      id: "tk103",
      brand: tr(language, "core.catalog.tk103.brand"),
      name: tr(language, "core.catalog.tk103.name"),
      examples: tr(language, "core.catalog.tk103.examples"),
      protocol: "tk103",
      port: 5002,
      idLabel: "ID",
      setup: [
        sim,
        { title: apnTitle, text: sendSmsCode123456, command: `apn123456 ${apn}` },
        { title: serverTitle, text: tr(language, "core.catalog.tk103.server"), command: "adminip123456 {ip} {port}" },
        wait,
      ],
    },
    {
      id: "jt808",
      brand: "JT808",
      name: tr(language, "core.catalog.jt808.name"),
      examples: tr(language, "core.catalog.jt808.examples"),
      protocol: "jt808",
      port: 5015,
      idLabel: tr(language, "core.catalog.jt808.idLabel"),
      setup: [
        sim,
        { title: serverTitle, text: tr(language, "core.catalog.jt808.server"), command: "SERVER,1,{host},{port},0#" },
        { title: idTitle, text: tr(language, "core.catalog.jt808.id") },
        wait,
      ],
    },
    {
      id: "gl200",
      brand: "Queclink",
      name: tr(language, "core.catalog.gl200.name"),
      examples: "GV58LAU, GV310LAU, GL300",
      protocol: "gl200",
      port: 5004,
      idLabel: "IMEI",
      setup: [sim, { title: serverTitle, text: tr(language, "core.catalog.gl200.server") }, wait],
    },
    {
      id: "suntech",
      brand: "Suntech",
      name: tr(language, "core.catalog.suntech.name"),
      examples: "ST8310U, ST4315U, ST310U",
      protocol: "suntech",
      port: 5011,
      idLabel: "ID",
      setup: [sim, { title: serverTitle, text: tr(language, "core.catalog.suntech.server") }, { title: idTitle, text: tr(language, "core.catalog.suntech.id") }, wait],
    },
    {
      id: "ruptela",
      brand: "Ruptela",
      name: tr(language, "core.catalog.ruptela.name"),
      examples: "Eco5, Eco5 Lite, Pro5",
      protocol: "ruptela",
      port: 5046,
      idLabel: "IMEI",
      setup: [sim, { title: serverTitle, text: tr(language, "core.catalog.ruptela.server") }, wait],
    },
  ];
}

const build = (language: Language): DeviceModel[] => families(language).map((family) => ({ ...family, models: KNOWN_MODELS[family.protocol] ?? [] }));
const BY_LANGUAGE = Object.fromEntries(LANGUAGES.map((language) => [language, build(language)])) as Record<Language, DeviceModel[]>;

/** The catalog as a person reads it when adding a GPS device: names and guides in their language. */
export const deviceCatalog = (language: Language): DeviceModel[] => BY_LANGUAGE[language];

/**
 * The catalog in the reference language, for what treats it as data: the copy in the
 * database, the ids and the models of each family.
 */
export const CATALOG: DeviceModel[] = BY_LANGUAGE.es;

/** Copies the catalog to the database and deactivates what is no longer in it. Its texts go in the reference language: nothing reads them from there. */
export async function syncCatalog(db: Queryable): Promise<void> {
  for (const [index, m] of CATALOG.entries()) {
    await db.query(
      `INSERT INTO gps.device_models (id, brand, name, examples, protocol, port, id_label, setup, sort_order, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, true)
       ON CONFLICT (id) DO UPDATE SET
         brand = EXCLUDED.brand, name = EXCLUDED.name, examples = EXCLUDED.examples,
         protocol = EXCLUDED.protocol, port = EXCLUDED.port, id_label = EXCLUDED.id_label,
         setup = EXCLUDED.setup, sort_order = EXCLUDED.sort_order, enabled = true`,
      [m.id, m.brand, m.name, m.examples, m.protocol, m.port, m.idLabel, JSON.stringify(m.setup), index],
    );
  }
  await db.query(`UPDATE gps.device_models SET enabled = false WHERE id <> ALL($1::text[])`, [CATALOG.map((m) => m.id)]);
}

export function findModel(id: string): DeviceModel | undefined {
  return CATALOG.find((m) => m.id === id);
}
