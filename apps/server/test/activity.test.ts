// The activity log shows each recorded action as a phrase. Every action the
// server records must have one, or the screen falls back to its internal id.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = resolve(process.cwd(), "src");
/** The phrases, in the reference language: the path of each text under "actions" is the action it describes ("vehicle.create"). */
const CATALOG = resolve(process.cwd(), "../web/src/locales/es/activity.json");
/** Actions built from a variable, with the values that variable takes. */
const DYNAMIC: Record<string, string[]> = { "fleet.${field}": ["fleet.status", "fleet.state"] };

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

type Tree = { [key: string]: string | Tree };
/** The path of every text in a tree of texts. */
const paths = (tree: Tree, prefix = ""): string[] =>
  Object.entries(tree).flatMap(([key, value]) => (typeof value === "string" ? [prefix + key] : paths(value, `${prefix}${key}.`)));

describe("activity log", () => {
  it("has a phrase for every action the server records", () => {
    const recorded = new Set<string>();
    for (const file of sources(SOURCE)) {
      const code = readFileSync(file, "utf8");
      for (const call of code.matchAll(/\baudit\w*\(/g)) {
        // The action is one of the first arguments: look only inside this statement.
        const start = call.index + call[0].length;
        const statement = code.slice(start, start + 260).split(";\n")[0] ?? "";
        for (const [, action] of statement.matchAll(/["'`]([a-z]+(?:\.[a-z_${}]+)+)["'`]/g)) {
          if (action) for (const name of DYNAMIC[action] ?? [action]) recorded.add(name);
        }
      }
    }
    const phrases = new Set(paths((JSON.parse(readFileSync(CATALOG, "utf8")) as { actions: Tree }).actions));
    expect(recorded.size).toBeGreaterThan(100);
    expect([...recorded].filter((action) => !phrases.has(action)).sort()).toEqual([]);
  });
});
