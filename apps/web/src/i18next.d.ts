// Types of the translation keys: `t` only accepts keys that exist in the
// reference language.
import "i18next";
import type { resources } from "./lib/i18n";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "web";
    resources: (typeof resources)["es"];
  }
}
