import SpellWorker from "./spellWorker.ts?worker&inline";

// In the bundle the worker's code is inline and started from a blob: URL, so
// it runs whatever origin the host serves the script from (a worker script
// must otherwise come from the page's own origin).

export function startWorker(): Worker {
  return new SpellWorker();
}
