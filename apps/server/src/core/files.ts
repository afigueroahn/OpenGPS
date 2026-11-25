// Where the files users upload live on disk:
//   <filesDir>/<kind>/<account>/<entity>/<file>
// Paths are rebuilt from ids every time; nothing about them is stored in the
// database.
import { join } from "node:path";
import type { Config } from "../config";

/** One folder per kind of upload. */
export type FileKind = "incidents" | "maintenance" | "routes" | "fleet";

/** Folder of a kind of upload, or of an account or an entity inside it. */
export const filesFolder = (config: Pick<Config, "filesDir">, kind: FileKind, ...parts: string[]): string => join(config.filesDir, kind, ...parts);
