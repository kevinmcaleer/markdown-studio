/// <reference lib="webworker" />
// The affix rules are small enough to ship as text in this file; the word lists
// are files of their own, and each request says where its list is (see
// dictionaryUrls.ts), so the worker works the same from any origin.
import enGbAff from "@dictionaries/en-gb/index.aff?raw";
import enUsAff from "@dictionaries/en/index.aff?raw";
import { createSpeller, isCorrect, suggestions, type Speller } from "./spellCore";
import type { SpellRequest, SpellResponse } from "./speller";

// Hunspell runs here, off the main thread: loading a dictionary takes a moment
// and suggestions are slow to work out. The files are part of the app, so the
// service worker keeps them and spelling works offline.

const affixes: Record<string, string> = { "en-GB": enGbAff, "en-US": enUsAff };

const spellers = new Map<string, Promise<Speller>>();

function speller(language: string, dic: string): Promise<Speller> {
  let found = spellers.get(language);
  if (!found) {
    const aff = affixes[language] ?? affixes["en-GB"];
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
    const s = await speller(request.language, request.dic);
    response =
      request.type === "check"
        ? { id: request.id, wrong: request.words.filter((w) => !isCorrect(s, w)) }
        : { id: request.id, suggestions: suggestions(s, request.word) };
  } catch (err) {
    response = { id: request.id, error: String(err) };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
};
