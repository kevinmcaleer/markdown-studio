import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// Two builds share this file:
//   vite build                    ESM for bundlers (dist/markdown-editor.mjs, dist/collab.mjs)
//   vite build --mode standalone  one IIFE for a plain <script> (dist/markdown-editor.js, window.MarkdownEditor)
// Both write dist/markdown-editor.css and the Hunspell word lists under dist/dictionaries/.

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string };
const dictionary = (name: string) => dirname(createRequire(import.meta.url).resolve(name));
const DICTIONARIES: [string, string][] = [
  ["en-GB", "dictionary-en-gb"],
  ["en-US", "dictionary-en"],
];

/** The word lists sit beside the script, so a host serves them with it and spelling works offline. */
function wordLists(): Plugin {
  return {
    name: "markdown-editor-word-lists",
    apply: "build",
    generateBundle() {
      for (const [language, pkg] of DICTIONARIES) {
        this.emitFile({ type: "asset", fileName: `dictionaries/${language}.dic`, source: readFileSync(join(dictionary(pkg), "index.dic")) });
        this.emitFile({ type: "asset", fileName: `dictionaries/${language}.LICENSE`, source: readFileSync(join(dictionary(pkg), "license")) });
      }
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const standalone = mode === "standalone";
  return {
    plugins: [react(), wordLists()],
    resolve: {
      alias: [
        { find: /^@dictionaries\/en-gb\//, replacement: `${dictionary("dictionary-en-gb")}/` },
        { find: /^@dictionaries\/en\//, replacement: `${dictionary("dictionary-en")}/` },
        // Built as a library, the word lists are found beside the script rather than through Vite's
        // asset URLs, and the spell worker is carried inline (see the .bundle.ts files).
        ...(command === "build"
          ? [
              { find: /^\.\/dictionaryUrls$/, replacement: join(here, "src/proofing/dictionaryUrls.bundle.ts") },
              { find: /^\.\/startWorker$/, replacement: join(here, "src/proofing/startWorker.bundle.ts") },
            ]
          : []),
      ],
    },
    // React reads process.env.NODE_ENV, which a browser page doesn't have.
    define: {
      __MARKDOWN_EDITOR_VERSION__: JSON.stringify(version),
      // An IIFE has no import.meta; the bundle finds its own URL from document.currentScript instead.
      ...(standalone ? { "import.meta.url": "undefined" } : {}),
      ...(command === "build" ? { "process.env.NODE_ENV": JSON.stringify("production") } : {}),
    },
    worker: { format: "iife" },
    build: {
      outDir: "dist",
      emptyOutDir: !standalone,
      sourcemap: true,
      cssCodeSplit: false,
      lib: standalone
        ? {
            entry: join(here, "src/standalone.ts"),
            name: "MarkdownEditor",
            formats: ["iife"],
            fileName: () => "markdown-editor.js",
            cssFileName: "markdown-editor",
          }
        : {
            entry: { "markdown-editor": join(here, "src/index.ts"), collab: join(here, "src/collab.ts") },
            formats: ["es"],
            fileName: (_format, name) => `${name}.mjs`,
            cssFileName: "markdown-editor",
          },
      // Co-editing needs the host's own Yjs: two copies can't share a document.
      rolldownOptions: standalone ? {} : { external: ["yjs"] },
    },
  };
});
