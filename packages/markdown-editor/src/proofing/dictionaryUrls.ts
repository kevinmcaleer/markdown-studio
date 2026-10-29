import enGbDic from "@dictionaries/en-gb/index.dic?url";
import enUsDic from "@dictionaries/en/index.dic?url";
import type { ProofLanguage } from "./speller";

// Where the spell worker finds each language's word list. Built into an app
// (Markdown Studio), Vite gives the files URLs of their own, so the service
// worker keeps them and spelling works offline. The standalone bundle swaps
// this module for dictionaryUrls.bundle.ts, which finds them beside the script.

const bundled: Record<ProofLanguage, string> = { "en-GB": enGbDic, "en-US": enUsDic };

let base: string | null = null;

/** Look for `en-GB.dic` and `en-US.dic` under this URL instead. Null goes back to the defaults. */
export function setDictionaryBase(url: string | null): void {
  base = url;
}

export function dictionaryUrl(language: ProofLanguage): string {
  if (base) return new URL(`${language}.dic`, new URL(base.replace(/\/?$/, "/"), location.href)).href;
  return new URL(bundled[language] ?? bundled["en-GB"], location.href).href;
}
