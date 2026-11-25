import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development, the web app runs on port 5173 and forwards /api (including the
// live channel) to the local backend.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3000", ws: true } },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
