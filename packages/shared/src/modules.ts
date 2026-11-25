// Optional modules.

/** Modules enabled per account, without touching the core. Their names are in the catalog: "module.<key>". */
const MODULE_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];
export const ALL_MODULES: ModuleKey[] = [...MODULE_KEYS];
