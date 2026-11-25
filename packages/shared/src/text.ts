// Texts by language. A catalog is a tree of texts; a key is the path to one
// of them ("event.speeding"). The same catalogs and the same rules serve the
// backend and the web: variables go between double braces ({{name}}) and a
// text that depends on a number has a singular (`key_one`) and a plural
// (`key_other`) form, chosen by its `count`.

/** A catalog, or a branch of one. */
export type TextTree = { readonly [key: string]: string | TextTree };
export type TextParams = Record<string, string | number>;

/** The same tree with any texts: what another language has to provide. */
export type SameShape<T> = { readonly [K in keyof T]: T[K] extends string ? string : SameShape<T[K]> };

/** The name a text is asked for by: a counted one ("days_one", "days_other") goes by its base name, with a `count`. */
type TextName<K extends string> = K extends `${infer Base}_one` | `${infer Base}_other` ? Base : K;

/** Every "a.b.c" path to a text of a tree. */
export type TextKey<T> = T extends string
  ? never
  : { [K in keyof T & string]: T[K] extends string ? TextName<K> : `${K}.${TextKey<T[K]>}` }[keyof T & string];

/** The text at a path, or undefined if the path leads nowhere or to a branch. */
export function lookupText(tree: TextTree, key: string): string | undefined {
  let at: string | TextTree | undefined = tree;
  for (const part of key.split(".")) {
    if (typeof at !== "object") return undefined;
    at = at[part];
  }
  return typeof at === "string" ? at : undefined;
}

/** Puts each variable in its place. A variable the text names and nobody gave is left as it is. */
export function fillText(template: string, params?: TextParams): string {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/**
 * The text of a key, with its variables. With a `count`, the singular or the
 * plural form if the catalog has them. A key that is not in the catalog comes
 * back as it is: a hole that shows is found sooner than one that is hidden.
 */
export function translate(tree: TextTree, key: string, params?: TextParams): string {
  const count = params?.count;
  const counted = typeof count === "number" ? lookupText(tree, `${key}_${count === 1 ? "one" : "other"}`) : undefined;
  return fillText(counted ?? lookupText(tree, key) ?? key, params);
}
