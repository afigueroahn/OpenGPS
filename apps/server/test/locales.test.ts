// Translation catalogs: every language must have exactly the keys of the
// reference one, with the same placeholders, so no screen falls back to
// another language or shows a text with a hole in it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { LANGUAGES } from "@opengps/shared";
import { describe, expect, it } from "vitest";

/** Folders that hold one subfolder per language, each with its namespace files. */
const CATALOGS = [resolve(process.cwd(), "../web/src/locales")];
const [reference, ...others] = LANGUAGES;

type Tree = { [key: string]: string | Tree };

/** "a.b.c" → text, for every text of a catalog. */
function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort();
const read = (file: string) => flatten(JSON.parse(readFileSync(file, "utf8")) as Tree);

describe("translation catalogs", () => {
  for (const folder of CATALOGS) {
    const files = readdirSync(join(folder, reference)).filter((f) => f.endsWith(".json"));

    it(`has the reference language in ${folder.split("/").slice(-3).join("/")}`, () => {
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) for (const [key, text] of read(join(folder, reference, file))) expect(text.trim(), `${file}: ${key} is empty`).not.toBe("");
    });

    for (const language of others) {
      it(`${language} has the same texts as ${reference}`, () => {
        // No namespace that the reference language lacks.
        expect(readdirSync(join(folder, language)).filter((f) => f.endsWith(".json")).sort()).toEqual([...files].sort());
        for (const file of files) {
          const path = join(folder, language, file);
          expect(existsSync(path), `${language}/${file} is missing`).toBe(true);
          const base = read(join(folder, reference, file));
          const translated = read(path);
          expect([...translated.keys()].sort(), `${language}/${file} has other keys`).toEqual([...base.keys()].sort());
          for (const [key, text] of base) {
            expect(translated.get(key)?.trim(), `${language}/${file}: ${key} is empty`).not.toBe("");
            expect(placeholders(translated.get(key) ?? ""), `${language}/${file}: ${key} has other placeholders`).toEqual(placeholders(text));
          }
        }
      });
    }
  }
});
