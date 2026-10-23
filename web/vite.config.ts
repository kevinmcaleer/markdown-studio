import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the Python server runs on :8000 (`make dev-server`) and Vite
// proxies the API to it, so the browser sees one origin and cookies just work.
const api = process.env.STUDIO_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/health": api,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
