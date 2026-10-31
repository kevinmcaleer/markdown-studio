import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// vite build    ESM for hosts: dist/layers.js (Fabric.js bundled in, CSS carried inline)
//               and dist/doc.js, the PNG/document helpers on their own.
const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string };

export default defineConfig(({ command }) => ({
  test: { environment: "node" },
  define: {
    __LAYERS_VERSION__: JSON.stringify(version),
    ...(command === "build" ? { "process.env.NODE_ENV": JSON.stringify("production") } : {}),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: "oxc",
    // Vite keeps a library's whitespace; this one is served as is, so it goes out fully minified.
    rolldownOptions: { output: { minify: true } },
    lib: {
      entry: { layers: join(here, "src/index.ts"), doc: join(here, "src/docOnly.ts") },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
  },
}));
