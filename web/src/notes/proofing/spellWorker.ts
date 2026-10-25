/// <reference lib="webworker" />
// The affix rules are small enough to ship as text in this file; the word lists
// are files of their own. (A data: URL can't be fetched under the app's CSP.)
import enGbAff from "@dictionaries/en-gb/index.aff?raw";
import enGbDic from "@dictionaries/en-gb/index.dic?url";
import enUsAff from "@dictionaries/en/index.aff?raw";
import enUsDic from "@dictionaries/en/index.dic?url";
import { createSpeller, isCorrect, suggestions, type Speller } from "./spellCore";
import type { SpellRequest, SpellResponse } from "./speller";

// Hunspell runs here, off the main thread: loading a dictionary takes a moment
// and suggestions are slow to work out. The files are part of the app, so the
// service worker keeps them and spelling works offline.

const files: Record<string, [string, string]> = {
  "en-GB": [enGbAff, enGbDic],
  "en-US": [enUsAff, enUsDic],
};

const spellers = new Map<string, Promise<Speller>>();

function speller(language: string): Promise<Speller> {
  let found = spellers.get(language);
  if (!found) {
    const [aff, dic] = files[language] ?? files["en-GB"];
    found = fetch(dic)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((d) => createSpeller(aff, d));
    found.catch(() => spellers.delete(language));
    spellers.set(language, found);
  }
  return found;
}

self.onmessage = async (event: MessageEvent<SpellRequest>) => {
  const request = event.data;
  let response: SpellResponse;
  try {
    const s = await speller(request.language);
    response =
      request.type === "check"
        ? { id: request.id, wrong: request.words.filter((w) => !isCorrect(s, w)) }
        : { id: request.id, suggestions: suggestions(s, request.word) };
  } catch (err) {
    response = { id: request.id, error: String(err) };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
};
