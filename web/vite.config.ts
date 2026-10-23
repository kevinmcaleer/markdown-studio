import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
        .concat(["/favicon.svg", "/manifest.webmanifest", "/notes.webmanifest", "/decks.webmanifest"])
        .sort();
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./sw.js", import.meta.url), "utf8")
        .replace('const VERSION = "__VERSION__";', `const VERSION = "${version}";`)
        .replace("const PRECACHE = __PRECACHE__;", `const PRECACHE = ${JSON.stringify(files)};`);
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// keynotejs 0.1.0 imports a few Node modules for reading and writing files.
// Decks only uses its in-memory API, so in the browser those imports get
// stand-ins (src/decks/nodeShim.ts). Tests run on Node and keep the real ones.
function keynoteInBrowser(): Plugin {
  const shim = fileURLToPath(new URL("./src/decks/nodeShim.ts", import.meta.url));
  return {
    name: "keynote-in-browser",
    enforce: "pre",
    resolveId(source, importer) {
      if (process.env.VITEST || !source.startsWith("node:") || !importer?.includes("keynotejs")) return null;
      return shim;
    },
  };
}

// The Keynote theme files that ship with keynotejs, imported with ?url.
const keynoteTemplates = join(dirname(createRequire(import.meta.url).resolve("@kevsmac/keynotejs")), "../templates");

// In development the Python server runs on :8000 (`make dev-server`) and Vite
// proxies the API to it, so the browser sees one origin and cookies just work.
const api = process.env.STUDIO_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), serviceWorker(), keynoteInBrowser()],
  resolve: {
    alias: [{ find: /^@keynote-templates\//, replacement: `${keynoteTemplates}/` }],
  },
  // Served as-is in development, so the plugin above sees its imports.
  optimizeDeps: { exclude: ["@kevsmac/keynotejs"] },
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
