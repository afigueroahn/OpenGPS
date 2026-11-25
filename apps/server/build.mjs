// Bundles the backend into a single file: dist/main.mjs.
// The final image carries no node_modules, so everything goes inside the bundle.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "info",
  // Optional dependencies that no code path uses.
  external: ["pg-native", "bufferutil", "utf-8-validate", "pg-cloudflare"],
  // Several dependencies are CommonJS and expect require, __filename and __dirname.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
});
