import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

// keynotejs ships 16 Keynote themes, and Vite copies them all into the build.
// Decks only uses Basic White (src/decks/keynote.ts), so only that is precached.
function unusedKeynoteTheme(name: string): boolean {
  return name.endsWith(".key") && !/^assets\/basic-white-(16x9|parts)-[\w-]+\.key$/.test(name);
}

// Builds sw.js from ./sw.js, filling in the list of files to precache so the
// apps (including lazily loaded parts) open offline after the first visit.
function serviceWorker(): Plugin {
  return {
    name: "studio-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => !name.endsWith(".map") && name !== "index.html" && !unusedKeynoteTheme(name))
        .map((name) => `/${name}`)
        .concat(["/favicon.svg", "/manifest.webmanifest", "/notes.webmanifest", "/tables.webmanifest", "/decks.webmanifest"])
        .sort();
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./sw.js", import.meta.url), "utf8")
        .replace('const VERSION = "__VERSION__";', `const VERSION = "${version}";`)
        .replace("const PRECACHE = __PRECACHE__;", `const PRECACHE = ${JSON.stringify(files)};`);
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// The Keynote theme files that ship with keynotejs, imported with ?url (see src/decks/keynote.ts).
const keynoteTemplates = join(dirname(createRequire(import.meta.url).resolve("@kevsmac/keynotejs")), "../templates");

// Hunspell dictionaries for spelling, imported with ?url (see src/notes/proofing/spellWorker.ts).
// Their packages only export a Node entry point, so this reaches the files directly.
const dictionary = (name: string) => dirname(createRequire(import.meta.url).resolve(name));

// In development the Python server runs on :8000 (`make dev-server`) and Vite
// proxies the API to it, so the browser sees one origin and cookies just work.
const api = process.env.STUDIO_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), serviceWorker()],
  resolve: {
    alias: [
      { find: /^@keynote-templates\//, replacement: `${keynoteTemplates}/` },
      { find: /^@dictionaries\/en-gb\//, replacement: `${dictionary("dictionary-en-gb")}/` },
      { find: /^@dictionaries\/en\//, replacement: `${dictionary("dictionary-en")}/` },
    ],
  },
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
