import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { personalDictionary } from "./dictionary";
import { languageFeatures, type LanguageFeatures } from "./languageApi";
import type { ProofingSettings } from "./settings";
import type { ProofLanguage } from "./speller";

// The proofing choices behind the status bar's language chip. They're
// remembered on this device and apply to every note, like Word's defaults.

const LANGUAGE_KEY = "notes.language";
const SPELLING_KEY = "notes.spelling";
const GRAMMAR_KEY = "notes.grammar";
const RETRY_FIRST = 15_000;
const RETRY_MAX = 5 * 60_000;

/** What the right-click menu says in place of Look Up and Translate when the server can't give them. */
export function languageNote(features: LanguageFeatures): string {
  if (features.unavailable === "offline") return "Spelling still works. Look Up and Synonyms need the language server, which can't be reached right now.";
  if (features.unavailable === "signin") return "Sign in to use Look Up and Synonyms.";
  return "";
}

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
  const current = useRef(features);
  current.current = features;
  useEffect(() => {
    // A server that couldn't be reached is asked again, less and less often, and
    // straight away when the window gets focus or the browser comes back online.
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = RETRY_FIRST;
    const check = () =>
      languageFeatures().then((f) => {
        if (!live) return;
        setFeatures(f);
        clearTimeout(timer);
        if (f.unavailable === "offline") {
          timer = setTimeout(check, delay);
          delay = Math.min(delay * 2, RETRY_MAX);
        }
      });
    const again = () => {
      if (current.current.unavailable !== "offline") return;
      delay = RETRY_FIRST;
      void check();
    };
    void check();
    window.addEventListener("online", again);
    window.addEventListener("focus", again);
    // A right-click is when you want Look Up: ask again then too, so a server
    // that's come back is offered without waiting for the next retry.
    window.addEventListener("contextmenu", again, true);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("online", again);
      window.removeEventListener("focus", again);
      window.removeEventListener("contextmenu", again, true);
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
      translateOffered: features.translate,
      languageNote: languageNote(features),
      translateHint: !features.translate ? "Translation isn't set up on this server" : "Sign in to translate",
    }),
    [language, spelling, grammar, features, signedIn],
  );

  return { settings, features, signedIn, setLanguage, setSpelling, setGrammar, dictionarySize, clearDictionary: personalDictionary.clear };
}

export type Proofing = ReturnType<typeof useProofing>;
