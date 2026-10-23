import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// Builds sw.js from ./sw.js, filling in the list of files to precache so the
// apps (including lazily loaded parts) open offline after the first visit.
function serviceWorker(): Plugin {
  return {
    name: "studio-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => !name.endsWith(".map") && name !== "index.html")
        .map((name) => `/${name}`)
        .concat(["/favicon.svg", "/manifest.webmanifest", "/notes.webmanifest"])
        .sort();
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./sw.js", import.meta.url), "utf8")
        .replace('const VERSION = "__VERSION__";', `const VERSION = "${version}";`)
        .replace("const PRECACHE = __PRECACHE__;", `const PRECACHE = ${JSON.stringify(files)};`);
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// In development the Python server runs on :8000 (`make dev-server`) and Vite
// proxies the API to it, so the browser sees one origin and cookies just work.
const api = process.env.STUDIO_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, ws: true },
      "/health": api,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
