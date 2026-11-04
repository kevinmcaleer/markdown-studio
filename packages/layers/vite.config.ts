import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";

// vite build    ESM for hosts: dist/layers.js (Fabric.js bundled in, CSS carried inline)
//               and dist/doc.js, the PNG/document helpers on their own.
//               dist/occt/: OpenCascade's STEP reader (occt-import-js, LGPL),
//               its own unchanged files, loaded only when a STEP file is opened.
const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string };

const occtDir = dirname(createRequire(import.meta.url).resolve("occt-import-js"));
function occt(): Plugin {
  return {
    name: "layers-occt",
    apply: "build",
    generateBundle() {
      for (const [from, to] of [
        ["occt-import-js.js", "occt-import-js.js"],
        ["occt-import-js.wasm", "occt-import-js.wasm"],
        ["license.occt-import-js.txt", "LICENSE-occt-import-js.txt"],
        ["license.occt.txt", "LICENSE-occt.txt"],
      ]) this.emitFile({ type: "asset", fileName: `occt/${to}`, source: readFileSync(join(occtDir, from)) });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [occt()],
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
