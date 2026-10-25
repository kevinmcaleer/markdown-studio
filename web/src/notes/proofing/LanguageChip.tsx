import { useEffect, useRef, useState } from "react";
import { LANGUAGE_NAMES } from "./settings";
import type { ProofLanguage } from "./speller";
import type { Proofing } from "./useProofing";

// The status bar's language chip, like Word's: the proofing language, and
// switches for spelling and grammar.

export function LanguageChip({ proofing }: { proofing: Proofing }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { settings, features, signedIn } = proofing;

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) {
        // Stop Escape from also leaving focus mode.
        if (event instanceof KeyboardEvent) event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const grammarNote = features.grammar
    ? signedIn
      ? "Checked by LanguageTool on your server."
      : "Basic checks. Sign in for full grammar checking."
    : "Basic checks. Full grammar checking needs LanguageTool on the server.";

  return (
    <div className="menu language-chip" ref={ref}>
      <button
        type="button"
        className="writing-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Proofing language, spelling and grammar"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M1.5 11 4 4.5 6.5 11M2.4 9h3.2M8.5 4.5v6.5h2a1.6 1.6 0 0 0 0-3.3h-2M10.3 7.7h-1.8M10 13.5l1.5 1.5 3-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {LANGUAGE_NAMES[settings.language]}
      </button>
      {open && (
        <div className="menu-list language-popover" role="dialog" aria-label="Language">
          <div className="menu-heading">Proofing language</div>
          {(Object.keys(LANGUAGE_NAMES) as ProofLanguage[]).map((lang) => (
            <label key={lang} className="language-option">
              <input type="radio" name="proofing-language" checked={settings.language === lang} onChange={() => proofing.setLanguage(lang)} />
              {LANGUAGE_NAMES[lang]}
            </label>
          ))}
          <div className="menu-separator" role="separator" />
          <label className="language-option">
            <input type="checkbox" checked={settings.spelling} onChange={(e) => proofing.setSpelling(e.target.checked)} />
            Check spelling as you type
          </label>
          <label className="language-option">
            <input type="checkbox" checked={settings.grammar} onChange={(e) => proofing.setGrammar(e.target.checked)} />
            Check grammar as you type
          </label>
          <p className="muted small">{grammarNote}</p>
          {proofing.dictionarySize > 0 && (
            <div className="language-dictionary small">
              <span>
                {proofing.dictionarySize} {proofing.dictionarySize === 1 ? "word" : "words"} in your dictionary
              </span>
              <button type="button" className="menu-button" onClick={proofing.clearDictionary}>
                Clear
              </button>
            </div>
          )}
          <p className="muted small">Right-click a word for suggestions, Look Up and Translate. Shift+right-click gives the browser's menu.</p>
        </div>
      )}
    </div>
  );
}
