import type { ProofLanguage } from "./speller";

// The standalone bundle's word lists: `dictionaries/en-GB.dic` beside
// markdown-editor.js, wherever the host serves it from. The script's own URL
// is only known while it first runs, so it's read once, here.

const script =
  (typeof document !== "undefined" && document.currentScript instanceof HTMLScriptElement && document.currentScript.src) || import.meta.url;

let base: string | null = null;

/** Look for `en-GB.dic` and `en-US.dic` under this URL instead. Null goes back to the defaults. */
export function setDictionaryBase(url: string | null): void {
  base = url;
}

export function dictionaryUrl(language: ProofLanguage): string {
  const name = `${language === "en-US" ? "en-US" : "en-GB"}.dic`;
  if (base) return new URL(name, new URL(base.replace(/\/?$/, "/"), location.href)).href;
  const folder = "dictionaries/";
  return new URL(folder + name, script).href;
}
