import { api } from "../../api";

// The server's half of the language tools. Lookup is local to the server;
// grammar and translation go to LanguageTool and LibreTranslate when the
// server has them set up.

export type LanguageFeatures = { lookup: boolean; grammar: boolean; translate: boolean };

export type Sense = { definition: string; examples: string[]; synonyms: string[] };
export type Definition = { word: string; lemma: string; entries: { pos: string; lemma: string; senses: Sense[] }[] };

export type GrammarSegment = { text?: string; markup?: string; interpretAs?: string };
export type GrammarMatch = { offset: number; length: number; message: string; short: string; replacements: string[]; rule: string };

const NONE: LanguageFeatures = { lookup: false, grammar: false, translate: false };
let features: Promise<LanguageFeatures> | null = null;

/** What this server offers. Asked once; offline, it's nothing. */
export function languageFeatures(): Promise<LanguageFeatures> {
  if (!features) {
    features = api<LanguageFeatures>("/api/language").catch(() => {
      features = null;
      return NONE;
    });
  }
  return features;
}

const definitions = new Map<string, Promise<Definition | null>>();

/** A definition, or null when the dictionary doesn't have the word. */
export function define(word: string): Promise<Definition | null> {
  const key = word.toLowerCase();
  let found = definitions.get(key);
  if (!found) {
    found = api<Definition>(`/api/language/define?word=${encodeURIComponent(word)}`).catch((err) => {
      definitions.delete(key);
      if (err?.status === 404) return null;
      throw err;
    });
    definitions.set(key, found);
  }
  return found;
}

export function checkGrammar(language: string, annotation: GrammarSegment[]) {
  return api<{ matches: GrammarMatch[] }>("/api/language/check", { body: { language, annotation } }).then((r) => r.matches);
}

let targets: Promise<{ code: string; name: string }[]> | null = null;

export function translationLanguages() {
  if (!targets) {
    targets = api<{ languages: { code: string; name: string }[] }>("/api/language/translate/languages").then(
      (r) => r.languages,
      (err) => {
        targets = null;
        throw err;
      },
    );
  }
  return targets;
}

export function translate(text: string, target: string) {
  return api<{ text: string; detected: string | null }>("/api/language/translate", { body: { text, target } });
}
