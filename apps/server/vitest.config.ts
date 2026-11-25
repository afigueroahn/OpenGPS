import { defineConfig } from "vitest/config";

// The tests use the test database of .env.local (README.md, "Desarrollo y
// pruebas"): they create their own accounts and delete them when they finish.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
