// Starts the Hunspell worker. Built into an app, it's a file of its own that
// the service worker can keep; the standalone bundle swaps this module for
// startWorker.bundle.ts, which carries the worker inside the script.

export function startWorker(): Worker {
  return new Worker(new URL("./spellWorker.ts", import.meta.url), { type: "module" });
}
