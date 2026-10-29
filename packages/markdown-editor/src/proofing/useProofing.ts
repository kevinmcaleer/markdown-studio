import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { personalDictionary } from "./dictionary";
import { languageFeatures, type LanguageFeatures } from "./languageApi";
import type { ProofingSettings } from "./settings";
import type { ProofLanguage } from "./speller";

// The proofing choices behind the status bar's language chip. They're
// remembered on this device and apply to every note, like Word's defaults.

const LANGUAGE_KEY = "notes.language";
const SPELLING_KEY = "notes.spelling";
const GRAMMAR_KEY = "notes.grammar";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function useStored<T extends string | boolean>(key: string, fallback: T, valid: (raw: string) => boolean, parse: (raw: string) => T) {
  const [value, setValue] = useState<T>(() => {
    const raw = read(key);
    return raw !== null && valid(raw) ? parse(raw) : fallback;
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        /* private mode */
      }
    },
    [key],
  );
  return [value, set] as const;
}

const isLanguage = (raw: string): raw is ProofLanguage => raw === "en-GB" || raw === "en-US";
const isBool = (raw: string) => raw === "true" || raw === "false";

export function useProofing(signedIn: boolean, defaultLanguage: ProofLanguage = "en-GB") {
  const [language, setLanguage] = useStored<ProofLanguage>(LANGUAGE_KEY, defaultLanguage, isLanguage, (raw) => raw as ProofLanguage);
  const [spelling, setSpelling] = useStored(SPELLING_KEY, true, isBool, (raw) => raw === "true");
  const [grammar, setGrammar] = useStored(GRAMMAR_KEY, true, isBool, (raw) => raw === "true");
  const [features, setFeatures] = useState<LanguageFeatures>({ lookup: false, grammar: false, translate: false });
  useEffect(() => {
    let live = true;
    languageFeatures().then((f) => live && setFeatures(f));
    return () => {
      live = false;
    };
  }, []);
  const dictionarySize = useSyncExternalStore(
    (listener) => {
      const unsubscribe = personalDictionary.subscribe(listener);
      return () => void unsubscribe();
    },
    personalDictionary.size,
  );

  const settings = useMemo<ProofingSettings>(
    () => ({
      language,
      spelling,
      grammar,
      remoteGrammar: features.grammar && signedIn,
      lookup: features.lookup,
      translate: features.translate && signedIn,
      translateHint: !features.translate ? "Translation isn't set up on this server" : "Sign in to translate",
    }),
    [language, spelling, grammar, features, signedIn],
  );

  return { settings, features, signedIn, setLanguage, setSpelling, setGrammar, dictionarySize, clearDictionary: personalDictionary.clear };
}

export type Proofing = ReturnType<typeof useProofing>;
