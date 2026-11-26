// Adding a GPS: finding its model in the catalog, checking its identifier and
// filling in the setup instructions with this platform's address. Same rules
// as the web app's (apps/web/src/app/AddGpsWizard.tsx).
import type { DeviceModel } from "@opengps/shared";

export interface ModelOption {
  /** The family, which sets the protocol and the port. */
  modelId: string;
  /** The model chosen from the family's list; null = only the family is known ("otro modelo"). */
  modelName: string | null;
  family: DeviceModel;
}

/** Most options listed at once: typing narrows them. */
export const OPTIONS_SHOWN = 40;

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * The models that match what the person typed, and the "other model" of each family that matches.
 * A model is found by its name, its family, brand and protocol; the family's examples only find
 * its "other model", so typing one model does not list the whole family.
 */
export function modelOptions(models: DeviceModel[], query: string): ModelOption[] {
  const words = plain(query).split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((w) => plain(text).includes(w));
  const out: ModelOption[] = [];
  for (const family of models) {
    const familyText = `${family.name} ${family.brand} ${family.protocol}`;
    for (const name of family.models) if (matches(`${name} ${familyText}`)) out.push({ modelId: family.id, modelName: name, family });
    if (matches(`${familyText} ${family.examples}`)) out.push({ modelId: family.id, modelName: null, family });
  }
  return out;
}

/** The identifier as the device shows it, without the spaces people type between groups of digits. */
export const cleanId = (typed: string) => typed.replace(/\s+/g, "");
/** Letters and numbers only, 6 to 20, as the platform accepts it. */
export const isValidId = (id: string) => /^[0-9A-Za-z]{6,20}$/.test(id);

/** An instruction with this platform's server, its address and the family's port. */
export const fillSetup = (text: string, where: { host: string; ip: string | null; port: number }) =>
  text.replaceAll("{host}", where.host).replaceAll("{ip}", where.ip ?? where.host).replaceAll("{port}", String(where.port));
